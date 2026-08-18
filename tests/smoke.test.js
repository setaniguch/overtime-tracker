// @ts-check
/**
 * Overtime Tracker - ローカル動作のスモークテスト（Vitest）
 *
 * 設計書 Testing Strategy「統合/スモークテスト」に基づき、ローカル動作・外部接続なし・
 * 単一フォルダ起動（要件14.1〜14.3）を、ディスク上の成果物ファイルに対する静的確認で検証する。
 *
 * 本テストはドメイン/アダプタのロジックではなく「配布物の構成」を検査する:
 *   - index.html と src 配下の全 .js ファイルに外部ネットワーク／CDN 参照が存在しないこと（要件14.2）。
 *   - index.html が相対ローカルアセット（src/styles.css, src/main.js）のみを参照し、
 *     <main id="app"> を持ち、スクリプトが type="module" であること。これにより
 *     単一フォルダ配置で file:// からインストール不要に起動できる（要件14.1, 14.3）。
 *
 * _Requirements: 14.1, 14.2, 14.3_
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const INDEX_HTML = path.join(ROOT, 'index.html');

/**
 * 外部リソース参照とみなす禁止パターン群（要件14.2）。
 * ここでは「実際のリソース参照」を検出することを目的とし、コメント中の言及は許容する。
 */
const FORBIDDEN_PATTERNS = [
  /https?:\/\//i, // http:// or https:// スキーム
  /(^|[^a-z0-9])\/\/[a-z0-9.-]+\.[a-z]/i, // プロトコル相対 //host.tld
  /\bunpkg\b/i,
  /\bjsdelivr\b/i,
  /\bgoogleapis\b/i,
  /\bcdnjs\b/i,
  /\/\/cdn\b/i,
];

/** src/ 配下の全 .js ファイルを再帰的に収集する。 */
function collectJsFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * JavaScript のコメント（ブロックコメントと行コメント）を除去する。
 * ブロックコメントはスラッシュとアスタリスクで開始し、アスタリスクとスラッシュで閉じる。
 * 行コメントはスラッシュ2つで開始する。
 * 行コメント除去では URL 中の `://` の直後のスラッシュ2つを誤って除去しないよう、
 * 直前が `:` でないスラッシュ2つのみをコメント開始として扱う。
 */
function stripJsComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  out = out.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  return out;
}

/**
 * import / export ... from '...' と 動的 import('...') のモジュール指定子を抽出する。
 *
 * 静的 import/export 文とバレア（副作用）import 文は必ず文の先頭（行頭・インデント可）に
 * 現れるため、`m` フラグ + 行頭アンカー（^\s*）で限定する。これにより文字列リテラル中の
 * 部分文字列（例: DOM id の 'csv-import' に含まれる "import"）を誤ってモジュール指定子として
 * 抽出してしまう誤検出を防ぐ。動的 import(...) は式中にも現れうるため行頭アンカーは課さない。
 */
function extractModuleSpecifiers(code) {
  /** @type {string[]} */
  const specs = [];
  const staticRe = /^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm;
  const bareImportRe = /^\s*import\s+['"]([^'"]+)['"]/gm;
  const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = staticRe.exec(code)) !== null) specs.push(m[1]);
  while ((m = bareImportRe.exec(code)) !== null) specs.push(m[1]);
  while ((m = dynamicRe.exec(code)) !== null) specs.push(m[1]);
  return specs;
}

/** HTML から src/href 属性値を抽出する。 */
function extractHtmlResourceRefs(html) {
  /** @type {string[]} */
  const refs = [];
  const attrRe = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = attrRe.exec(html)) !== null) {
    refs.push(m[1] !== undefined ? m[1] : m[2]);
  }
  return refs;
}

const jsFiles = collectJsFiles(SRC_DIR);

describe('スモーク: ローカル動作・外部参照なし（要件14.1, 14.2, 14.3）', () => {
  it('index.html と src/**/*.js が存在する', () => {
    expect(fs.existsSync(INDEX_HTML)).toBe(true);
    expect(jsFiles.length).toBeGreaterThan(0);
  });

  it('src/**/*.js に外部ネットワーク／CDN 参照が存在しない（要件14.2）', () => {
    for (const file of jsFiles) {
      const raw = fs.readFileSync(file, 'utf8');
      const code = stripJsComments(raw);
      const rel = path.relative(ROOT, file);

      // 実コード（コメント除去後）に禁止パターンが無いこと。
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(
          pattern.test(code),
          `${rel} にコード上の外部参照 ${pattern} が含まれています`
        ).toBe(false);
      }

      // import/export の指定子はすべて相対パス（./ または ../）で始まること。
      for (const spec of extractModuleSpecifiers(raw)) {
        expect(
          spec.startsWith('./') || spec.startsWith('../'),
          `${rel} のモジュール指定子 "${spec}" が相対ローカルパスではありません`
        ).toBe(true);
      }
    }
  });

  it('index.html は外部ネットワーク／CDN 参照を含まない（要件14.2）', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const refs = extractHtmlResourceRefs(html);
    for (const ref of refs) {
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(
          pattern.test(ref),
          `index.html の参照 "${ref}" が外部参照 ${pattern} に一致します`
        ).toBe(false);
      }
      // 各リソース参照は相対ローカルパスであること（絶対 URL・ルート絶対を排除）。
      expect(
        /^https?:/i.test(ref) || ref.startsWith('//'),
        `index.html の参照 "${ref}" が外部/プロトコル相対 URL です`
      ).toBe(false);
    }
  });
});

describe('スモーク: 単一フォルダ・file:// 起動の実行可能性（要件14.1, 14.3）', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');

  it('相対ローカルアセット src/styles.css と src/main.js のみを参照する', () => {
    const refs = extractHtmlResourceRefs(html);
    // 想定される相対アセットを参照していること。
    expect(refs).toContain('src/styles.css');
    expect(refs).toContain('src/main.js');
    // すべての参照が相対（http/https/プロトコル相対/ルート絶対でない）であること。
    for (const ref of refs) {
      expect(/^([a-z]+:)?\/\//i.test(ref)).toBe(false);
      expect(ref.startsWith('/')).toBe(false);
    }
  });

  it('<main id="app"> ルート要素を持つ', () => {
    expect(/<main\b[^>]*\bid\s*=\s*["']app["'][^>]*>/i.test(html)).toBe(true);
  });

  it('エントリスクリプトが type="module" で src/main.js を読み込む', () => {
    const scriptRe = /<script\b[^>]*>/gi;
    const scripts = html.match(scriptRe) || [];
    const moduleScript = scripts.find(
      (s) => /type\s*=\s*["']module["']/i.test(s) && /src\s*=\s*["']src\/main\.js["']/i.test(s)
    );
    expect(
      Boolean(moduleScript),
      'type="module" かつ src="src/main.js" の <script> が見つかりません'
    ).toBe(true);
  });
});
