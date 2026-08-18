// @ts-check
/**
 * Overtime Tracker - アプリケーションエントリポイント
 *
 * 起動時のオーケストレーションを担う配線層。副作用（DOM 参照・ストレージ・ファイル I/O）を
 * 伴うアダプタ層（fileIO / dataStore / ui）とドメイン層（src/core/）を結線する。
 * 外部ネットワークへは一切アクセスせず、単一フォルダ内の HTML/JavaScript のみで `file://`
 * からも起動できる（要件14.1, 14.2, 14.3）。
 *
 * 起動シーケンス（design.md「起動エラー」「再計算フロー」および要件13.2/13.3/14.4/3.1）:
 *   1. checkRequiredAssets(): 必要なローカルアセット（CSS / JS モジュール / #app ルート）を検査する。
 *      不足があれば描画を行わず、#app に起動中止メッセージ（不足ファイル一覧）を表示する（要件14.4）。
 *   2. Data_Store.load(): 保存済み状態を復元する（要件13.2）。無し／破損なら null。
 *      null の場合は空状態（基準日＝当日、要件13.3, 3.1）を生成する。破損時（保存はあったが
 *      読み込めない）には復元失敗の通知を UI に表示する（要件13.4）。
 *   3. createUI(...).mount(): ドメイン層・アダプタ層を結線した UI を初期描画する。
 *
 * @module main
 */

import { createFileIO } from './adapters/fileIO.js';
import { createDataStore } from './adapters/dataStore.js';
import { createUI, createInitialState, todayISO } from './adapters/ui.js';

/**
 * @typedef {import('./core/types.js').AppState} AppState
 */

/**
 * 起動中止メッセージを #app（または document.body）へ描画する（要件14.4）。
 * UI の初期描画は行わず、不足しているアセットの一覧を提示する。
 * @param {Document} doc
 * @param {string[]} missing 不足しているアセットのパス／要素一覧
 * @returns {void}
 */
function renderStartupAbort(doc, missing) {
  const root =
    (typeof doc.getElementById === 'function' && doc.getElementById('app')) ||
    doc.body ||
    doc.documentElement;
  if (!root) return;

  root.textContent = '';

  const section = doc.createElement('section');
  section.className = 'startup-error';
  section.setAttribute('role', 'alert');

  const heading = doc.createElement('h2');
  heading.textContent = '起動できませんでした';
  section.appendChild(heading);

  const desc = doc.createElement('p');
  desc.textContent =
    '起動に必要なファイルの一部が見つかりません。以下のファイルが同じフォルダに揃っているか確認してください。';
  section.appendChild(desc);

  const list = doc.createElement('ul');
  for (const item of missing) {
    const li = doc.createElement('li');
    li.textContent = item;
    list.appendChild(li);
  }
  section.appendChild(list);

  root.appendChild(section);
}

/**
 * アプリケーションを初期化する。アセット検査 → 状態復元 → UI 初期描画の順に配線する。
 * DOM が利用できない環境（テスト等で document が無い場合）は何もしない。
 * @param {Document} [doc] 使用する Document（テスト注入用）。既定は globalThis.document。
 * @returns {void}
 */
export function init(doc = typeof document !== 'undefined' ? document : /** @type {any} */ (undefined)) {
  if (!doc) {
    // DOM 非対応環境では起動処理を行わない。
    return;
  }

  // アダプタ層を生成する（既定の環境依存物＝document / localStorage / File API を使用）。
  const fileIO = createFileIO({ document: doc });
  const dataStore = createDataStore();

  // 1. 起動アセット検査（要件14.4）。不足があれば描画せず中止メッセージを表示する。
  const assetCheck = fileIO.checkRequiredAssets();
  if (!assetCheck.ok) {
    renderStartupAbort(doc, assetCheck.missing);
    return;
  }

  // 2. 保存済み状態の復元（要件13.2）。無し／破損は null → 空状態で起動（要件13.3, 3.1）。
  const today = todayISO();
  let restored = null;
  try {
    restored = dataStore.load();
  } catch {
    // load は通常例外を投げないが、想定外の環境例外に備えて空状態へフォールバックする。
    restored = null;
  }
  const state = restored || createInitialState(today);

  // 3. UI を結線して初期描画する。ドメイン層は UI 内部で結線済み。
  const ui = createUI({
    document: doc,
    state,
    dataStore,
    fileIO,
    today,
  });
  ui.mount();
}

// ブラウザで読み込まれた際のエントリポイント。file:// でも type="module" として実行される。
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init());
  } else {
    init();
  }
}
