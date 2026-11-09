"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ensurePlan } from "@/lib/actions/plan";
import { Button } from "@/components/ui";

/** 새 기간(목요일) 계획 생성. 직전 확정 계획의 겹치는 날짜를 이어받는다 (3.1) */
export function NewPlanButton({ defaultPeriod, compact }: { defaultPeriod: string; compact?: boolean }) {
  const router = useRouter();
  const [period, setPeriod] = useState(defaultPeriod);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    const r = await ensurePlan(period);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    router.push(`/plan?period=${period}&rev=${r.data.draftId}`);
    router.refresh();
  }

  const isThursday = new Date(`${period}T00:00:00Z`).getUTCDay() === 4;

  return (
    <div className="flex items-center gap-2 text-xs">
      <input type="date" className="h-7 rounded-[var(--radius-sm)] border border-border bg-white px-2 text-xs" value={period} onChange={(e) => setPeriod(e.target.value)} />
      <Button size="sm" variant={compact ? "secondary" : "primary"} disabled={busy || !isThursday} onClick={create} title={isThursday ? "" : "목요일을 선택하세요"}>
        {busy ? "생성 중…" : compact ? "새 기간 계획" : "15일 계획 만들기"}
      </Button>
      {!isThursday ? <span className="text-text-muted">목요일을 선택하세요</span> : null}
      {error ? <span className="text-danger">{error}</span> : null}
    </div>
  );
}
