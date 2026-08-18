// @ts-check
/**
 * Unit tests for File I/O 起動アセット検査（src/adapters/fileIO.js の checkRequiredAssets）。
 *
 * 対応タスク: tasks.md 15.2「必要ファイル欠落検査のユニットテスト」。
 * 要件14.4: 起動に必要なローカルアセット（CSS / JS モジュール / #app ルート）の
 * 欠落を検出し、不足があれば起動中断結果 { ok: false, missing: [...] } を、
 * すべて揃っていれば { ok: true } を返すことを検証する。
 *
 * checkRequiredAssets は環境依存物（document / requiredAssets / appRootId）を注入できる。
 * ここでは実 DOM を用いず、必要なメソッドのみを備えたスタブ document を組み立てて検査する。
 */
import { describe, it, expect } from 'vitest';
import {
  checkRequiredAssets,
  REQUIRED_ASSETS,
  APP_ROOT_ID,
} from '../src/adapters/fileIO.js';

/**
 * スタブ要素を作る。
 * @param {Record<string, string|null>} attrs getAttribute で返す属性
 * @param {{ sheet?: any }} [extra] link 用の sheet など
 */
function makeElement(attrs, extra = {}) {
  return {
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    ...extra,
  };
}

/**
 * checkRequiredAssets が参照する最小限の API を備えたスタブ document を作る。
 * @param {Object} config
 * @param {boolean} [config.hasRoot] #app ルート要素が存在するか（既定 true）
 * @param {Array<{ href: string, sheet?: any }>} [config.stylesheetLinks]
 *   <link rel="stylesheet"> 群（sheet 未指定時は空オブジェクトで読み込み済み扱い）
 * @param {Array<{ src: string }>} [config.moduleScripts] <script type="module"> 群
 */
function makeDocument({
  hasRoot = true,
  stylesheetLinks = [],
  moduleScripts = [],
} = {}) {
  const links = stylesheetLinks.map((l) =>
    makeElement({ href: l.href }, { sheet: 'sheet' in l ? l.sheet : {} }),
  );
  const scripts = moduleScripts.map((s) => makeElement({ src: s.src }));
  return {
    getElementById: (id) => (hasRoot && id === APP_ROOT_ID ? makeElement({}) : null),
    querySelectorAll: (selector) => {
      if (selector === 'link[rel="stylesheet"]') return links;
      if (selector === 'script[type="module"]') return scripts;
      return [];
    },
  };
}

/** すべてのアセットが揃った健全な document を作る。 */
function makeHealthyDocument() {
  return makeDocument({
    hasRoot: true,
    stylesheetLinks: [{ href: 'src/styles.css', sheet: {} }],
    moduleScripts: [{ src: 'src/main.js' }],
  });
}

describe('checkRequiredAssets - 起動アセット欠落検査（要件14.4）', () => {
  it('すべての必須アセットが揃っていれば { ok: true } を返す', () => {
    const doc = makeHealthyDocument();
    const result = checkRequiredAssets({ document: doc });
    expect(result).toEqual({ ok: true });
  });

  it('絶対URL・クエリ/ハッシュ付きの属性でも末尾一致で受理する', () => {
    const doc = makeDocument({
      hasRoot: true,
      stylesheetLinks: [{ href: 'https://example.com/app/src/styles.css?v=2', sheet: {} }],
      moduleScripts: [{ src: 'https://example.com/app/src/main.js#x' }],
    });
    const result = checkRequiredAssets({ document: doc });
    expect(result).toEqual({ ok: true });
  });

  it('スタイルシートが欠落していれば ok:false と missing に該当パスを含む', () => {
    const doc = makeDocument({
      hasRoot: true,
      stylesheetLinks: [],
      moduleScripts: [{ src: 'src/main.js' }],
    });
    const result = checkRequiredAssets({ document: doc });
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('missing');
    // @ts-ignore ok:false 分岐でのみ missing を持つ
    expect(result.missing).toContain('src/styles.css');
    // @ts-ignore
    expect(result.missing).not.toContain('src/main.js');
  });

  it('link は在るが sheet が null（未読込）なら不足として扱う', () => {
    const doc = makeDocument({
      hasRoot: true,
      stylesheetLinks: [{ href: 'src/styles.css', sheet: null }],
      moduleScripts: [{ src: 'src/main.js' }],
    });
    const result = checkRequiredAssets({ document: doc });
    expect(result.ok).toBe(false);
    // @ts-ignore
    expect(result.missing).toContain('src/styles.css');
  });

  it('モジュールスクリプトが欠落していれば ok:false と missing に該当パスを含む', () => {
    const doc = makeDocument({
      hasRoot: true,
      stylesheetLinks: [{ href: 'src/styles.css', sheet: {} }],
      moduleScripts: [],
    });
    const result = checkRequiredAssets({ document: doc });
    expect(result.ok).toBe(false);
    // @ts-ignore
    expect(result.missing).toContain('src/main.js');
    // @ts-ignore
    expect(result.missing).not.toContain('src/styles.css');
  });

  it('#app ルート要素が欠落していれば missing に "#app" を含む', () => {
    const doc = makeDocument({
      hasRoot: false,
      stylesheetLinks: [{ href: 'src/styles.css', sheet: {} }],
      moduleScripts: [{ src: 'src/main.js' }],
    });
    const result = checkRequiredAssets({ document: doc });
    expect(result.ok).toBe(false);
    // @ts-ignore
    expect(result.missing).toContain(`#${APP_ROOT_ID}`);
  });

  it('すべて欠落していれば missing に全アセット + ルートを列挙する', () => {
    const doc = makeDocument({
      hasRoot: false,
      stylesheetLinks: [],
      moduleScripts: [],
    });
    const result = checkRequiredAssets({ document: doc });
    expect(result.ok).toBe(false);
    // @ts-ignore
    expect(result.missing).toContain(`#${APP_ROOT_ID}`);
    for (const asset of REQUIRED_ASSETS) {
      // @ts-ignore
      expect(result.missing).toContain(asset.path);
    }
  });

  it('DOM が利用できない（document が null）場合は検査不能として全必須アセットを不足報告する', () => {
    const result = checkRequiredAssets({ document: null });
    expect(result.ok).toBe(false);
    for (const asset of REQUIRED_ASSETS) {
      // @ts-ignore
      expect(result.missing).toContain(asset.path);
    }
  });

  it('sheet 参照が例外を投げる環境では「存在すれば良し」として受理する', () => {
    const throwingLink = {
      getAttribute: (name) => (name === 'href' ? 'src/styles.css' : null),
      get sheet() {
        throw new Error('cross-origin');
      },
    };
    const doc = {
      getElementById: (id) => (id === APP_ROOT_ID ? makeElement({}) : null),
      querySelectorAll: (selector) => {
        if (selector === 'link[rel="stylesheet"]') return [throwingLink];
        if (selector === 'script[type="module"]') return [makeElement({ src: 'src/main.js' })];
        return [];
      },
    };
    const result = checkRequiredAssets({ document: doc });
    expect(result).toEqual({ ok: true });
  });

  it('注入した requiredAssets / appRootId を尊重する', () => {
    const doc = {
      getElementById: (id) => (id === 'custom-root' ? makeElement({}) : null),
      querySelectorAll: (selector) => {
        if (selector === 'script[type="module"]') {
          return [makeElement({ src: 'dist/bundle.js' })];
        }
        return [];
      },
    };
    const result = checkRequiredAssets({
      document: doc,
      requiredAssets: [{ path: 'dist/bundle.js', kind: 'module' }],
      appRootId: 'custom-root',
    });
    expect(result).toEqual({ ok: true });
  });
});
