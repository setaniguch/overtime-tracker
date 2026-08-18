// @ts-check
/**
 * Overtime Tracker - Aggregator プロパティテスト（Vitest + fast-check）
 *
 * 対象: src/core/aggregator.js
 *   - effectiveHours（対象残業時間の選択）
 *   - monthlyTotal / allMonthlyTotals（月合計・年度12か月網羅）
 *   - annualActualTotal / annualPredictedTotal（年間合計）
 *
 * 期待値は本テスト内で独立に（整数の 1/10 時間単位で）算出し、浮動小数点誤差を避ける。
 * 比較は 1/10 時間精度で行う（toBeCloseTo）。
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  effectiveHours,
  monthlyTotal,
  allMonthlyTotals,
  annualActualTotal,
  annualPredictedTotal,
} from '../src/core/aggregator.js';
import { fiscalYearDates, fiscalYearMonths } from '../src/core/fiscalYear.js';

const RUNS = { numRuns: 100 };

/**
 * 残業時間を「1/10 時間（tenths）」で生成する。null または 0〜149（=0.0〜14.9）。
 * @returns {fc.Arbitrary<number|null>}
 */
function tenthsArb() {
  return fc.option(fc.integer({ min: 0, max: 149 }), { nil: null, freq: 4 });
}

/** tenths → 時間値（0.1刻み）。null はそのまま。 */
function toHours(tenths) {
  return tenths === null ? null : tenths / 10;
}

