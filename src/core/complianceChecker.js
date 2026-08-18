// @ts-check
/**
 * Overtime Tracker - Compliance_Checker（上限警告）
 *
 * 副作用のない純粋関数。月合計の集合と締め年度合計を入力として受け取り、
 * 社内の残業上限ルール（要件9・10）に対する警告リストを導出する。
 *
 * 判定はすべて「現在の入力のみ」から決まる。過去の警告状態を保持しないため、
 * 値が基準を下回れば対応する警告は次回評価で自動的に消える（要件9.5, 10.5）。
 *
 * 締め年度合計（3/21〜翌3/20 の対象残業時間の総和）は、呼び出し側が
 * effectiveHours を用いて別途算出した値を数値として受け取る（要件10.2）。
 * 本モジュールは締め期間の集計そのものは行わず、閾値分類のみを担う。
 *
 * 判定規則（design.md の Compliance_Checker 仕様、要件9・10より）:
 * - OVER_45:         月合計 > 45.0（45.0 ちょうどは含めない）。超過月ごとに1件。
 * - OVER_45_COUNT:   45.0 を超える月の数が 7 以上（上限6回を超過）。
 * - CONSECUTIVE_45:  暦月として連続する2か月がともに > 45.0。該当ペアごとに1件。
 * - ADJUST_TO_55:    月合計 > 45.0 かつ < 55.0。該当月ごとに1件。
 * - OVER_69:         月合計 > 69.0（重大警告）。該当月ごとに1件。
 * - CUTOFF_YEAR_360: 締め年度合計 > 360.0 かつ <= 690.0。
 * - CUTOFF_YEAR_690: 締め年度合計 > 690.0（重大警告）。
 *
 * @module core/complianceChecker
 */

/**
 * @typedef {import('./types.js').MonthlyTotal} MonthlyTotal
 * @typedef {import('./types.js').YearMonth} YearMonth
 */

/**
 * 上限警告。code により種別を識別する。months/value/limit は種別に応じて付与する。
 * @typedef {Object} Warning
 * @property {('OVER_45'|'OVER_45_COUNT'|'CONSECUTIVE_45'|'ADJUST_TO_55'|'OVER_69'|'CUTOFF_YEAR_360'|'CUTOFF_YEAR_690')} code 警告種別
 * @property {YearMonth[]} [months] 対象となる年月（該当する種別のみ）
 * @property {number} [value]       判定に用いた実測値（月合計・超過回数・締め年度合計）
 * @property {number} [limit]       判定に用いた上限値
 * @property {string} message       利用者向けの説明メッセージ
 */

/** 月45時間関連の閾値（時間）。45.0 ちょうどは超過に含めない。 */
const LIMIT_45 = 45.0;
/** 45時間超過月に推奨する調整下限（時間）。この値未満なら 55 時間以上への調整を促す。 */
const ADJUST_UPPER = 55.0;
/** 一発アウトに相当する重大上限（時間）。 */
const LIMIT_69 = 69.0;
/** 締め年度の通常上限（時間）。 */
const CUTOFF_NORMAL = 360.0;
/** 締め年度の特例上限（時間）。 */
const CUTOFF_SPECIAL = 690.0;
/** 45時間超過が警告対象となる月数（7回目からアウト＝上限6回）。 */
const OVER_45_COUNT_THRESHOLD = 7;
/** 45時間超過の許容回数（上限）。 */
const OVER_45_ALLOWED = 6;

/**
 * 年月を通し番号（year*12 + month）へ写像する（内部ヘルパ）。
 * 暦月としての連続性判定・昇順ソートに用いる。
 * @param {YearMonth|MonthlyTotal} ym
 * @returns {number}
 */
function monthIndex(ym) {
  return ym.year * 12 + ym.month;
}

/**
 * 年月を "YYYY年M月" 形式のメッセージ用文字列にする（内部ヘルパ）。
 * @param {YearMonth|MonthlyTotal} ym
 * @returns {string}
 */
function formatMonth(ym) {
  return `${ym.year}年${ym.month}月`;
}

/**
 * 月合計集合と締め年度合計から上限警告リストを導出する（要件9・10）。
 *
 * すべての警告は現在の入力のみから決定される純粋関数。基準を下回る値に対しては
 * 警告を生成しないため、再評価時に基準を下回った警告は自動的に解除される。
 * @param {MonthlyTotal[]} monthlyTotals 年度内の月合計集合（順不同でも可）
 * @param {number} cutoffYearTotal 締め年度（3/21〜翌3/20）の残業合計（effectiveHours ベースで別途算出した値）
 * @returns {Warning[]} 該当する警告のリスト（該当なしなら空配列）
 */
