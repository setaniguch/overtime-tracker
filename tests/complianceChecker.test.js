// @ts-check
/**
 * Overtime Tracker - Compliance_Checker プロパティテスト（Vitest + fast-check）
 *
 * 対象: src/core/complianceChecker.js
 *   - evaluateCompliance(monthlyTotals, cutoffYearTotal)
 *
 * 併せて、締め年度合計の集計定義（要件10.2）を、本番の合成部品
 *   - effectiveHours（src/core/aggregator.js）
 *   - cutoffYearPeriod（src/core/fiscalYear.js）
 * で検証する（複合合計を数値として受け取る evaluateCompliance の入力定義そのもの）。
 *
 * 判定規則（design.md の Compliance_Checker 仕様、要件9・10より）:
 *   OVER_45(>45.0)、OVER_45_COUNT(超過月>=7)、CONSECUTIVE_45(暦月連続2か月>45.0)、
 *   ADJUST_TO_55(>45.0 かつ <55.0)、OVER_69(>69.0)、
 *   CUTOFF_YEAR_360(>360.0 かつ <=690.0)、CUTOFF_YEAR_690(>690.0)。
 *
 * 期待値は 1/10 時間（tenths, 整数）で独立に算出し、浮動小数点誤差を避ける。
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { evaluateCompliance } from '../src/core/complianceChecker.js';
import { effectiveHours } from '../src/core/aggregator.js';
import { cutoffYearPeriod } from '../src/core/fiscalYear.js';

const RUNS = { numRuns: 100 };

/** 閾値（時間）。tenths 換算: 45.0=450, 55.0=550, 69.0=690, 360.0=3600, 690.0=6900。 */
const LIMIT_45 = 45.0;
const ADJUST_UPPER = 55.0;
const LIMIT_69 = 69.0;
const CUTOFF_NORMAL = 360.0;
const CUTOFF_SPECIAL = 690.0;

/** 年月を通し番号へ写像（連続性判定・昇順比較用）。 */
function monthIndex(ym) {
  return ym.year * 12 + ym.month;
}

/** 年月をキー文字列にする。 */
function monthKey(ym) {
  return `${ym.year}-${ym.month}`;
}

