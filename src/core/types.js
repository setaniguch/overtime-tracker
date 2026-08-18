// @ts-check
/**
 * Overtime Tracker - コア型定義（JSDoc typedefs）
 *
 * 本ファイルは実行時コードを持たず、ドメイン層/アダプタ層で共有する型のみを定義する。
 * 設計書（design.md）の Data Models セクションに厳密に対応する。
 *
 * 日付の内部表現は "YYYY-MM-DD"（ゼロ埋め）で保持し、CSV 入出力時に "YYYY/M/D" と相互変換する。
 * 未入力（集計対象外）は null で表現する。
 */

/**
 * 正規化された日付文字列。書式は "YYYY-MM-DD"（ゼロ埋め）。
 * @typedef {string} DateISO
 */

/**
 * 曜日。月・火・水・木・金・土・日のいずれか。
 * @typedef {('月'|'火'|'水'|'木'|'金'|'土'|'日')} Weekday
 */

/**
 * 年と月の組。month は 1〜12。
 * @typedef {Object} YearMonth
 * @property {number} year  西暦年
 * @property {number} month 月（1〜12）
 */

/**
 * 日次エントリ（1日分のデータ）。
 * @typedef {Object} DailyEntry
 * @property {DateISO} date            正規化日付（"YYYY-MM-DD"）
 * @property {Weekday} weekday         date から導出した曜日（保存もする）
 * @property {number|null} actualHours 実績残業時間。未入力は null。0.0〜15.0未満、0.1刻み
 * @property {number|null} predictedHours 予測残業時間。未入力は null。0.0〜15.0未満、0.1刻み
 * @property {string} note             備考。最大500文字。既定は ""
 */

/**
 * 年度状態（4/1〜翌3/31 の全日付分の日次エントリを保持）。
 * @typedef {Object} FiscalYearState
 * @property {number} startYear        年度開始年（例: 2026）
 * @property {DailyEntry[]} entries    4/1〜翌3/31 の全日付分（365 または 366 件）、日付昇順
 */

/**
 * アプリ全体の永続化状態。
 * @typedef {Object} AppState
 * @property {DateISO} referenceDate        基準日/本日
 * @property {number} selectedStartYear     現在選択中の年度（開始年）
 * @property {FiscalYearState[]} fiscalYears 作成済み年度の集合
 * @property {DateISO[]} excludedDates      祝日・有休など営業日から除外する日
 * @property {number} annualCap             年間残業上限。既定 360.0
 * @property {number} schemaVersion         破損検知/移行用スキーマバージョン
 */

/**
 * 月合計（表示・エクスポート用）。
 * @typedef {Object} MonthlyTotal
 * @property {number} year   西暦年
 * @property {number} month  月（1〜12）
 * @property {number} total  月合計（時間、小数第1位）
 */

/**
 * 21日締め合計（実績・予測を独立して保持）。
 * @typedef {Object} CutoffTotal
 * @property {number} year            西暦年
 * @property {number} month           月（1〜12）
 * @property {number} actualTotal     実績合計（時間、小数第1位）
 * @property {number} predictedTotal  予測合計（時間、小数第1位）
 */

/**
 * 集計表の1行分（4月〜翌3月の各月に対応）。
 * @typedef {Object} SummaryRow
 * @property {number} month                  月（1〜12）
 * @property {number} monthlyTotal           月合計
 * @property {number} monthProgressRate      月経過率（%、0.0〜100.0）
 * @property {number} cutoffActual           21日締め合計（実績）
 * @property {number} cutoffPredicted        21日締め合計（予測）
 * @property {number} businessDays           営業日数
 * @property {number} remainingBusinessDays  残営業日数
 * @property {number} cutoffProgressRate     21日締め経過率（%、0.0〜100.0）
 */

/**
 * 集計結果モデル（表示・エクスポート用）。
 * @typedef {Object} SummaryModel
 * @property {SummaryRow[]} rows          4月〜翌3月の各行
 * @property {DateISO} referenceDate      基準日
 * @property {number} annualActualTotal   年間実績合計
 * @property {number} annualPredictedTotal 年間予測合計
 */

// 本ファイルは型定義のみを提供する（実行時のエクスポートは持たない）。
export {};
