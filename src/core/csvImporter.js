// @ts-check
/**
 * Overtime Tracker - CSV_Importer（入力ツール形式 CSV → 日次エントリ）
 *
 * 副作用のない純粋関数群。既存の「残業入力ツール.csv」形式のテキストを解析し、
 * 日次エントリ（DailyEntry）の配列へ変換する。検証エラーでは例外を投げず、
 * 行番号付きの結果型（{ ok: false, lineNumber, reason }）を返して取り込みを中止する。
 *
 * 本モジュールは重複排除や年度への割り当てを行わない（要件11.4は呼び出し側=UI層の責務）。
 * 検証・丸めは Input_Manager（parseHours / validateNote）を、曜日導出・暦日判定は
 * FiscalYear（weekdayOf / isValidCalendarDate）を再利用する。
 *
 * CSV 仕様（入力ツール形式）:
 *   1行目: `,,残業時間[h],,`（セクション見出し）
 *   2行目: `日付,曜日,実績,予想,`（列見出し。予測列の見出しは「予想」表記の場合がある）
 *   3行目以降: `日付,曜日,実績,予想,備考`（データ行。実績/予測/備考は空欄可）
 * 日付列は「西暦4桁/月/日」（YYYY/M/D）。内部表現 "YYYY-MM-DD" へ正規化する。
 *
 * 行番号規約: lineNumber は元テキストを改行で分割した際の 1 始まりの物理行番号
 * （ヘッダ行を含む）を指す。すなわちエラー行の CSV 内での実際の位置。
 *
 * 設計書（design.md）の CSV_Importer コンポーネント仕様、要件11に対応する。
 * @module core/csvImporter
 */

import { parseHours, validateNote } from './inputManager.js';
import { weekdayOf, isValidCalendarDate } from './fiscalYear.js';

/**
 * @typedef {import('./types.js').DailyEntry} DailyEntry
 * @typedef {import('./types.js').DateISO} DateISO
 */

/**
 * CSV 取り込みの結果。
 * 成功時は変換済み日次エントリ配列を、失敗時は該当行番号と説明的理由（日本語）を返す。
 * @typedef {(
 *   { ok: true, entries: DailyEntry[] }
 *   | { ok: false, lineNumber: number, reason: string }
 * )} ImportResult
 */

/**
 * CSV の1行を、引用符（"..."）・エスケープ引用符（""）・引用符内カンマに対応して
 * セル配列へ分割する最小 CSV パーサ。外部ライブラリは使用しない。
 *
 * - 引用符で囲まれたフィールド内のカンマはセパレータとして扱わない。
 * - 引用符内の連続する二重引用符（""）は1個の引用符文字として展開する。
 * - 引用符外の文字はそのまま蓄積する。
 * @param {string} line 1行分の文字列（改行文字を含まない）
 * @returns {string[]} 分割後のセル配列
 */
function parseCsvLine(line) {
  /** @type {string[]} */
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        // 連続する "" は 1 個の引用符。それ以外の " は引用フィールドの終了。
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        cells.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
  }
  cells.push(cur);
  return cells;
}

/**
 * 「西暦4桁/月/日」（YYYY/M/D）形式の文字列を解釈する。
 * 月・日はゼロ埋め有無を問わない（例: "2026/1/2" も "2026/01/02" も可）。
 * 実在する暦日でなければ null を返す。
 * @param {string} raw 日付セルの生文字列
 * @returns {DateISO|null} 正規化日付 "YYYY-MM-DD"、解釈不能なら null
 */
