// @ts-check
/**
 * Overtime Tracker - UI 層（DOM 描画・イベント・再計算オーケストレーション）
 *
 * 副作用（DOM 参照・イベント・保存トリガ）を担うアダプタ層。ドメイン層（src/core/）の
 * 純粋関数群を呼び出して集計・警告・ペース配分を導出し、AppState を単一の状態源として
 * 管理する。ドメイン層は状態を書き換えないため、状態遷移（既存値の保持を含む）はすべて
 * 本モジュールが責務を負う。
 *
 * 主な責務:
 * - 年度選択・年度作成（未作成・既存年度の扱い。要件1.2, 1.5, 1.6）
 * - 日次入力グリッド（実績・予測・備考。検証失敗時は既存値を保持しエラーのみ表示。要件2系）
 * - 基準日入力（有効な暦日のみ採用。要件3.1, 3.2, 3.3）
 * - 集計表（月合計・月経過率・21日締め合計・営業日数・残営業日数・締め経過率・年間合計。要件4/5/6/7/8）
 * - 警告表示（現在の入力のみから再評価し、基準を下回れば自動解除。要件9/10, 10.5）
 * - ペース配分表示（年間上限360時間の残り月按分。要件15.1, 15.7）
 * - CSV 入出力（入力ツール/集計ツール互換。要件11/12）
 * - 変更時の永続化トリガ（Data_Store のデバウンス保存へ委譲。要件13.1）
 *
 * 再計算フロー（design.md「再計算フロー」）: 入力/基準日変更 → 検証 → 採用なら
 * 全集計・警告を再計算して表示更新 → 保存。検証失敗なら既存値を保持しエラー表示のみ。
 *
 * テスト容易性のため createUI(options) で document・dataStore・fileIO・today を注入できる。
 * @module adapters/ui
 */

import {
  fiscalYearDates,
  fiscalYearMonths,
  weekdayOf,
  isValidCalendarDate,
  cutoffPeriod,
  cutoffYearPeriod,
} from '../core/fiscalYear.js';
import { roundToTenth, parseHours, validateNote } from '../core/inputManager.js';
import {
  effectiveHours,
  allMonthlyTotals,
  annualActualTotal,
  annualPredictedTotal,
} from '../core/aggregator.js';
import { allCutoffTotals } from '../core/cutoffAggregator.js';
import { businessDays, remainingBusinessDays } from '../core/businessDayCalculator.js';
import { progressRate } from '../core/progressCalculator.js';
import { evaluateCompliance } from '../core/complianceChecker.js';
import { computePacePlan } from '../core/pacePlanner.js';
import { importInputCsv } from '../core/csvImporter.js';
import { exportInputCsv, exportSummaryCsv } from '../core/csvExporter.js';

/**
 * @typedef {import('../core/types.js').AppState} AppState
 * @typedef {import('../core/types.js').FiscalYearState} FiscalYearState
 * @typedef {import('../core/types.js').DailyEntry} DailyEntry
 * @typedef {import('../core/types.js').DateISO} DateISO
 * @typedef {import('../core/types.js').SummaryModel} SummaryModel
 */

/** 現行スキーマバージョン（Data_Store と一致させる）。 */
export const SCHEMA_VERSION = 1;

/** 年間残業上限の既定値（時間）。要件15.1。 */
export const DEFAULT_ANNUAL_CAP = 360.0;

/** 入力エクスポートの既定ファイル名（入力ツール互換）。 */
const INPUT_CSV_FILENAME = '残業入力ツール.csv';
/** 集計エクスポートの既定ファイル名（集計ツール互換）。 */
const SUMMARY_CSV_FILENAME = '残業集計ツール.csv';

/** 月見出し（集計表の左端表示用）。 */
const MONTH_LABELS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

// --------------------------------------------------------------------------
// 純粋ヘルパ（日付・状態生成・集計モデル構築）。DOM に依存しない。
// --------------------------------------------------------------------------

/**
 * 数値を4桁ゼロ埋め文字列にする。
 * @param {number} n
 * @returns {string}
 */
function pad4(n) {
  return String(n).padStart(4, '0');
}

/**
 * 数値を2桁ゼロ埋め文字列にする。
 * @param {number} n
 * @returns {string}
 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 指定年月の末日（日数）を返す。
 * @param {number} year
 * @param {number} month 1〜12
 * @returns {number}
 */