/** 任意の妥当な "YYYY-MM-DD"（day は 1〜28 に制限して常に実在させる）。 */
function isoDateArb() {
  return fc
    .record({
      y: fc.integer({ min: 2020, max: 2030 }),
      m: fc.integer({ min: 1, max: 12 }),
      d: fc.integer({ min: 1, max: 28 }),
    })
    .map(
      ({ y, m, d }) =>
        `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    );
}

/**
 * 年度（startYear の4/1〜翌3/31）内の日付を持つ DailyEntry と、
 * 年度外のノイズエントリを混在させた集合を生成する。
 * @returns {fc.Arbitrary<{ startYear: number, entries: import('../src/core/types.js').DailyEntry[], referenceDate: string }>}
 */
function scenarioArb() {
  return fc
    .integer({ min: 2024, max: 2027 })
    .chain((startYear) => {
      const fyDates = fiscalYearDates(startYear);
      // 年度内エントリ: 年度の実在日から index で選ぶ。
      const inFyEntryArb = fc.record({
        idx: fc.integer({ min: 0, max: fyDates.length - 1 }),
        a: tenthsArb(),
        p: tenthsArb(),
      });
      // 年度外ノイズ: 4月より前（1〜3月 startYear）や翌年度以降。
      const noiseDateArb = fc.oneof(
        fc.integer({ min: 1, max: 3 }).map(
          (m) => `${String(startYear).padStart(4, '0')}-${String(m).padStart(2, '0')}-15`,
        ),
        fc.integer({ min: 4, max: 12 }).map(
          (m) => `${String(startYear + 1).padStart(4, '0')}-${String(m).padStart(2, '0')}-15`,
        ),
      );
      const noiseEntryArb = fc.record({
        date: noiseDateArb,
        a: tenthsArb(),
        p: tenthsArb(),
      });
      return fc.record({
        startYear: fc.constant(startYear),
        inFy: fc.array(inFyEntryArb, { maxLength: 40 }),
        noise: fc.array(noiseEntryArb, { maxLength: 10 }),
        referenceDate: isoDateArb(),
      }).map(({ startYear: sy, inFy, noise, referenceDate }) => {
        /** @type {import('../src/core/types.js').DailyEntry[]} */
        const entries = [];
        for (const e of inFy) {
          entries.push({
            date: fyDates[e.idx],
            weekday: '月',
            actualHours: toHours(e.a),
            predictedHours: toHours(e.p),
            note: '',
          });
        }
        for (const e of noise) {
          entries.push({
            date: e.date,
            weekday: '月',
            actualHours: toHours(e.a),
            predictedHours: toHours(e.p),
            note: '',
          });
        }
        return { startYear: sy, entries, referenceDate };
      });
    });
}

/** 独立実装: entry と基準日から対象時間の tenths を返す（null は null）。 */
function expectedEffectiveTenths(dateStr, aTenths, pTenths, referenceDate) {
  return dateStr <= referenceDate ? aTenths : pTenths;
}

describe('Aggregator - property based tests', () => {
  // Feature: overtime-tracker, Property 11: 対象残業時間の選択（基準日以前は実績、基準日より後は予測。採用列が null なら null）
  it('Property 11: effectiveHours selects actual on/before referenceDate and predicted after, propagating null', () => {
    fc.assert(
      fc.property(
        isoDateArb(),
        isoDateArb(),
        tenthsArb(),
        tenthsArb(),
        (date, referenceDate, aTenths, pTenths) => {
          const entry = {
            date,
            weekday: '月',
            actualHours: toHours(aTenths),
            predictedHours: toHours(pTenths),
            note: '',
          };
          const result = effectiveHours(entry, referenceDate);
          if (date <= referenceDate) {
            expect(result).toBe(entry.actualHours);
          } else {
            expect(result).toBe(entry.predictedHours);
          }
        },
      ),
      RUNS,
    );
  });

  // Feature: overtime-tracker, Property 12: 月合計の集計（当月各日の対象時間を null 除外で合算し小数第1位に丸めた値に等しい）
  it('Property 12: monthlyTotal equals the null-excluded sum of effectiveHours over that month, rounded to one decimal', () => {
    fc.assert(
      fc.property(scenarioArb(), ({ startYear, entries, referenceDate }) => {
        for (const { year, month } of fiscalYearMonths(startYear)) {
          const prefix = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-`;
          let expectedTenths = 0;
          for (const e of entries) {
            if (!e.date.startsWith(prefix)) continue;
            const aTenths = e.actualHours === null ? null : Math.round(e.actualHours * 10);
            const pTenths = e.predictedHours === null ? null : Math.round(e.predictedHours * 10);
            const eff = expectedEffectiveTenths(e.date, aTenths, pTenths, referenceDate);
            if (eff === null) continue;
            expectedTenths += eff;
          }
          const expected = expectedTenths / 10;
          const actual = monthlyTotal(entries, year, month, referenceDate);
          expect(actual).toBeCloseTo(expected, 5);
        }
      }),
      RUNS,
    );
  });

  // Feature: overtime-tracker, Property 13: 年度は12か月を網羅（allMonthlyTotals は4月〜翌3月のちょうど12件を返す）
  it('Property 13: allMonthlyTotals returns exactly 12 entries covering April..next March', () => {
    fc.assert(
      fc.property(scenarioArb(), ({ startYear, entries, referenceDate }) => {
        const result = allMonthlyTotals(entries, startYear, referenceDate);
        expect(result.length).toBe(12);
        const expectedMonths = fiscalYearMonths(startYear);
        for (let i = 0; i < 12; i++) {
          expect(result[i].year).toBe(expectedMonths[i].year);
          expect(result[i].month).toBe(expectedMonths[i].month);
        }
      }),
      RUNS,
    );
  });

  // Feature: overtime-tracker, Property 19: 年間合計の集計（年間実績=年度内 actualHours の null 除外合計、年間予測=年度内 predictedHours の null 除外合計）
  it('Property 19: annualActualTotal/annualPredictedTotal equal fiscal-year null-excluded sums of actual/predicted', () => {
    fc.assert(
      fc.property(scenarioArb(), ({ startYear, entries }) => {
        const start = `${String(startYear).padStart(4, '0')}-04-01`;
        const end = `${String(startYear + 1).padStart(4, '0')}-03-31`;
        let actualTenths = 0;
        let predictedTenths = 0;
        for (const e of entries) {
          if (e.date < start || e.date > end) continue;
          if (e.actualHours !== null) actualTenths += Math.round(e.actualHours * 10);
          if (e.predictedHours !== null) predictedTenths += Math.round(e.predictedHours * 10);
        }
        expect(annualActualTotal(entries, startYear)).toBeCloseTo(actualTenths / 10, 5);
        expect(annualPredictedTotal(entries, startYear)).toBeCloseTo(predictedTenths / 10, 5);
      }),
      RUNS,
    );
  });
});
