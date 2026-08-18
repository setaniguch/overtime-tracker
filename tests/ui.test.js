// @vitest-environment jsdom
// @ts-check
/**
 * UI 状態遷移のユニットテスト（tasks.md 17.3）。
 *
 * createUI（src/adapters/ui.js）のコントローラ経由で、DOM 表示と状態遷移を検証する。
 * jsdom 環境（本ファイル冒頭の per-file 指定）で実行し、グローバル vitest 設定
 * （environment: 'node'）は変更しない。
 *
 * 検証対象の受け入れ基準:
 * - 要件1.2: 作成済み年度を選択すると当該年度の日次エントリ・集計を表示する。
 * - 要件1.5: 既存年度の再作成を拒否し、既存の日次エントリを保持する。
 * - 要件1.6: 未作成年度を選択すると日次エントリが無い旨を表示し作成を促す。
 * - 要件3.2: 基準日を有効日へ変更すると集計（月合計等）を再計算して表示更新する。
 * - 要件4.2: 実績/予測の入力に応じて該当月の月合計表示を更新する。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createUI } from '../src/adapters/ui.js';

/**
 * #app ルートを用意し、UI を mount して返す。
 * @param {{ today?: string }} [opts]
 */
function setup(opts = {}) {
  document.body.innerHTML = '<div id="app"></div>';
  const ui = createUI({ today: opts.today || '2026-05-15' });
  ui.mount();
  return ui;
}

/** メッセージ領域のテキストを返す。 */
function messageText() {
  const el = document.getElementById('message');
  return el ? el.textContent || '' : '';
}

/**
 * 集計表から、指定した月ラベル（例: '5月'）の月合計セルのテキストを返す。
 * @param {string} label
 * @returns {string|null}
 */
function monthlyTotalText(label) {
  // 列順の変更に強いよう、ヘッダから「月合計」列のインデックスを求めて参照する。
  const heads = Array.from(
    document.querySelectorAll('#summary .summary-table thead th'),
  ).map((th) => th.textContent || '');
  const colIndex = heads.indexOf('月合計');
  if (colIndex < 0) return null;
  const rows = document.querySelectorAll('#summary .summary-table tbody tr');
  for (const tr of Array.from(rows)) {
    const tds = tr.querySelectorAll('td');
    if (tds.length > colIndex && (tds[0].textContent || '') === label) {
      return tds[colIndex].textContent;
    }
  }
  return null;
}

/**
 * 指定日の実績入力欄へ値を入力し change を発火する。
 * @param {string} dateISO
 * @param {string} value
 */
function enterActualHours(dateISO, value) {
  const input = /** @type {HTMLInputElement} */ (
    document.querySelector(`tr[data-date="${dateISO}"] input.actual`)
  );
  if (!input) throw new Error(`入力欄が見つかりません: ${dateISO}`);
  input.value = value;
  input.dispatchEvent(new Event('change'));
}

describe('createUI - UI 状態遷移', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('要件1.2: 作成済み年度を選択すると日次エントリと集計を表示する', () => {
    const ui = setup({ today: '2026-05-15' });
    // 2026 年度を作成後、別の年度へ移動してから作成済み年度を再選択する。
    ui.createSelectedYear();
    ui.selectYear(2025); // 未作成年度へ移動
    ui.selectYear(2026); // 作成済み年度を選択

    expect(ui.getState().selectedStartYear).toBe(2026);
    // 作成済み年度なので日次入力グリッド（テーブル）が表示される。
    expect(document.querySelector('#grid .grid-table')).not.toBeNull();
    expect(document.querySelector('#grid .empty-year')).toBeNull();
    // 集計表も表示される。
    expect(document.querySelector('#summary .summary-table')).not.toBeNull();
    expect(messageText()).toContain('2026年度を表示');
  });

  it('要件1.5: 既存年度の再作成を拒否し既存の日次エントリを保持する', () => {
    const ui = setup({ today: '2026-05-15' });
    ui.createSelectedYear();

    const state = ui.getState();
    const fy = state.fiscalYears.find((f) => f.startYear === 2026);
    expect(fy).toBeTruthy();
    const entriesRef = fy.entries;
    // 既存年度にデータを入れておく（保持されるべき対象）。
    entriesRef[0].actualHours = 4.2;
    const lengthBefore = state.fiscalYears.length;

    // 同じ年度をもう一度作成しようとする。
    ui.createSelectedYear();

    // 拒否され、年度数は増えず、既存エントリ（参照・値）は保持される。
    expect(ui.getState().fiscalYears.length).toBe(lengthBefore);
    expect(ui.getState().fiscalYears.find((f) => f.startYear === 2026).entries).toBe(entriesRef);
    expect(entriesRef[0].actualHours).toBe(4.2);
    expect(messageText()).toContain('既に存在します');
  });

  it('要件1.6: 未作成年度を選択すると案内を表示し作成を促す', () => {
    const ui = setup({ today: '2026-05-15' });
    // 2030 年度は未作成のまま選択する。
    ui.selectYear(2030);

    expect(ui.getState().selectedStartYear).toBe(2030);
    // 日次エントリが無い旨の案内（empty-year）が表示され、グリッドテーブルは無い。
    expect(document.querySelector('#grid .empty-year')).not.toBeNull();
    expect(document.querySelector('#grid .grid-table')).toBeNull();
    expect(messageText()).toContain('未作成');
  });

  it('要件3.2: 基準日を有効日へ変更すると月合計を再計算して表示更新する', () => {
    const ui = setup({ today: '2026-05-01' });
    ui.createSelectedYear();

    // 5/15 の実績と予測を別値にし、基準日をまたぐと採用値が切り替わるようにする。
    const fy = ui.getState().fiscalYears.find((f) => f.startYear === 2026);
    const entry = fy.entries.find((e) => e.date === '2026-05-15');
    expect(entry).toBeTruthy();
    entry.actualHours = 2.0;
    entry.predictedHours = 5.0;

    // 基準日が 5/15 より前 → 予測（5.0）を集計に採用。
    expect(ui.setReferenceDate('2026-05-10')).toBe(true);
    const before = monthlyTotalText('5月');

    // 基準日が 5/15 以降 → 実績（2.0）を集計に採用。
    expect(ui.setReferenceDate('2026-05-20')).toBe(true);
    const after = monthlyTotalText('5月');

    expect(before).toBe('5.0');
    expect(after).toBe('2.0');
    expect(before).not.toBe(after);
  });

  it('要件3.2(補): 無効な日付は拒否し変更前の基準日を保持する', () => {
    const ui = setup({ today: '2026-05-01' });
    const original = ui.getState().referenceDate;
    expect(ui.setReferenceDate('2026-02-30')).toBe(false);
    expect(ui.getState().referenceDate).toBe(original);
  });

  it('要件4.2: 実績時間の入力で該当月の月合計表示が更新される', () => {
    // 基準日を年度末側にし、5/15 が基準日以前（実績採用）となるようにする。
    const ui = setup({ today: '2026-05-31' });
    ui.createSelectedYear();

    // 入力前は月合計 0.0。
    expect(monthlyTotalText('5月')).toBe('0.0');

    // 5/15 の実績欄へ 3.5 を入力（change 発火）。
    enterActualHours('2026-05-15', '3.5');

    // 該当月（5月）の月合計表示が更新される。
    expect(monthlyTotalText('5月')).toBe('3.5');
  });
});
