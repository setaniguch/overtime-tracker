# Implementation Plan: Overtime Tracker

## Overview

本実装計画は、設計書のレイヤ分離（副作用のないドメイン層 + 副作用を担うアダプタ層）に従い、純粋関数のドメイン層をボトムアップで構築し、各コンポーネント直後にプロパティテスト（fast-check + Vitest）を配置してエラーを早期に捕捉する。ドメイン層が揃った後にアダプタ層（Data_Store・File I/O・UI）を実装し、最後に全体を単一 HTML から起動できるよう配線する。

実装言語は設計書の技術選定に従い、バニラ JavaScript（ES Modules）+ HTML + CSS、テストは fast-check + Vitest を用いる（ビルド不要・外部 CDN 非依存）。各プロパティテストは最低 100 回反復（`fc.assert(..., { numRuns: 100 })`）し、`Feature: overtime-tracker, Property {番号}` のコメントを付す。

## Tasks

- [x] 1. プロジェクト構造とコア型・テスト基盤の整備
  - `src/core/`（ドメイン層）、`src/adapters/`（アダプタ層）、`tests/` のディレクトリ構造を作成する
  - `index.html` の骨格と `src/main.js` エントリの空実装を配置する
  - JSDoc typedef で `DateISO`, `Weekday`, `YearMonth`, `DailyEntry`, `FiscalYearState`, `AppState`, `MonthlyTotal`, `CutoffTotal`, `SummaryRow`, `SummaryModel` を `src/core/types.js` に定義する
  - `package.json` に Vitest + fast-check を devDependencies として追加し、テストスクリプト（`vitest --run`）を設定する（成果物はテスト依存を含めない）
  - _Requirements: 14.3, 1.3, 1.4_

- [x] 2. FiscalYear（年度・締め年度の期間生成）
  - [x] 2.1 FiscalYear 純粋関数を実装
    - `fiscalYearDates`, `fiscalYearMonths`, `cutoffPeriod`, `cutoffYearPeriod`, `weekdayOf`, `isValidCalendarDate` を `src/core/fiscalYear.js` に実装する
    - 内部日付表現は `YYYY-MM-DD`、閏年（翌暦年の2/29）を考慮する
    - _Requirements: 1.1, 1.3, 1.4, 3.3, 5.1, 10.2_

  - [x]* 2.2 年度期間の不変条件のプロパティテスト
    - **Property 1: 年度期間の不変条件**
    - **Validates: Requirements 1.1**

  - [x]* 2.3 年度日数生成の正しさのプロパティテスト
    - **Property 2: 年度日数生成の正しさ**
    - **Validates: Requirements 1.3**

  - [x]* 2.4 曜日付与の正しさのプロパティテスト
    - **Property 3: 曜日付与の正しさ**
    - **Validates: Requirements 1.4**

  - [x]* 2.5 無効な基準日の拒否のプロパティテスト
    - **Property 10: 無効な基準日の拒否**
    - **Validates: Requirements 3.3**

- [x] 3. Input_Manager（入力検証・丸め）
  - [x] 3.1 入力検証・丸め純粋関数を実装
    - `parseHours`, `roundToTenth`, `validateNote` を `src/core/inputManager.js` に実装する
    - 丸め規約「小数第2位以下を四捨五入して小数第1位」、範囲 0.0〜15.0未満、備考最大500文字を適用する
    - 検証失敗時は結果型（`{ok:false, reason}`）を返し、状態は書き換えない
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 2.6, 2.7, 2.8_

  - [x]* 3.2 残業時間の丸めと範囲のプロパティテスト
    - **Property 4: 残業時間の丸めと範囲**
    - **Validates: Requirements 2.1, 2.2**

  - [x]* 3.3 備考の受理のプロパティテスト
    - **Property 5: 備考の受理**
    - **Validates: Requirements 2.3**

  - [x]* 3.4 負の残業時間の拒否のプロパティテスト
    - **Property 6: 負の残業時間の拒否**
    - **Validates: Requirements 2.5**

  - [x]* 3.5 過大な残業時間の拒否のプロパティテスト
    - **Property 7: 過大な残業時間の拒否**
    - **Validates: Requirements 2.6**

  - [x]* 3.6 非数値入力の拒否のプロパティテスト
    - **Property 8: 非数値入力の拒否**
    - **Validates: Requirements 2.7**

  - [x]* 3.7 過長な備考の拒否のプロパティテスト
    - **Property 9: 過長な備考の拒否**
    - **Validates: Requirements 2.8**

