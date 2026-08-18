// @ts-check
/**
 * Overtime Tracker - File I/O（CSV 読込 / ダウンロード / 起動アセット検査アダプタ）
 *
 * 副作用（ファイル読込・ダウンロード・DOM 参照）を担うアダプタ層。ドメイン層とは分離し、
 * ブラウザの File API / Blob / DOM に依存する処理をここへ閉じ込める。外部ネットワークへは
 * 一切アクセスしない（要件14.2）。
 *
 * - readTextFile(file): 利用者が選択した CSV ファイル（File）をテキストとして読み込む
 *   （要件11.1 のインポート、要件12.1 の入力エクスポートの前段で用いる）。
 *   File API（FileReader）を用い、読込結果の文字列で解決する Promise を返す。
 * - downloadCsv(filename, content): 文字列を Blob 化し、一時的な <a download> 経由で
 *   ローカルへ保存させる（要件12.1 入力エクスポート / 要件12.2 集計エクスポート）。
 *   ネットワークを介さず、生成した Object URL は使用後に解放する。
 * - checkRequiredAssets(): 起動に必要なローカルアセット（CSS / JS モジュール / #app ルート）が
 *   読み込まれているかを検査し、不足があれば missing 一覧を返す（要件14.4）。
 *
 * テスト容易性のため、各関数は環境依存物（document / window / URL / FileReader）を
 * オプションで注入できる。既定は globalThis の対応物を用いる。
 *
 * 設計書（design.md）の File I/O コンポーネント仕様に対応する。
 * @module adapters/fileIO
 */

/**
 * 起動時に存在を確認する必須アセットの定義（要件14.4）。
 * path は index.html からの相対パス（末尾一致で照合）、kind は検査方法の種別。
 * - 'stylesheet': <link rel="stylesheet"> が存在し、スタイルシートが読み込まれていること。
 * - 'module'    : <script type="module"> が存在すること。
 * @type {ReadonlyArray<{ path: string, kind: 'stylesheet'|'module' }>}
 */
export const REQUIRED_ASSETS = Object.freeze([
  { path: 'src/styles.css', kind: 'stylesheet' },
  { path: 'src/main.js', kind: 'module' },
]);

/**
 * アプリ本体を描画するルート要素の id（index.html の <main id="app">）。
 * この要素が無ければ主 HTML が欠落／破損しているとみなす（要件14.4）。
 */
export const APP_ROOT_ID = 'app';

/**
 * readTextFile のオプション。
 * @typedef {Object} ReadTextFileOptions
 * @property {typeof FileReader} [FileReaderCtor] 使用する FileReader コンストラクタ（テスト注入用）。
 * @property {string} [encoding] 読み込みエンコーディング。既定は 'UTF-8'。
 */

/**
 * 利用者が選択したファイル（File / Blob）をテキストとして読み込む（要件11.1）。
 * File API（FileReader.readAsText）を用い、読み込んだ文字列で解決する Promise を返す。
 * 読み込みに失敗した場合や File API が利用できない環境では reject する。
 * 本アダプタは内容の検証・変換を行わない（CSV 解析は CSV_Importer の責務）。
 * @param {Blob} file 読み込み対象のファイル（<input type="file"> で得た File など）
 * @param {ReadTextFileOptions} [options]
 * @returns {Promise<string>} ファイル内容のテキスト
 */
