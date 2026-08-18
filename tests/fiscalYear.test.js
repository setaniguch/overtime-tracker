// @ts-check
/**
 * Overtime Tracker - FiscalYear プロパティテスト（fast-check + Vitest）
 *
 * 設計書の Correctness Properties のうち、FiscalYear コンポーネントに対応する
 * Property 1・2・3・10 を検証する。各プロパティは最低100回反復する。
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  fiscalYearDates,
  weekdayOf,
  isValidCalendarDate,
} from '../src/core/fiscalYear.js';

// --- テスト用の独立参照実装 ---------------------------------------------

/** グレゴリオ暦の閏年判定（モジュールとは独立に実装した参照） */
function refIsLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** 当該年月の日数（参照実装） */
function refDaysInMonth(y, m) {
  const table = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m === 2 && refIsLeapYear(y)) return 29;
  return table[m - 1];
}

/**
 * Zeller の公式による曜日算出（JS Date に依存しない独立参照）。
 * h: 0=土,1=日,2=月,3=火,4=水,5=木,6=金
 * @param {number} y 西暦年
 * @param {number} m 月（1〜12）
 * @param {number} d 日
 * @returns {('日'|'月'|'火'|'水'|'木'|'金'|'土')}
 */
function refWeekday(y, m, d) {
  let mm = m;
  let yy = y;
  if (mm < 3) {
    mm += 12;
    yy -= 1;
  }
  const q = d;
  const K = yy % 100;
  const J = Math.floor(yy / 100);
  const h =
    (q +
      Math.floor((13 * (mm + 1)) / 5) +
      K +
      Math.floor(K / 4) +
      Math.floor(J / 4) +
      5 * J) %
    7;
  const map = ['土', '日', '月', '火', '水', '木', '金'];
  return map[h];
}

// --- Property 1 ----------------------------------------------------------

describe('FiscalYear: Property 1 - 年度期間の不変条件', () => {
  it('fiscalYearDates は startYear-04-01 で始まり (startYear+1)-03-31 で終わる', () => {
    // Feature: overtime-tracker, Property 1: 年度期間の不変条件 - fiscalYearDates(startYear) の最初の日付は startYear-04-01、最後の日付は (startYear+1)-03-31 である
    fc.assert(
      fc.property(fc.integer({ min: 2000, max: 2100 }), (startYear) => {
        const dates = fiscalYearDates(startYear);
        const first = dates[0];
        const last = dates[dates.length - 1];
        expect(first).toBe(`${String(startYear).padStart(4, '0')}-04-01`);
        expect(last).toBe(`${String(startYear + 1).padStart(4, '0')}-03-31`);
      }),
      { numRuns: 100 }
    );
  });
});

// --- Property 2 ----------------------------------------------------------

describe('FiscalYear: Property 2 - 年度日数生成の正しさ', () => {
  it('日数は実カレンダー通りで、日付は一意・連続・昇順である', () => {
    // Feature: overtime-tracker, Property 2: 年度日数生成の正しさ - 生成件数は 4/1〜翌3/31 の実日数（平年365・翌暦年が閏年なら366）に等しく、全日付が一意・連続・昇順である
    fc.assert(
      fc.property(fc.integer({ min: 2000, max: 2100 }), (startYear) => {
        const dates = fiscalYearDates(startYear);

        // 件数: 翌暦年（startYear+1）の 2月に 2/29 が含まれるかで決まる
        const expectedCount = refIsLeapYear(startYear + 1) ? 366 : 365;
        expect(dates.length).toBe(expectedCount);

        // 一意性
        const unique = new Set(dates);
        expect(unique.size).toBe(dates.length);

        // 昇順（文字列 "YYYY-MM-DD" は辞書順 = 時系列順）かつ連続（1日ずつ増える）
        const DAY_MS = 24 * 60 * 60 * 1000;
        for (let i = 0; i < dates.length; i++) {
          const [y, m, d] = dates[i].split('-').map(Number);
          // 各要素が実在する暦日である
          expect(m >= 1 && m <= 12).toBe(true);
          expect(d >= 1 && d <= refDaysInMonth(y, m)).toBe(true);

          if (i > 0) {
            expect(dates[i] > dates[i - 1]).toBe(true); // 昇順
            const [py, pm, pd] = dates[i - 1].split('-').map(Number);
            const prev = Date.UTC(py, pm - 1, pd);
            const cur = Date.UTC(y, m - 1, d);
            expect(cur - prev).toBe(DAY_MS); // 連続（差はちょうど1日）
          }
        }
      }),
      { numRuns: 100 }
    );
  });
});

// --- Property 3 ----------------------------------------------------------

describe('FiscalYear: Property 3 - 曜日付与の正しさ', () => {
  it('weekdayOf は真のカレンダー曜日（Zeller 参照）と一致する', () => {
    // Feature: overtime-tracker, Property 3: 曜日付与の正しさ - 任意の有効日付について weekdayOf(date) は真の暦曜日に等しい
    fc.assert(
      fc.property(
        fc.integer({ min: 1583, max: 3000 }), // グレゴリオ暦成立以降
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 31 }),
        (y, m, d) => {
          // 実在しない日付は前提条件外として除外（有効日のみ検証）
          fc.pre(d <= refDaysInMonth(y, m));
          const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
          expect(weekdayOf(iso)).toBe(refWeekday(y, m, d));
        }
      ),
      { numRuns: 100 }
    );
  });
});

// --- Property 10 ---------------------------------------------------------

describe('FiscalYear: Property 10 - 無効な基準日の拒否', () => {
  it('有効な暦日は true、実在しない暦日は false を返す', () => {
    // Feature: overtime-tracker, Property 10: 無効な基準日の拒否 - 実在しない暦日(y,m,d)は isValidCalendarDate が false、実在する暦日は true を返す
    // ケースA: 有効な日付は必ず true
    fc.assert(
      fc.property(
        fc.integer({ min: 1583, max: 3000 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 31 }),
        (y, m, d) => {
          fc.pre(d <= refDaysInMonth(y, m));
          expect(isValidCalendarDate(y, m, d)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );

    // ケースB: 実在しない日付は必ず false
    // 月/日の範囲外や、当該年月の実日数を超える日を含む広い範囲から生成し、
    // 「実在しない」ものだけを前提条件で残す。
    fc.assert(
      fc.property(
        fc.integer({ min: 1583, max: 3000 }),
        fc.integer({ min: -3, max: 15 }),
        fc.integer({ min: -3, max: 40 }),
        (y, m, d) => {
          const exists =
            Number.isInteger(m) &&
            m >= 1 &&
            m <= 12 &&
            d >= 1 &&
            d <= refDaysInMonth(y, m);
          fc.pre(!exists); // 実在しない日付のみを対象にする
          expect(isValidCalendarDate(y, m, d)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );

    // ケースC: 非整数入力は false（境界仕様の明示的検証）
    fc.assert(
      fc.property(
        fc.integer({ min: 1583, max: 3000 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        (y, m, d) => {
          expect(isValidCalendarDate(y + 0.5, m, d)).toBe(false);
          expect(isValidCalendarDate(y, m + 0.5, d)).toBe(false);
          expect(isValidCalendarDate(y, m, d + 0.5)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});
