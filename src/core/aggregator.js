// @ts-check
/**
 * Overtime Tracker - Aggregator（対象残業時間の選択・月合計・年間合計）
 *
 * 副作用のない純粋関数群。対象残業時間（基準日以前は実績、基準日より後は予測）の
 * 選択、年度内の各月の月合計、年度全体の年間実績合計・年間予測合計を算出する。
 *
 * 内部日付表現は "YYYY-MM-DD"（ゼロ埋め）。この書式はゼロ埋めのため辞書順比較が
 * 時系列順と一致する。基準日との大小比較や年度期間の判定は文字列比較で決定的に行う。
 *
 * 未入力（集計対象外）は null で表現し、いずれの合計でも加算対象から除外する。
 * 丸め規約は「小数第2位以下を四捨五入して小数第1位（0.1刻み）」で、既存の
 * inputManager.roundToTenth を再利用する。
 *
 * 設計書（design.md）の Aggregator コンポーネント仕様（要件3.4/3.5, 4, 8）に対応する。
 * @module core/aggregator
 */

import { roundToTenth } from './inputManager.js';
import { fiscalYearMonths } from './fiscalYear.js';

/**
 * @typedef {import('./types.js').DailyEntry} DailyEntry
 * @typedef {import('./types.js').DateISO} DateISO
 * @typedef {import('./types.js').MonthlyTotal} MonthlyTotal
 */

/**
 * 数値を2桁ゼロ埋め文字列にする（内部ヘルパ）。
 * @param {number} n
 * @returns {string}
 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 対象残業時間を選択する（要件3.4, 3.5）。
 *
 * 対象日（entry.date）が基準日以前（当日を含む）なら実績残業時間を、
 * 基準日より後なら予測残業時間を返す。採用する列が未入力（null）なら null を返す。
 * @param {DailyEntry} entry 日次エントリ
 * @param {DateISO} referenceDate 基準日（"YYYY-MM-DD"）
 * @returns {number|null} 対象残業時間。採用列が未入力なら null
 */
export function effectiveHours(entry, referenceDate) {
  // "YYYY-MM-DD" はゼロ埋めのため辞書順比較が時系列比較と一致する。
  if (entry.date <= referenceDate) {
    return entry.actualHours;
  }
  return entry.predictedHours;
}

/**
 * 指定した年月の月合計を算出する（要件4.1, 4.4, 4.5, 2.4）。
 *
 * 対象月（year年month月）に属する各日の対象残業時間（effectiveHours）を、
 * 未入力（null）を除外して合算し、小数第1位に丸めて返す。加算対象の日が
 * 1日も存在しない場合は 0.0 を返す。
 * @param {DailyEntry[]} entries 日次エントリ集合
 * @param {number} year 対象年（西暦）
 * @param {number} month 対象月（1〜12）
 * @param {DateISO} referenceDate 基準日（"YYYY-MM-DD"）
 * @returns {number} 月合計（時間、小数第1位）
 */
export function monthlyTotal(entries, year, month, referenceDate) {
  const prefix = `${String(year).padStart(4, '0')}-${pad2(month)}-`;
  let sum = 0;
  for (const entry of entries) {
    if (!entry.date.startsWith(prefix)) continue;
    const hours = effectiveHours(entry, referenceDate);
    if (hours === null) continue;
    sum += hours;
  }
  return roundToTenth(sum);
}

/**
 * 年度内の12か月（4月〜翌年3月）それぞれの月合計を昇順で返す（要件4.3）。
 *
 * 常にちょうど12件を返す。加算対象日が存在しない月の total は 0.0 になる。
 * @param {DailyEntry[]} entries 日次エントリ集合
 * @param {number} startYear 年度開始年
 * @param {DateISO} referenceDate 基準日（"YYYY-MM-DD"）
 * @returns {MonthlyTotal[]} 4月〜翌3月のちょうど12件（昇順）
 */
export function allMonthlyTotals(entries, startYear, referenceDate) {
  return fiscalYearMonths(startYear).map(({ year, month }) => ({
    year,
    month,
    total: monthlyTotal(entries, year, month, referenceDate),
  }));
}

/**
 * 年度期間（開始年の4/1〜翌年3/31）に属するかを判定する（内部ヘルパ）。
 * "YYYY-MM-DD" の辞書順比較で範囲内かを決定的に判定する。
 * @param {DateISO} date
 * @param {number} startYear
 * @returns {boolean}
 */
function isWithinFiscalYear(date, startYear) {
  const start = `${String(startYear).padStart(4, '0')}-04-01`;
  const end = `${String(startYear + 1).padStart(4, '0')}-03-31`;
  return date >= start && date <= end;
}

/**
 * 年間実績合計を算出する（要件8.1, 8.4, 8.5）。
 *
 * 年度（4/1〜翌年3/31）内の全日次エントリの実績残業時間（actualHours）を、
 * 未入力（null）を除外して合算し、小数第1位に丸めて返す。加算対象が
 * 1件も存在しない場合は 0.0 を返す。基準日には依存しない。
 * @param {DailyEntry[]} entries 日次エントリ集合
 * @param {number} startYear 年度開始年
 * @returns {number} 年間実績合計（時間、小数第1位）
 */
export function annualActualTotal(entries, startYear) {
  let sum = 0;
  for (const entry of entries) {
    if (!isWithinFiscalYear(entry.date, startYear)) continue;
    if (entry.actualHours === null) continue;
    sum += entry.actualHours;
  }
  return roundToTenth(sum);
}

/**
 * 年間予測合計を算出する（要件8.2, 8.4, 8.5）。
 *
 * 年度（4/1〜翌年3/31）内の全日次エントリの予測残業時間（predictedHours）を、
 * 未入力（null）を除外して合算し、小数第1位に丸めて返す。加算対象が
 * 1件も存在しない場合は 0.0 を返す。基準日には依存しない。
 * @param {DailyEntry[]} entries 日次エントリ集合
 * @param {number} startYear 年度開始年
 * @returns {number} 年間予測合計（時間、小数第1位）
 */
export function annualPredictedTotal(entries, startYear) {
  let sum = 0;
  for (const entry of entries) {
    if (!isWithinFiscalYear(entry.date, startYear)) continue;
    if (entry.predictedHours === null) continue;
    sum += entry.predictedHours;
  }
  return roundToTenth(sum);
}
