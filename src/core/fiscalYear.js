// @ts-check
/**
 * Overtime Tracker - FiscalYear（年度・締め年度の期間生成）
 *
 * 副作用のない純粋関数群。年度（4/1〜翌3/31）および締め期間・締め年度の
 * 期間生成、曜日付与、暦日の妥当性判定を提供する。
 *
 * 内部日付表現は "YYYY-MM-DD"（ゼロ埋め）。タイムゾーンに依存しないよう、
 * 日付演算はすべて UTC ベース（Date.UTC / getUTC*）で行い、決定的に処理する。
 *
 * 設計書（design.md）の FiscalYear コンポーネント仕様に対応する。
 * @module core/fiscalYear
 */

/**
 * @typedef {import('./types.js').DateISO} DateISO
 * @typedef {import('./types.js').Weekday} Weekday
 * @typedef {import('./types.js').YearMonth} YearMonth
 */

/**
 * JS の getUTCDay()（0=日曜）を日本語曜日へ写像する表。
 * 0→日, 1→月, 2→火, 3→水, 4→木, 5→金, 6→土
 * @type {Weekday[]}
 */
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/**
 * 数値を2桁ゼロ埋め文字列にする。
 * @param {number} n
 * @returns {string}
 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 年月日から正規化日付文字列 "YYYY-MM-DD" を生成する。
 * @param {number} y 西暦年
 * @param {number} m 月（1〜12）
 * @param {number} d 日（1〜31）
 * @returns {DateISO}
 */
function toISO(y, m, d) {
  return `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
}

/**
 * 指定した年がグレゴリオ暦の閏年かどうかを判定する。
 * @param {number} y 西暦年
 * @returns {boolean}
 */
function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/**
 * 指定した年月の日数（末日）を返す。
 * @param {number} y 西暦年
 * @param {number} m 月（1〜12）
 * @returns {number}
 */
function daysInMonth(y, m) {
  const table = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m === 2 && isLeapYear(y)) return 29;
  return table[m - 1];
}

/**
 * 実在する暦日（年月日）かどうかを判定する。
 * 年・月・日はいずれも整数でなければならず、月は 1〜12、
 * 日は当該年月の実日数（閏年を含む）の範囲内である必要がある。
 * @param {number} y 西暦年
 * @param {number} m 月
 * @param {number} d 日
 * @returns {boolean} 実在する日付なら true
 */
export function isValidCalendarDate(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    return false;
  }
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > daysInMonth(y, m)) return false;
  return true;
}

/**
 * 正規化日付文字列 "YYYY-MM-DD" の曜日を返す。
 * @param {DateISO} date 正規化日付
 * @returns {Weekday} 月・火・水・木・金・土・日のいずれか
 */
export function weekdayOf(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new Error(`Invalid DateISO format: ${date}`);
  }
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return WEEKDAYS[dow];
}

/**
 * 年度（開始年の4/1〜翌年3/31）の全日付を昇順で生成する。
 * 平年は365件、翌暦年が閏年（2/29 を含む）なら366件。
 * @param {number} startYear 年度開始年
 * @returns {DateISO[]} 4/1 から翌3/31 までの日付（昇順）
 */
export function fiscalYearDates(startYear) {
  /** @type {DateISO[]} */
  const dates = [];
  // JS の月は 0 始まり。4月 = 3、翌年3/31 = (startYear+1, 月2, 31日)。
  const start = Date.UTC(startYear, 3, 1);
  const end = Date.UTC(startYear + 1, 2, 31);
  const DAY_MS = 24 * 60 * 60 * 1000;
  for (let t = start; t <= end; t += DAY_MS) {
    const dt = new Date(t);
    dates.push(toISO(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()));
  }
  return dates;
}

/**
 * 年度に属する12か月（4月〜翌年3月）を昇順で返す。
 * @param {number} startYear 年度開始年
 * @returns {YearMonth[]} 12件（4月〜翌3月）
 */
export function fiscalYearMonths(startYear) {
  /** @type {YearMonth[]} */
  const months = [];
  for (let i = 0; i < 12; i++) {
    const m = 4 + i; // 4,5,...,15
    if (m <= 12) {
      months.push({ year: startYear, month: m });
    } else {
      months.push({ year: startYear + 1, month: m - 12 });
    }
  }
  return months;
}

/**
 * 指定した年月に対応する締め期間（前月21日〜当月20日）を返す。
 * 例: cutoffPeriod(2026, 4) → { start: "2026-03-21", end: "2026-04-20" }
 * 1月の前月は前年12月に繰り上がる。
 * @param {number} year 対象年
 * @param {number} month 対象月（1〜12）
 * @returns {{ start: DateISO, end: DateISO }}
 */
export function cutoffPeriod(year, month) {
  let prevYear = year;
  let prevMonth = month - 1;
  if (prevMonth === 0) {
    prevMonth = 12;
    prevYear = year - 1;
  }
  return {
    start: toISO(prevYear, prevMonth, 21),
    end: toISO(year, month, 20),
  };
}

/**
 * 締め年度（3/21〜翌年3/20）の期間を返す。
 * 年間上限（360/690時間）判定に用いる。
 * @param {number} startYear 締め年度の開始年
 * @returns {{ start: DateISO, end: DateISO }}
 */
export function cutoffYearPeriod(startYear) {
  return {
    start: toISO(startYear, 3, 21),
    end: toISO(startYear + 1, 3, 20),
  };
}
