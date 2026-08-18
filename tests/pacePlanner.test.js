// @ts-check
/**
 * Pace_Planner（残業ペース配分）のプロパティテスト。
 *
 * Feature: overtime-tracker
 * Property 33: 残余残業予算の算出 (Validates: Requirements 15.2)
 * Property 34: 残り月数の算出 (Validates: Requirements 15.3)
 * Property 35: 月あたり配分の算出と超過時の扱い (Validates: Requirements 15.4, 15.5, 15.6)
 *
 * computePacePlan(entries, startYear, referenceDate, annualCap?) を、独立に実装した
 * オラクルと突き合わせて検証する。丸め規約は inputManager.roundToTenth を再利用する。
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computePacePlan } from '../src/core/pacePlanner.js';
import { roundToTenth } from '../src/core/inputManager.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 4 桁ゼロ埋め。 */
function pad4(n) {
  return String(n).padStart(4, '0');
}

/** UTC タイムスタンプ（ミリ秒）を "YYYY-MM-DD" に変換する。 */
function isoFromTs(t) {
  const d = new Date(t);
  return `${pad4(d.getUTCFullYear())}-${String(d.getUTCMonth() + 1).padStart(
    2,
    '0'
  )}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** date から曜日文字を導出する（型整合のためだけに保持。算出には未使用）。 */
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
function weekdayOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** 年度開始年から年度開始日（4/1）の UTC タイムスタンプを返す。 */
function fyStartTs(startYear) {
  return Date.UTC(startYear, 3, 1); // 4月 = index 3
}

/** 年度期間の判定（"YYYY-MM-DD" の辞書順比較）。 */
function isWithinFiscalYear(date, startYear) {
  return date >= `${pad4(startYear)}-04-01` && date <= `${pad4(startYear + 1)}-03-31`;
}

/**
 * 独立オラクル: 年度内で基準日以前（当日含む）の実績残業時間合計（既消化）。
 */
function consumedOracle(entries, startYear, referenceDate) {
  let sum = 0;
  for (const e of entries) {
    if (!isWithinFiscalYear(e.date, startYear)) continue;
    if (e.date > referenceDate) continue;
    if (e.actualHours === null) continue;
    sum += e.actualHours;
  }
  return roundToTenth(sum);
}

/**
 * 独立オラクル: 残り月数（基準日が属する月〜翌年3月、属する月を含む）。
 * 年度開始より前 → 12、年度末より後 → 0。
 */
function remainingMonthsOracle(referenceDate, startYear) {
  const [refYear, refMonth] = referenceDate.split('-').map(Number);
  const index = (refYear - startYear) * 12 + (refMonth - 4);
  if (index < 0) return 12;
  if (index > 11) return 0;
  return 12 - index;
}

/** 独立オラクル: 期待される PacePlan（コードと同じ判定優先順位）。 */
function pacePlanOracle(entries, startYear, referenceDate, annualCap) {
  const consumed = consumedOracle(entries, startYear, referenceDate);
  const remainingBudget = roundToTenth(annualCap - consumed);
  const remainingMonths = remainingMonthsOracle(referenceDate, startYear);
  if (remainingBudget < 0) {
    return { kind: 'over_cap', remainingBudget, monthlyAllowance: 0.0 };
  }
  if (remainingMonths === 0) {
    return { kind: 'year_ended' };
  }
  const monthlyAllowance = roundToTenth(remainingBudget / remainingMonths);
  return { kind: 'normal', remainingBudget, remainingMonths, monthlyAllowance };
}

/**
 * 日次エントリ生成器。年度開始年を与えると、年度前後を含む日付オフセット上に
 * エントリを配置する。actualHours は null または小数第1位の非負値。
 * @param {number} startYear
 * @param {{minHours?: number, maxHours?: number}} [opts]
 */
function entriesArb(startYear, opts = {}) {
  const { minHours = 0, maxHours = 14.9 } = opts;
  const base = fyStartTs(startYear);
  return fc.array(
    fc.record({
      // -60〜430日: 年度前・年度内(0〜364)・年度後を網羅（年度フィルタを検証）
      offset: fc.integer({ min: -60, max: 430 }),
      // 実績は null か [minHours, maxHours] の 0.1 刻み
      actual: fc.oneof(
        fc.constant(null),
        fc
          .integer({ min: Math.round(minHours * 10), max: Math.round(maxHours * 10) })
          .map((x) => x / 10)
      ),
      predicted: fc.oneof(
        fc.constant(null),
        fc.integer({ min: 0, max: 149 }).map((x) => x / 10)
      ),
    }),
    { maxLength: 40 }
  ).map((rows) =>
    rows.map((r) => {
      const iso = isoFromTs(base + r.offset * DAY_MS);
      return {
        date: iso,
        weekday: weekdayOf(iso),
        actualHours: r.actual,
        predictedHours: r.predicted,
        note: '',
      };
    })
  );
}

describe('computePacePlan - Property 33: 残余残業予算の算出', () => {
  // Feature: overtime-tracker, Property 33: 残余残業予算の算出
  it('残余残業予算は「年間上限 −（年度内で基準日以前の実績残業時間の合計）」に等しい', () => {
    const arb = fc.integer({ min: 2020, max: 2030 }).chain((startYear) =>
      fc.record({
        startYear: fc.constant(startYear),
        entries: entriesArb(startYear),
        // 基準日は年度内（4/1〜翌3/31）→ 結果は normal か over_cap（両者とも remainingBudget を持つ）
        refOffset: fc.integer({ min: 0, max: 364 }),
        annualCap: fc.integer({ min: 0, max: 5000 }).map((x) => x / 10), // 0.0〜500.0
      })
    );

    fc.assert(
      fc.property(arb, ({ startYear, entries, refOffset, annualCap }) => {
        const referenceDate = isoFromTs(fyStartTs(startYear) + refOffset * DAY_MS);
        const plan = computePacePlan(entries, startYear, referenceDate, annualCap);

        const expectedBudget = roundToTenth(
          annualCap - consumedOracle(entries, startYear, referenceDate)
        );

        // 基準日が年度内なので year_ended は発生しない
        expect(plan.kind === 'normal' || plan.kind === 'over_cap').toBe(true);
        // @ts-ignore - normal/over_cap はともに remainingBudget を持つ
        expect(plan.remainingBudget).toBeCloseTo(expectedBudget, 9);
      }),
      { numRuns: 100 }
    );
  });
});

describe('computePacePlan - Property 34: 残り月数の算出', () => {
  // Feature: overtime-tracker, Property 34: 残り月数の算出
  it('年度内の基準日について、残り月数は属する月〜翌年3月の月数（属する月含む）で 1〜12 に収まる', () => {
    const arb = fc.integer({ min: 2020, max: 2030 }).chain((startYear) =>
      fc.record({
        startYear: fc.constant(startYear),
        // actualHours を小さく抑え、consumed < cap を保証して kind を normal に固定する
        entries: entriesArb(startYear, { minHours: 0, maxHours: 0.5 }),
        refOffset: fc.integer({ min: 0, max: 364 }),
      })
    );

    fc.assert(
      fc.property(arb, ({ startYear, entries, refOffset }) => {
        const referenceDate = isoFromTs(fyStartTs(startYear) + refOffset * DAY_MS);
        // 年間上限 360.0、実績最大 0.5*40=20.0 < 360 → 残余予算 >= 0 → normal
        const plan = computePacePlan(entries, startYear, referenceDate, 360.0);

        expect(plan.kind).toBe('normal');
        const expectedMonths = remainingMonthsOracle(referenceDate, startYear);
        // @ts-ignore - normal は remainingMonths を持つ
        expect(plan.remainingMonths).toBe(expectedMonths);
        // @ts-ignore
        expect(plan.remainingMonths).toBeGreaterThanOrEqual(1);
        // @ts-ignore
        expect(plan.remainingMonths).toBeLessThanOrEqual(12);
      }),
      { numRuns: 100 }
    );
  });
});

describe('computePacePlan - Property 35: 月あたり配分の算出と超過時の扱い', () => {
  // Feature: overtime-tracker, Property 35: 月あたり配分の算出と超過時の扱い
  it('normal は残余予算÷残り月数(小数第1位)、残余予算<0 は over_cap(配分0.0)、残り月数0 は year_ended', () => {
    const arb = fc.integer({ min: 2020, max: 2030 }).chain((startYear) =>
      fc.record({
        startYear: fc.constant(startYear),
        entries: entriesArb(startYear),
        // 基準日を年度前・年度内・年度後まで広げて全分岐を網羅する
        refOffset: fc.integer({ min: -60, max: 430 }),
        // 上限を小さめにも取り、over_cap を出やすくする
        annualCap: fc.integer({ min: 0, max: 4000 }).map((x) => x / 10), // 0.0〜400.0
      })
    );

    fc.assert(
      fc.property(arb, ({ startYear, entries, refOffset, annualCap }) => {
        const referenceDate = isoFromTs(fyStartTs(startYear) + refOffset * DAY_MS);
        const plan = computePacePlan(entries, startYear, referenceDate, annualCap);
        const expected = pacePlanOracle(entries, startYear, referenceDate, annualCap);

        expect(plan.kind).toBe(expected.kind);
        if (expected.kind === 'normal') {
          // @ts-ignore
          expect(plan.remainingBudget).toBeCloseTo(expected.remainingBudget, 9);
          // @ts-ignore
          expect(plan.remainingMonths).toBe(expected.remainingMonths);
          // 月あたり配分 = 残余予算 ÷ 残り月数（小数第1位）
          // @ts-ignore
          expect(plan.monthlyAllowance).toBeCloseTo(expected.monthlyAllowance, 9);
        } else if (expected.kind === 'over_cap') {
          // 残余予算 < 0 → 配分 0.0 + 超過扱い
          // @ts-ignore
          expect(plan.remainingBudget).toBeLessThan(0);
          // @ts-ignore
          expect(plan.monthlyAllowance).toBe(0.0);
        } else {
          // year_ended → 配分は算出されない
          expect(plan).toEqual({ kind: 'year_ended' });
        }
      }),
      { numRuns: 100 }
    );
  });
});
