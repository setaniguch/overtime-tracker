// @ts-check
/**
 * Overtime Tracker - CSV_Exporter（エントリ→CSV / 集計→CSV）
 *
 * 副作用のない純粋関数群。ドメインのデータ（日次エントリ／集計結果）を、既存の
 * 「残業入力ツール.csv」「残業集計ツール.csv」と互換なテキストへ書き出す。
 * 状態は書き換えず、文字列を返すのみ。例外は投げない（不正値も可能な限り素直に文字列化する）。
 *
 * 日付は内部表現 "YYYY-MM-DD"（ゼロ埋め）で受け取り、CSV では "YYYY/M/D"（月日のゼロ埋め無し・
 * 年は4桁）へ変換する。未入力（null / 空）は空セルとして出力する。
 *
 * 数値表記の規約（設計書 要件12・Property 30/31 に対応）:
 * - 時間（実績・予測・各合計）: 常に小数第1位まで（toFixed(1)。例 "4.0", "0.7"）。
 * - 経過率（%）: 小数第1位まで＋末尾 "%"（例 "19.4%", "100.0%"）。参照 CSV の "100.0%" 表記に合わせる。
 * - 営業日数・残営業日数: 日数（整数）としてそのまま文字列化する（小数点を付けない）。
 *
 * CSV エスケープ: 値にカンマ・二重引用符・改行のいずれかを含む場合のみ、フィールド全体を
 * 二重引用符で囲み、内部の二重引用符は "" に倍化する（RFC 4180 準拠）。
 *
 * 設計書（design.md）の CSV_Exporter コンポーネント仕様、および
 * Property 30（入力CSVの構造）・Property 31（集計CSVの構造）に対応する。
 * @module core/csvExporter
 */

/**
 * @typedef {import('./types.js').DailyEntry} DailyEntry
 * @typedef {import('./types.js').SummaryModel} SummaryModel
 * @typedef {import('./types.js').SummaryRow} SummaryRow
 * @typedef {import('./types.js').DateISO} DateISO
 */

/** 入力ツール互換のヘッダ列（要件12.1）。 */
const INPUT_HEADER = ['日付', '曜日', '実績', '予測', '備考'];

/**
 * 集計ツール互換のヘッダ列（要件12.2）。列順は仕様どおり固定。
 * 参照 CSV の見出しを 1 行に正規化したもの（月合計・月経過率は括弧なしの短縮見出し）。
 */
const SUMMARY_HEADER = [
  '月',
  '月合計',
  '月経過率',
  '21日締め合計(実績)',
  '21日締め合計(予測)',
  '営業日数',
  '残営業日数',
  '21日締め経過率',
  '本日',
];

/**
 * 内部日付 "YYYY-MM-DD"（ゼロ埋め）を CSV 表記 "YYYY/M/D"（月日はゼロ埋め無し・年は4桁）へ変換する。
 * 期待書式に一致しない入力はそのまま返す（防御的挙動）。
 * @param {DateISO} iso 正規化日付
 * @returns {string} "YYYY/M/D" 形式の文字列
 */
function isoToSlash(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return String(iso ?? '');
  const year = match[1];
  const month = String(Number(match[2])); // 先頭ゼロを除去
  const day = String(Number(match[3]));
  return `${year}/${month}/${day}`;
}

/**
 * 時間値を常に小数第1位まで表記する。null/undefined/非数値は空文字にする。
 * @param {number|null|undefined} hours 時間値
 * @returns {string} "4.0" など、または空文字
 */
function formatHours(hours) {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) {
    return '';
  }
  return hours.toFixed(1);
}

/**
 * 経過率（%、0.0〜100.0）を小数第1位まで＋末尾 "%" で表記する。
 * null/undefined/非数値は空文字にする。
 * @param {number|null|undefined} rate 経過率（%）
 * @returns {string} "100.0%" など、または空文字
 */
function formatRate(rate) {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) {
    return '';
  }
  return `${rate.toFixed(1)}%`;
}

/**
 * 日数（営業日数・残営業日数）を整数としてそのまま文字列化する。
 * null/undefined/非数値は空文字にする。小数点は付けない。
 * @param {number|null|undefined} days 日数
 * @returns {string} "20" など、または空文字
 */
function formatDays(days) {
  if (days === null || days === undefined || !Number.isFinite(days)) {
    return '';
  }
  return String(days);
}

/**
 * 1 フィールドを CSV 用にエスケープする。
 * カンマ・二重引用符・改行（CR/LF）のいずれかを含む場合のみ二重引用符で囲み、
 * 内部の二重引用符は "" に倍化する（RFC 4180）。
 * @param {string|number|null|undefined} value フィールド値
 * @returns {string} エスケープ済みフィールド
 */
