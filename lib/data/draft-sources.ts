/**
 * 초안 자동 생성이 참고할 과거 계획 고르기 (순수 함수).
 * 예전에는 plans 를 따로 조회해서
 *   process_tab = '1STAGE' · period_start >= from · period_start < periodStart · period_start 오름차순
 * 으로 받았다. 같은 조건을 /plan 이 이미 읽은 1STAGE 계획 목록에 적용한다.
 */
import { addDays } from "@/lib/engine/calendar";

export interface HistoryPlanInput {
  periodStart: string;
  revisions: { id: string; revNo: number | null; status: string }[];
}

export interface HistorySource {
  revId: string;
  label: string;
  periodStart: string;
}

/** 과거 몇 주를 볼지의 시작일 (draft_history_weeks) */
export function historyFrom(periodStart: string, historyWeeks: number): string {
  return addDays(periodStart, -7 * historyWeeks);
}

/** 기간 [from, periodStart) 안의 계획만, 시작일 오름차순 (같은 시작일은 받은 순서 유지) */
export function plansInHistoryWindow<T extends { periodStart: string }>(plans: T[], periodStart: string, historyWeeks: number): T[] {
  const from = historyFrom(periodStart, historyWeeks);
  return plans
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.periodStart >= from && p.periodStart < periodStart)
    .sort((a, b) => (a.p.periodStart < b.p.periodStart ? -1 : a.p.periodStart > b.p.periodStart ? 1 : a.i - b.i))
    .map(({ p }) => p);
}

/** 계획마다 최신 확정 Rev (rev_no 가 있는 확정본 중 가장 큰 것). 확정본이 없는 계획은 뺀다 */
export function pickHistorySources(plans: HistoryPlanInput[]): HistorySource[] {
  const sources: HistorySource[] = [];
  for (const p of plans) {
    const revs = p.revisions.filter((r) => r.status === "confirmed" && r.revNo !== null);
    if (!revs.length) continue;
    const latest = [...revs].sort((a, b) => (b.revNo ?? 0) - (a.revNo ?? 0))[0];
    sources.push({ revId: latest.id, periodStart: p.periodStart, label: `${Number(p.periodStart.slice(5, 7))}/${Number(p.periodStart.slice(8, 10))} 주 Rev ${latest.revNo}` });
  }
  return sources;
}
