/**
 * 주문 입력값 검사 (순수 함수). 직접 입력과 엑셀 업로드가 같은 규칙을 쓴다.
 *
 * 납기일
 *  - 오늘보다 PAST_LIMIT_DAYS(30일) 넘게 지난 날짜, FUTURE_LIMIT_DAYS(2년) 넘게 먼 날짜는 잘못 넣은 것으로 보고 받지 않는다
 *    (예: 2020-01-01 처럼 연도를 잘못 고른 경우).
 *  - 최근 30일 안에 지난 납기는 받되 "납기 지남"으로 표시한다(늦게 입력하는 지연 주문이 있을 수 있다).
 * 주문번호
 *  - 앞뒤 공백과 대소문자를 무시하고 같으면 같은 주문번호로 본다.
 */
import { addDays } from "../engine/calendar";

export const PAST_LIMIT_DAYS = 30;
export const FUTURE_LIMIT_DAYS = 730;

export type DueDateCheck = { ok: true; overdue: boolean } | { ok: false; reason: string };

export function checkDueDate(dueDate: string, today: string): DueDateCheck {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(new Date(`${dueDate}T00:00:00Z`).getTime())) return { ok: false, reason: "납기일 형식이 올바르지 않습니다" };
  if (dueDate < addDays(today, -PAST_LIMIT_DAYS)) return { ok: false, reason: `납기일 ${dueDate} 이(가) 오늘(${today})보다 ${PAST_LIMIT_DAYS}일 넘게 지났습니다. 연도를 확인하세요` };
  if (dueDate > addDays(today, FUTURE_LIMIT_DAYS)) return { ok: false, reason: `납기일 ${dueDate} 이(가) 2년보다 더 뒤입니다. 연도를 확인하세요` };
  return { ok: true, overdue: dueDate < today };
}

export function orderNoKey(orderNo: string | null | undefined): string | null {
  const t = orderNo?.normalize("NFC").trim().toLowerCase();
  return t ? t : null;
}

/** 목록에서 두 번 넘게 쓰인 주문번호(정규화한 키) */
export function duplicateOrderNoKeys(orders: { orderNo: string | null }[]): Set<string> {
  const seen = new Map<string, number>();
  for (const o of orders) {
    const k = orderNoKey(o.orderNo);
    if (k) seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  return new Set(Array.from(seen).filter(([, n]) => n > 1).map(([k]) => k));
}

/** 오늘(한국 시간) 'YYYY-MM-DD' */
export function todayKst(now: number = Date.now()): string {
  return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 납기일 표시: 올해면 '11/25 수', 다른 해면 '2020-01-01 수' 처럼 연도를 붙인다 */
export function formatDueDate(dueDate: string, today: string): string {
  const dow = ["일", "월", "화", "수", "목", "금", "토"][new Date(`${dueDate}T00:00:00Z`).getUTCDay()];
  if (dueDate.slice(0, 4) === today.slice(0, 4)) return `${Number(dueDate.slice(5, 7))}/${Number(dueDate.slice(8, 10))} ${dow}`;
  return `${dueDate} ${dow}`;
}