function escapeField(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * 1 行分の値配列を CSV 行文字列へ変換する（各フィールドをエスケープしてカンマ結合）。
 * @param {Array<string|number|null|undefined>} fields フィールド配列
 * @returns {string} CSV 1 行（改行なし）
 */
function toRow(fields) {
  return fields.map(escapeField).join(',');
}

/**
 * 日次エントリ集合を入力ツール互換の CSV 文字列へ書き出す（要件12.1, 12.3, 12.5・Property 30）。
 *
 * 出力仕様:
 * - 1 行目は固定ヘッダ `日付,曜日,実績,予測,備考`（5 列）。
 * - データ行は日付昇順（"YYYY-MM-DD" の文字列昇順＝暦日昇順。ゼロ埋めのため単純比較で正しい）。
 * - 日付は "YYYY/M/D" へ変換。曜日は entry.weekday をそのまま出力。
 * - 実績・予測は未入力（null）なら空セル、値があれば小数第1位まで（"4.0" 等）。
 * - 備考は空/未定義なら空セル、値があれば文字列。カンマ・引用符・改行を含む場合は CSV エスケープする。
 * - entries が空なら、ヘッダ行のみを出力しデータ行は含めない（要件12.5）。
 *
 * 行区切りは "\r\n"、末尾に改行は付けない。入力配列は破壊しない（コピーしてからソート）。
 * @param {DailyEntry[]} entries 日次エントリ集合
 * @returns {string} 入力ツール互換の CSV 文字列
 */
export function exportInputCsv(entries) {
  const lines = [toRow(INPUT_HEADER)];
  const list = Array.isArray(entries) ? entries.slice() : [];
  // "YYYY-MM-DD"（ゼロ埋め）は辞書順＝暦日昇順。localeCompare ではなく単純比較で決定的にソート。
  list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const entry of list) {
    lines.push(
      toRow([
        isoToSlash(entry.date),
        entry.weekday,
        formatHours(entry.actualHours),
        formatHours(entry.predictedHours),
        entry.note ? entry.note : '',
      ]),
    );
  }
  return lines.join('\r\n');
}

/**
 * 集計結果を集計ツール互換の CSV 文字列へ書き出す（要件12.2・Property 31）。
 *
 * 出力仕様:
 * - 1 行目は固定ヘッダ（列順は SUMMARY_HEADER のとおり）:
 *   `月,月合計,月経過率,21日締め合計(実績),21日締め合計(予測),営業日数,残営業日数,21日締め経過率,本日`
 * - 続いて summary.rows の各行（想定 12 か月分、4月〜翌3月）を、配列順のまま 1 行ずつ出力する:
 *   月="{month}月" / 月合計=monthlyTotal(小数1位) / 月経過率=monthProgressRate("%"付) /
 *   21日締め合計(実績)=cutoffActual / 21日締め合計(予測)=cutoffPredicted /
 *   営業日数=businessDays(整数) / 残営業日数=remainingBusinessDays(整数) /
 *   21日締め経過率=cutoffProgressRate("%"付) / 本日=（下記）。
 * - 「本日」列は summary.referenceDate を "YYYY/M/D" へ変換した値を **先頭行のみ** に出力し、
 *   2 行目以降は空にする（参照 CSV でも本日はヘッダ付近に 1 度だけ現れるため、先頭行で代表させる）。
 * - 末尾に合計行を 1 行付与する（参照 CSV の "合計" 行に相当）:
 *   月="合計" / 月合計=各行 monthlyTotal の総和(小数1位) /
 *   21日締め合計(実績)=summary.annualActualTotal / 21日締め合計(予測)=summary.annualPredictedTotal /
 *   月経過率・営業日数・残営業日数・21日締め経過率・本日 は意味を持たないため空セル。
 *
 * 行区切りは "\r\n"、末尾に改行は付けない。
 * @param {SummaryModel} summary 集計結果モデル
 * @returns {string} 集計ツール互換の CSV 文字列
 */
export function exportSummaryCsv(summary) {
  const lines = [toRow(SUMMARY_HEADER)];
  const rows = summary && Array.isArray(summary.rows) ? summary.rows : [];
  const referenceSlash = summary && summary.referenceDate ? isoToSlash(summary.referenceDate) : '';

  let monthlyTotalSum = 0;
  rows.forEach((row, index) => {
    if (Number.isFinite(row.monthlyTotal)) {
      monthlyTotalSum += row.monthlyTotal;
    }
    lines.push(
      toRow([
        `${row.month}月`,
        formatHours(row.monthlyTotal),
        formatRate(row.monthProgressRate),
        formatHours(row.cutoffActual),
        formatHours(row.cutoffPredicted),
        formatDays(row.businessDays),
        formatDays(row.remainingBusinessDays),
        formatRate(row.cutoffProgressRate),
        index === 0 ? referenceSlash : '',
      ]),
    );
  });

  // 合計行（参照 CSV の "合計" 行に相当）。意味を持たないセルは空にする。
  lines.push(
    toRow([
      '合計',
      formatHours(monthlyTotalSum),
      '',
      formatHours(summary ? summary.annualActualTotal : null),
      formatHours(summary ? summary.annualPredictedTotal : null),
      '',
      '',
      '',
      '',
    ]),
  );

  return lines.join('\r\n');
}
