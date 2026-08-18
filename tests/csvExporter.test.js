// @ts-check
/**
 * Overtime Tracker - CSV_Exporter プロパティテスト（Vitest + fast-check）
 *
 * 対象: src/core/csvExporter.js（exportInputCsv / exportSummaryCsv）
 *
 * 本ファイルが担当するタスク（tasks.md）:
 *   - 13.6 Property 30: 入力CSVの構造（Validates: Requirements 12.1, 12.5）
 *   - 13.7 Property 31: 集計CSVの構造（Validates: Requirements 12.2）
 *
 * design.md「Correctness Properties」「ジェネレータ設計」に従い、各プロパティを
 * fast-check + Vitest で最低100回反復して検証する。
 */
import { describe, it } from 'vitest';
import fc from 'fast-check';
import { exportInputCsv, exportSummaryCsv } from '../src/core/csvExporter.js';
import { fiscalYearMonths, weekdayOf } from '../src/core/fiscalYear.js';

const RUNS = { numRuns: 100 };

/** 入力ツール互換ヘッダ列（要件12.1）。 */
const INPUT_HEADER = ['日付', '曜日', '実績', '予測', '備考'];

/** 集計ツール互換ヘッダ列（要件12.2）。列順は仕様どおり固定。 */
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

/** 1/10 時間（tenths, 0〜149）→ 時間値。null はそのまま。 */
function toHours(tenths) {
  return tenths === null ? null : tenths / 10;
}

