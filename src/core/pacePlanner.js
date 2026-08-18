// @ts-check
/**
 * Overtime Tracker - Pace_Planner（残業ペース配分）
 *
 * 副作用のない純粋関数。年間残業上限（既定 360.0 時間）に対する残余残業予算を、
 * 年度内で基準日以前の実績残業時間の合計（既消化残業時間）を差し引いて算出し、
 * 残り月数（基準日が属する月〜翌年3月、属する月を含む）で按分して、月あたりに
 * 許容される残業時間の目安（月あたり配分）を求める。
 *
 * 内部日付表現は "YYYY-MM-DD"（ゼロ埋め）。この書式はゼロ埋めのため辞書順比較が
 * 時系列順と一致する。年度期間の判定や基準日以前の判定は文字列比較で決定的に行う。
 *
 * 丸め規約は「小数第2位以下を四捨五入して小数第1位（0.1刻み）」で、既存の
 * inputManager.roundToTenth を再利用する。
 *
 * 判定の優先順位（要件15.5, 15.6）:
 * - 残余予算 < 0 → over_cap（月あたり配分 0.0 + 年間上限超過警告）
 * - 残り月数 0 → year_ended（配分を算出しない。年度終了）
 * - それ以外（残り月数 >= 1 かつ 残余予算 >= 0）→ normal（残余予算 ÷ 残り月数）
 *
 * 設計書（design.md）の Pace_Planner コンポーネント仕様（要件15.1〜15.7）に対応する。
 * @module core/pacePlanner
 */

import { roundToTenth } from './inputManager.js';

/**
 * @typedef {import('./types.js').DailyEntry} DailyEntry
 * @typedef {import('./types.js').DateISO} DateISO
 */

/**
 * @typedef {(
 *   | { kind: 'normal', remainingBudget: number, remainingMonths: number, monthlyAllowance: number }
 *   | { kind: 'over_cap', remainingBudget: number, monthlyAllowance: number }
 *   | { kind: 'year_ended' }
 * )} PacePlan
 */

/** 年間残業上限の既定値（時間）（要件15.1）。 */
const DEFAULT_ANNUAL_CAP = 360.0;

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
 * 年度内で基準日以前（当日を含む）の実績残業時間の合計（既消化残業時間）を返す。
 *
 * 年度（4/1〜翌年3/31）内の日次エントリのうち、日付が基準日以前のものの
 * 実績残業時間（actualHours）を、未入力（null）を除外して合算し、小数第1位に丸める。
 * @param {DailyEntry[]} entries 日次エントリ集合
 * @param {number} startYear 年度開始年
 * @param {DateISO} referenceDate 基準日（"YYYY-MM-DD"）
 * @returns {number} 既消化残業時間（時間、小数第1位）
 */
function consumedActualTotal(entries, startYear, referenceDate) {
  let sum = 0;
  for (const entry of entries) {
    if (!isWithinFiscalYear(entry.date, startYear)) continue;
    if (entry.date > referenceDate) continue;
    if (entry.actualHours === null) continue;
    sum += entry.actualHours;
  }
  return roundToTenth(sum);
}

/**
 * 基準日の属する月から翌年3月までの残り月数を算出する（要件15.3）。
 *
 * 年度は 4月（開始年）〜翌年3月 の12か月からなる。基準日が属する月を年度内での
 * 通し位置（4月=0, …, 翌年3月=11）に写像し、残り月数を「12 − 位置」として返す
 * （属する月を含む）。年度内の基準日では 1〜12 の範囲となる。
 * 基準日が年度末より後（翌年4月以降）なら 0（年度終了）、年度開始より前なら 12 を返す。
 * @param {DateISO} referenceDate 基準日（"YYYY-MM-DD"）
 * @param {number} startYear 年度開始年
 * @returns {number} 残り月数（0〜12）
 */
function remainingMonthsOf(referenceDate, startYear) {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(referenceDate);
  if (!match) {
    throw new Error(`Invalid DateISO format: ${referenceDate}`);
  }
  const refYear = Number(match[1]);
  const refMonth = Number(match[2]);
  // 年度内での通し位置（4月=0, …, 12月=8, 翌1月=9, 翌2月=10, 翌3月=11）。
  const index = (refYear - startYear) * 12 + (refMonth - 4);
  if (index < 0) return 12; // 年度開始より前 → 全月が残る
  if (index > 11) return 0; // 年度末より後 → 年度終了
  return 12 - index;
}

/**
 * 残業ペース配分を算出する（要件15.1〜15.6）。
 *
 * - remainingBudget = annualCap −（年度内で基準日以前の実績残業時間の合計）
 * - remainingMonths = 基準日が属する月〜翌年3月（属する月を含む）
 * - monthlyAllowance = remainingBudget ÷ remainingMonths（小数第1位）
 *
 * 結果は次のいずれかを返す。
 * - 残余予算 < 0 → { kind: 'over_cap', remainingBudget, monthlyAllowance: 0.0 }
 * - 残り月数 0 → { kind: 'year_ended' }
 * - それ以外 → { kind: 'normal', remainingBudget, remainingMonths, monthlyAllowance }
 * @param {DailyEntry[]} entries 日次エントリ集合
 * @param {number} startYear 年度開始年
 * @param {DateISO} referenceDate 基準日（"YYYY-MM-DD"）
 * @param {number} [annualCap] 年間残業上限（既定 360.0）
 * @returns {PacePlan}
 */
export function computePacePlan(entries, startYear, referenceDate, annualCap = DEFAULT_ANNUAL_CAP) {
  const consumed = consumedActualTotal(entries, startYear, referenceDate);
  const remainingBudget = roundToTenth(annualCap - consumed);
  const remainingMonths = remainingMonthsOf(referenceDate, startYear);

  // 残余予算が 0 未満なら、月あたり配分は 0.0 とし超過警告を伴う（要件15.6）。
  if (remainingBudget < 0) {
    return { kind: 'over_cap', remainingBudget, monthlyAllowance: 0.0 };
  }

  // 残り月数が 0 なら配分を算出しない（年度終了）（要件15.5）。
  if (remainingMonths === 0) {
    return { kind: 'year_ended' };
  }

  // 通常ケース: 残余予算を残り月数で按分し小数第1位に丸める（要件15.4）。
  const monthlyAllowance = roundToTenth(remainingBudget / remainingMonths);
  return { kind: 'normal', remainingBudget, remainingMonths, monthlyAllowance };
}
