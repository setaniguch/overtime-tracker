// @ts-check
/**
 * Overtime Tracker - Input_Manager（入力検証・丸め）
 *
 * 副作用のない純粋関数群。日次の残業時間（実績・予測）と備考の検証・丸めを担う。
 * ドメイン層は「採用すべき値」または「拒否理由」を結果型で返すのみで、状態の
 * 書き換え（既存値の保持を含む）は呼び出し側（UI 層）が行う。例外は投げない。
 *
 * 丸め規約: すべての時間値は「小数第2位以下を四捨五入して小数第1位（0.1刻み）」。
 * 受理範囲: 0.0 以上 15.0 未満（要件2.1, 2.2, 2.6）。備考は最大500文字（要件2.3, 2.8）。
 *
 * 設計書（design.md）の Input_Manager コンポーネント仕様に対応する。
 * @module core/inputManager
 */

/**
 * 残業時間の検証結果。
 * 受理時は 0.1 刻みに丸めた 0.0〜15.0 未満の値を、拒否時は理由を返す。
 * @typedef {(
 *   { ok: true, value: number }
 *   | { ok: false, reason: ('not_number'|'negative'|'too_large') }
 * )} HoursResult
 */

/**
 * 備考の検証結果。
 * @typedef {(
 *   { ok: true, value: string }
 *   | { ok: false, reason: 'too_long' }
 * )} NoteResult
 */

/** 1日の残業時間の上限（この値以上は拒否）。要件2.6。 */
const MAX_HOURS_EXCLUSIVE = 15.0;

/** 備考の最大文字数。要件2.3, 2.8。 */
const MAX_NOTE_LENGTH = 500;

/**
 * 数値を「小数第2位以下を四捨五入して小数第1位（0.1刻み）」に丸める。
 * 四捨五入は 0.5 切り上げ（round half up）。
 * @param {number} value 丸め対象の数値
 * @returns {number} 0.1 の整数倍に丸めた値
 */
export function roundToTenth(value) {
  // value*10 を整数へ四捨五入し 10 で割る。負値でも対称に扱えるよう符号を分離する。
  const sign = value < 0 ? -1 : 1;
  const scaled = Math.abs(value) * 10;
  // 0.5 を加えて floor するだけで正しい round-half-up になる。JS の乗算 value*10 は
  // 既に最近接の double へ正しく丸められるため、追加のイプシロン補正は不要。
  // むしろ補正を加えると 14.9499999999… のような境界直下の値を誤って 15.0 まで
  // 押し上げてしまう（丸め結果が本来 14.9 であるべきところを過大に丸める）ため加えない。
  const rounded = Math.floor(scaled + 0.5);
  return (sign * rounded) / 10;
}

/**
 * 残業時間の生入力文字列を検証し、受理時は丸めた値を返す。
 *
 * 判定順（要件2.5, 2.6, 2.7）:
 * 1. 数値として解釈できない（空文字・非数値・非有限）→ 拒否理由 'not_number'
 * 2. 元の値が 0 未満 → 拒否理由 'negative'
 * 3. まず 0.1 刻みに丸め、丸めた値が 15.0 以上 → 拒否理由 'too_large'
 *    （[14.95, 15.0) の入力は丸めると 15.0 になるため、ここで正しく拒否される）
 * 4. 上記以外（丸めた値が 0.0〜15.0未満）→ 受理し、その丸めた値を返す
 *
 * 範囲判定は丸めた後の値に対して行う。これにより「採用・保存される値」が
 * 常に 0.0 以上 15.0 未満（design.md Property 4 の不変条件）を満たす。
 * 一方 'negative' 判定は元の数値の符号で行う（-0.02 が 0.0 に丸まって
 * 負値の拒否を取りこぼすことを防ぐ。要件2.5）。
 *
 * いずれの拒否でも状態は書き換えず、結果型を返すのみ（既存値の保持は呼び出し側の責務）。
 * @param {string} raw 利用者が入力した生文字列
 * @returns {HoursResult}
 */
export function parseHours(raw) {
  const trimmed = (typeof raw === 'string' ? raw : String(raw ?? '')).trim();
  // 空文字・空白のみは数値として解釈できない（Number('') が 0 になる罠を回避）。
  if (trimmed === '') {
    return { ok: false, reason: 'not_number' };
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    return { ok: false, reason: 'not_number' };
  }
  // 'negative' は元の値の符号で判定する（-0.02 が 0.0 に丸まる取りこぼしを防ぐ）。
  if (n < 0) {
    return { ok: false, reason: 'negative' };
  }
  // 先に丸めてから範囲判定する。これにより保存値が常に [0.0, 15.0) を満たす。
  const rounded = roundToTenth(n);
  if (rounded >= MAX_HOURS_EXCLUSIVE) {
    return { ok: false, reason: 'too_large' };
  }
  return { ok: true, value: rounded };
}

/**
 * 備考文字列を検証する。500文字以内なら受理し、そのままの値を返す（要件2.3）。
 * 500文字を超える場合は拒否理由 'too_long' を返す（要件2.8）。拒否時に状態は書き換えない。
 * @param {string} raw 備考の生入力
 * @returns {NoteResult}
 */
export function validateNote(raw) {
  const value = typeof raw === 'string' ? raw : String(raw ?? '');
  if (value.length > MAX_NOTE_LENGTH) {
    return { ok: false, reason: 'too_long' };
  }
  return { ok: true, value };
}
