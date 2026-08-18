// @ts-check
/**
 * Overtime Tracker - CSV_Importer テスト（Vitest + fast-check）
 *
 * 対象: src/core/csvImporter.js（importInputCsv）／ src/core/csvExporter.js（exportInputCsv）
 *
 * 本ファイルが担当するタスク（tasks.md）:
 *   - 13.3 Property 27: 入力CSVのラウンドトリップ（Validates: Requirements 12.4, 12.3, 11.3, 11.1）
 *   - 13.4 Property 28: 日付不正行のインポート拒否（Validates: Requirements 11.2）
 *   - 13.5 Property 29: セル値不正行のインポート拒否（Validates: Requirements 11.5, 11.6）
 *   - 13.8 ユニットテスト: CSV インポートの年度反映・上書き（Requirements 11.4）
 *
 * design.md「Correctness Properties」「ジェネレータ設計」に従い、各プロパティを
 * fast-check + Vitest で最低100回反復して検証する。
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { importInputCsv } from '../src/core/csvImporter.js';
import { exportInputCsv } from '../src/core/csvExporter.js';
import { fiscalYearDates, weekdayOf } from '../src/core/fiscalYear.js';

const RUNS = { numRuns: 100 };

/** 値の一致判定に用いる微小許容誤差（浮動小数点表現の遊び）。 */
const VALUE_EPSILON = 1e-9;

/** 入力ツール互換ヘッダ行（要件12.1）。 */
const INPUT_HEADER_LINE = '日付,曜日,実績,予測,備考';

/** 1/10 時間（tenths, 0〜149 = 0.0〜14.9）→ 時間値。null はそのまま。 */
function toHours(tenths) {
  return tenths === null ? null : tenths / 10;
}

