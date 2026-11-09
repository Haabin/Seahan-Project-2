/**
 * 날짜 유틸. 'YYYY-MM-DD' 문자열만 다루며 UTC 기준으로 계산해 타임존 문제를 피한다.
 */
import type { ISODate, YearMonth } from "./types";

const DAY_MS = 86_400_000;

/** 'YYYY-MM-DD' → UTC 자정 epoch ms */
export function toUtcMs(iso: ISODate): number {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  return Date.UTC(y, m - 1, d);
}

/** UTC epoch ms → 'YYYY-MM-DD' */
export function fromUtcMs(ms: number): ISODate {
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** n일 더한 날짜 (음수 허용) */
export function addDays(iso: ISODate, n: number): ISODate {
  return fromUtcMs(toUtcMs(iso) + n * DAY_MS);
}

/** 0=일 … 6=토 */
export function dayOfWeek(iso: ISODate): number {
  return new Date(toUtcMs(iso)).getUTCDay();
}

/** 토·일 여부 */
export function isWeekend(iso: ISODate): boolean {
  const dow = dayOfWeek(iso);
  return dow === 0 || dow === 6;
}

/** startIso 부터 days 일 (startIso 포함) */
export function dateRange(startIso: ISODate, days: number): ISODate[] {
  const out: ISODate[] = [];
  const base = toUtcMs(startIso);
  for (let i = 0; i < Math.max(0, Math.floor(days)); i++) {
    out.push(fromUtcMs(base + i * DAY_MS));
  }
  return out;
}

/** b − a (일 수). b가 a보다 뒤면 양수 */
export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / DAY_MS);
}

/** 'YYYY-MM' */
export function yearMonthOf(iso: ISODate): YearMonth {
  return iso.slice(0, 7);
}

const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"] as const;

/** '월' … '일' */
export function dayOfWeekKo(iso: ISODate): string {
  return DOW_KO[dayOfWeek(iso)];
}

/** 오늘이 속한 주(월~일)의 목요일 */
export function thisWeekThursday(todayIso: ISODate): ISODate {
  const dow = dayOfWeek(todayIso); // 0=일
  // 월요일 기준 인덱스: 월=0 … 일=6
  const mondayIndex = (dow + 6) % 7;
  const monday = addDays(todayIso, -mondayIndex);
  return addDays(monday, 3);
}

/** 'M/D' 짧은 표기 (설명문용) */
export function shortDate(iso: ISODate): string {
  return `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
}
