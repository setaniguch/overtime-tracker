// @ts-check
/**
 * Overtime Tracker - Cutoff_Aggregator プロパティテスト
 *
 * 対象: src/core/cutoffAggregator.js
 *   - cutoffActualTotal(entries, year, month)
 *   - cutoffPredictedTotal(entries, year, month)
 *   - allCutoffTotals(entries, startYear)
 *
 * 締め期間は「前月21日〜当月20日」。実績列・予測列を独立に合算し、未入力(null)は
 * 加算対象から除外する。合計は「小数第2位以下を四捨五入して小数第1位」に丸める。
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  cutoffActualTotal,
  cutoffPredictedTotal,
  allCutoffTotals,
} from '../src/core/cutoffAggregator.js';

/** 2桁ゼロ埋め。 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 年月日から "YYYY-MM-DD"（ゼロ埋め）を生成する。 */
function toISO(y, m, d) {
  return `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
}

/**
 * 丸め規約の独立実装:「小数第2位以下を四捨五入して小数第1位（0.1刻み）」。
 * 実装側 inputManager.roundToTenth と同一の規約（round half up + 誤差補正）に従う。
 * @param {number} value
 * @returns {number}
 */
function roundToTenthExpected(value) {
  const sign = value < 0 ? -1 : 1;
  const scaled = Math.abs(value) * 10;
  const rounded = Math.floor(scaled + 0.5 + Number.EPSILON * scaled);
  return (sign * rounded) / 10;
}

/**
 * 締め期間（前月21日〜当月20日）の境界を、実装に依存せず独立に算出する。
 * @param {number} year
 * @param {number} month
 * @returns {{ start: string, end: string }}
 */
function expectedCutoffPeriod(year, month) {
  let py = year;
  let pm = month - 1;
  if (pm === 0) {
    pm = 12;
    py = year - 1;
  }
  return { start: toISO(py, pm, 21), end: toISO(year, month, 20) };
}

/**
 * 締め期間内の非null実績合計を独立に算出する。
 * @param {Array<{date:string, actualHours:number|null, predictedHours:number|null}>} entries
 */
function expectedActual(entries, year, month) {
  const { start, end } = expectedCutoffPeriod(year, month);
  let sum = 0;
  for (const e of entries) {
    if (e.date < start || e.date > end) continue;
    if (e.actualHours === null) continue;
    sum += e.actualHours;
  }
  return roundToTenthExpected(sum);
}

/** 締め期間内の非null予測合計を独立に算出する。 */
function expectedPredicted(entries, year, month) {
  const { start, end } = expectedCutoffPeriod(year, month);
  let sum = 0;
  for (const e of entries) {
    if (e.date < start || e.date > end) continue;
    if (e.predictedHours === null) continue;
    sum += e.predictedHours;
  }
  return roundToTenthExpected(sum);
}

/** 年度（4月〜翌3月）の12か月を独立に算出する。 */
function expectedFiscalMonths(startYear) {
  const months = [];
  for (let i = 0; i < 12; i++) {
    const m = 4 + i;
    if (m <= 12) months.push({ year: startYear, month: m });
    else months.push({ year: startYear + 1, month: m - 12 });
  }
  return months;
}

// 有効な残業時間（0.1刻み・[0,15)）または未入力(null)を生成する。
const hoursOrNull = fc.oneof(
  { weight: 1, arbitrary: fc.constant(null) },
  { weight: 4, arbitrary: fc.integer({ min: 0, max: 149 }).map((n) => n / 10) }
);

// 締め境界（20日/21日）付近を厚めに含む日付を生成する（1〜28は全て有効な暦日）。
const dayArb = fc.oneof(
  { weight: 2, arbitrary: fc.constantFrom(18, 19, 20, 21, 22, 23) },
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 28 }) }
);

// 1件分の生エントリ（年オフセット・月・日・実績・予測）。
const rawEntryArb = fc.record({
  yearOffset: fc.constantFrom(0, 1), // startYear または startYear+1
  month: fc.integer({ min: 1, max: 12 }),
  day: dayArb,
  actualHours: hoursOrNull,
  predictedHours: hoursOrNull,
});

const EPS = 1e-9;

describe('Cutoff_Aggregator: 21日締め合計（実績・予測独立集計）', () => {
  it('Property 14: 締め期間ごとに実績・予測を独立集計し、未入力を除外し、年度12件を返す', () => {
    // Feature: overtime-tracker, Property 14: 21日締め合計の実績・予測独立集計
    // Validates: Requirements 5.1, 5.2, 5.4, 5.5
    fc.assert(
      fc.property(
        fc.integer({ min: 2000, max: 2100 }),
        fc.array(rawEntryArb, { maxLength: 60 }),
        (startYear, rawEntries) => {
          const entries = rawEntries.map((r) => {
            const y = startYear + r.yearOffset;
            return {
              date: toISO(y, r.month, r.day),
              weekday: '月',
              actualHours: r.actualHours,
              predictedHours: r.predictedHours,
              note: '',
            };
          });

          // allCutoffTotals はちょうど12件（4月〜翌3月）を昇順で返す（要件5.4）。
          const totals = allCutoffTotals(entries, startYear);
          const fiscalMonths = expectedFiscalMonths(startYear);
          expect(totals).toHaveLength(12);

          for (let i = 0; i < 12; i++) {
            const { year, month } = fiscalMonths[i];

            // 年・月の並びが年度定義（4月〜翌3月・昇順）と一致する。
            expect(totals[i].year).toBe(year);
            expect(totals[i].month).toBe(month);

            const expA = expectedActual(entries, year, month);
            const expP = expectedPredicted(entries, year, month);

            // 実績合計は締め期間内の非null実績のみの合算（要件5.1, 5.5）。
            expect(Math.abs(cutoffActualTotal(entries, year, month) - expA)).toBeLessThan(EPS);
            // 予測合計は締め期間内の非null予測のみの合算（要件5.2 の独立算出）。
            expect(Math.abs(cutoffPredictedTotal(entries, year, month) - expP)).toBeLessThan(EPS);

            // allCutoffTotals の各値は個別関数の結果と一致する（要件5.4）。
            expect(Math.abs(totals[i].actualTotal - expA)).toBeLessThan(EPS);
            expect(Math.abs(totals[i].predictedTotal - expP)).toBeLessThan(EPS);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