function parseSlashDate(raw) {
  const trimmed = raw.trim();
  const match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(trimmed);
  if (!match) {
    return null;
  }
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (!isValidCalendarDate(y, m, d)) {
    return null;
  }
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * セルが「西暦4桁/月/日」の日付として解釈できるかを判定する。
 * データ行の開始位置（先頭のヘッダ/セクション行を読み飛ばす基準）に用いる。
 * @param {string|undefined} cell 判定対象セル
 * @returns {boolean}
 */
function looksLikeDate(cell) {
  return typeof cell === 'string' && parseSlashDate(cell) !== null;
}

/**
 * 行のすべてのセルが空（トリム後に空文字）かどうかを判定する。
 * @param {string[]} cells セル配列
 * @returns {boolean}
 */
function isBlankRow(cells) {
  return cells.every((c) => c.trim() === '');
}

/**
 * 入力ツール形式の CSV テキストを解析し、日次エントリ配列へ変換する。
 *
 * 手順:
 * 1. テキストを行へ分割（\r\n / \n 両対応）。各行に物理行番号（1始まり）を対応付ける。
 * 2. 先頭のヘッダ/セクション行を読み飛ばす。列見出し行（先頭セルが「日付」）を
 *    通過した後、または最初に日付として解釈できる行以降を、データ領域とみなす。
 *    列見出し行の通過後は、日付として解釈できない行も「データ行の日付不正」として
 *    要件11.2のエラー対象になる（先頭データ行が壊れていても正しく検出できる）。
 * 3. 各データ行について:
 *    - 日付列を YYYY/M/D として解釈（不正なら要件11.2により中止）。
 *    - 曜日は CSV のセルを信用せず date から weekdayOf で再導出する。
 *    - 実績/予測列: 空欄は null（要件11.3）。非空は parseHours で検証（拒否時は
 *      要件11.5/11.6により中止）し、丸めた値を採用する。
 *    - 備考列: 任意。存在すれば validateNote で検証（500文字超は中止）。既定 ""。
 *    - 全セルが空の行は末尾/途中の空行として読み飛ばす。
 * 検証エラーでは例外を投げず、{ ok: false, lineNumber, reason } を返して中止する。
 * 重複排除・年度割り当ては行わない（要件11.4は呼び出し側の責務）。
 * @param {string} text CSV 全文
 * @returns {ImportResult}
 */
export function importInputCsv(text) {
  const src = typeof text === 'string' ? text : String(text ?? '');
  // \r\n / \r / \n を統一してから分割する。物理行番号は分割後の添字+1。
  const rawLines = src.replace(/\r\n?/g, '\n').split('\n');

  /** @type {DailyEntry[]} */
  const entries = [];
  let dataStarted = false;
  // 列見出し行（先頭セルが「日付」）を通過したか。通過後は非空行をすべてデータ行として扱う。
  let headerColumnSeen = false;

  for (let i = 0; i < rawLines.length; i++) {
    const lineNumber = i + 1;
    const line = rawLines[i];
    const cells = parseCsvLine(line);

    // 空行はスキップ（先頭ヘッダ前・データ間・末尾の空行いずれも許容）。
    if (isBlankRow(cells)) {
      continue;
    }

    const firstCell = cells[0] !== undefined ? cells[0].trim() : '';

    // データ開始前: 列見出し行の通過、または最初の日付行でデータ領域へ移行する。
    if (!dataStarted) {
      // 列見出し行（例: 「日付,曜日,実績,予想,」）自体は読み飛ばすが、
      // これを通過したら以降の非空行はすべてデータ行とみなす。
      if (firstCell === '日付') {
        headerColumnSeen = true;
        continue;
      }
      if (headerColumnSeen || looksLikeDate(firstCell)) {
        dataStarted = true;
      } else {
        // それ以外の先頭ヘッダ/セクション行（例: 「,,残業時間[h],,」）は読み飛ばす。
        continue;
      }
    }

    // データ行の日付を解釈（要件11.2）。
    const date = parseSlashDate(firstCell);
    if (date === null) {
      return {
        ok: false,
        lineNumber,
        reason: `${lineNumber}行目: 日付「${firstCell}」を「西暦4桁/月/日」形式として解釈できません。`,
      };
    }

    // 曜日は CSV を信用せず date から再導出する（正確性のため）。
    const weekday = weekdayOf(date);

    // 実績列（3列目）と予測列（4列目）。空欄は null（要件11.3）。
    const actualRaw = cells[2] !== undefined ? cells[2].trim() : '';
    const predictedRaw = cells[3] !== undefined ? cells[3].trim() : '';

    const actualResult = parseHoursCell(actualRaw, lineNumber, '実績');
    if (actualResult.ok === false) {
      return actualResult;
    }
    const predictedResult = parseHoursCell(predictedRaw, lineNumber, '予測');
    if (predictedResult.ok === false) {
      return predictedResult;
    }

    // 備考列（5列目）。任意。存在すれば validateNote で検証。既定 ""。
    const noteRaw = cells[4] !== undefined ? cells[4] : '';
    const noteResult = validateNote(noteRaw);
    if (noteResult.ok === false) {
      return {
        ok: false,
        lineNumber,
        reason: `${lineNumber}行目: 備考が最大文字数（500文字）を超えています。`,
      };
    }

    entries.push({
      date,
      weekday,
      actualHours: actualResult.value,
      predictedHours: predictedResult.value,
      note: noteResult.value,
    });
  }

  return { ok: true, entries };
}

/**
 * 実績/予測セルの1個を解釈する内部ヘルパ。
 * 空欄は未入力（null）として受理する（要件11.3）。非空は parseHours で検証し、
 * 拒否時は行番号付きの中止結果を返す（要件11.5 数値不正 / 11.6 範囲外）。
 * @param {string} raw トリム済みセル文字列
 * @param {number} lineNumber 物理行番号（1始まり）
 * @param {string} label エラーメッセージ用の列名（"実績" / "予測"）
 * @returns {{ ok: true, value: number|null } | { ok: false, lineNumber: number, reason: string }}
 */
function parseHoursCell(raw, lineNumber, label) {
  if (raw === '') {
    return { ok: true, value: null };
  }
  const result = parseHours(raw);
  if (result.ok === true) {
    return { ok: true, value: result.value };
  }
  // 拒否理由を日本語メッセージへ写像する（要件11.5 / 11.6）。
  let detail;
  switch (result.reason) {
    case 'not_number':
      detail = `数値として解釈できません`;
      break;
    case 'negative':
      detail = `0未満の値は指定できません`;
      break;
    case 'too_large':
      detail = `15時間以上の値は指定できません`;
      break;
    default:
      detail = `不正な値です`;
  }
  return {
    ok: false,
    lineNumber,
    reason: `${lineNumber}行目: ${label}列「${raw}」は${detail}。`,
  };
}
