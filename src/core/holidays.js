// @ts-check
/**
 * Overtime Tracker - 日本の祝日計算（副作用なしの純粋関数）
 *
 * 指定した暦年の「国民の祝日」を "YYYY-MM-DD" の集合として返す。営業日数の算定で
 * 祝日を除外するために用いる（要件7.5 の除外日の一系統）。外部ネットワークやカレンダー
 * ファイルには依存せず、法定のルールを計算で再現する（ローカル動作要件）。
 *
 * 対応範囲:
 * - 固定日の祝日（元日・建国記念の日・昭和の日・憲法記念日・みどりの日・こどもの日・
 *   山の日・文化の日・勤労感謝の日・天皇誕生日〈2020年〜 2/23〉）
 * - ハッピーマンデー（成人の日=1月第2月曜, 海の日=7月第3月曜, 敬老の日=9月第3月曜,
 *   スポーツ/体育の日=10月第2月曜）
 * - 春分の日・秋分の日（1980〜2099 年に有効な近似式）
 * - 国民の休日（前後を祝日に挟まれた平日）
 * - 振替休日（祝日が日曜のとき、直後の非祝日を休日に）
 *
 * 注意: 東京五輪（2020/2021）の特例移動などの一過性の例外は対象外。近似式の範囲外の
 * 年については概算となる。実運用の対象年（2020年代〜）では実用上十分な精度。
 * @module core/holidays
 */

/**
 * @typedef {import('./types.js').DateISO} DateISO
 */

/** 年ごとの計算結果キャッシュ（同一年の再計算を避ける）。 */
const cache = new Map();

/** 2桁ゼロ埋め。 */
function pad2(n) {
  return String(n).padStart(2, '0');
}
/** 4桁ゼロ埋め。 */
function pad4(n) {
  return String(n).padStart(4, '0');
}
/** 年月日を "YYYY-MM-DD" に整形。 */
function iso(y, m, d) {
  return `${pad4(y)}-${pad2(m)}-${pad2(d)}`;
}
/** 曜日番号（0=日〜6=土）を UTC で返す。 */
function dow(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
/** 指定月の第 n 月曜日の日付（日）を返す。 */
function nthMonday(year, month, n) {
  const firstDow = dow(year, month, 1); // 0=日..6=土
  // 1日から見て最初の月曜までのオフセット。
  const offset = (8 - firstDow) % 7; // firstDow==1(月)なら0
  return 1 + offset + (n - 1) * 7;
}
/** 春分の日（3月）。1980〜2099 で有効な近似式。 */
function vernalEquinoxDay(year) {
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}
/** 秋分の日（9月）。1980〜2099 で有効な近似式。 */
function autumnalEquinoxDay(year) {
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

/**
 * 指定した暦年の国民の祝日（振替休日・国民の休日を含む）を返す。
 * @param {number} year 西暦年
 * @returns {Set<DateISO>}
 */
export function japaneseHolidays(year) {
  if (cache.has(year)) return cache.get(year);

  /** @type {Map<string, true>} 基本の祝日（キー: ISO）。 */
  const base = new Map();
  const add = (m, d) => base.set(iso(year, m, d), true);

  // 固定日。
  add(1, 1); // 元日
  add(2, 11); // 建国記念の日
  if (year >= 2020) add(2, 23); // 天皇誕生日（令和）
  add(4, 29); // 昭和の日
  add(5, 3); // 憲法記念日
  add(5, 4); // みどりの日
  add(5, 5); // こどもの日
  if (year >= 2016) add(8, 11); // 山の日
  add(11, 3); // 文化の日
  add(11, 23); // 勤労感謝の日
  if (year <= 2018) add(12, 23); // 天皇誕生日（平成）

  // ハッピーマンデー。
  add(1, nthMonday(year, 1, 2)); // 成人の日
  add(7, nthMonday(year, 7, 3)); // 海の日（近年）
  add(9, nthMonday(year, 9, 3)); // 敬老の日
  add(10, nthMonday(year, 10, 2)); // スポーツの日/体育の日

  // 春分・秋分。
  add(3, vernalEquinoxDay(year));
  add(9, autumnalEquinoxDay(year));

  // 国民の休日: 平日（非日曜）で、前日・翌日がともに祝日である日。
  const baseKeys = Array.from(base.keys());
  for (const key of baseKeys) {
    const [y, m, d] = key.split('-').map(Number);
    const prev = new Date(Date.UTC(y, m - 1, d - 1));
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    // key と next の間に1日空くケース（key, gap, next+? ）を検出するため、
    // 「ある祝日の翌々日も祝日で、間の日が非祝日・非日曜」を国民の休日とする。
    const gap = new Date(Date.UTC(y, m - 1, d + 1));
    const after = new Date(Date.UTC(y, m - 1, d + 2));
    const gapIso = iso(gap.getUTCFullYear(), gap.getUTCMonth() + 1, gap.getUTCDate());
    const afterIso = iso(after.getUTCFullYear(), after.getUTCMonth() + 1, after.getUTCDate());
    if (base.has(afterIso) && !base.has(gapIso) && gap.getUTCDay() !== 0) {
      base.set(gapIso, true);
    }
    void prev;
    void next;
  }

  // 振替休日: 祝日が日曜のとき、直後の「祝日でない日」を休日にする。
  const withKokumin = Array.from(base.keys());
  for (const key of withKokumin) {
    const [y, m, d] = key.split('-').map(Number);
    if (dow(y, m, d) === 0) {
      // 次の非祝日まで進める。
      let n = 1;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const dt = new Date(Date.UTC(y, m - 1, d + n));
        const k = iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
        if (!base.has(k)) {
          base.set(k, true);
          break;
        }
        n += 1;
      }
    }
  }

  const result = new Set(base.keys());
  cache.set(year, result);
  return result;
}

/**
 * 指定した年範囲（両端含む）の祝日をまとめた集合を返す。
 * @param {number} fromYear
 * @param {number} toYear
 * @returns {Set<DateISO>}
 */
export function japaneseHolidaysBetween(fromYear, toYear) {
  /** @type {Set<DateISO>} */
  const set = new Set();
  for (let y = fromYear; y <= toYear; y++) {
    for (const d of japaneseHolidays(y)) set.add(d);
  }
  return set;
}
