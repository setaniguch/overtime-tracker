// @ts-check
/**
 * Overtime Tracker - Cutoff_Aggregator（21日締め合計）
 *
 * 副作用のない純粋関数群。締め期間（前月21日〜当月20日）を対象に、実績合計と
 * 予測合計をそれぞれ独立した値として算出する。Aggregator の月合計とは異なり、
 * 基準日による実績/予測の切替（effectiveHours）は行わず、実績列・予測列を別々に
 * 合算する（要件5.2 が実績合計・予測合計の独立算出を求めるため）。
 *
 * 内部日付表現は "YYYY-MM-DD"（ゼロ埋め）。この書式はゼロ埋めのため辞書順比較が
 * 時系列順と一致する。締め期間への所属判定は date >= start && date <= end で
 * 決定的に行う。締め期間の境界は fiscalYear.cutoffPeriod に委譲する。
 *
 * 未入力（集計対象外）は null で表現し、実績合計・予測合計のいずれでも加算対象から
 * 除外する（要件5.5）。丸め規約は「小数第2位以下を四捨五入して小数第1位（0.1刻み）」で、
 * 既存の inputManager.roundToTenth を再利用する。
 *
 * 設計書（design.md）の Cutoff_Aggregator コンポーネント仕様（要件5.1, 5.2, 5.4, 5.5）に対応する。
 * @module core/cutoffAggregator
 */

import { roundToTenth } from './inputManager.js';
import { cutoffPeriod, fiscalYearMonths } from './fiscalYear.js';

/**
 * @typedef {import('./types.js').DailyEntry} DailyEntry
 * @typedef {import('./types.js').CutoffTotal} CutoffTotal
 */

/**
 * 指定した年月の締め期間（前月21日〜当月20日）の実績合計を算出する（要件5.1, 5.5）。
 *
 * 締め期間に属する各日の実績残業時間（actualHours）を、未入力（null）を除外して
 * 合算し、小数第1位に丸めて返す。加算対象の日が1日も存在しない場合は 0.0 を返す。
 * 基準日には依存しない（実績列のみを合算する）。
 * @param {DailyEntry[]} entries 日次エントリ集合
 * @param {number} year 対象年（西暦）
 * @param {number} month 対象月（1〜12）
 * @returns {number} 締め期間の実績合計（時間、小数第1位）
 */
export function cutoffActualTotal(entries, year, month) {
  const { start, end } = cutoffPeriod(year, month);
  let sum = 0;
  for (const entry of entries) {
    // "YYYY-MM-DD" はゼロ埋めのため辞書順比較が時系列比較と一致する。
    if (entry.date < start || entry.date > end) continue;
    if (entry.actualHours === null) continue;
    sum += entry.actualHours;
  }
  return roundToTenth(sum);
}

/**
 * 指定した年月の締め期間（前月21日〜当月20日）の予測合計を算出する（要件5.1, 5.5）。
 *
 * 締め期間に属する各日の予測残業時間（predictedHours）を、未入力（null）を除外して
 * 合算し、小数第1位に丸めて返す。加算対象の日が1日も存在しない場合は 0.0 を返す。
 * 基準日には依存しない（予測列のみを合算する）。
 * @param {DailyEntry[]} entries 日次エントリ集合
 * @param {number} year 対象年（西暦）
 * @param {number} month 対象月（1〜12）
 * @returns {number} 締め期間の予測合計（時間、小数第1位）
 */
export function cutoffPredictedTotal(entries, year, month) {
  const { start, end } = cutoffPeriod(year, month);
  let sum = 0;
  for (const entry of entries) {
    if (entry.date < start || entry.date > end) continue;
    if (entry.predictedHours === null) continue;
    sum += entry.predictedHours;
  }
  return roundToTenth(sum);
}

/**
 * 年度内の各月（4月〜翌年3月）に対応する締め期間の実績合計・予測合計を昇順で返す（要件5.4）。
 *
 * 常にちょうど12件を返す。実績合計と予測合計はそれぞれ独立に算出される。
 * 加算対象日が存在しない締め期間の合計は 0.0 になる。
 * @param {DailyEntry[]} entries 日次エントリ集合
 * @param {number} startYear 年度開始年
 * @returns {CutoffTotal[]} 4月〜翌3月のちょうど12件（昇順）
 */
export function allCutoffTotals(entries, startYear) {
  return fiscalYearMonths(startYear).map(({ year, month }) => ({
    year,
    month,
    actualTotal: cutoffActualTotal(entries, year, month),
    predictedTotal: cutoffPredictedTotal(entries, year, month),
  }));
}
