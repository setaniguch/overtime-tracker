// @ts-check
/**
 * Overtime Tracker - Business_Day_Calculator（営業日数・残営業日数）
 *
 * 副作用のない純粋関数群。平日（月〜金）を営業日とし、除外日集合（祝日・有休など）を
 * 差し引いて営業日数・残営業日数を算出する。
 *
 * 内部日付表現は "YYYY-MM-DD"（ゼロ埋め）。この書式はゼロ埋めのため辞書順比較が
 * 時系列順と一致する。日付の反復はタイムゾーンに依存しないよう UTC ベース
 * （Date.UTC / getUTCDay）で行い、決定的に処理する。
 *
 * 除外日集合 excluded は Set<DateISO>。未指定（undefined/null）の場合は空集合として扱う。
 *
 * 設計書（design.md）の Business_Day_Calculator コンポーネント仕様
 * （要件7.1, 7.2, 7.4, 7.5）に対応する。
 * @module core/businessDayCalculator
 */

/**
 * @typedef {import('./types.js').DateISO} DateISO
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 正規化日付文字列 "YYYY-MM-DD" を UTC タイムスタンプ（ミリ秒）に変換する（内部ヘルパ）。
 * @param {DateISO} date 正規化日付
 * @returns {number} UTC タイムスタンプ（ミリ秒）
 */
function toUTC(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new Error(`Invalid DateISO format: ${date}`);
  }
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/**
 * UTC タイムスタンプが平日（月〜金）かどうかを判定する（内部ヘルパ）。
 * getUTCDay(): 0=日曜, 6=土曜。1〜5 が平日。
 * @param {number} t UTC タイムスタンプ（ミリ秒）
 * @returns {boolean} 平日なら true
 */
function isWeekday(t) {
  const dow = new Date(t).getUTCDay();
  return dow >= 1 && dow <= 5;
}

/**
 * 期間 [start, end]（両端を含む）の営業日数を算出する（要件7.1, 7.5）。
 *
 * 平日（月〜金）を営業日として数え、土日および除外日集合 excluded に含まれる日を
 * 差し引く。start > end（空期間）の場合は 0 を返す。
 * @param {DateISO} start 期間開始日（"YYYY-MM-DD"、両端含む）
 * @param {DateISO} end 期間終了日（"YYYY-MM-DD"、両端含む）
 * @param {Set<DateISO>} [excluded] 除外日集合（祝日・有休など）。未指定なら空集合
 * @returns {number} 営業日数
 */
export function businessDays(start, end, excluded) {
  const startT = toUTC(start);
  const endT = toUTC(end);
  if (startT > endT) return 0;
  const excludedSet = excluded ?? new Set();
  let count = 0;
  for (let t = startT; t <= endT; t += DAY_MS) {
    if (!isWeekday(t)) continue;
    const dt = new Date(t);
    const iso = `${String(dt.getUTCFullYear()).padStart(4, '0')}-${String(
      dt.getUTCMonth() + 1
    ).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
    if (excludedSet.has(iso)) continue;
    count += 1;
  }
  return count;
}

/**
 * 期間 [start, end] 内の残営業日数を算出する（要件7.2, 7.4, 7.5）。
 *
 * referenceDate より後（当日を含まない）の平日数を数え、除外日集合 excluded に
 * 含まれる日を差し引く。実効的な開始日は referenceDate の翌日と start の遅い方、
 * 実効的な終了日は end。referenceDate が期間終了日 end 以降の場合は 0 を返す（要件7.4）。
 * @param {DateISO} start 期間開始日（"YYYY-MM-DD"、両端含む）
 * @param {DateISO} end 期間終了日（"YYYY-MM-DD"、両端含む）
 * @param {DateISO} referenceDate 基準日（"YYYY-MM-DD"）。当日は残営業日に含めない
 * @param {Set<DateISO>} [excluded] 除外日集合（祝日・有休など）。未指定なら空集合
 * @returns {number} 残営業日数
 */
export function remainingBusinessDays(start, end, referenceDate, excluded) {
  // referenceDate が期間終了日以降なら残営業日は 0（要件7.4）。
  if (referenceDate >= end) return 0;
  // referenceDate の翌日と start の遅い方を実効開始日とする。
  const dayAfterRef = toUTC(referenceDate) + DAY_MS;
  const effectiveStartT = Math.max(dayAfterRef, toUTC(start));
  const dt = new Date(effectiveStartT);
  const effectiveStart = `${String(dt.getUTCFullYear()).padStart(4, '0')}-${String(
    dt.getUTCMonth() + 1
  ).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  return businessDays(effectiveStart, end, excluded);
}
