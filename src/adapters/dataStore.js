// @ts-check
/**
 * Overtime Tracker - Data_Store（localStorage 永続化アダプタ）
 *
 * 副作用（ストレージ I/O）を担うアダプタ層。ドメイン層とは異なり、ここでは
 * 保存・復元の失敗を捕捉して呼び出し側へ通知する責務を持つ。
 *
 * - save(state): 変更を 2 秒デバウンスでまとめて 1 回だけ書き込む（要件13.1）。
 *   デバウンス期間中に複数回呼ばれても、最後の状態のみが書き込まれる。
 *   保存に失敗（容量不足＝QuotaExceededError 等）した場合は、返した Promise を
 *   reject して呼び出し側へ通知する（要件13.5）。メモリ上の状態は本アダプタでは
 *   保持しない（保持は呼び出し側の責務）。
 * - load(): 保存済みデータを復元する（要件13.2）。データが無ければ null（要件13.3）、
 *   JSON 解析失敗または schemaVersion 不整合（破損）なら null を返す（要件13.4）。
 *
 * テスト容易性のため factory 関数 `createDataStore(options)` を提供し、ストレージ・
 * タイマー・デバウンス時間を注入できるようにする（既定は globalThis.localStorage）。
 *
 * 設計書（design.md）の Data_Store コンポーネント仕様に対応する。
 * @module adapters/dataStore
 */

/**
 * @typedef {import('../core/types.js').AppState} AppState
 */

/** localStorage に用いる固定キー。 */
export const STORAGE_KEY = 'overtime-tracker:appState';

/** 現行のスキーマバージョン。読み込み時にこの値と一致しなければ破損とみなす（要件13.4）。 */
export const SCHEMA_VERSION = 1;

/** 既定のデバウンス時間（ミリ秒）。要件13.1 の「2秒以内」に対応。 */
export const DEBOUNCE_MS = 2000;

/**
 * 最小限の Web Storage 互換インタフェース（テスト時に注入可能）。
 * @typedef {Object} StorageLike
 * @property {(key: string) => (string|null)} getItem
 * @property {(key: string, value: string) => void} setItem
 * @property {(key: string) => void} [removeItem]
 */

/**
 * createDataStore のオプション。
 * @typedef {Object} DataStoreOptions
 * @property {StorageLike|null} [storage] 使用するストレージ。既定は globalThis.localStorage。
 *   利用不可（file:// 等で未定義）の場合は null 相当として扱う。
 * @property {number} [debounceMs] デバウンス時間（ミリ秒）。既定は DEBOUNCE_MS。
 * @property {(handler: () => void, ms: number) => any} [setTimeoutFn] タイマー設定関数（テスト注入用）。
 * @property {(id: any) => void} [clearTimeoutFn] タイマー解除関数（テスト注入用）。
 */

/**
 * Data_Store インスタンス。
 * @typedef {Object} DataStore
 * @property {(state: AppState) => Promise<void>} save 2秒デバウンスで保存する。
 * @property {() => (AppState|null)} load 復元する。無し/破損時は null。
 * @property {() => Promise<void>} flush 保留中の保存を即時実行する（主にテスト・終了時用）。
 * @property {() => void} cancel 保留中の保存を取り消す。
 */

/**
 * globalThis.localStorage を安全に取得する。file:// やアクセス不可環境では null を返す。
 * @returns {StorageLike|null}
 */
function getDefaultStorage() {
  try {
    const ls = /** @type {any} */ (globalThis).localStorage;
    if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') {
      return /** @type {StorageLike} */ (ls);
    }
  } catch {
    // Some environments throw on access (e.g. security-restricted iframes / file://).
  }
  return null;
}

/**
 * 復元した生オブジェクトが最低限 AppState の形をしているかを検証する。
 * schemaVersion の一致に加え、必須フィールドの型を軽く確認して破損を弾く。
 * @param {any} obj JSON.parse 結果
 * @returns {obj is AppState}
 */
function isValidAppState(obj) {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    obj.schemaVersion === SCHEMA_VERSION &&
    typeof obj.referenceDate === 'string' &&
    typeof obj.selectedStartYear === 'number' &&
    Array.isArray(obj.fiscalYears) &&
    Array.isArray(obj.excludedDates) &&
    typeof obj.annualCap === 'number'
  );
}

/**
 * Data_Store を生成する。ストレージ・タイマーを注入できるためユニットテスト可能。
 * @param {DataStoreOptions} [options]
 * @returns {DataStore}
 */
