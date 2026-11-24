import type { AppRole } from "@/lib/auth/session";

export type DeleteVerdict = { ok: true } | { ok: false; reason: string };

/**
 * 초안 계획 삭제 가능 여부 (화면 버튼 표시와 서버 액션이 같은 판단을 쓴다).
 * - admin 만 지울 수 있다.
 * - 확정된 Rev 가 하나라도 있으면 지울 수 없다(NFR-09 이력 보존). DB 트리거 plan_revisions_immutable 도 같은 경우를 막는다.
 */
export function canDeleteDraftPlan(input: { role: AppRole; revisions: { status: string }[] }): DeleteVerdict {
  if (input.role !== "admin") return { ok: false, reason: "관리자만 초안 계획을 삭제할 수 있습니다" };
  const confirmed = input.revisions.filter((r) => r.status !== "draft").length;
  if (confirmed > 0) return { ok: false, reason: `확정된 Rev가 ${confirmed}개 있어 삭제할 수 없습니다 (NFR-09)` };
  return { ok: true };
}

const dayNo = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

/**
 * 삭제 후 이동할 기간: 남은 기간 중 지운 기간과 날짜 차이가 가장 작은 것. 앞뒤로 같은 거리면 뒤(다가오는) 기간.
 * 남은 기간이 없으면 null.
 */
export function nearestPeriod(periods: string[], deleted: string): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const p of periods) {
    if (p === deleted) continue;
    const dist = Math.abs(dayNo(p) - dayNo(deleted));
    if (dist < bestDist || (dist === bestDist && best !== null && p > best)) {
      best = p;
      bestDist = dist;
    }
  }
  return best;
}