- [x] 4. チェックポイント - 期間生成と入力検証のテストを確認
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Aggregator（対象残業時間の選択・月合計・年間合計）
  - [x] 5.1 対象残業時間選択と集計関数を実装
    - `effectiveHours`, `monthlyTotal`, `allMonthlyTotals`, `annualActualTotal`, `annualPredictedTotal` を `src/core/aggregator.js` に実装する
    - 基準日以前は実績、基準日より後は予測を用い、未入力（null）は加算対象外とする
    - _Requirements: 3.4, 3.5, 4.1, 4.3, 4.4, 4.5, 8.1, 8.2, 8.4, 8.5, 2.4_

  - [x]* 5.2 対象残業時間の選択のプロパティテスト
    - **Property 11: 対象残業時間の選択**
    - **Validates: Requirements 3.4, 3.5**

  - [x]* 5.3 月合計の集計のプロパティテスト
    - **Property 12: 月合計の集計**
    - **Validates: Requirements 4.1, 4.4, 2.4**

  - [x]* 5.4 年度は12か月を網羅のプロパティテスト
    - **Property 13: 年度は12か月を網羅**
    - **Validates: Requirements 4.3**

  - [x]* 5.5 年間合計の集計のプロパティテスト
    - **Property 19: 年間合計の集計**
    - **Validates: Requirements 8.1, 8.2, 8.4**

- [x] 6. Cutoff_Aggregator（21日締め合計）
  - [x] 6.1 締め合計関数を実装
    - `cutoffActualTotal`, `cutoffPredictedTotal`, `allCutoffTotals` を `src/core/cutoffAggregator.js` に実装する
    - 締め期間（前月21日〜当月20日）で実績・予測を独立集計し、未入力は除外する
    - _Requirements: 5.1, 5.2, 5.4, 5.5_

  - [x]* 6.2 21日締め合計の実績・予測独立集計のプロパティテスト
    - **Property 14: 21日締め合計の実績・予測独立集計**
    - **Validates: Requirements 5.1, 5.2, 5.4, 5.5**

- [x] 7. Business_Day_Calculator（営業日数・残営業日数）
  - [x] 7.1 営業日数関数を実装
    - `businessDays`, `remainingBusinessDays` を `src/core/businessDayCalculator.js` に実装する
    - 平日（月〜金）を営業日とし、除外日集合（祝日・有休）を差し引く
    - _Requirements: 7.1, 7.2, 7.4, 7.5_

  - [x]* 7.2 営業日数の算出のプロパティテスト
    - **Property 16: 営業日数の算出**
    - **Validates: Requirements 7.1**

  - [x]* 7.3 残営業日数の算出のプロパティテスト
    - **Property 17: 残営業日数の算出**
    - **Validates: Requirements 7.2, 7.4**

  - [x]* 7.4 除外日のメタモルフィック性のプロパティテスト
    - **Property 18: 除外日のメタモルフィック性**
    - **Validates: Requirements 7.5**

- [x] 8. Progress_Calculator（経過率）
  - [x] 8.1 経過率関数を実装
    - `progressRate` を `src/core/progressCalculator.js` に実装する（Business_Day_Calculator を利用）
    - 経過営業日数 / 総営業日数 × 100、小数第1位、0.0〜100.0、境界（基準日 >= 末日 → 100.0、< 初日 → 0.0、分母0 → 0.0）を扱う
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x]* 8.2 経過率の定義と範囲のプロパティテスト
    - **Property 15: 経過率の定義と範囲**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5**

- [x] 9. チェックポイント - 集計・経過率のテストを確認
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Compliance_Checker（上限警告）
  - [x] 10.1 上限判定関数を実装
    - `evaluateCompliance` を `src/core/complianceChecker.js` に実装する
    - 判定規則: `OVER_45`(>45.0)、`OVER_45_COUNT`(超過月>=7)、`CONSECUTIVE_45`(連続2か月>45.0)、`ADJUST_TO_55`(>45.0 かつ <55.0)、`OVER_69`(>69.0)、`CUTOFF_YEAR_360`(>360.0 かつ <=690.0)、`CUTOFF_YEAR_690`(>690.0)
    - 締め年度合計は `effectiveHours` を用いて別途算出した値を入力として受け取る
    - 現在の入力のみから警告を導出し、基準を下回れば自動解除する
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 10.1, 10.2, 10.3, 10.4, 10.5_

  - [x]* 10.2 45時間超過月の判定のプロパティテスト
    - **Property 20: 45時間超過月の判定**
    - **Validates: Requirements 9.1, 9.5**

  - [x]* 10.3 45時間超過回数の上限警告のプロパティテスト
    - **Property 21: 45時間超過回数の上限警告**
    - **Validates: Requirements 9.2**

  - [x]* 10.4 連続超過の判定のプロパティテスト
    - **Property 22: 連続超過の判定**
    - **Validates: Requirements 9.3**

  - [x]* 10.5 55時間への調整警告のプロパティテスト
    - **Property 23: 55時間への調整警告**
    - **Validates: Requirements 9.4**

  - [x]* 10.6 69時間超過の重大警告のプロパティテスト
    - **Property 24: 69時間超過の重大警告**
    - **Validates: Requirements 10.1**

  - [x]* 10.7 締め年度合計の集計のプロパティテスト
    - **Property 25: 締め年度合計の集計**
    - **Validates: Requirements 10.2**

  - [x]* 10.8 締め年度上限の閾値分類のプロパティテスト
    - **Property 26: 締め年度上限の閾値分類**
    - **Validates: Requirements 10.3, 10.4, 10.5**