function lastDayOfMonth(year, month) {
  // Date.UTC(year, month, 0) は「month 月の 0 日」＝前月末＝当月末日。
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * システム日付（ローカル）を "YYYY-MM-DD" で返す。
 * @param {Date} [now]
 * @returns {DateISO}
 */
export function todayISO(now = new Date()) {
  return `${pad4(now.getFullYear())}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/**
 * "YYYY-MM-DD" が属する年度（開始年）を返す。4月以降はその年、1〜3月は前年。
 * @param {DateISO} dateISO
 * @returns {number}
 */
export function fiscalYearOfDate(dateISO) {
  const year = Number(dateISO.slice(0, 4));
  const month = Number(dateISO.slice(5, 7));
  return month >= 4 ? year : year - 1;
}

/**
 * 指定した年度開始年の空の年度状態を生成する（要件1.3, 1.4）。
 * 4/1〜翌3/31 の全日付分の日次エントリ（実績/予測=null、備考=""）を昇順で生成し、
 * 各エントリに暦上の曜日を付与する。
 * @param {number} startYear
 * @returns {FiscalYearState}
 */
export function createEmptyFiscalYear(startYear) {
  const entries = fiscalYearDates(startYear).map((date) => ({
    date,
    weekday: weekdayOf(date),
    actualHours: null,
    predictedHours: null,
    note: '',
  }));
  return { startYear, entries };
}

/**
 * 初期 AppState を生成する（保存データが無いときの空状態。要件13.3, 3.1）。
 * 基準日は当日、選択年度は当日が属する年度。作成済み年度は空。
 * @param {DateISO} [today]
 * @returns {AppState}
 */
export function createInitialState(today = todayISO()) {
  return {
    referenceDate: today,
    selectedStartYear: fiscalYearOfDate(today),
    fiscalYears: [],
    excludedDates: [],
    annualCap: DEFAULT_ANNUAL_CAP,
    schemaVersion: SCHEMA_VERSION,
  };
}

/**
 * 指定年度の年度状態を返す（無ければ null）。
 * @param {AppState} state
 * @param {number} startYear
 * @returns {FiscalYearState|null}
 */
export function getFiscalYear(state, startYear) {
  return state.fiscalYears.find((fy) => fy.startYear === startYear) || null;
}

/**
 * 営業日数計算で用いる除外日集合を構築する（要件7.5）。
 * 供給源: (a) state.excludedDates（利用者登録の祝日・休業日）、
 * (b) 備考に「有休」を含む日次エントリの日付。
 * @param {AppState} state
 * @returns {Set<DateISO>}
 */
export function computeExcludedSet(state) {
  const set = new Set(Array.isArray(state.excludedDates) ? state.excludedDates : []);
  for (const fy of state.fiscalYears) {
    for (const e of fy.entries) {
      if (typeof e.note === 'string' && e.note.includes('有休')) {
        set.add(e.date);
      }
    }
  }
  return set;
}

/**
 * 締め年度（3/21〜翌3/20）の対象残業合計を effectiveHours ベースで算出する（要件10.2）。
 * @param {DailyEntry[]} entries
 * @param {number} startYear
 * @param {DateISO} referenceDate
 * @returns {number}
 */
export function computeCutoffYearTotal(entries, startYear, referenceDate) {
  const { start, end } = cutoffYearPeriod(startYear);
  let sum = 0;
  for (const e of entries) {
    if (e.date < start || e.date > end) continue;
    const h = effectiveHours(e, referenceDate);
    if (h === null) continue;
    sum += h;
  }
  return roundToTenth(sum);
}

/**
 * 集計表（SummaryModel）を構築する（要件4/5/6/7/8, 12.2）。
 * 12か月（4月〜翌3月）それぞれについて、月合計・月経過率・21日締め合計（実績/予測）・
 * 営業日数・残営業日数・締め経過率を算出し、年間実績/予測合計を付す。
 * @param {DailyEntry[]} entries
 * @param {number} startYear
 * @param {DateISO} referenceDate
 * @param {Set<DateISO>} excluded
 * @returns {SummaryModel}
 */
export function buildSummaryModel(entries, startYear, referenceDate, excluded) {
  const months = fiscalYearMonths(startYear);
  const monthly = allMonthlyTotals(entries, startYear, referenceDate);
  const cutoffs = allCutoffTotals(entries, startYear);

  const rows = months.map(({ year, month }, i) => {
    const monthStart = `${pad4(year)}-${pad2(month)}-01`;
    const monthEnd = `${pad4(year)}-${pad2(month)}-${pad2(lastDayOfMonth(year, month))}`;
    const cp = cutoffPeriod(year, month);
    return {
      month,
      monthlyTotal: monthly[i].total,
      monthProgressRate: progressRate(monthStart, monthEnd, referenceDate, excluded),
      cutoffActual: cutoffs[i].actualTotal,
      cutoffPredicted: cutoffs[i].predictedTotal,
      businessDays: businessDays(monthStart, monthEnd, excluded),
      remainingBusinessDays: remainingBusinessDays(monthStart, monthEnd, referenceDate, excluded),
      cutoffProgressRate: progressRate(cp.start, cp.end, referenceDate, excluded),
    };
  });

  return {
    rows,
    referenceDate,
    annualActualTotal: annualActualTotal(entries, startYear),
    annualPredictedTotal: annualPredictedTotal(entries, startYear),
  };
}

// --------------------------------------------------------------------------
// 表示用フォーマッタ。
// --------------------------------------------------------------------------

/**
 * 時間値を小数第1位まで文字列化する。null/未入力は空文字。
 * @param {number|null|undefined} h
 * @returns {string}
 */
function fmtHours(h) {
  if (h === null || h === undefined || !Number.isFinite(h)) return '';
  return h.toFixed(1);
}

/**
 * 経過率を "xx.x%" で文字列化する。
 * @param {number|null|undefined} r
 * @returns {string}
 */
function fmtRate(r) {
  if (r === null || r === undefined || !Number.isFinite(r)) return '';
  return `${r.toFixed(1)}%`;
}

/**
 * "YYYY-MM-DD" を "YYYY/M/D" 表示へ変換する。
 * @param {DateISO} iso
 * @returns {string}
 */
function isoToSlash(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return String(iso ?? '');
  return `${m[1]}/${Number(m[2])}/${Number(m[3])}`;
}

// --------------------------------------------------------------------------
// createUI: DOM 描画・イベント・状態管理・再計算オーケストレーション。
// --------------------------------------------------------------------------

/**
 * createUI のオプション。
 * @typedef {Object} CreateUIOptions
 * @property {HTMLElement} [root] 描画先ルート要素。既定は document.getElementById('app')。
 * @property {Document} [document] 使用する Document。既定は globalThis.document。
 * @property {AppState} [state] 初期状態。既定は createInitialState()。
 * @property {{ save: (s: AppState) => Promise<void> }} [dataStore] 永続化アダプタ（save のみ利用）。
 * @property {{ readTextFile: (f: Blob) => Promise<string>, downloadCsv: (name: string, content: string) => void }} [fileIO] File I/O アダプタ。
 * @property {DateISO} [today] 当日（初期状態生成用）。既定は todayISO()。
 */

/**
 * UI コントローラ。
 * @typedef {Object} UIController
 * @property {() => void} mount 骨格を描画し初期表示する。
 * @property {() => AppState} getState 現在の状態（参照）を返す。
 * @property {(startYear: number) => void} selectYear 年度を選択する（未作成/既存を判定して表示）。
 * @property {() => void} createSelectedYear 現在選択中の年度を作成する（既存なら拒否）。
 * @property {(value: string) => boolean} setReferenceDate 基準日を設定する（無効なら false・既存保持）。
 * @property {(text: string) => void} importCsvText 入力ツール CSV テキストを取り込む。
 * @property {() => void} renderAll 全セクションを再描画する。
 * @property {(view: 'main'|'input') => void} showView 表示する画面を切り替える。
 */

/**
 * UI を生成する。副作用（DOM 参照・イベント登録・保存トリガ）はここに閉じ込める。
 * @param {CreateUIOptions} [options]
 * @returns {UIController}
 */
export function createUI(options = {}) {
  const doc =
    options.document !== undefined
      ? options.document
      : typeof document !== 'undefined'
        ? document
        : null;
  if (doc === null) {
    throw new Error('createUI: Document が利用できません。');
  }

  const root =
    options.root !== undefined
      ? options.root
      : /** @type {any} */ (doc).getElementById
        ? doc.getElementById('app')
        : null;
  if (!root) {
    throw new Error('createUI: ルート要素（#app）が見つかりません。');
  }

  const today = options.today || todayISO();
  /** @type {AppState} */
  let state = options.state || createInitialState(today);
  const dataStore = options.dataStore || null;
  const fileIO = options.fileIO || null;

  // 動的更新するコンテナ要素への参照（mount で生成）。
  /** @type {any} */ let elYearSelect = null;
  /** @type {any} */ let elMessage = null;
  /** @type {any} */ let elRefDate = null;
  /** @type {any} */ let elGrid = null;
  /** @type {any} */ let elSummary = null;
  /** @type {any} */ let elWarnings = null;
  /** @type {any} */ let elPace = null;
  /** @type {any} */ let elViewMain = null;
  /** @type {any} */ let elViewInput = null;
  /** @type {any} */ let elMainStats = null;
  /** @type {any} */ let elTabMain = null;
  /** @type {any} */ let elTabInput = null;
  /** @type {'main'|'input'} 現在表示中の画面。 */
  let currentView = 'main';
  /** @type {number} 入力画面で表示中の月（1〜12）。既定は基準日の月。 */
  let selectedInputMonth = Number(state.referenceDate.slice(5, 7)) || 4;
  /** @type {Set<string>} 利用者が非表示にした警告メッセージの集合（表示制御・メモリ保持）。 */
  const dismissedWarnings = new Set();

  /**
   * 要素を生成する小さなヘルパ。attrs は属性、text は textContent。
   * @param {string} tag
   * @param {Record<string, any>} [attrs]
   * @param {string} [text]
   * @returns {any}
   */
  function el(tag, attrs = {}, text) {
    const node = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (v !== undefined && v !== null) node.setAttribute(k, String(v));
    }
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * メッセージ領域に通知を表示する（要件のエラー/情報表示に対応）。
   * @param {string} text
   * @param {'error'|'info'|'success'} [kind]
   * @returns {void}
   */
  function showMessage(text, kind = 'info') {
    if (!elMessage) return;
    elMessage.textContent = text;
    elMessage.className = `message message-${kind}`;
  }

  /** メッセージ領域をクリアする。 */
  function clearMessage() {
    if (!elMessage) return;
    elMessage.textContent = '';
    elMessage.className = 'message';
  }

  /**
   * 変更を Data_Store へ保存トリガする（2秒デバウンスはアダプタ側。要件13.1）。
   * 保存失敗（容量不足等・要件13.5）は通知するがメモリ上の状態は保持する。
   * @returns {void}
   */
  function scheduleSave() {
    if (!dataStore || typeof dataStore.save !== 'function') return;
    Promise.resolve(dataStore.save(state)).catch(() => {
      showMessage('データの保存に失敗しました。入力内容はこの画面に保持されています。', 'error');
    });
  }

  /**
   * 現在選択中の年度のエントリ配列を返す（未作成なら空配列）。
   * @returns {DailyEntry[]}
   */
  function currentEntries() {
    const fy = getFiscalYear(state, state.selectedStartYear);
    return fy ? fy.entries : [];
  }

  /**
   * 全年度の日次エントリを平坦化して返す。締め期間（前月21日〜当月20日）が年度境界を
   * またぐ場合（例: 4月の締めは前年度の3/21〜3/31を含む）でも正しく集計できるよう、
   * 集計・警告・統計は選択年度単体ではなく全エントリ横断で行う。
   * @returns {DailyEntry[]}
   */
  function allEntries() {
    /** @type {DailyEntry[]} */
    const out = [];
    for (const fy of state.fiscalYears) {
      for (const e of fy.entries) out.push(e);
    }
    return out;
  }

  /**
   * "YYYY-MM-DD" の開始日〜終了日（両端含む）の日付列を昇順で返す。
   * @param {DateISO} startISO
   * @param {DateISO} endISO
   * @returns {DateISO[]}
   */
  function datesInRange(startISO, endISO) {
    /** @type {DateISO[]} */
    const dates = [];
    const s = Date.UTC(+startISO.slice(0, 4), +startISO.slice(5, 7) - 1, +startISO.slice(8, 10));
    const e = Date.UTC(+endISO.slice(0, 4), +endISO.slice(5, 7) - 1, +endISO.slice(8, 10));
    const DAY_MS = 24 * 60 * 60 * 1000;
    for (let t = s; t <= e; t += DAY_MS) {
      const d = new Date(t);
      dates.push(`${pad4(d.getUTCFullYear())}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`);
    }
    return dates;
  }

  /**
   * 指定日の日次エントリを全年度から取得する。存在しない場合は、その日付が属する年度を
   * 必要に応じて生成してエントリを作成し、実体（保存対象）への参照を返す。締め期間表示で
   * 年度境界をまたぐ日（例: 4月表示の3/21〜3/31）も編集・保存できるようにするため。
   * @param {DateISO} dateISO
   * @returns {DailyEntry}
   */
  function getOrCreateEntry(dateISO) {
    const sy = fiscalYearOfDate(dateISO);
    let fy = getFiscalYear(state, sy);
    if (!fy) {
      fy = createEmptyFiscalYear(sy);
      state.fiscalYears.push(fy);
    }
    let entry = fy.entries.find((e) => e.date === dateISO);
    if (!entry) {
      entry = {
        date: dateISO,
        weekday: weekdayOf(dateISO),
        actualHours: null,
        predictedHours: null,
        note: '',
      };
      fy.entries.push(entry);
      fy.entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    }
    return entry;
  }

  // ------------------------------------------------------------------------
  // 骨格描画（mount）。
  // ------------------------------------------------------------------------

  /**
   * アプリの骨格（コントロール・メッセージ・グリッド・集計・警告・ペース）を構築する。
   * @returns {void}
   */
  function mount() {
    root.textContent = '';

    // --- 共有コントロールバー（年度選択・作成・基準日）。両画面で共通。---
    const controls = el('section', { class: 'controls' });

    // 年度選択。
    const yearWrap = el('div', { class: 'control control-year' });
    yearWrap.appendChild(el('label', { for: 'year-select' }, '年度'));
    elYearSelect = el('select', { id: 'year-select' });
    elYearSelect.addEventListener('change', () => {
      selectYear(Number(elYearSelect.value));
    });
    yearWrap.appendChild(elYearSelect);
    const createBtn = el('button', { type: 'button', id: 'create-year' }, '年度を作成');
    createBtn.addEventListener('click', () => createSelectedYear());
    yearWrap.appendChild(createBtn);
    controls.appendChild(yearWrap);

    // 基準日。
    const refWrap = el('div', { class: 'control control-refdate' });
    refWrap.appendChild(el('label', { for: 'reference-date' }, '基準日（本日）'));
    elRefDate = el('input', { type: 'date', id: 'reference-date', value: state.referenceDate });
    elRefDate.addEventListener('change', () => {
      setReferenceDate(elRefDate.value);
    });
    refWrap.appendChild(elRefDate);
    controls.appendChild(refWrap);

    root.appendChild(controls);

    // --- 画面切り替えタブ（メイン画面 / 入力画面）。---
    const nav = el('nav', { class: 'view-nav', role: 'tablist' });
    elTabMain = el('button', { type: 'button', class: 'tab', id: 'tab-main', role: 'tab' }, '📊 メイン画面');
    elTabMain.addEventListener('click', () => showView('main'));
    elTabInput = el('button', { type: 'button', class: 'tab', id: 'tab-input', role: 'tab' }, '✍ 入力画面');
    elTabInput.addEventListener('click', () => showView('input'));
    nav.appendChild(elTabMain);
    nav.appendChild(elTabInput);
    root.appendChild(nav);

    // --- メッセージ領域。両画面で共通。---
    elMessage = el('div', { class: 'message', id: 'message', role: 'status' });
    root.appendChild(elMessage);

    // --- メイン画面: 年度統計 → ペース配分 → 警告 → 集計表 →（下部）集計CSV出力。---
    elViewMain = el('section', { class: 'view view-main', id: 'view-main', role: 'tabpanel' });

    elMainStats = el('section', { class: 'main-stats', id: 'main-stats' });
    elViewMain.appendChild(elMainStats);

    elPace = el('section', { class: 'pace', id: 'pace' });
    elViewMain.appendChild(elPace);

    elWarnings = el('section', { class: 'warnings', id: 'warnings' });
    elViewMain.appendChild(elWarnings);

    elSummary = el('section', { class: 'summary', id: 'summary' });
    elViewMain.appendChild(elSummary);

    const mainActions = el('div', { class: 'view-actions view-actions-bottom' });
    const exportSummaryBtn = el('button', { type: 'button', id: 'export-summary' }, '集計CSV出力');
    exportSummaryBtn.addEventListener('click', () => handleExportSummary());
    mainActions.appendChild(exportSummaryBtn);
    elViewMain.appendChild(mainActions);

    root.appendChild(elViewMain);

    // --- 入力画面: 日次入力グリッド →（下部）CSV取込・入力CSV出力。---
    elViewInput = el('section', { class: 'view view-input', id: 'view-input', role: 'tabpanel' });

    elGrid = el('section', { class: 'grid', id: 'grid' });
    elViewInput.appendChild(elGrid);

    const inputActions = el('div', { class: 'view-actions view-actions-bottom' });
    const importLabel = el('label', { class: 'button', for: 'csv-import' }, 'CSV 取込');
    const importInput = el('input', { type: 'file', id: 'csv-import', accept: '.csv,text/csv' });
    importInput.style.display = 'none';
    importInput.addEventListener('change', () => {
      const file = importInput.files && importInput.files[0];
      if (file) handleImportFile(file);
      importInput.value = '';
    });
    inputActions.appendChild(importLabel);
    inputActions.appendChild(importInput);
    const exportInputBtn = el('button', { type: 'button', id: 'export-input' }, '入力CSV出力');
    exportInputBtn.addEventListener('click', () => handleExportInput());
    inputActions.appendChild(exportInputBtn);
    elViewInput.appendChild(inputActions);

    root.appendChild(elViewInput);

    renderYearSelector();
    renderGrid();
    renderAll();
    showView(currentView);
  }

  /**
   * 表示する画面を切り替える（メイン画面 / 入力画面）。
   * @param {'main'|'input'} view
   * @returns {void}
   */
  function showView(view) {
    currentView = view === 'input' ? 'input' : 'main';
    if (elViewMain) elViewMain.style.display = currentView === 'main' ? '' : 'none';
    if (elViewInput) elViewInput.style.display = currentView === 'input' ? '' : 'none';
    if (elTabMain) elTabMain.className = currentView === 'main' ? 'tab active' : 'tab';
    if (elTabInput) elTabInput.className = currentView === 'input' ? 'tab active' : 'tab';
  }

  // ------------------------------------------------------------------------
  // 年度選択・作成（要件1.2, 1.5, 1.6）。
  // ------------------------------------------------------------------------

  /**
   * 年度セレクタの選択肢を構築する。作成済み年度・選択年度・当年度周辺を候補に含め、
   * 未作成年度には「(未作成)」を付す。
   * @returns {void}
   */
  function renderYearSelector() {
    if (!elYearSelect) return;
    const created = new Set(state.fiscalYears.map((fy) => fy.startYear));
    const base = fiscalYearOfDate(today);
    /** @type {Set<number>} */
    const candidates = new Set();
    for (let y = base - 3; y <= base + 2; y++) candidates.add(y);
    for (const y of created) candidates.add(y);
    candidates.add(state.selectedStartYear);
    const sorted = Array.from(candidates).sort((a, b) => a - b);

    elYearSelect.textContent = '';
    for (const y of sorted) {
      const label = created.has(y) ? `${y}年度` : `${y}年度（未作成）`;
      const opt = el('option', { value: y }, label);
      if (y === state.selectedStartYear) opt.setAttribute('selected', 'selected');
      elYearSelect.appendChild(opt);
    }
    elYearSelect.value = String(state.selectedStartYear);
  }

  /**
   * 年度を選択する。作成済みなら該当年度のエントリと集計を表示（要件1.2）、
   * 未作成なら日次エントリが無い旨を表示し作成を促す（要件1.6）。
   * @param {number} startYear
   * @returns {void}
   */
  function selectYear(startYear) {
    if (!Number.isInteger(startYear)) return;
    state.selectedStartYear = startYear;
    renderYearSelector();
    renderGrid();
    renderAll();
    if (getFiscalYear(state, startYear)) {
      showMessage(`${startYear}年度を表示しています。`, 'info');
    } else {
      showMessage(
        `${startYear}年度は未作成です。日次エントリがありません。「年度を作成」ボタンで作成してください。`,
        'info',
      );
    }
    scheduleSave();
  }

  /**
   * 現在選択中の年度を作成する。既に存在する場合は作成を拒否し、既存エントリを保持した
   * まま既存である旨を表示する（要件1.5）。未作成なら全日付分の空エントリを生成する（要件1.3）。
   * @returns {void}
   */
  function createSelectedYear() {
    const startYear = state.selectedStartYear;
    if (getFiscalYear(state, startYear)) {
      showMessage(`${startYear}年度は既に存在します。既存のデータを保持します。`, 'error');
      return;
    }
    state.fiscalYears.push(createEmptyFiscalYear(startYear));
    renderYearSelector();
    renderGrid();
    renderAll();
    showMessage(`${startYear}年度を作成しました。`, 'success');
    scheduleSave();
  }

  // ------------------------------------------------------------------------
  // 基準日（要件3.1, 3.2, 3.3）。
  // ------------------------------------------------------------------------

  /**
   * 基準日を設定する。有効な暦日なら採用して全集計・警告・残営業日数・ペースを再計算し（要件3.2）、
   * 無効な日付なら変更前の基準日を保持しエラーを表示する（要件3.3）。
   * @param {string} value "YYYY-MM-DD"
   * @returns {boolean} 採用したら true
   */
  function setReferenceDate(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    const valid = m && isValidCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (!valid) {
      // 既存の基準日を保持し、入力欄も元に戻す（要件3.3）。
      if (elRefDate) elRefDate.value = state.referenceDate;
      showMessage('有効な日付（実在する年月日）を入力してください。', 'error');
      return false;
    }
    state.referenceDate = value;
    if (elRefDate) elRefDate.value = value;
    clearMessage();
    renderAll();
    scheduleSave();
    return true;
  }

  // ------------------------------------------------------------------------
  // 日次入力グリッド（要件2系・検証失敗時は既存値保持）。
  // ------------------------------------------------------------------------

  /**
   * 日次入力グリッドを描画する。選択年度が未作成なら作成を促す案内を表示する（要件1.6）。
   * @returns {void}
   */
  function renderGrid() {
    if (!elGrid) return;
    elGrid.textContent = '';
    const fy = getFiscalYear(state, state.selectedStartYear);

    const heading = el('h2', {}, `${state.selectedStartYear}年度 日次入力`);
    elGrid.appendChild(heading);

    if (!fy) {
      elGrid.appendChild(
        el(
          'p',
          { class: 'empty-year' },
          `${state.selectedStartYear}年度の日次エントリはまだありません。「年度を作成」ボタンで作成してください。`,
        ),
      );
      return;
    }

    // --- 月切り替えナビ（4月〜翌3月）。選択した1か月分のみ表示する。---
    elGrid.appendChild(renderMonthNav());

    // 選択中の月に属する暦年（4〜12月は開始年、1〜3月は翌年）。
    const targetYear =
      selectedInputMonth >= 4 ? state.selectedStartYear : state.selectedStartYear + 1;
    // 20日締め・21日開始: 表示範囲は締め期間（前月21日〜当月20日）。
    // 例: 4月を選ぶと 3/21〜4/20 を表示する。
    const cp = cutoffPeriod(targetYear, selectedInputMonth);
    const monthEntries = datesInRange(cp.start, cp.end).map((d) => getOrCreateEntry(d));

    const monthTitle = el(
      'h3',
      { class: 'grid-month-title' },
      `${targetYear}年 ${MONTH_LABELS[selectedInputMonth - 1]}分（${isoToSlash(cp.start)}〜${isoToSlash(cp.end)}）`,
    );
    elGrid.appendChild(monthTitle);

    // 締め期間が前年度にまたがり新たな年度を生成した場合に備え、年度セレクタを更新する。
    renderYearSelector();

    const excluded = computeExcludedSet(state);

    const table = el('table', { class: 'grid-table' });
    const thead = el('thead');
    const headRow = el('tr');
    for (const h of ['日付', '曜日', '実績', '予測', '備考']) {
      headRow.appendChild(el('th', {}, h));
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    let sumActual = 0;
    let sumPredicted = 0;
    const tbody = el('tbody');
    for (const entry of monthEntries) {
      tbody.appendChild(buildGridRow(entry, excluded));
      if (typeof entry.actualHours === 'number') sumActual += entry.actualHours;
      if (typeof entry.predictedHours === 'number') sumPredicted += entry.predictedHours;
    }
    table.appendChild(tbody);

    // 合計行（実績・予測の月合計）。
    const tfoot = el('tfoot');
    const totalRow = el('tr', { class: 'total-row' });
    totalRow.appendChild(el('td', {}, '合計'));
    totalRow.appendChild(el('td', {}, ''));
    totalRow.appendChild(el('td', {}, fmtHours(roundToTenth(sumActual))));
    totalRow.appendChild(el('td', {}, fmtHours(roundToTenth(sumPredicted))));
    totalRow.appendChild(el('td', {}, ''));
    tfoot.appendChild(totalRow);
    table.appendChild(tfoot);

    elGrid.appendChild(table);
  }

  /**
   * 入力画面の月切り替えナビ（前月・翌月ボタン ＋ 12か月ボタン）を構築する。
   * 年度の月順（4月〜翌3月）で並べ、選択中の月を強調する。
   * @returns {any}
   */
  function renderMonthNav() {
    const months = fiscalYearMonths(state.selectedStartYear); // 4月〜翌3月の12件
    const nav = el('div', { class: 'month-nav' });

    const prevBtn = el('button', { type: 'button', class: 'month-step', id: 'month-prev' }, '‹ 前の月');
    prevBtn.addEventListener('click', () => stepInputMonth(-1));
    nav.appendChild(prevBtn);

    const btns = el('div', { class: 'month-buttons' });
    for (const { month } of months) {
      const b = el(
        'button',
        { type: 'button', class: month === selectedInputMonth ? 'month-btn active' : 'month-btn' },
        MONTH_LABELS[month - 1],
      );
      b.addEventListener('click', () => {
        selectedInputMonth = month;
        renderGrid();
      });
      btns.appendChild(b);
    }
    nav.appendChild(btns);

    const nextBtn = el('button', { type: 'button', class: 'month-step', id: 'month-next' }, '次の月 ›');
    nextBtn.addEventListener('click', () => stepInputMonth(1));
    nav.appendChild(nextBtn);

    return nav;
  }

  /**
   * 表示月を年度の月順（4→…→12→1→2→3）で相対移動する。端では循環しない。
   * @param {number} delta -1（前月）または +1（翌月）
   * @returns {void}
   */
  function stepInputMonth(delta) {
    const order = fiscalYearMonths(state.selectedStartYear).map((m) => m.month);
    const idx = order.indexOf(selectedInputMonth);
    const nextIdx = Math.min(order.length - 1, Math.max(0, idx + delta));
    selectedInputMonth = order[nextIdx];
    renderGrid();
  }

  /**
   * 1日分の入力行を構築する。実績・予測・備考の各入力に検証付きのイベントを登録する。
   * 土日・除外日（祝日・有休）の行には off-day クラスを付す。
   * @param {DailyEntry} entry
   * @param {Set<DateISO>} [excluded] 除外日集合（祝日・有休）
   * @returns {any}
   */
  function buildGridRow(entry, excluded) {
    const isWeekend = entry.weekday === '土' || entry.weekday === '日';
    const isHoliday = excluded ? excluded.has(entry.date) : false;
    const tr = el('tr', { dataset: { date: entry.date } });
    if (isWeekend || isHoliday) tr.className = 'off-day';
    tr.appendChild(el('td', {}, isoToSlash(entry.date)));
    tr.appendChild(el('td', {}, entry.weekday));

    // 実績。
    const actualTd = el('td');
    const actualInput = el('input', {
      type: 'text',
      class: 'hours-input actual',
      inputmode: 'decimal',
      value: fmtHours(entry.actualHours),
    });
    actualInput.addEventListener('change', () => handleHoursChange(entry, 'actualHours', actualInput));
    actualTd.appendChild(actualInput);
    tr.appendChild(actualTd);

    // 予測。
    const predTd = el('td');
    const predInput = el('input', {
      type: 'text',
      class: 'hours-input predicted',
      inputmode: 'decimal',
      value: fmtHours(entry.predictedHours),
    });
    predInput.addEventListener('change', () => handleHoursChange(entry, 'predictedHours', predInput));
    predTd.appendChild(predInput);
    tr.appendChild(predTd);

    // 備考。
    const noteTd = el('td');
    const noteInput = el('input', { type: 'text', class: 'note-input', value: entry.note || '' });
    noteInput.addEventListener('change', () => handleNoteChange(entry, noteInput));
    noteTd.appendChild(noteInput);
    tr.appendChild(noteTd);

    return tr;
  }

  /**
   * 実績/予測の入力変更を処理する。空欄は未入力（null）として採用。数値は parseHours で
   * 検証し、採用時は丸めた値を保存して再計算する。検証失敗時は既存値を保持し、入力欄を
   * 元の値へ戻してエラーのみ表示する（要件2.1, 2.2, 2.5, 2.6, 2.7）。
   * @param {DailyEntry} entry
   * @param {'actualHours'|'predictedHours'} field
   * @param {any} input
   * @returns {void}
   */
  function handleHoursChange(entry, field, input) {
    const raw = input.value;
    if (typeof raw === 'string' && raw.trim() === '') {
      // 未入力（空欄）＝集計対象外（要件2.4）。
      entry[field] = null;
      input.value = '';
      clearMessage();
      recompute();
      return;
    }
    const result = parseHours(raw);
    if (result.ok) {
      entry[field] = result.value;
      input.value = fmtHours(result.value);
      clearMessage();
      recompute();
      return;
    }
    // 検証失敗: 既存値を保持し、入力欄を元へ戻す（要件2.5/2.6/2.7）。
    input.value = fmtHours(entry[field]);
    showMessage(hoursErrorMessage(result.reason), 'error');
  }

  /**
   * 備考の入力変更を処理する。500文字以内なら採用して再計算し（有休判定で除外日にも影響）、
   * 超過なら既存備考を保持し入力欄を戻してエラーのみ表示する（要件2.3, 2.8）。
   * @param {DailyEntry} entry
   * @param {any} input
   * @returns {void}
   */
  function handleNoteChange(entry, input) {
    const result = validateNote(input.value);
    if (result.ok) {
      entry.note = result.value;
      clearMessage();
      recompute();
      return;
    }
    input.value = entry.note || '';
    showMessage('備考は500文字以内で入力してください。', 'error');
  }

  /**
   * 残業時間の拒否理由を利用者向けメッセージへ写像する。
   * @param {'not_number'|'negative'|'too_large'} reason
   * @returns {string}
   */
  function hoursErrorMessage(reason) {
    switch (reason) {
      case 'negative':
        return '残業時間は0以上の値を入力してください。';
      case 'too_large':
        return '1日の残業時間は15時間未満で入力してください。';
      case 'not_number':
      default:
        return '残業時間は数値で入力してください。';
    }
  }

  // ------------------------------------------------------------------------
  // CSV 入出力（要件11, 12）。
  // ------------------------------------------------------------------------

  /**
   * 取込ファイルを読み込んで importCsvText へ渡す。
   * @param {Blob} file
   * @returns {void}
   */
  function handleImportFile(file) {
    if (!fileIO || typeof fileIO.readTextFile !== 'function') {
      showMessage('この環境ではファイルの読み込みができません。', 'error');
      return;
    }
    Promise.resolve(fileIO.readTextFile(file))
      .then((text) => importCsvText(text))
      .catch(() => showMessage('ファイルの読み込みに失敗しました。', 'error'));
  }

  /**
   * 入力ツール CSV テキストを取り込む。成功時は各エントリを、その日付が属する年度へ反映し、
   * 同一日付の既存エントリを上書きする（要件11.4）。未作成年度は自動生成する。失敗時は
   * 行番号付きエラーを表示し、既存の日次エントリを保持する（要件11.2, 11.5, 11.6）。
   * @param {string} text
   * @returns {void}
   */
  function importCsvText(text) {
    const result = importInputCsv(text);
    if (!result.ok) {
      showMessage(result.reason, 'error');
      return;
    }
    if (result.entries.length === 0) {
      showMessage('取り込み可能なデータがありませんでした。', 'info');
      return;
    }
    for (const imported of result.entries) {
      const startYear = fiscalYearOfDate(imported.date);
      let fy = getFiscalYear(state, startYear);
      if (!fy) {
        fy = createEmptyFiscalYear(startYear);
        state.fiscalYears.push(fy);
      }
      const target = fy.entries.find((e) => e.date === imported.date);
      if (target) {
        target.actualHours = imported.actualHours;
        target.predictedHours = imported.predictedHours;
        target.note = imported.note;
        target.weekday = imported.weekday;
      } else {
        // 年度期間外の日付（通常は起こらない）。当該年度へ追加し日付昇順を保つ。
        fy.entries.push({ ...imported });
        fy.entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      }
    }
    // 取り込んだ先頭エントリの年度を選択して表示する。
    state.selectedStartYear = fiscalYearOfDate(result.entries[0].date);
    renderYearSelector();
    renderGrid();
    renderAll();
    showMessage(`${result.entries.length}件の日次エントリを取り込みました。`, 'success');
    scheduleSave();
  }

  /**
   * 選択年度の日次エントリを入力ツール互換 CSV としてダウンロードする（要件12.1）。
   * @returns {void}
   */
  function handleExportInput() {
    if (!fileIO || typeof fileIO.downloadCsv !== 'function') {
      showMessage('この環境ではCSVのダウンロードができません。', 'error');
      return;
    }
    const csv = exportInputCsv(currentEntries());
    try {
      fileIO.downloadCsv(INPUT_CSV_FILENAME, csv);
      showMessage('入力CSVを出力しました。', 'success');
    } catch {
      showMessage('CSVの出力に失敗しました。', 'error');
    }
  }

  /**
   * 選択年度の集計結果を集計ツール互換 CSV としてダウンロードする（要件12.2）。
   * @returns {void}
   */
  function handleExportSummary() {
    if (!fileIO || typeof fileIO.downloadCsv !== 'function') {
      showMessage('この環境ではCSVのダウンロードができません。', 'error');
      return;
    }
    const excluded = computeExcludedSet(state);
    const summary = buildSummaryModel(allEntries(), state.selectedStartYear, state.referenceDate, excluded);
    const csv = exportSummaryCsv(summary);
    try {
      fileIO.downloadCsv(SUMMARY_CSV_FILENAME, csv);
      showMessage('集計CSVを出力しました。', 'success');
    } catch {
      showMessage('CSVの出力に失敗しました。', 'error');
    }
  }

  // ------------------------------------------------------------------------
  // 再計算と描画（要件4.2, 5.3, 7.3, 8.3, 9/10, 10.5, 15.7）。
  // ------------------------------------------------------------------------

  /**
   * 日次エントリ変更後の再計算と保存トリガ。集計・警告・ペースを更新する。
   * @returns {void}
   */
  function recompute() {
    renderAll();
    scheduleSave();
  }

  /**
   * 集計表・警告・ペース配分を現在の状態から再描画する。
   * @returns {void}
   */
  function renderAll() {
    // 締め期間が年度境界をまたぐため、集計・統計・警告は全年度横断のエントリで行う。
    const entries = allEntries();
    const startYear = state.selectedStartYear;
    const refDate = state.referenceDate;
    const excluded = computeExcludedSet(state);
    const summary = buildSummaryModel(entries, startYear, refDate, excluded);

    renderMainStats(computeYearStats(entries, startYear, refDate, excluded));
    renderSummary(summary);

    const cutoffYearTotal = computeCutoffYearTotal(entries, startYear, refDate);
    // 月45時間系の警告判定は「21日締め(実績)」を基準に評価する。
    const complianceTotals = summary.rows.map((r, i) => {
      const ym = fiscalYearMonths(startYear)[i];
      return { year: ym.year, month: ym.month, total: r.cutoffActual };
    });
    const warnings = evaluateCompliance(complianceTotals, cutoffYearTotal);
    renderWarnings(warnings);

    const plan = computePacePlan(entries, startYear, refDate, state.annualCap);
    renderPace(plan);
  }

  /**
   * 集計表を描画する（月合計・月経過率・21日締め合計・営業日数・残営業日数・締め経過率＋年間合計）。
   * @param {SummaryModel} summary
   * @returns {void}
   */
  function renderSummary(summary) {
    if (!elSummary) return;
    elSummary.textContent = '';
    elSummary.appendChild(el('h2', {}, '集計'));

    const table = el('table', { class: 'summary-table' });
    const thead = el('thead');
    const headRow = el('tr');
    for (const h of [
      '月',
      '21日締め経過率',
      '21日締め(実績)',
      '21日締め(予測)',
      '営業日数',
      '残営業日数',
      '月合計',
      '月経過率',
    ]) {
      headRow.appendChild(el('th', {}, h));
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    let sumMonthly = 0;
    let sumCutoffActual = 0;
    let sumCutoffPredicted = 0;

    const tbody = el('tbody');
    for (const row of summary.rows) {
      const tr = el('tr');
      tr.appendChild(el('td', {}, MONTH_LABELS[row.month - 1]));
      tr.appendChild(el('td', {}, fmtRate(row.cutoffProgressRate)));
      tr.appendChild(el('td', {}, fmtHours(row.cutoffActual)));
      tr.appendChild(el('td', {}, fmtHours(row.cutoffPredicted)));
      tr.appendChild(el('td', {}, String(row.businessDays)));
      tr.appendChild(el('td', {}, String(row.remainingBusinessDays)));
      tr.appendChild(el('td', {}, fmtHours(row.monthlyTotal)));
      tr.appendChild(el('td', {}, fmtRate(row.monthProgressRate)));
      tbody.appendChild(tr);
      sumMonthly += row.monthlyTotal;
      sumCutoffActual += row.cutoffActual;
      sumCutoffPredicted += row.cutoffPredicted;
    }
    table.appendChild(tbody);

    // 合計行（月合計・21日締め実績・21日締め予測の合計）。
    const tfoot = el('tfoot');
    const totalRow = el('tr', { class: 'total-row' });
    totalRow.appendChild(el('td', {}, '合計'));
    totalRow.appendChild(el('td', {}, '')); // 21日締め経過率
    totalRow.appendChild(el('td', {}, fmtHours(roundToTenth(sumCutoffActual))));
    totalRow.appendChild(el('td', {}, fmtHours(roundToTenth(sumCutoffPredicted))));
    totalRow.appendChild(el('td', {}, '')); // 営業日数
    totalRow.appendChild(el('td', {}, '')); // 残営業日数
    totalRow.appendChild(el('td', {}, fmtHours(roundToTenth(sumMonthly))));
    totalRow.appendChild(el('td', {}, '')); // 月経過率
    tfoot.appendChild(totalRow);
    table.appendChild(tfoot);

    elSummary.appendChild(table);
  }

  /**
   * 年度単位の統計（経過/残営業日数・1日平均・年間予測）を算出する。
   * 対象期間は年度（4/1〜翌3/31）。「これまでの残業時間」は基準日以前の実績合計。
   * @param {DailyEntry[]} entries
   * @param {number} startYear
   * @param {DateISO} refDate
   * @param {Set<DateISO>} excluded
   * @returns {{ totalBiz: number, elapsedBiz: number, remainingBiz: number, elapsedActual: number, dailyAvg: number, projectedAnnual: number }}
   */
  function computeYearStats(entries, startYear, refDate, excluded) {
    const yearStart = `${pad4(startYear)}-04-01`;
    const yearEnd = `${pad4(startYear + 1)}-03-31`;
    const totalBiz = businessDays(yearStart, yearEnd, excluded);
    const remainingBiz = remainingBusinessDays(yearStart, yearEnd, refDate, excluded);
    const elapsedBiz = Math.max(0, totalBiz - remainingBiz);

    let elapsedActual = 0;
    for (const e of entries) {
      if (
        e.date >= yearStart &&
        e.date <= yearEnd &&
        e.date <= refDate &&
        typeof e.actualHours === 'number'
      ) {
        elapsedActual += e.actualHours;
      }
    }
    elapsedActual = roundToTenth(elapsedActual);
    const dailyAvg = elapsedBiz > 0 ? roundToTenth(elapsedActual / elapsedBiz) : 0;
    const projectedAnnual = roundToTenth(dailyAvg * totalBiz);
    return { totalBiz, elapsedBiz, remainingBiz, elapsedActual, dailyAvg, projectedAnnual };
  }

  /**
   * 年度統計をカード形式で描画する（経過営業日数・残営業日数・1日平均・年間予測）。
   * @param {{ totalBiz: number, elapsedBiz: number, remainingBiz: number, elapsedActual: number, dailyAvg: number, projectedAnnual: number }} s
   * @returns {void}
   */
  function renderMainStats(s) {
    if (!elMainStats) return;
    elMainStats.textContent = '';
    elMainStats.appendChild(el('h2', {}, '年度サマリー'));

    const grid = el('div', { class: 'stats-grid' });
    /** @param {string} label @param {string} value */
    const card = (label, value) => {
      const c = el('div', { class: 'stat-card' });
      c.appendChild(el('div', { class: 'stat-label' }, label));
      c.appendChild(el('div', { class: 'stat-value' }, value));
      return c;
    };
    grid.appendChild(card('経過営業日数', `${s.elapsedBiz} 日`));
    grid.appendChild(card('残りの営業日数', `${s.remainingBiz} 日`));
    grid.appendChild(card('これまでの残業（実績）', `${fmtHours(s.elapsedActual)} 時間`));
    grid.appendChild(card('1日あたり残業平均', `${fmtHours(s.dailyAvg)} 時間 / 営業日`));
    grid.appendChild(card('このペースの年間予測', `${fmtHours(s.projectedAnnual)} 時間`));
    elMainStats.appendChild(grid);
  }

  /**
   * 警告リストを描画する（該当なしは「警告なし」を表示。要件9/10, 10.5）。
   * @param {ReturnType<typeof evaluateCompliance>} warnings
   * @returns {void}
   */
  function renderWarnings(warnings) {
    if (!elWarnings) return;
    elWarnings.textContent = '';
    elWarnings.appendChild(el('h2', {}, '警告'));

    const all = warnings || [];
    if (all.length === 0) {
      elWarnings.appendChild(el('p', { class: 'no-warnings' }, '現在、上限ルールに関する警告はありません。'));
      return;
    }

    const visible = all.filter((w) => !dismissedWarnings.has(w.message));
    const hiddenCount = all.length - visible.length;

    if (visible.length === 0) {
      elWarnings.appendChild(
        el('p', { class: 'no-warnings' }, `表示中の警告はありません（${hiddenCount}件を非表示中）。`),
      );
    } else {
      const severe = new Set(['OVER_69', 'CUTOFF_YEAR_690']);
      const ul = el('ul', { class: 'warning-list' });
      for (const w of visible) {
        const li = el('li', { class: severe.has(w.code) ? 'warning severe' : 'warning' });
        li.dataset.code = w.code;
        li.appendChild(el('span', { class: 'warning-text' }, w.message));
        const hideBtn = el('button', { type: 'button', class: 'warning-hide', title: 'この警告を非表示' }, '×');
        hideBtn.addEventListener('click', () => {
          dismissedWarnings.add(w.message);
          renderAll();
        });
        li.appendChild(hideBtn);
        ul.appendChild(li);
      }
      elWarnings.appendChild(ul);
    }

    if (hiddenCount > 0) {
      const showBtn = el(
        'button',
        { type: 'button', class: 'warning-show-all' },
        `非表示の警告 ${hiddenCount}件を再表示`,
      );
      showBtn.addEventListener('click', () => {
        dismissedWarnings.clear();
        renderAll();
      });
      elWarnings.appendChild(showBtn);
    }
  }

  /**
   * 残業ペース配分を描画する（要件15.1, 15.4, 15.5, 15.6, 15.7）。
   * @param {ReturnType<typeof computePacePlan>} plan
   * @returns {void}
   */
  function renderPace(plan) {
    if (!elPace) return;
    elPace.textContent = '';
    elPace.appendChild(el('h2', {}, '残業ペース配分'));
    elPace.appendChild(el('p', { class: 'annual-cap' }, `年間残業上限: ${fmtHours(state.annualCap)} 時間`));

    if (plan.kind === 'year_ended') {
      elPace.appendChild(el('p', { class: 'pace-ended' }, '年度が終了しており、配分対象月がありません。'));
      return;
    }
    if (plan.kind === 'over_cap') {
      elPace.appendChild(
        el('p', { class: 'pace-over' }, `残余残業予算: ${fmtHours(plan.remainingBudget)} 時間`),
      );
      elPace.appendChild(el('p', { class: 'pace-over severe' }, '年間上限を既に超過しています。月あたり配分は0.0時間です。'));
      return;
    }
    // normal
    const dl = el('dl', { class: 'pace-detail' });
    dl.appendChild(el('dt', {}, '残余残業予算'));
    dl.appendChild(el('dd', {}, `${fmtHours(plan.remainingBudget)} 時間`));
    dl.appendChild(el('dt', {}, '残り月数'));
    dl.appendChild(el('dd', {}, `${plan.remainingMonths} か月`));
    dl.appendChild(el('dt', {}, '月あたり配分'));
    dl.appendChild(el('dd', { class: 'pace-allowance' }, `${fmtHours(plan.monthlyAllowance)} 時間 / 月`));
    elPace.appendChild(dl);
  }

  return {
    mount,
    getState: () => state,
    selectYear,
    createSelectedYear,
    setReferenceDate,
    importCsvText,
    renderAll,
    showView,
  };
}
