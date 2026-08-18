// @ts-check
/**
 * Overtime Tracker - Data_Store テスト（fast-check + Vitest）
 *
 * 永続化アダプタ（src/adapters/dataStore.js）を検証する。
 *
 * - 14.2 プロパティテスト: Property 32「永続化状態のシリアライズ往復」（要件13.2）。
 *   任意の AppState について save → load が元の状態に一致することを確認する。
 * - 14.3 ユニットテスト: 保存タイミング（2秒デバウンス・要件13.1）、破損データの
 *   空起動（要件13.4）、保存失敗時のメモリ保持（要件13.5）を localStorage モックと
 *   フェイクタイマーで検証する。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import {
  createDataStore,
  STORAGE_KEY,
  SCHEMA_VERSION,
} from '../src/adapters/dataStore.js';

// --- テスト用の最小 localStorage モック（Map ベース） ---------------------

/**
 * Web Storage 互換の最小インメモリ実装。テストで注入する。
 * @returns {{ getItem: (k: string) => (string|null), setItem: (k: string, v: string) => void, removeItem: (k: string) => void, _map: Map<string, string> }}
 */
function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? /** @type {string} */ (map.get(k)) : null),
    setItem: (k, v) => {
      map.set(k, String(v));
    },
    removeItem: (k) => {
      map.delete(k);
    },
    _map: map,
  };
}

// --- Property 32 用のジェネレータ ---------------------------------------

const weekdayArb = fc.constantFrom('月', '火', '水', '木', '金', '土', '日');