- [x] 11. Pace_Planner（残業ペース配分）
  - [x] 11.1 ペース配分関数を実装
    - `computePacePlan` を `src/core/pacePlanner.js` に実装する
    - 残余予算 = 年間上限 −（年度内で基準日以前の実績合計）、残り月数 = 基準日の属する月〜翌3月、月あたり配分 = 残余予算 / 残り月数（小数第1位）
    - 予算 < 0 → 配分0.0 + 超過警告、残り月数0 → 年度終了
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7_

  - [x]* 11.2 残余残業予算の算出のプロパティテスト
    - **Property 33: 残余残業予算の算出**
    - **Validates: Requirements 15.2**

  - [x]* 11.3 残り月数の算出のプロパティテスト
    - **Property 34: 残り月数の算出**
    - **Validates: Requirements 15.3**

  - [x]* 11.4 月あたり配分の算出と超過時の扱いのプロパティテスト
    - **Property 35: 月あたり配分の算出と超過時の扱い**
    - **Validates: Requirements 15.4, 15.5, 15.6**

- [x] 12. チェックポイント - 上限警告とペース配分のテストを確認
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. CSV_Importer / CSV_Exporter（CSV 入出力）
  - [x] 13.1 CSV インポータを実装
    - `importInputCsv` を `src/core/csvImporter.js` に実装する（Input_Manager と FiscalYear を利用）
    - ヘッダ除去、`YYYY/M/D` 解釈、空セルは null、日付/セル値不正は行番号付きエラーで中止
    - _Requirements: 11.1, 11.2, 11.3, 11.5, 11.6_

  - [x] 13.2 CSV エクスポータを実装
    - `exportInputCsv`, `exportSummaryCsv` を `src/core/csvExporter.js` に実装する
    - 入力ツール互換ヘッダ（日付・曜日・実績・予測・備考）、集計ツール互換ヘッダ（月・月合計・月経過率・21日締め合計(実績)・21日締め合計(予測)・営業日数・残営業日数・21日締め経過率・本日）
    - 未入力は空セル、日付昇順、`YYYY-MM-DD`→`YYYY/M/D` 変換、空データはヘッダのみ
    - _Requirements: 12.1, 12.2, 12.3, 12.5_

  - [x]* 13.3 入力CSVのラウンドトリップのプロパティテスト
    - **Property 27: 入力CSVのラウンドトリップ**
    - **Validates: Requirements 12.4, 12.3, 11.3, 11.1**

  - [x]* 13.4 日付不正行のインポート拒否のプロパティテスト
    - **Property 28: 日付不正行のインポート拒否**
    - **Validates: Requirements 11.2**

  - [x]* 13.5 セル値不正行のインポート拒否のプロパティテスト
    - **Property 29: セル値不正行のインポート拒否**
    - **Validates: Requirements 11.5, 11.6**

  - [x]* 13.6 入力CSVの構造のプロパティテスト
    - **Property 30: 入力CSVの構造**
    - **Validates: Requirements 12.1, 12.5**

  - [x]* 13.7 集計CSVの構造のプロパティテスト
    - **Property 31: 集計CSVの構造**
    - **Validates: Requirements 12.2**

  - [x]* 13.8 CSV インポートの年度反映・上書きのユニットテスト
    - 取り込んだエントリが属する年度に反映され、同一日付の既存エントリを上書きすることを検証する
    - _Requirements: 11.4_