export function createDataStore(options = {}) {
  const storage =
    options.storage !== undefined ? options.storage : getDefaultStorage();
  const debounceMs =
    typeof options.debounceMs === 'number' ? options.debounceMs : DEBOUNCE_MS;
  const setTimeoutFn = options.setTimeoutFn || ((h, ms) => setTimeout(h, ms));
  const clearTimeoutFn = options.clearTimeoutFn || ((id) => clearTimeout(id));

  /** @type {any} 保留中デバウンスタイマーの識別子。 */
  let timerId = null;
  /** @type {AppState|null} 直近に save() で受け取った、まだ書き込んでいない状態。 */
  let pendingState = null;
  /** @type {Array<{resolve: () => void, reject: (e: any) => void}>} 保留中の save Promise。 */
  let pendingWaiters = [];

  /**
   * pendingState を実際にストレージへ書き込む。成功で resolve、失敗で reject する。
   * @returns {void}
   */
  function writeNow() {
    timerId = null;
    const stateToWrite = pendingState;
    const waiters = pendingWaiters;
    pendingState = null;
    pendingWaiters = [];

    if (stateToWrite === null) {
      // 書き込むものが無い（既に flush/cancel 済み）。
      for (const w of waiters) w.resolve();
      return;
    }

    if (storage === null) {
      // ストレージ利用不可は保存失敗として通知する（要件13.5）。
      const err = new Error('Storage is not available in this environment.');
      for (const w of waiters) w.reject(err);
      return;
    }

    try {
      const serialized = JSON.stringify({
        ...stateToWrite,
        schemaVersion: SCHEMA_VERSION,
      });
      storage.setItem(STORAGE_KEY, serialized);
      for (const w of waiters) w.resolve();
    } catch (err) {
      // QuotaExceededError やシリアライズ失敗を呼び出し側へ伝える（要件13.5）。
      for (const w of waiters) w.reject(err);
    }
  }

  /**
   * 状態を 2 秒デバウンスで保存する（要件13.1）。デバウンス期間中の複数回呼び出しは
   * 最後の状態に集約され、1 回だけ書き込まれる。返した Promise は実際の書き込み結果で
   * 解決/拒否される（保存失敗＝要件13.5 は reject）。
   * @param {AppState} state 保存対象の状態
   * @returns {Promise<void>}
   */
  function save(state) {
    pendingState = state;
    if (timerId !== null) {
      clearTimeoutFn(timerId);
    }
    return new Promise((resolve, reject) => {
      pendingWaiters.push({ resolve, reject });
      timerId = setTimeoutFn(writeNow, debounceMs);
    });
  }

  /**
   * 保存済みデータを復元する。無し（要件13.3）・破損（JSON 解析失敗 / schemaVersion 不整合、
   * 要件13.4）の場合は null を返す。復元成功時は AppState を返す（要件13.2）。
   * @returns {AppState|null}
   */
  function load() {
    if (storage === null) {
      return null;
    }
    let raw;
    try {
      raw = storage.getItem(STORAGE_KEY);
    } catch {
      // 読み取り自体が失敗する環境では空状態で起動する。
      return null;
    }
    if (raw === null || raw === undefined) {
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // JSON 解析失敗＝破損（要件13.4）。
      return null;
    }
    if (!isValidAppState(parsed)) {
      // schemaVersion 不整合や必須フィールド欠落＝破損（要件13.4）。
      return null;
    }
    return parsed;
  }

  /**
   * 保留中の保存を即時実行する。主にアプリ終了時やテストでの確定に用いる。
   * @returns {Promise<void>}
   */
  function flush() {
    if (timerId !== null) {
      clearTimeoutFn(timerId);
    }
    return new Promise((resolve, reject) => {
      // 既存の waiter に加えて、flush 完了も待てるようにする。
      pendingWaiters.push({ resolve, reject });
      writeNow();
    });
  }

  /**
   * 保留中の保存を取り消す。破棄された save の Promise は解決される（書き込みは行わない）。
   * @returns {void}
   */
  function cancel() {
    if (timerId !== null) {
      clearTimeoutFn(timerId);
      timerId = null;
    }
    const waiters = pendingWaiters;
    pendingState = null;
    pendingWaiters = [];
    for (const w of waiters) w.resolve();
  }

  return { save, load, flush, cancel };
}