export function evaluateCompliance(monthlyTotals, cutoffYearTotal) {
  /** @type {Warning[]} */
  const warnings = [];

  // 45時間超過月（要件9.1）。45.0 ちょうどは含めない。
  const over45 = monthlyTotals.filter((mt) => mt.total > LIMIT_45);

  // OVER_45: 超過月ごとに1件（要件9.1）。
  for (const mt of over45) {
    warnings.push({
      code: 'OVER_45',
      months: [{ year: mt.year, month: mt.month }],
      value: mt.total,
      limit: LIMIT_45,
      message: `${formatMonth(mt)}の月合計が${mt.total}時間で、45時間を超過しています。`,
    });
  }

  // OVER_45_COUNT: 超過月数が上限（6回）を超える＝7以上（要件9.2）。
  if (over45.length >= OVER_45_COUNT_THRESHOLD) {
    warnings.push({
      code: 'OVER_45_COUNT',
      months: over45.map((mt) => ({ year: mt.year, month: mt.month })),
      value: over45.length,
      limit: OVER_45_ALLOWED,
      message: `45時間超過月が${over45.length}回あり、年間の上限（6回）を超えています。`,
    });
  }

  // CONSECUTIVE_45: 暦月として連続する2か月がともに > 45.0（要件9.3）。
  // 順不同入力に対応するため通し番号で昇順ソートし、隣接ペアが連続月かを判定する。
  const sorted = [...monthlyTotals].sort((a, b) => monthIndex(a) - monthIndex(b));
  for (let i = 0; i + 1 < sorted.length; i++) {
    const cur = sorted[i];
    const next = sorted[i + 1];
    const isConsecutive = monthIndex(next) - monthIndex(cur) === 1;
    if (isConsecutive && cur.total > LIMIT_45 && next.total > LIMIT_45) {
      warnings.push({
        code: 'CONSECUTIVE_45',
        months: [
          { year: cur.year, month: cur.month },
          { year: next.year, month: next.month },
        ],
        message: `${formatMonth(cur)}と${formatMonth(next)}が連続して45時間を超過しています。連続超過は避けてください。`,
      });
    }
  }

  // ADJUST_TO_55: 月合計 > 45.0 かつ < 55.0（要件9.4）。
  for (const mt of monthlyTotals) {
    if (mt.total > LIMIT_45 && mt.total < ADJUST_UPPER) {
      warnings.push({
        code: 'ADJUST_TO_55',
        months: [{ year: mt.year, month: mt.month }],
        value: mt.total,
        limit: ADJUST_UPPER,
        message: `${formatMonth(mt)}の月合計が${mt.total}時間です。45時間を超える月は55時間以上に調整してください。`,
      });
    }
  }

  // OVER_69: 月合計 > 69.0（重大警告・要件10.1）。
  for (const mt of monthlyTotals) {
    if (mt.total > LIMIT_69) {
      warnings.push({
        code: 'OVER_69',
        months: [{ year: mt.year, month: mt.month }],
        value: mt.total,
        limit: LIMIT_69,
        message: `${formatMonth(mt)}の月合計が${mt.total}時間で、上限（69時間）を超過しています（一発アウト）。`,
      });
    }
  }

  // 締め年度合計の閾値分類（要件10.3, 10.4）。両警告は排他（値により一方のみ生成）。
  if (cutoffYearTotal > CUTOFF_SPECIAL) {
    warnings.push({
      code: 'CUTOFF_YEAR_690',
      value: cutoffYearTotal,
      limit: CUTOFF_SPECIAL,
      message: `締め年度合計が${cutoffYearTotal}時間で、特例上限（690時間）を超過しています。`,
    });
  } else if (cutoffYearTotal > CUTOFF_NORMAL) {
    warnings.push({
      code: 'CUTOFF_YEAR_360',
      value: cutoffYearTotal,
      limit: CUTOFF_NORMAL,
      message: `締め年度合計が${cutoffYearTotal}時間で、通常上限（360時間）を超過しています（特例上限690時間の範囲内）。`,
    });
  }

  return warnings;
}