export function readTextFile(file, options = {}) {
  return new Promise((resolve, reject) => {
    if (file === null || file === undefined || typeof file !== 'object') {
      reject(new TypeError('readTextFile: 有効なファイルが指定されていません。'));
      return;
    }
    const Ctor =
      options.FileReaderCtor ||
      (typeof FileReader !== 'undefined' ? FileReader : undefined);
    if (typeof Ctor !== 'function') {
      reject(new Error('readTextFile: File API（FileReader）が利用できません。'));
      return;
    }
    const encoding = options.encoding || 'UTF-8';
    let reader;
    try {
      reader = new Ctor();
    } catch (err) {
      reject(err);
      return;
    }
    reader.onload = () => {
      const result = reader.result;
      resolve(typeof result === 'string' ? result : String(result ?? ''));
    };
    reader.onerror = () => {
      reject(reader.error || new Error('readTextFile: ファイルの読み込みに失敗しました。'));
    };
    try {
      reader.readAsText(file, encoding);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * downloadCsv のオプション。
 * @typedef {Object} DownloadCsvOptions
 * @property {Document} [document] 使用する Document（テスト注入用）。既定は globalThis.document。
 * @property {{ createObjectURL: (blob: Blob) => string, revokeObjectURL: (url: string) => void }} [urlApi]
 *   Object URL API（テスト注入用）。既定は globalThis.URL。
 * @property {typeof Blob} [BlobCtor] 使用する Blob コンストラクタ（テスト注入用）。
 * @property {boolean} [bom] 先頭に UTF-8 BOM を付与するか。既定 false（内容を素通しし往復特性を保つ）。
 * @property {string} [mimeType] Blob の MIME タイプ。既定 'text/csv;charset=utf-8;'。
 */

/**
 * CSV 文字列を Blob 化し、一時的な <a download> リンクのクリックでローカルへ保存させる
 * （要件12.1 入力エクスポート / 要件12.2 集計エクスポート）。外部ネットワークは介さない（要件14.2）。
 *
 * 手順: Blob 生成 → Object URL 生成 → 非表示 <a href download> を DOM へ追加 → click() →
 * DOM から除去 → Object URL を解放（revokeObjectURL）。DOM / URL API が利用できない環境では
 * 例外を投げる（呼び出し側＝UI 層が捕捉して通知する）。
 * @param {string} filename 保存ファイル名（例 "残業入力ツール.csv"）
 * @param {string} content CSV 本文（CSV_Exporter の出力そのまま）
 * @param {DownloadCsvOptions} [options]
 * @returns {void}
 */
export function downloadCsv(filename, content, options = {}) {
  const doc =
    options.document !== undefined
      ? options.document
      : typeof document !== 'undefined'
        ? document
        : null;
  const urlApi =
    options.urlApi !== undefined
      ? options.urlApi
      : typeof URL !== 'undefined'
        ? /** @type {any} */ (URL)
        : null;
  const BlobCtor =
    options.BlobCtor || (typeof Blob !== 'undefined' ? Blob : undefined);

  if (doc === null || typeof doc.createElement !== 'function') {
    throw new Error('downloadCsv: DOM が利用できないためダウンロードできません。');
  }
  if (
    urlApi === null ||
    typeof urlApi.createObjectURL !== 'function' ||
    typeof urlApi.revokeObjectURL !== 'function'
  ) {
    throw new Error('downloadCsv: Object URL API が利用できません。');
  }
  if (typeof BlobCtor !== 'function') {
    throw new Error('downloadCsv: Blob が利用できません。');
  }

  const mimeType = options.mimeType || 'text/csv;charset=utf-8;';
  const text = content === null || content === undefined ? '' : String(content);
  // Excel での日本語表示互換が必要な場合のみ BOM を付与する（既定は付与せず往復特性を保つ）。
  const parts = options.bom ? ['\uFEFF', text] : [text];
  const blob = new BlobCtor(parts, { type: mimeType });

  const url = urlApi.createObjectURL(blob);
  try {
    const anchor = doc.createElement('a');
    anchor.href = url;
    anchor.download =
      filename === null || filename === undefined ? 'download.csv' : String(filename);
    anchor.style.display = 'none';
    const parent = doc.body || doc.documentElement;
    if (parent && typeof parent.appendChild === 'function') {
      parent.appendChild(anchor);
    }
    anchor.click();
    if (parent && typeof parent.removeChild === 'function' && anchor.parentNode === parent) {
      parent.removeChild(anchor);
    }
  } finally {
    // 生成した Object URL は必ず解放する（メモリリーク防止）。
    urlApi.revokeObjectURL(url);
  }
}

/**
 * checkRequiredAssets の結果。
 * @typedef {(
 *   { ok: true }
 *   | { ok: false, missing: string[] }
 * )} AssetCheckResult
 */

/**
 * checkRequiredAssets のオプション。
 * @typedef {Object} CheckRequiredAssetsOptions
 * @property {Document|null} [document] 検査対象の Document（テスト注入用）。既定は globalThis.document。
 * @property {ReadonlyArray<{ path: string, kind: 'stylesheet'|'module' }>} [requiredAssets]
 *   検査するアセット定義（テスト注入用）。既定は REQUIRED_ASSETS。
 * @property {string} [appRootId] ルート要素 id。既定は APP_ROOT_ID。
 */

/**
 * 属性値（href / src）が指定パスを指しているかを末尾一致で判定する。
 * 絶対 URL・相対パス・クエリ/ハッシュ付きのいずれでも、パス部分の末尾一致で照合する。
 * @param {string|null|undefined} attr 要素の href / src 属性値
 * @param {string} path 期待するアセットパス（例 'src/styles.css'）
 * @returns {boolean}
 */
function attrMatchesPath(attr, path) {
  if (typeof attr !== 'string' || attr === '') return false;
  // クエリ・ハッシュを除去し、バックスラッシュを正規化する。
  const cleaned = attr.split(/[?#]/)[0].replace(/\\/g, '/');
  return cleaned.endsWith(path);
}

/**
 * 起動に必要なローカルアセットが読み込まれているかを検査する（要件14.4）。
 *
 * 検査項目:
 * - ルート要素（<main id="app">）が存在すること（主 HTML が欠落／破損していないこと）。
 * - REQUIRED_ASSETS の各アセット:
 *   - 'stylesheet': 対応する <link rel="stylesheet"> が存在し、かつスタイルシートが
 *     読み込まれていること（link.sheet が非 null。取得不能な環境では存在のみで許容）。
 *   - 'module'    : 対応する <script type="module"> が存在すること。
 *
 * 不足があれば ok:false と missing（不足アセットのパス一覧）を返す。Document が
 * 利用できない環境（DOM 非対応）では、検査不能として全必須アセットを missing とみなす。
 * 例外は投げず、常に結果型を返す。
 * @param {CheckRequiredAssetsOptions} [options]
 * @returns {AssetCheckResult}
 */
export function checkRequiredAssets(options = {}) {
  const doc =
    options.document !== undefined
      ? options.document
      : typeof document !== 'undefined'
        ? document
        : null;
  const required = options.requiredAssets || REQUIRED_ASSETS;
  const appRootId = options.appRootId || APP_ROOT_ID;

  /** @type {string[]} */
  const missing = [];

  if (doc === null || typeof doc.querySelectorAll !== 'function') {
    // DOM が無い環境では検査できないため、全必須アセットを不足として報告する。
    for (const asset of required) missing.push(asset.path);
    if (typeof (doc && doc.getElementById) !== 'function') {
      // ルート要素の存在も確認できない。
    }
    return { ok: false, missing };
  }

  // ルート要素の存在（主 HTML の健全性）。
  const rootPresent =
    typeof doc.getElementById === 'function' && doc.getElementById(appRootId) !== null;
  if (!rootPresent) {
    missing.push(`#${appRootId}`);
  }

  for (const asset of required) {
    if (asset.kind === 'stylesheet') {
      const links = Array.from(doc.querySelectorAll('link[rel="stylesheet"]'));
      const link = links.find((el) =>
        attrMatchesPath(el.getAttribute('href'), asset.path),
      );
      if (!link) {
        missing.push(asset.path);
        continue;
      }
      // スタイルシートが実際に読み込まれたか（sheet が取れる環境のみ検査）。
      // クロスオリジン等で sheet 取得が例外になる場合は「存在すれば良し」とする。
      try {
        const sheet = /** @type {any} */ (link).sheet;
        if (sheet === null) {
          missing.push(asset.path);
        }
      } catch {
        // sheet へのアクセス不可＝読み込み判定不能。存在は確認できたので許容する。
      }
    } else if (asset.kind === 'module') {
      const scripts = Array.from(doc.querySelectorAll('script[type="module"]'));
      const script = scripts.find((el) =>
        attrMatchesPath(el.getAttribute('src'), asset.path),
      );
      if (!script) {
        missing.push(asset.path);
      }
    }
  }

  if (missing.length > 0) {
    return { ok: false, missing };
  }
  return { ok: true };
}

/**
 * createFileIO のオプション（既定注入をまとめて指定できる）。
 * @typedef {ReadTextFileOptions & DownloadCsvOptions & CheckRequiredAssetsOptions} FileIOOptions
 */

/**
 * File I/O アダプタのインスタンス（設計書 FileIO インタフェースに対応）。
 * @typedef {Object} FileIO
 * @property {(file: Blob) => Promise<string>} readTextFile
 * @property {(filename: string, content: string) => void} downloadCsv
 * @property {() => AssetCheckResult} checkRequiredAssets
 */

/**
 * File I/O アダプタを生成する。環境依存物を注入でき、UI 層からは統一インタフェースで利用できる。
 * @param {FileIOOptions} [options]
 * @returns {FileIO}
 */
export function createFileIO(options = {}) {
  return {
    readTextFile: (file) => readTextFile(file, options),
    downloadCsv: (filename, content) => downloadCsv(filename, content, options),
    checkRequiredAssets: () => checkRequiredAssets(options),
  };
}