/** {y,m,d} を正規化日付 "YYYY-MM-DD" にする。 */
function isoOf(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** CSV 表記 "YYYY/M/D" を比較用の "YYYY-MM-DD"（ゼロ埋め）へ戻す。 */
function slashToIso(slash) {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(slash);
  if (!m) return slash;
  return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
}

/**
 * 実績/予測の生成器。null（未入力）または 0.0〜14.9（0.1刻み）。
 * @returns {fc.Arbitrary<number|null>}
 */
function hoursArb() {
  return fc.option(fc.integer({ min: 0, max: 149 }).map(toHours), { nil: null, freq: 3 });
}

/**
 * 日次エントリ集合の生成器（Property 30 用）。
 * 列数を「,」分割で数えられるよう、備考はカンマ・引用符・CR/LF を含まない単純文字列にする。
 * 日は 1〜28 に制限して実在させ、曜日は date から導出する。日付の重複は許容する（構造検証のため）。
 * @returns {fc.Arbitrary<import('../src/core/types.js').DailyEntry[]>}
 */
function entriesArb() {
  const rowArb = fc.record({
    y: fc.integer({ min: 2023, max: 2028 }),
    m: fc.integer({ min: 1, max: 12 }),
    d: fc.integer({ min: 1, max: 28 }),
    a: hoursArb(),
    p: hoursArb(),
    note: fc.string({ maxLength: 20 }).map((s) => s.replace(/[",\r\n]/g, '')),
  });
  return fc.array(rowArb, { minLength: 0, maxLength: 30 }).map((rows) =>
    rows.map((r) => {
      const date = isoOf(r.y, r.m, r.d);
      return {
        date,
        weekday: weekdayOf(date),
        actualHours: r.a,
        predictedHours: r.p,
        note: r.note,
      };
    }),
  );
}

/**
 * SummaryModel の生成器（Property 31 用）。rows は 4月〜翌3月の 12 か月分。
 * @returns {fc.Arbitrary<import('../src/core/types.js').SummaryModel>}
 */
function summaryArb() {
  const rateArb = fc.double({ min: 0, max: 100, noNaN: true });
  const hourArb = fc.double({ min: 0, max: 200, noNaN: true });
  const dayArb = fc.integer({ min: 0, max: 23 });
  return fc
    .record({
      startYear: fc.integer({ min: 2020, max: 2030 }),
      refM: fc.integer({ min: 1, max: 12 }),
      refD: fc.integer({ min: 1, max: 28 }),
      annualActualTotal: hourArb,
      annualPredictedTotal: hourArb,
      rowSeeds: fc.array(
        fc.record({
          monthlyTotal: hourArb,
          monthProgressRate: rateArb,
          cutoffActual: hourArb,
          cutoffPredicted: hourArb,
          businessDays: dayArb,
          remainingBusinessDays: dayArb,
          cutoffProgressRate: rateArb,
        }),
        { minLength: 12, maxLength: 12 },
      ),
    })
    .map(({ startYear, refM, refD, annualActualTotal, annualPredictedTotal, rowSeeds }) => {
      const months = fiscalYearMonths(startYear); // 12件（4月〜翌3月）
      const rows = months.map((ym, i) => ({ month: ym.month, ...rowSeeds[i] }));
      return {
        rows,
        referenceDate: isoOf(startYear, refM, refD),
        annualActualTotal,
        annualPredictedTotal,
      };
    });
}

describe('CSV_Exporter - exportInputCsv / exportSummaryCsv (properties)', () => {
  // Feature: overtime-tracker, Property 30: 入力CSVの構造
  // 任意の日次エントリ集合について、exportInputCsv の出力は入力ツール互換ヘッダ行
  // （日付・曜日・実績・予測・備考）で始まり、各データ行は 5 列を持ち、データ行は日付昇順である。
  // 出力対象が空ならヘッダ行のみとなる。
  it('Property 30: 入力CSVの構造', () => {
    fc.assert(
      fc.property(entriesArb(), (entries) => {
        const csv = exportInputCsv(entries);
        const lines = csv.split('\r\n');

        // 1 行目は固定ヘッダ（要件12.1）。
        if (lines[0] !== INPUT_HEADER.join(',')) {
          throw new Error(`header mismatch: ${JSON.stringify(lines[0])}`);
        }

        // 出力対象が空ならヘッダ行のみ（要件12.5）。
        if (entries.length === 0) {
          if (lines.length !== 1) {
            throw new Error(`empty entries should yield header-only, got ${lines.length} lines`);
          }
          return;
        }

        // データ行数はエントリ数と一致する。
        const dataLines = lines.slice(1);
        if (dataLines.length !== entries.length) {
          throw new Error(`data line count ${dataLines.length} !== entries ${entries.length}`);
        }

        let prevIso = null;
        for (const line of dataLines) {
          const cells = line.split(',');
          // 各データ行は 5 列（備考にカンマを含めない生成器のため単純分割で判定可能）。
          if (cells.length !== 5) {
            throw new Error(`row does not have 5 columns: ${JSON.stringify(line)} -> ${cells.length}`);
          }
          // 日付昇順（"YYYY-MM-DD" 比較で非減少）。
          const iso = slashToIso(cells[0]);
          if (prevIso !== null && !(prevIso <= iso)) {
            throw new Error(`data rows not ascending: ${prevIso} > ${iso}`);
          }
          prevIso = iso;
        }
      }),
      RUNS,
    );
  });

  // Feature: overtime-tracker, Property 31: 集計CSVの構造
  // 任意の SummaryModel について、exportSummaryCsv の出力は集計ツール互換ヘッダを規定の列順で含み、
  // 12 か月分の行と合計行を持つ。
  it('Property 31: 集計CSVの構造', () => {
    fc.assert(
      fc.property(summaryArb(), (summary) => {
        const csv = exportSummaryCsv(summary);
        const lines = csv.split('\r\n');

        // 1 行目は集計ツール互換ヘッダ（規定の列順・要件12.2）。
        if (lines[0] !== SUMMARY_HEADER.join(',')) {
          throw new Error(`summary header mismatch: ${JSON.stringify(lines[0])}`);
        }
        // ヘッダ列を個別に列順検証する。
        const headerCells = lines[0].split(',');
        if (headerCells.length !== SUMMARY_HEADER.length) {
          throw new Error(`header column count ${headerCells.length} !== ${SUMMARY_HEADER.length}`);
        }
        for (let i = 0; i < SUMMARY_HEADER.length; i++) {
          if (headerCells[i] !== SUMMARY_HEADER[i]) {
            throw new Error(`header column ${i} mismatch: ${headerCells[i]} vs ${SUMMARY_HEADER[i]}`);
          }
        }

        // 行構成: ヘッダ(1) + 12 か月分 + 合計行(1) = 14 行。
        if (lines.length !== 1 + 12 + 1) {
          throw new Error(`expected 14 lines, got ${lines.length}`);
        }

        // 各行は 9 列。
        for (const line of lines) {
          const cells = line.split(',');
          if (cells.length !== SUMMARY_HEADER.length) {
            throw new Error(`row column count ${cells.length} !== ${SUMMARY_HEADER.length}: ${JSON.stringify(line)}`);
          }
        }

        // 12 か月分の行（先頭セルは "{month}月"）と、末尾の合計行（先頭セル "合計"）。
        for (let i = 0; i < 12; i++) {
          const first = lines[i + 1].split(',')[0];
          const expected = `${summary.rows[i].month}月`;
          if (first !== expected) {
            throw new Error(`month row ${i} first cell ${first} vs ${expected}`);
          }
        }
        const totalFirst = lines[13].split(',')[0];
        if (totalFirst !== '合計') {
          throw new Error(`total row first cell should be 合計, got ${totalFirst}`);
        }
      }),
      RUNS,
    );
  });
});
