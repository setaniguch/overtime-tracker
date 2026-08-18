// @ts-check
/**
 * Property-based tests for Input_Manager (src/core/inputManager.js).
 *
 * 対応タスク: tasks.md 3.2〜3.7（Property 4〜9）。
 * design.md「Correctness Properties」および「ジェネレータ設計」に従い、
 * fast-check + Vitest で各プロパティを最低100回反復して検証する。
 */
import { describe, it } from 'vitest';
import fc from 'fast-check';
import { parseHours, validateNote } from '../src/core/inputManager.js';

/** 値の一致判定に用いる微小許容誤差（浮動小数点表現の遊び）。 */
const VALUE_EPSILON = 1e-9;

/** 1日の残業時間の上限（この値以上は拒否）。要件2.6。 */
const MAX_HOURS_EXCLUSIVE = 15.0;

/**
 * x を小数第1位へ round-half-up で丸めた値を、実装とは独立に算出する。
 * parseHours / roundToTenth が採用すべき丸め規約（小数第2位以下を四捨五入）を
 * テスト側で再定義したもの。
 * @param {number} x
 * @returns {number}
 */
function expectedRoundHalfUpToTenth(x) {
  return Math.floor(x * 10 + 0.5) / 10;
}

describe('Input_Manager - parseHours / validateNote (properties)', () => {
  // Feature: overtime-tracker, Property 4: 任意の実数 x（0.0 <= x < 15.0）について、parseHours はまず x を小数第1位へ四捨五入（round-half-up）する。丸めた値が 15.0 未満なら受理してその値を採用し（結果は 0.0 以上 15.0 未満かつ 0.1 の整数倍）、丸めた値が 15.0 以上（[14.95, 15.0) の入力）なら理由 'too_large' で拒否する。
  it('Property 4: 残業時間の丸めと範囲', () => {
    fc.assert(
      // [14.95, 15.0) の境界帯を含めて [0.0, 15.0) を網羅する。
      fc.property(fc.double({ min: 0, max: 14.999999999, noNaN: true }), (x) => {
        const raw = String(x);
        const result = parseHours(raw);
        // 実装とは独立に期待する丸め値を算出（round-half-up）。
        const expected = expectedRoundHalfUpToTenth(x);

        if (expected >= MAX_HOURS_EXCLUSIVE) {
          // 丸めた値が 15.0 以上なら拒否（理由 'too_large'）。
          if (result.ok) {
            throw new Error(`expected reject (too_large) for ${raw} (rounds to ${expected}), got accept ${result.value}`);
          }
          if (result.reason !== 'too_large') {
            throw new Error(`expected reason 'too_large' for ${raw}, got '${result.reason}'`);
          }
          return;
        }

        // 丸めた値が 15.0 未満なら受理し、その丸め値を採用する。
        if (!result.ok) {
          throw new Error(`expected accept for ${raw} (rounds to ${expected}), got reject ${result.reason}`);
        }
        const v = result.value;
        // 採用値は独立に算出した丸め値に一致する。
        if (Math.abs(v - expected) > VALUE_EPSILON) {
          throw new Error(`value mismatch for ${raw}: got ${v}, expected ${expected}`);
        }
        // 範囲 [0.0, 15.0)
        if (!(v >= 0.0 && v < MAX_HOURS_EXCLUSIVE)) {
          throw new Error(`value out of range [0.0, 15.0): ${v}`);
        }
        // 0.1 の整数倍
        if (Math.abs(v * 10 - Math.round(v * 10)) > VALUE_EPSILON) {
          throw new Error(`value not a multiple of 0.1: ${v}`);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: overtime-tracker, Property 5: 長さ 500 以下の任意の文字列について、validateNote は受理し、保存される値は入力と等しい。
  it('Property 5: 備考の受理', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (note) => {
        const result = validateNote(note);
        if (!result.ok) {
          throw new Error(`expected accept for length ${note.length}, got reject ${result.reason}`);
        }
        if (result.value !== note) {
          throw new Error(`stored value differs from input`);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: overtime-tracker, Property 6: 0 未満の任意の数値入力について、parseHours は拒否し、理由は 'negative' である。
  it('Property 6: 負の残業時間の拒否', () => {
    fc.assert(
      fc.property(fc.double({ min: -100000, max: -1e-6, noNaN: true }), (x) => {
        const result = parseHours(String(x));
        if (result.ok) {
          throw new Error(`expected reject for ${x}, got accept ${result.value}`);
        }
        if (result.reason !== 'negative') {
          throw new Error(`expected reason 'negative' for ${x}, got '${result.reason}'`);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: overtime-tracker, Property 7: 15.0 以上の任意の数値入力について、parseHours は拒否し、理由は 'too_large' である。
  it('Property 7: 過大な残業時間の拒否', () => {
    fc.assert(
      fc.property(fc.double({ min: 15.0, max: 100000, noNaN: true }), (x) => {
        const result = parseHours(String(x));
        if (result.ok) {
          throw new Error(`expected reject for ${x}, got accept ${result.value}`);
        }
        if (result.reason !== 'too_large') {
          throw new Error(`expected reason 'too_large' for ${x}, got '${result.reason}'`);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: overtime-tracker, Property 8: 数値として解釈できない任意の文字列について、parseHours は拒否し、理由は 'not_number' である。
  it('Property 8: 非数値入力の拒否', () => {
    const nonNumeric = fc.string().filter((s) => {
      const trimmed = s.trim();
      // 数値として解釈できない = 空（空白のみ含む）または Number() が有限にならない。
      return trimmed === '' || !Number.isFinite(Number(trimmed));
    });
    fc.assert(
      fc.property(nonNumeric, (s) => {
        const result = parseHours(s);
        if (result.ok) {
          throw new Error(`expected reject for ${JSON.stringify(s)}, got accept ${result.value}`);
        }
        if (result.reason !== 'not_number') {
          throw new Error(`expected reason 'not_number' for ${JSON.stringify(s)}, got '${result.reason}'`);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: overtime-tracker, Property 9: 長さ 500 を超える任意の文字列について、validateNote は拒否し、理由は 'too_long' である。
  it('Property 9: 過長な備考の拒否', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 501 }), (note) => {
        const result = validateNote(note);
        if (result.ok) {
          throw new Error(`expected reject for length ${note.length}, got accept`);
        }
        if (result.reason !== 'too_long') {
          throw new Error(`expected reason 'too_long', got '${result.reason}'`);
        }
      }),
      { numRuns: 100 },
    );
  });
});
