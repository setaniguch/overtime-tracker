# tests

ドメイン層のプロパティテスト（fast-check + Vitest）とユニットテストを配置する。

- ファイル命名: `*.test.js`
- 各プロパティテストは最低 100 回反復（`fc.assert(..., { numRuns: 100 })`）し、
  `Feature: overtime-tracker, Property {番号}` のコメントを付す。

テストは開発時のみ利用し、配布物（成果物）には含めない。
