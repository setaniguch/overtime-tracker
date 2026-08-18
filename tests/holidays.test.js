// @ts-check
/**
 * 日本の祝日計算のユニットテスト（src/core/holidays.js）。
 * 代表的な固定日・ハッピーマンデー・春分/秋分・振替休日を検証する。
 */
import { describe, it, expect } from 'vitest';
import { japaneseHolidays, japaneseHolidaysBetween } from '../src/core/holidays.js';

describe('japaneseHolidays', () => {
  it('2026年の固定日・ハッピーマンデーを含む', () => {
    const h = japaneseHolidays(2026);
    expect(h.has('2026-01-01')).toBe(true); // 元日
    expect(h.has('2026-02-11')).toBe(true); // 建国記念の日
    expect(h.has('2026-02-23')).toBe(true); // 天皇誕生日
    expect(h.has('2026-04-29')).toBe(true); // 昭和の日
    expect(h.has('2026-05-03')).toBe(true); // 憲法記念日
    expect(h.has('2026-05-04')).toBe(true); // みどりの日
    expect(h.has('2026-05-05')).toBe(true); // こどもの日
    expect(h.has('2026-08-11')).toBe(true); // 山の日
    expect(h.has('2026-11-03')).toBe(true); // 文化の日
    expect(h.has('2026-11-23')).toBe(true); // 勤労感謝の日
    // 成人の日（1月第2月曜）= 2026-01-12
    expect(h.has('2026-01-12')).toBe(true);
  });

  it('春分・秋分を含む（2026年）', () => {
    const h = japaneseHolidays(2026);
    expect(h.has('2026-03-20')).toBe(true); // 春分の日
    expect(h.has('2026-09-22')).toBe(true); // 秋分の日
  });

  it('振替休日: 祝日が日曜なら翌平日が休日（2027-01-01は金曜なので別年で検証）', () => {
    // 2026-05-03(日) 憲法記念日 → 5/6(水)が振替休日（5/4みどり,5/5こどもは祝日のため後ろ倒し）。
    const h = japaneseHolidays(2026);
    expect(h.has('2026-05-06')).toBe(true);
  });

  it('範囲指定で複数年をまとめて返す', () => {
    const h = japaneseHolidaysBetween(2025, 2026);
    expect(h.has('2025-01-01')).toBe(true);
    expect(h.has('2026-01-01')).toBe(true);
  });
});