/** {y,m,d} を正規化日付 "YYYY-MM-DD" にする。 */
function isoOf(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * 実績/予測の生成器。null（未入力）または 0.0〜14.9（0.1刻み）。
 * @returns {fc.Arbitrary<number|null>}
 */
function hoursArb() {
  return fc.option(fc.integer({ min: 0, max: 149 }).map(toHours), { nil: null, freq: 3 });
}

/**
 * 一意な日付を持つ DailyEntry 集合の生成器。
 * 日は 1〜28 に制限して常に実在させ、曜日は date から weekdayOf で導出する。
 * note は CR/LF を除いた任意文字列（カンマ・引用符を含みうる＝CSV エスケープ往復も検証）。
 * @returns {fc.Arbitrary<import('../src/core/types.js').DailyEntry[]>}
 */
function entriesArb(minLength = 0) {
  const rowArb = fc.record({
    y: fc.integer({ min: 2023, max: 2028 }),
    m: fc.integer({ min: 1, max: 12 }),
    d: fc.integer({ min: 1, max: 28 }),
    a: hoursArb(),
    p: hoursArb(),
    note: fc.string({ maxLength: 60 }).map((s) => s.replace(/[\r\n]/g, ' ')),
  });
  return fc.array(rowArb, { minLength, maxLength: 30 }).map((rows) => {
    const seen = new Set();
    /** @type {import('../src/core/types.js').DailyEntry[]} */
    const entries = [];
    for (const r of rows) {
      const date = isoOf(r.y, r.m, r.d);
      if (seen.has(date)) continue;
      seen.add(date);
      entries.push({
        date,
        weekday: weekdayOf(date),
        actualHours: r.a,
        predictedHours: r.p,
        note: r.note,
      });
    }
    return entries;
  });
}

/**
 * 一意な日付・単純な備考（カンマ・引用符・CR/LF を含まない）を持つ非空エントリ集合の生成器。
 * Property 28/29 では行を「,」で機械的に分割して1セルを差し替えるため、
 * セルにカンマや引用符が現れない単純な備考を用いる。
 * @returns {fc.Arbitrary<import('../src/core/types.js').DailyEntry[]>}
 */
function simpleEntriesArb() {
  const rowArb = fc.record({
    y: fc.integer({ min: 2023, max: 2028 }),
    m: fc.integer({ min: 1, max: 12 }),
    d: fc.integer({ min: 1, max: 28 }),
    a: hoursArb(),
    p: hoursArb(),
    note: fc.string({ maxLength: 20 }).map((s) => s.replace(/[",\r\n]/g, '')),
  });
  return fc.array(rowArb, { minLength: 1, maxLength: 20 }).map((rows) => {
    const seen = new Set();
    /** @type {import('../src/core/types.js').DailyEntry[]} */
    const entries = [];
    for (const r of rows) {
      const date = isoOf(r.y, r.m, r.d);
      if (seen.has(date)) continue;
      seen.add(date);
      entries.push({
        date,
        weekday: weekdayOf(date),
        actualHours: r.a,
        predictedHours: r.p,
        note: r.note,
      });
    }
    return entries;
  });
}

/** 期待する「日付昇順」の並び（"YYYY-MM-DD" 文字列昇順＝暦日昇順）。 */
function sortByDate(entries) {
  return entries.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** 実績/予測（number|null）の一致判定。 */
function hoursEqual(x, y) {
  if (x === null || y === null) return x === y;
  return Math.abs(x - y) <= VALUE_EPSILON;
}

describe('CSV_Importer - importInputCsv / exportInputCsv (properties)', () => {
  // Feature: overtime-tracker, Property 27: 入力CSVのラウンドトリップ
  // 任意の有効な日次エントリ集合について、exportInputCsv で書き出し importInputCsv で
  // 読み戻すと、全エントリの日付・曜日・実績・予測・備考が元と一致し、日付昇順が保持される。
  // 未入力（null）は空セルとして往復する。
  it('Property 27: 入力CSVのラウンドトリップ', () => {
    fc.assert(
      fc.property(entriesArb(0), (entries) => {
        const csv = exportInputCsv(entries);
        const result = importInputCsv(csv);
        if (!result.ok) {
          throw new Error(`round-trip import failed: ${result.reason}`);
        }
        const expected = sortByDate(entries);
        const got = result.entries;
        if (got.length !== expected.length) {
          throw new Error(`length mismatch: got ${got.length}, expected ${expected.length}`);
        }
        for (let i = 0; i < expected.length; i++) {
          const e = expected[i];
          const g = got[i];
          // 日付昇順の保持（隣接ペアが厳密昇順。日付は一意なので < で判定）。
          if (i > 0 && !(got[i - 1].date < g.date)) {
            throw new Error(`not ascending at ${i}: ${got[i - 1].date} !< ${g.date}`);
          }
          if (g.date !== e.date) throw new Error(`date mismatch at ${i}: ${g.date} vs ${e.date}`);
          if (g.weekday !== e.weekday) {
            throw new Error(`weekday mismatch at ${i}: ${g.weekday} vs ${e.weekday}`);
          }
          if (!hoursEqual(g.actualHours, e.actualHours)) {
            throw new Error(`actual mismatch at ${i}: ${g.actualHours} vs ${e.actualHours}`);
          }
          if (!hoursEqual(g.predictedHours, e.predictedHours)) {
            throw new Error(`predicted mismatch at ${i}: ${g.predictedHours} vs ${e.predictedHours}`);
          }
          if (g.note !== e.note) {
            throw new Error(`note mismatch at ${i}: ${JSON.stringify(g.note)} vs ${JSON.stringify(e.note)}`);
          }
        }
      }),
      RUNS,
    );
  });

  // Feature: overtime-tracker, Property 28: 日付不正行のインポート拒否
  // 任意の有効な入力 CSV について、任意の1データ行の日付を YYYY/M/D として解釈できない値に
  // 置換すると、importInputCsv は該当する行番号を伴うエラーを返し、取り込みを中止する。
  it('Property 28: 日付不正行のインポート拒否', () => {
    // parseSlashDate が必ず null を返す（＝解釈不能な）非空・カンマなしの日付文字列。
    const badDateArb = fc.constantFrom(
      'abc',
      'notadate',
      '2026/13/1',
      '2026/2/30',
      '1999-1-1',
      'xx/yy/zz',
      '2026//',
      '13/13/13',
    );
    const scenarioArb = simpleEntriesArb().chain((entries) =>
      fc.record({
        entries: fc.constant(entries),
        rowIdx: fc.integer({ min: 0, max: entries.length - 1 }),
        badDate: badDateArb,
      }),
    );
    fc.assert(
      fc.property(scenarioArb, ({ entries, rowIdx, badDate }) => {
        const csv = exportInputCsv(entries);
        const lines = csv.split('\r\n');
        // lines[0] はヘッダ。データ行 rowIdx は物理行 lines[rowIdx + 1]（＝行番号 rowIdx + 2）。
        const physicalLine = rowIdx + 1;
        const parts = lines[physicalLine].split(',');
        parts[0] = badDate; // 日付セルを不正値に置換
        lines[physicalLine] = parts.join(',');
        const corrupted = lines.join('\r\n');

        const result = importInputCsv(corrupted);
        if (result.ok) {
          throw new Error(`expected reject for bad date "${badDate}" at line ${physicalLine + 1}`);
        }
        if (result.lineNumber !== physicalLine + 1) {
          throw new Error(`lineNumber mismatch: got ${result.lineNumber}, expected ${physicalLine + 1}`);
        }
      }),
      RUNS,
    );
  });

  // Feature: overtime-tracker, Property 29: セル値不正行のインポート拒否
  // 任意の有効な入力 CSV について、任意の1データ行の実績または予測を、数値として解釈できない値、
  // または 0 未満もしくは 15.0 以上の値に置換すると、importInputCsv は該当する行番号を伴う
  // エラーを返し、取り込みを中止する。
  it('Property 29: セル値不正行のインポート拒否', () => {
    // parseHours が必ず拒否する（not_number / negative / too_large）非空・カンマなしの値。
    const badValueArb = fc.constantFrom('abc', 'xyz', '-1', '-0.5', '15', '15.0', '20', '99');
    const scenarioArb = simpleEntriesArb().chain((entries) =>
      fc.record({
        entries: fc.constant(entries),
        rowIdx: fc.integer({ min: 0, max: entries.length - 1 }),
        col: fc.constantFrom(2, 3), // 3列目=実績 / 4列目=予測（0始まりで 2 / 3）
        badValue: badValueArb,
      }),
    );
    fc.assert(
      fc.property(scenarioArb, ({ entries, rowIdx, col, badValue }) => {
        const csv = exportInputCsv(entries);
        const lines = csv.split('\r\n');
        const physicalLine = rowIdx + 1;
        const parts = lines[physicalLine].split(',');
        parts[col] = badValue; // 実績 or 予測セルを不正値に置換
        lines[physicalLine] = parts.join(',');
        const corrupted = lines.join('\r\n');

        const result = importInputCsv(corrupted);
        if (result.ok) {
          throw new Error(`expected reject for bad value "${badValue}" at line ${physicalLine + 1}`);
        }
        if (result.lineNumber !== physicalLine + 1) {
          throw new Error(`lineNumber mismatch: got ${result.lineNumber}, expected ${physicalLine + 1}`);
        }
      }),
      RUNS,
    );
  });
});

describe('CSV_Importer - 年度反映・上書き（Requirement 11.4, unit）', () => {
  /**
   * 取り込んだ日次エントリを、その日付が属する年度（FiscalYearState）へ反映する（要件11.4）。
   * 年度の帰属は fiscalYearDates（実装関数）に日付が含まれるかで判定し、同一日付の既存エントリが
   * あれば上書きする。この反映はドメイン層ではなく呼び出し側（UI層）の責務であり、本テストは
   * その仕様を例示的に検証する（design.md の 11.4 例示テスト分類に対応）。
   * @param {import('../src/core/types.js').FiscalYearState[]} fiscalYears
   * @param {import('../src/core/types.js').DailyEntry[]} imported
   */
  function reflectImportedEntries(fiscalYears, imported) {
    for (const entry of imported) {
      const target = fiscalYears.find((fy) => fiscalYearDates(fy.startYear).includes(entry.date));
      if (!target) continue; // どの年度にも属さない日付は対象外
      const idx = target.entries.findIndex((e) => e.date === entry.date);
      if (idx >= 0) {
        target.entries[idx] = entry; // 同一日付を上書き
      } else {
        target.entries.push(entry);
      }
    }
  }

  /** startYear 年度の全日付を null 値で初期化した FiscalYearState を作る。 */
  function makeFiscalYearState(startYear) {
    return {
      startYear,
      entries: fiscalYearDates(startYear).map((date) => ({
        date,
        weekday: weekdayOf(date),
        actualHours: null,
        predictedHours: null,
        note: '',
      })),
    };
  }

  /** 年度状態から特定日付のエントリを取り出す。 */
  function entryOf(fy, date) {
    return fy.entries.find((e) => e.date === date);
  }

  it('取り込んだエントリが日付の属する年度に反映され、同一日付の既存エントリを上書きする', () => {
    // 年度2025（2025-04-01〜2026-03-31）と 年度2026（2026-04-01〜2027-03-31）。
    const fy2025 = makeFiscalYearState(2025);
    const fy2026 = makeFiscalYearState(2026);

    // 既存値を仕込む（上書き対象を明確化）。
    entryOf(fy2025, '2025-05-01').actualHours = 9.0;
    entryOf(fy2025, '2025-05-01').note = '旧データ';
    entryOf(fy2026, '2026-06-15').actualHours = 1.0;

    // 帰属の前提確認（fiscalYearDates による年度判定）。
    expect(fiscalYearDates(2025).includes('2025-05-01')).toBe(true);
    expect(fiscalYearDates(2025).includes('2026-02-10')).toBe(true); // 翌暦年でも年度2025に属する
    expect(fiscalYearDates(2026).includes('2026-06-15')).toBe(true);

    // 入力ツール形式 CSV（年度2025 に2件、年度2026 に1件）。
    const csv = [
      INPUT_HEADER_LINE,
      '2025/5/1,,3.0,,新データ',
      '2026/2/10,,2.0,,',
      '2026/6/15,,4.0,,',
    ].join('\r\n');

    const result = importInputCsv(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) return; // 型絞り込み

    reflectImportedEntries([fy2025, fy2026], result.entries);

    // 年度2025: 既存 2025-05-01 が上書きされる。
    const overwritten = entryOf(fy2025, '2025-05-01');
    expect(overwritten.actualHours).toBeCloseTo(3.0, 6);
    expect(overwritten.note).toBe('新データ');

    // 年度2025: 翌暦年の 2026-02-10 も年度2025へ反映される。
    expect(entryOf(fy2025, '2026-02-10').actualHours).toBeCloseTo(2.0, 6);

    // 年度2026: 2026-06-15 が上書きされる（1.0 → 4.0）。
    expect(entryOf(fy2026, '2026-06-15').actualHours).toBeCloseTo(4.0, 6);

    // 反映されなかった他の日付は未入力のまま。
    expect(entryOf(fy2025, '2025-04-01').actualHours).toBeNull();
    expect(entryOf(fy2026, '2027-03-31').actualHours).toBeNull();
  });
});
