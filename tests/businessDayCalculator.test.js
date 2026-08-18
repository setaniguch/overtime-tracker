// @ts-check
/**
 * Business_Day_Calculator のプロパティテスト（fast-check + Vitest）
 *
 * 対応タスク: 7.2 (Property 16), 7.3 (Property 17), 7.4 (Property 18)
 * 検証対象: src/core/businessDayCalculator.js
 */

import { describe, it } from 'vitest';
import fc from 'fast-check';
import {
  businessDays,
  remainingBusinessDays,
} from '../src/core/businessDayCalculator.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 年月日（UTC）から "YYYY-MM-DD" を生成する。 */
function toISO(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(
    d
  ).padStart(2, '0')}`;
}

/** UTC タイムスタンプから "YYYY-MM-DD" を生成する。 */
function stampToISO(t) {
  const dt = new Date(t);
  return toISO(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** "YYYY-MM-DD" を UTC タイムスタンプに変換する。 */
function toUTC(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/**
 * 期間 [start, end]（両端含む）内で、除外集合に含まれない平日（月〜金）の一覧を
 * 独立に列挙する（参照実装）。
 * @param {string} start
 * @param {string} end
 * @param {Set<string>} [excluded]
 * @returns {string[]}
 */
function weekdaysInRange(start, end, excluded) {
  const startT = toUTC(start);
  const endT = toUTC(end);
  const ex = excluded ?? new Set();
  const out = [];
  for (let t = startT; t <= endT; t += DAY_MS) {
    const dow = new Date(t).getUTCDay();
    if (dow < 1 || dow > 5) continue; // 土日除外
    const iso = stampToISO(t);
    if (ex.has(iso)) continue;
    out.push(iso);
  }
  return out;
}

/**
 * サニティのある範囲（2000-01-01 起点）で start <= end の期間を生成する。
 * span を高々 ~1.5 年に抑え、100 回反復でも高速に完了させる。
 */
const periodArb = fc
  .record({
    offsetDays: fc.integer({ min: 0, max: 365 * 6 }),
    spanDays: fc.integer({ min: 0, max: 500 }),
  })
  .map(({ offsetDays, spanDays }) => {
    const base = Date.UTC(2000, 0, 1);
    const startT = base + offsetDays * DAY_MS;
    const endT = startT + spanDays * DAY_MS;
    return { start: stampToISO(startT), end: stampToISO(endT) };
  });

describe('businessDayCalculator', () => {
  // Feature: overtime-tracker, Property 16: 営業日数の算出（除外日なしのとき、営業日数は期間内の平日数に等しい）
  it('Property 16: businessDays は除外日なしのとき期間内の平日数に等しい', () => {
    fc.assert(
      fc.property(periodArb, ({ start, end }) => {
        const expected = weekdaysInRange(start, end).length;
        return businessDays(start, end) === expected;
      }),
      { numRuns: 100 }
    );
  });

  // Feature: overtime-tracker, Property 17: 残営業日数の算出（基準日より後の平日数に等しく、営業日数以下、基準日>=末日なら0）
  it('Property 17: remainingBusinessDays は基準日より後の平日数に等しく businessDays 以下、基準日>=末日で 0', () => {
    fc.assert(
      fc.property(
        periodArb,
        fc.integer({ min: -30, max: 530 }),
        ({ start, end }, refOffset) => {
          // 基準日を start を起点に前後させ、期間内外の両方を網羅する。
          const referenceDate = stampToISO(toUTC(start) + refOffset * DAY_MS);

          const total = businessDays(start, end);
          const remaining = remainingBusinessDays(start, end, referenceDate);

          // 参照実装: referenceDate より厳密に後（翌日以降）かつ期間内の平日数。
          const effStartT = Math.max(
            toUTC(referenceDate) + DAY_MS,
            toUTC(start)
          );
          const expected =
            effStartT > toUTC(end)
              ? 0
              : weekdaysInRange(stampToISO(effStartT), end).length;

          // 残営業日数は参照実装と一致する。
          if (remaining !== expected) return false;
          // 残営業日数は常に総営業日数以下。
          if (remaining > total) return false;
          // 基準日が末日以降なら 0（要件7.4）。
          if (referenceDate >= end && remaining !== 0) return false;
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: overtime-tracker, Property 18: 除外日のメタモルフィック性（未除外の平日を除外に追加すると営業日数はちょうど1減り、既除外日の追加では不変）
  it('Property 18: 除外集合への平日追加で businessDays はちょうど 1 減る（既除外なら不変）', () => {
    fc.assert(
      fc.property(
        periodArb,
        fc.double({ min: 0, max: 1, noNaN: true }),
        ({ start, end }, pick) => {
          const weekdays = weekdaysInRange(start, end);
          if (weekdays.length === 0) {
            // 平日が無い期間では追加できる平日が無いためスキップ（前提を満たさない）。
            return true;
          }
          const idx = Math.min(
            weekdays.length - 1,
            Math.floor(pick * weekdays.length)
          );
          const day = weekdays[idx];

          const base = new Set();
          const before = businessDays(start, end, base);

          const withDay = new Set(base);
          withDay.add(day);
          const after = businessDays(start, end, withDay);

          // 未除外の平日を追加すると営業日数はちょうど 1 減る。
          if (after !== before - 1) return false;

          // 既に除外済みの日を再追加しても不変（冪等）。
          const againSame = businessDays(start, end, withDay);
          if (againSame !== after) return false;

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});
