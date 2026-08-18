// @ts-check
/**
 * Overtime Tracker - Progress_Calculator（経過率）
 *
 * 副作用のない純粋関数。対象期間 [periodStart, periodEnd]（両端含む）について、
 * 期間初日から基準日まで（基準日を含む）に経過した営業日数を、期間の総営業日数で
 * 除し、100 を乗じた百分率（小数第1位、0.0〜100.0）を算出する。営業日数の定義は
 * Business_Day_Calculator（businessDays）に委譲し、除外日集合 excluded を分子・分母の
 * 双方に適用する。月経過率・21日締め経過率のいずれにも共通で利用できる。
 *
 * 内部日付表現は "YYYY-MM-DD"（ゼロ埋め）。この書式はゼロ埋めのため辞書順比較が
 * 時系列順と一致する。境界判定は文字列比較で決定的に行う。
 *
 * 境界条件（要件6.3, 6.4, 6.5）:
 * - 基準日が期間末日以降（referenceDate >= periodEnd）→ 100.0
 * - 基準日が期間初日より前（referenceDate < periodStart）→ 0.0
 * - 期間の総営業日数が 0 → 0.0
 *
 * 丸め規約は「小数第2位以下を四捨五入して小数第1位（0.1刻み）」で、既存の
 * inputManager.roundToTenth を再利用する。
 *
 * 設計書（design.md）の Progress_Calculator コンポーネント仕様（要件6.1〜6.5）に対応する。
 * @module core/progressCalculator
 */

import { roundToTenth } from './inputManager.js';
import { businessDays } from './businessDayCalculator.js';

/**
 * @typedef {import('./types.js').DateISO} DateISO
 */

/**
 * 対象期間の経過率（%）を算出する（要件6.1, 6.2, 6.3, 6.4, 6.5）。
 *
 * 経過営業日数（期間初日から基準日まで、基準日を含む）を期間の総営業日数で除し、
 * 100 を乗じて小数第1位に丸めた 0.0〜100.0 の百分率を返す。営業日数は
 * businessDays で算出し、除外日集合 excluded を分子・分母の双方に適用する。
 * 境界条件は以下のとおり優先して判定する。
 * - referenceDate >= periodEnd → 100.0
 * - referenceDate < periodStart → 0.0
 * - 総営業日数が 0 → 0.0
 * @param {DateISO} periodStart 期間開始日（"YYYY-MM-DD"、両端含む）
 * @param {DateISO} periodEnd 期間終了日（"YYYY-MM-DD"、両端含む）
 * @param {DateISO} referenceDate 基準日（"YYYY-MM-DD"）。当日を経過分に含める
 * @param {Set<DateISO>} [excluded] 除外日集合（祝日・有休など）。未指定なら空集合
 * @returns {number} 経過率（%、小数第1位、0.0〜100.0）
 */
export function progressRate(periodStart, periodEnd, referenceDate, excluded) {
  // "YYYY-MM-DD" はゼロ埋めのため辞書順比較が時系列比較と一致する。
  // 基準日が期間末日以降なら 100.0（要件6.3）。
  if (referenceDate >= periodEnd) return 100.0;
  // 基準日が期間初日より前なら 0.0（要件6.4）。
  if (referenceDate < periodStart) return 0.0;

  const total = businessDays(periodStart, periodEnd, excluded);
  // 総営業日数が 0 なら 0.0（要件6.5）。
  if (total === 0) return 0.0;

  // 経過営業日数は期間初日から基準日まで（基準日を含む）。
  // ここでは periodStart <= referenceDate < periodEnd が保証される。
  const elapsed = businessDays(periodStart, referenceDate, excluded);
  const rate = roundToTenth((elapsed / total) * 100);

  // 丸め後も 0.0〜100.0 の範囲に収める（要件6.1, 6.2）。
  if (rate < 0.0) return 0.0;
  if (rate > 100.0) return 100.0;
  return rate;
}