/** 2桁ゼロ埋め。 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 年月日から "YYYY-MM-DD"（ゼロ埋め）を生成する。 */
function toISO(y, m, d) {
  return `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
}

/**
 * 年度の12か月（4月〜翌3月）を独立に算出する（本番 fiscalYearMonths に依存しない）。
 * @param {number} startYear
 * @returns {{year:number, month:number}[]}
 */
function fiscalMonths(startYear) {
  const months = [];
  for (let i = 0; i < 12; i++) {
    const m = 4 + i;
    if (m <= 12) months.push({ year: startYear, month: m });
    else months.push({ year: startYear + 1, month: m - 12 });
  }
  return months;
}

/**
 * 月合計（時間）の生成器。境界（45.0/55.0/69.0）近傍を厚めに含めるため tenths で生成する。
 * 0.0〜80.0（0〜800 tenths）。
 * @returns {fc.Arbitrary<number>}
 */
const monthTotalHoursArb = fc
  .oneof(
    { weight: 3, arbitrary: fc.integer({ min: 0, max: 800 }) },
    { weight: 2, arbitrary: fc.constantFrom(449, 450, 451, 549, 550, 551, 689, 690, 691) },
  )
  .map((tenths) => tenths / 10);

/**
 * 年度に対応する MonthlyTotal 集合の生成器。
 * 各月について「含めるか」と「月合計」を選び、含める月のみを昇順で返す（欠落＝ギャップを許す）。
 * @returns {fc.Arbitrary<{ startYear:number, totals: {year:number,month:number,total:number}[] }>}
 */
function monthlyTotalsArb() {
  return fc.integer({ min: 2000, max: 2100 }).chain((startYear) => {
    const months = fiscalMonths(startYear);
    const perMonth = months.map(() =>
      fc.record({ include: fc.boolean(), total: monthTotalHoursArb }),
    );
    return fc.tuple(...perMonth).map((choices) => {
      /** @type {{year:number,month:number,total:number}[]} */
      const totals = [];
      choices.forEach((c, i) => {
        if (c.include) totals.push({ year: months[i].year, month: months[i].month, total: c.total });
      });
      return { startYear, totals };
    });
  });
}

/** 締め年度合計に無関係な固定値（月警告テストで cutoff 警告を出さない）。 */
const NO_CUTOFF_WARNING_TOTAL = 0;

describe('Compliance_Checker - property based tests', () => {
  // Feature: overtime-tracker, Property 20: 45時間超過月の判定
  // Validates: Requirements 9.1, 9.5
  it('Property 20: OVER_45 months equal exactly the months whose total exceeds 45.0; months <= 45.0 carry no 45h-related warning', () => {
    fc.assert(
      fc.property(monthlyTotalsArb(), ({ totals }) => {
        const warnings = evaluateCompliance(totals, NO_CUTOFF_WARNING_TOTAL);

        // OVER_45 の対象月集合は total > 45.0 の月集合に厳密一致する（要件9.1）。
        const expectedOver45 = new Set(
          totals.filter((t) => t.total > LIMIT_45).map(monthKey),
        );
        const actualOver45 = new Set(
          warnings.filter((w) => w.code === 'OVER_45').map((w) => monthKey(w.months[0])),
        );
        expect(actualOver45).toEqual(expectedOver45);

        // 月合計が 45.0 以下の月には 45時間系の警告が一切付かない（要件9.5）。
        const fortyFiveRelated = new Set(['OVER_45', 'ADJUST_TO_55', 'OVER_69', 'CONSECUTIVE_45']);
        const totalByKey = new Map(totals.map((t) => [monthKey(t), t.total]));
        for (const w of warnings) {
          if (!fortyFiveRelated.has(w.code)) continue;
          for (const m of w.months ?? []) {
            expect(totalByKey.get(monthKey(m))).toBeGreaterThan(LIMIT_45);
          }
        }
      }),
      RUNS,
    );
  });

  // Feature: overtime-tracker, Property 21: 45時間超過回数の上限警告
  // Validates: Requirements 9.2
  it('Property 21: OVER_45_COUNT warning is present iff the number of months over 45.0 is >= 7', () => {
    fc.assert(
      fc.property(monthlyTotalsArb(), ({ totals }) => {
        const warnings = evaluateCompliance(totals, NO_CUTOFF_WARNING_TOTAL);
        const over45Count = totals.filter((t) => t.total > LIMIT_45).length;
        const hasCountWarning = warnings.some((w) => w.code === 'OVER_45_COUNT');
        expect(hasCountWarning).toBe(over45Count >= 7);
        if (hasCountWarning) {
          const w = warnings.find((x) => x.code === 'OVER_45_COUNT');
          expect(w.value).toBe(over45Count);
        }
      }),
      RUNS,
    );
  });

  // Feature: overtime-tracker, Property 22: 連続超過の判定
  // Validates: Requirements 9.3
  it('Property 22: CONSECUTIVE_45 pairs equal exactly the calendar-consecutive month pairs both exceeding 45.0', () => {
    fc.assert(
      fc.property(monthlyTotalsArb(), ({ totals }) => {
        const warnings = evaluateCompliance(totals, NO_CUTOFF_WARNING_TOTAL);

        // 独立算出: 通し番号で昇順に並べ、差が1の隣接ペアがともに >45.0 か判定する。
        const sorted = [...totals].sort((a, b) => monthIndex(a) - monthIndex(b));
        const expectedPairs = new Set();
        for (let i = 0; i + 1 < sorted.length; i++) {
          const cur = sorted[i];
          const next = sorted[i + 1];
          if (
            monthIndex(next) - monthIndex(cur) === 1 &&
            cur.total > LIMIT_45 &&
            next.total > LIMIT_45
          ) {
            expectedPairs.add(`${monthIndex(cur)}|${monthIndex(next)}`);
          }
        }

        const actualPairs = new Set(
          warnings
            .filter((w) => w.code === 'CONSECUTIVE_45')
            .map((w) => `${monthIndex(w.months[0])}|${monthIndex(w.months[1])}`),
        );
        expect(actualPairs).toEqual(expectedPairs);
      }),
      RUNS,
    );
  });

  // Feature: overtime-tracker, Property 23: 55時間への調整警告
  // Validates: Requirements 9.4
  it('Property 23: ADJUST_TO_55 is generated for a month iff its total is > 45.0 and < 55.0', () => {
    fc.assert(
      fc.property(monthlyTotalsArb(), ({ totals }) => {
        const warnings = evaluateCompliance(totals, NO_CUTOFF_WARNING_TOTAL);
        const expected = new Set(
          totals.filter((t) => t.total > LIMIT_45 && t.total < ADJUST_UPPER).map(monthKey),
        );
        const actual = new Set(
          warnings.filter((w) => w.code === 'ADJUST_TO_55').map((w) => monthKey(w.months[0])),
        );
        expect(actual).toEqual(expected);
      }),
      RUNS,
    );
  });

  // Feature: overtime-tracker, Property 24: 69時間超過の重大警告
  // Validates: Requirements 10.1
  it('Property 24: OVER_69 critical warning is generated for a month iff its total exceeds 69.0', () => {
    fc.assert(
      fc.property(monthlyTotalsArb(), ({ totals }) => {
        const warnings = evaluateCompliance(totals, NO_CUTOFF_WARNING_TOTAL);
        const expected = new Set(totals.filter((t) => t.total > LIMIT_69).map(monthKey));
        const actual = new Set(
          warnings.filter((w) => w.code === 'OVER_69').map((w) => monthKey(w.months[0])),
        );
        expect(actual).toEqual(expected);
      }),
      RUNS,
    );
  });

  // Feature: overtime-tracker, Property 25: 締め年度合計の集計
  // Validates: Requirements 10.2
  it('Property 25: cutoff-year total equals the sum of effectiveHours over the cutoff-year period (3/21..next 3/20)', () => {
    // 締め境界（3/20・3/21）付近を厚めに含む日を生成する。
    const dayArb = fc.oneof(
      { weight: 2, arbitrary: fc.constantFrom(18, 19, 20, 21, 22, 23) },
      { weight: 3, arbitrary: fc.integer({ min: 1, max: 28 }) },
    );
    const tenthsOrNull = fc.oneof(
      { weight: 1, arbitrary: fc.constant(null) },
      { weight: 4, arbitrary: fc.integer({ min: 0, max: 149 }) },
    );
    const rawEntryArb = fc.record({
      yearOffset: fc.constantFrom(-1, 0, 1), // startYear-1 / startYear / startYear+1
      month: fc.integer({ min: 1, max: 12 }),
      day: dayArb,
      aTenths: tenthsOrNull,
      pTenths: tenthsOrNull,
    });

    fc.assert(
      fc.property(
        fc.integer({ min: 2020, max: 2029 }),
        fc.array(rawEntryArb, { maxLength: 60 }),
        fc.record({
          y: fc.integer({ min: 2020, max: 2031 }),
          m: fc.integer({ min: 1, max: 12 }),
          d: fc.integer({ min: 1, max: 28 }),
        }),
        (startYear, rawEntries, refParts) => {
          const referenceDate = toISO(refParts.y, refParts.m, refParts.d);

          // 生エントリを DailyEntry と、独立検算用の raw に展開する。
          const entries = rawEntries.map((r) => {
            const y = startYear + r.yearOffset;
            return {
              date: toISO(y, r.month, r.day),
              weekday: '月',
              actualHours: r.aTenths === null ? null : r.aTenths / 10,
              predictedHours: r.pTenths === null ? null : r.pTenths / 10,
              aTenths: r.aTenths,
              pTenths: r.pTenths,
            };
          });

          // SUT: 本番 cutoffYearPeriod + effectiveHours を合成した締め年度合計（tenths）。
          const { start, end } = cutoffYearPeriod(startYear);
          let sutTenths = 0;
          for (const e of entries) {
            if (e.date < start || e.date > end) continue;
            const h = effectiveHours(e, referenceDate);
            if (h === null) continue;
            sutTenths += Math.round(h * 10);
          }

          // 独立算出: 締め年度期間（3/21〜翌3/20）を独立に定め、effectiveHours 定義を再現する。
          const expStart = toISO(startYear, 3, 21);
          const expEnd = toISO(startYear + 1, 3, 20);
          let expTenths = 0;
          for (const e of entries) {
            if (e.date < expStart || e.date > expEnd) continue;
            const eff = e.date <= referenceDate ? e.aTenths : e.pTenths;
            if (eff === null) continue;
            expTenths += eff;
          }

          expect(sutTenths).toBe(expTenths);
        },
      ),
      RUNS,
    );
  });

  // Feature: overtime-tracker, Property 26: 締め年度上限の閾値分類
  // Validates: Requirements 10.3, 10.4, 10.5
  it('Property 26: cutoff-year threshold classification (<=360 none; 360<x<=690 only CUTOFF_YEAR_360; >690 CUTOFF_YEAR_690)', () => {
    // 締め年度合計（時間）を境界（360.0/690.0）近傍を厚めに含めて生成する。
    const cutoffTotalArb = fc
      .oneof(
        { weight: 3, arbitrary: fc.integer({ min: 0, max: 8000 }) },
        { weight: 2, arbitrary: fc.constantFrom(3599, 3600, 3601, 6899, 6900, 6901) },
      )
      .map((tenths) => tenths / 10);

    fc.assert(
      fc.property(cutoffTotalArb, (cutoffYearTotal) => {
        // 月合計を空にして cutoff 系警告のみを対象にする。
        const warnings = evaluateCompliance([], cutoffYearTotal);
        const has360 = warnings.some((w) => w.code === 'CUTOFF_YEAR_360');
        const has690 = warnings.some((w) => w.code === 'CUTOFF_YEAR_690');

        if (cutoffYearTotal <= CUTOFF_NORMAL) {
          expect(has360).toBe(false);
          expect(has690).toBe(false);
        } else if (cutoffYearTotal <= CUTOFF_SPECIAL) {
          expect(has360).toBe(true);
          expect(has690).toBe(false);
        } else {
          expect(has360).toBe(false);
          expect(has690).toBe(true);
        }
      }),
      RUNS,
    );
  });
});