/** "YYYY-MM-DD"（ゼロ埋め）形式の日付文字列を生成する。 */
const dateISOArb = fc
  .record({
    y: fc.integer({ min: 2000, max: 2100 }),
    m: fc.integer({ min: 1, max: 12 }),
    d: fc.integer({ min: 1, max: 28 }),
  })
  .map(
    ({ y, m, d }) =>
      `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  );

// 実績/予測の値域（0.0〜14.99）。JSON 往復で不安定な -0 は +0 に正規化する。
const nonNegHoursArb = fc
  .double({ min: 0, max: 14.99, noNaN: true })
  .map((v) => v + 0);
const hoursArb = fc.option(nonNegHoursArb, { nil: null });

const dailyEntryArb = fc.record({
  date: dateISOArb,
  weekday: weekdayArb,
  actualHours: hoursArb,
  predictedHours: hoursArb,
  note: fc.string({ maxLength: 500 }),
});

const fiscalYearArb = fc.record({
  startYear: fc.integer({ min: 2000, max: 2100 }),
  entries: fc.array(dailyEntryArb, { maxLength: 6 }),
});

/** 完全な AppState 生成器（Property 32）。schemaVersion は現行値に固定する。 */
const appStateArb = fc.record({
  referenceDate: dateISOArb,
  selectedStartYear: fc.integer({ min: 2000, max: 2100 }),
  fiscalYears: fc.array(fiscalYearArb, { maxLength: 3 }),
  excludedDates: fc.array(dateISOArb, { maxLength: 5 }),
  annualCap: fc.double({ min: 0, max: 10000, noNaN: true }).map((v) => v + 0),
  schemaVersion: fc.constant(SCHEMA_VERSION),
});

// =========================================================================
// 14.2 Property 32: 永続化状態のシリアライズ往復（要件13.2）
// =========================================================================

describe('14.2 Data_Store: 永続化状態のシリアライズ往復（Property 32）', () => {
  it('任意の AppState について save → load が元の状態に一致する', async () => {
    // Feature: overtime-tracker, Property 32: 任意の AppState について、
    // シリアライズしてデシリアライズすると元の状態に一致する（保存・復元でデータが失われない）。
    await fc.assert(
      fc.asyncProperty(appStateArb, async (state) => {
        const storage = createMemoryStorage();
        const store = createDataStore({ storage });

        // save はデバウンスされるため flush で書き込みを確定させる。
        store.save(state);
        await store.flush();

        const loaded = store.load();
        expect(loaded).toEqual(state);
      }),
      { numRuns: 100 }
    );
  });
});

// =========================================================================
// 14.3 保存タイミング・破損・保存失敗のユニットテスト（要件13.1, 13.4, 13.5）
// =========================================================================

/** テスト用の妥当な AppState を生成する。 */
function makeState(overrides = {}) {
  return {
    referenceDate: '2026-04-01',
    selectedStartYear: 2026,
    fiscalYears: [
      {
        startYear: 2026,
        entries: [
          {
            date: '2026-04-01',
            weekday: '水',
            actualHours: 1.5,
            predictedHours: null,
            note: '',
          },
        ],
      },
    ],
    excludedDates: [],
    annualCap: 360,
    schemaVersion: SCHEMA_VERSION,
    ...overrides,
  };
}

describe('14.3 Data_Store: 保存タイミング（要件13.1）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('変更発生から2秒以内（デバウンス満了時）に1回だけ保存する', () => {
    const storage = createMemoryStorage();
    const setItemSpy = vi.spyOn(storage, 'setItem');
    const store = createDataStore({ storage });

    const state = makeState();
    store.save(state);

    // 呼び出し直後には書き込まれない。
    expect(setItemSpy).not.toHaveBeenCalled();

    // 2秒未満（1999ms）ではまだ書き込まれない。
    vi.advanceTimersByTime(1999);
    expect(setItemSpy).not.toHaveBeenCalled();

    // 2秒到達で1回だけ書き込まれる。
    vi.advanceTimersByTime(1);
    expect(setItemSpy).toHaveBeenCalledTimes(1);

    // 保存内容は元の状態を復元できる。
    expect(store.load()).toEqual(state);
  });

  it('デバウンス期間中の複数回の変更は最後の状態に集約され1回だけ書き込まれる', () => {
    const storage = createMemoryStorage();
    const setItemSpy = vi.spyOn(storage, 'setItem');
    const store = createDataStore({ storage });

    const stateA = makeState({ annualCap: 360 });
    const stateB = makeState({ annualCap: 420 });

    store.save(stateA);
    vi.advanceTimersByTime(1000); // 満了前に再度変更
    store.save(stateB); // タイマーがリセットされる

    // 直近の save から 2秒未満では未書き込み。
    vi.advanceTimersByTime(1999);
    expect(setItemSpy).not.toHaveBeenCalled();

    // 直近の save から 2秒到達で1回だけ書き込み、内容は最後の状態。
    vi.advanceTimersByTime(1);
    expect(setItemSpy).toHaveBeenCalledTimes(1);
    expect(store.load()).toEqual(stateB);
  });
});

describe('14.3 Data_Store: 破損データの空起動（要件13.4）', () => {
  it('JSON として解釈できない保存データは load() が null を返す', () => {
    const storage = createMemoryStorage();
    storage.setItem(STORAGE_KEY, '{ this is not valid json ');
    const store = createDataStore({ storage });

    expect(store.load()).toBeNull();
  });

  it('schemaVersion が不整合な保存データは load() が null を返す', () => {
    const storage = createMemoryStorage();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify(makeState({ schemaVersion: 999 }))
    );
    const store = createDataStore({ storage });

    expect(store.load()).toBeNull();
  });

  it('必須フィールドを欠く保存データは load() が null を返す', () => {
    const storage = createMemoryStorage();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ referenceDate: '2026-04-01', schemaVersion: SCHEMA_VERSION })
    );
    const store = createDataStore({ storage });

    expect(store.load()).toBeNull();
  });

  it('保存データが存在しない場合は load() が null を返す（空状態で起動）', () => {
    const storage = createMemoryStorage();
    const store = createDataStore({ storage });

    expect(store.load()).toBeNull();
  });
});

describe('14.3 Data_Store: 保存失敗時のメモリ保持（要件13.5）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('保存領域の容量不足（setItem 例外）時は save が reject し、既存の保存内容は破壊されない', async () => {
    const storage = createMemoryStorage();

    // 既存の妥当なデータを事前に保存しておく（元のsetItemを使用）。
    const previous = makeState({ annualCap: 360 });
    storage.setItem(STORAGE_KEY, JSON.stringify(previous));

    // 以降の setItem は容量不足で失敗するようにする。
    const quotaError = new Error('QuotaExceededError');
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw quotaError;
    });

    const store = createDataStore({ storage });
    const newState = makeState({ annualCap: 420 });

    // reject を先に監視してから、デバウンスを満了させる。
    const p = store.save(newState);
    const assertion = expect(p).rejects.toBe(quotaError);
    vi.advanceTimersByTime(2000);
    await assertion;

    // 書き込みに失敗したため、ストレージ上の以前の内容は保持される
    // （呼び出し側はメモリ上の newState を保持し続けられる）。
    expect(store.load()).toEqual(previous);
  });

  it('ストレージ自体が利用不可（null）な場合も save が reject する', async () => {
    const store = createDataStore({ storage: null });

    const p = store.save(makeState());
    const assertion = expect(p).rejects.toThrow(/not available/);
    vi.advanceTimersByTime(2000);
    await assertion;
  });
});