- [x] 14. Data_Store（localStorage 永続化）
  - [x] 14.1 永続化アダプタを実装
    - `save`（2秒デバウンス）、`load`（破損時 null）を `src/adapters/dataStore.js` に実装する
    - `AppState` の JSON シリアライズ/デシリアライズと `schemaVersion` による破損検知を行う
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5_

  - [x]* 14.2 永続化状態のシリアライズ往復のプロパティテスト
    - **Property 32: 永続化状態のシリアライズ往復**
    - **Validates: Requirements 13.2**

  - [x]* 14.3 保存タイミング・破損・保存失敗のユニットテスト
    - localStorage モックで 2秒以内保存（13.1）、破損時の空起動（13.4）、保存失敗時のメモリ保持（13.5）を検証する
    - _Requirements: 13.1, 13.4, 13.5_

- [x] 15. File I/O（CSV 読込・ダウンロード・起動アセット検査）
  - [x] 15.1 ファイル入出力アダプタを実装
    - `readTextFile`（File API）、`downloadCsv`（Blob）、`checkRequiredAssets` を `src/adapters/fileIO.js` に実装する
    - _Requirements: 11.1, 12.1, 12.2, 14.4_

  - [x]* 15.2 必要ファイル欠落検査のユニットテスト
    - `checkRequiredAssets` が不足ファイルを提示し起動中止を返すことを検証する
    - _Requirements: 14.4_

- [x] 16. チェックポイント - CSV・永続化・ファイルI/Oのテストを確認
  - Ensure all tests pass, ask the user if questions arise.

- [x] 17. UI 層とアプリケーション配線
  - [x] 17.1 UI 描画とイベント・再計算オーケストレーションを実装
    - `src/adapters/ui.js` に年度選択・日次入力グリッド・基準日入力・集計表・警告表示・ペース配分表示・CSV 入出力ボタンを実装する
    - 入力/基準日変更時にドメイン層を呼び出して全集計・警告を再計算し、検証失敗時は既存値を保持してエラーのみ表示する
    - 年度作成/選択（未作成・既存年度の扱い）と AppState 状態管理を実装する
    - _Requirements: 1.2, 1.5, 1.6, 3.1, 3.2, 4.2, 5.3, 7.3, 8.3, 10.5, 15.1, 15.7_

  - [x] 17.2 全コンポーネントを main.js から配線
    - `src/main.js` で起動時に `checkRequiredAssets` → `Data_Store.load`（無ければ空状態・基準日=当日）→ UI 初期描画を行い、ドメイン層・アダプタ層を結線する
    - `index.html` から `src/main.js` を ES Module として読み込み、`file://` で起動可能にする
    - _Requirements: 13.2, 13.3, 14.1, 14.3, 3.1_

  - [ ]* 17.3 UI 状態遷移のユニットテスト
    - 年度選択（1.2）、既存年度再作成の拒否（1.5）、未作成年度選択の案内（1.6）、基準日変更の再計算トリガ（3.2）、月合計更新表示（4.2）を検証する
    - _Requirements: 1.2, 1.5, 1.6, 3.2, 4.2_

  - [ ]* 17.4 ローカル動作のスモークテスト
    - 外部ネットワーク参照・CDN 参照が存在しないことの静的確認と、単一フォルダ・`file://` 起動確認を行う
    - _Requirements: 14.1, 14.2, 14.3_

- [x] 18. 最終チェックポイント - 全テストを確認
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- `*` を付したサブタスクは任意（テスト系）で、MVP を急ぐ場合はスキップ可能。コア実装タスクは省略不可。
- 各タスクはトレーサビリティのため対応する要件番号を参照する。
- プロパティテストは設計書の Correctness Properties（Property 1〜35）を fast-check + Vitest で各最低100回反復して検証する。各プロパティは独立したサブタスクとして実装する。
- ユニット/統合/スモークテストは、普遍性の薄い受け入れ基準（UI 表示・トリガ・永続化タイミング・ローカル動作）を補完する。
- チェックポイントで段階的に検証し、ドメイン層 → アダプタ層 → 配線の順に統合する。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "3.1", "7.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "2.5", "3.2", "3.3", "3.4", "3.5", "3.6", "3.7", "7.2", "7.3", "7.4", "5.1", "6.1"] },
    { "id": 3, "tasks": ["5.2", "5.3", "5.4", "5.5", "6.2", "8.1", "10.1", "11.1"] },
    { "id": 4, "tasks": ["8.2", "10.2", "10.3", "10.4", "10.5", "10.6", "10.7", "10.8", "11.2", "11.3", "11.4", "13.1", "13.2", "14.1", "15.1"] },
    { "id": 5, "tasks": ["13.3", "13.4", "13.5", "13.6", "13.7", "13.8", "14.2", "14.3", "15.2"] },
    { "id": 6, "tasks": ["17.1"] },
    { "id": 7, "tasks": ["17.2"] },
    { "id": 8, "tasks": ["17.3", "17.4"] }
  ]
}
```
