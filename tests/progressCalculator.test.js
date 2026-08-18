// @ts-check
/**
 * Progress_Calculator（経過率）のテスト。
 *
 * Feature: overtime-tracker
 * Property 15: 経過率の定義と範囲
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5
 *
 * 経過率 = 小数第1位に丸めた ((期間初日〜基準日(当日含む)の営業日数) / (期間の総営業日数) * 100)。
 * 常に [0.0, 100.0]。基準日 >= 末日 → 100.0、基準日 < 初日 → 0.0、総営業日数 0 → 0.0。
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { progressRate } from '../src/core/progressCalculator.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const EPOCH = Date.UTC(2020, 0, 1); // 2020-01-01 (水)

/** UTC タイムスタンプ（ミリ秒）を "YYYY-MM-DD" に変換する。 */
function isoFromTs(t) {
  const d = new Date(t);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(
    d.getUTCMonth() + 1
  ).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** EPOCH からの日数オフセットを "YYYY-MM-DD" に変換する。 */
function isoFromOffset(off) {
  return isoFromTs(EPOCH + off * DAY_MS);
}

/** "YYYY-MM-DD" を UTC タイムスタンプ（ミリ秒）に変換する。 */
function toUTC(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/**
 * 期間 [startISO, endISO]（両端含む）の営業日数を独立に算出する。
 * 平日(月〜金)を数え、除外日集合に含まれる日を差し引く。UTC ベースでモジュールと一致させる。
 */
function countBusinessDays(startISO, endISO, excluded) {
  const s = toUTC(startISO);
  const e = toUTC(endISO);
  if (s > e) return 0;
  let count = 0;
  for (let t = s; t <= e; t += DAY_MS) {
    const dow = new Date(t).getUTCDay(); // 0=日, 6=土
    if (dow === 0 || dow === 6) continue;
    if (excluded.has(isoFromTs(t))) continue;
    count += 1;
  }
  return count;
}

/** 小数第2位以下を四捨五入(0.5切り上げ)して小数第1位に丸める。ここでは値は非負。 */
function roundToTenth(value) {
  return Math.round(value * 10 + Number.EPSILON * value * 10) / 10;
}

/** 期待される経過率を独立に算出する。 */
function expectedRate(periodStart, periodEnd, referenceDate, excluded) {
  if (referenceDate >= periodEnd) return 100.0;
  if (referenceDate < periodStart) return 0.0;
  const total = countBusinessDays(periodStart, periodEnd, excluded);
  if (total === 0) return 0.0;
  const elapsed = countBusinessDays(periodStart, referenceDate, excluded);
  let rate = roundToTenth((elapsed / total) * 100);
  if (rate < 0.0) return 0.0;
  if (rate > 100.0) return 100.0;
  return rate;
}

describe('progressRate - Property 15: 経過率の定義と範囲', () => {
  // Feature: overtime-tracker, Property 15: 経過率の定義と範囲
  it('任意の期間・基準日・除外日集合について、定義どおりの経過率を [0.0, 100.0] で返す', () => {
    const arb = fc.integer({ min: 0, max: 1200 }).chain((startOff) =>
      fc.integer({ min: 0, max: 200 }).chain((len) => {
        const endOff = startOff + len;
        return fc.record({
          startOff: fc.constant(startOff),
          endOff: fc.constant(endOff),
          // 基準日は期間の 30 日前〜30 日後まで（前・中・後を網羅）
          refOff: fc.integer({ min: startOff - 30, max: endOff + 30 }),
          // 除外日は期間内から選ぶ（分子・分母の双方に効くことを検証）
          excludedOffsets: fc.uniqueArray(
            fc.integer({ min: startOff, max: endOff }),
            { maxLength: 40 }
          ),
        });
      })
    );

    fc.assert(
      fc.property(arb, ({ startOff, endOff, refOff, excludedOffsets }) => {
        const periodStart = isoFromOffset(startOff);
        const periodEnd = isoFromOffset(endOff);
        const referenceDate = isoFromOffset(refOff);
        const excluded = new Set(excludedOffsets.map(isoFromOffset));

        const actual = progressRate(periodStart, periodEnd, referenceDate, excluded);
        const expected = expectedRate(periodStart, periodEnd, referenceDate, excluded);

        // 定義どおりの値（浮動小数の微差を許容）
        expect(Math.abs(actual - expected)).toBeLessThan(1e-9);
        // 範囲 [0.0, 100.0]（要件6.1, 6.2）
        expect(actual).toBeGreaterThanOrEqual(0.0);
        expect(actual).toBeLessThanOrEqual(100.0);
        // 境界（要件6.3, 6.4）
        if (referenceDate >= periodEnd) {
          expect(actual).toBe(100.0);
        } else if (referenceDate < periodStart) {
          expect(actual).toBe(0.0);
        }
      }),
      { numRuns: 100 }
    );
  });
});

describe('progressRate - 境界条件の代表例（要件6.3, 6.4, 6.5）', () => {
  it('基準日が期間末日以降なら 100.0', () => {
    // 2024-01-01(月) 〜 2024-01-05(金)
    expect(progressRate('2024-01-01', '2024-01-05', '2024-01-05', new Set())).toBe(100.0);
    expect(progressRate('2024-01-01', '2024-01-05', '2024-02-01', new Set())).toBe(100.0);
  });

  it('基準日が期間初日より前なら 0.0', () => {
    expect(progressRate('2024-01-08', '2024-01-12', '2024-01-01', new Set())).toBe(0.0);
  });

  it('期間全体が週末で総営業日数が 0 なら 0.0', () => {
    // 2024-01-06(土) 〜 2024-01-07(日)
    expect(progressRate('2024-01-06', '2024-01-07', '2024-01-06', new Set())).toBe(0.0);
  });

  it('除外により総営業日数が 0 なら 0.0（基準日は末日より前）', () => {
    // 2024-01-01(月)〜01-05(金) の平日をすべて除外 → 総営業日 0。
    // 基準日 01-02 は末日より前なので 100.0 判定に先取りされず、分母 0 → 0.0。
    const excluded = new Set([
      '2024-01-01',
      '2024-01-02',
      '2024-01-03',
      '2024-01-04',
      '2024-01-05',
    ]);
    expect(progressRate('2024-01-01', '2024-01-05', '2024-01-02', excluded)).toBe(0.0);
  });

  it('期間の途中で概ね半分なら約 50%（2024-01-01(月)〜01-10(水)、基準01-05(金)）', () => {
    // 営業日: 01,02,03,04,05,08,09,10 = 8日、経過: 01〜05 = 5日 → 62.5%
    expect(progressRate('2024-01-01', '2024-01-10', '2024-01-05', new Set())).toBe(62.5);
  });
});
