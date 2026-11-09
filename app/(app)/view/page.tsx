import { createSupabaseServer } from "@/lib/supabase/server";
import { requireSession } from "@/lib/auth/session";
import { loadPlanContext } from "@/lib/data/plan-context";
import { PlanWorkspace } from "@/components/gantt/plan-workspace";
import { Card, CardHeader, PageHeader } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

/** FR-13 조회 전용: 최신 확정 계획과 최근 변경 내역 */
export default async function ViewPage({ searchParams }: { searchParams: Promise<{ period?: string; rev?: string }> }) {
  const session = await requireSession();
  const { period, rev } = await searchParams;
  const db = await createSupabaseServer();
  const ctx = await loadPlanContext(db, { periodStart: period, revisionId: rev, preferDraft: false });

  if (!ctx || ctx.selected.status !== "confirmed") {
    return (
      <>
        <PageHeader title="계획 조회" />
        <Card className="p-6 text-sm text-text-muted">아직 확정된 계획이 없습니다.</Card>
      </>
    );
  }

  const confirmed = ctx.revisions.filter((r) => r.status === "confirmed").sort((a, b) => (b.revNo ?? 0) - (a.revNo ?? 0));

  return (
    <>
      <PageHeader title="계획 조회" sub={`확정 계획 Rev ${ctx.selected.revNo} · ${ctx.plan.periodStart} ~ ${ctx.plan.periodEnd} · 읽기 전용`} />
      <div className="mb-3">
        <Card>
          <CardHeader title="최근 변경 내역" sub="확정 후 변경된 Rev와 사유" />
          <ul className="divide-y divide-border text-xs">
            {confirmed.slice(0, 5).map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-4 py-2">
                <span className="w-14 font-semibold text-brand-deep">Rev {r.revNo}</span>
                <span className="w-16 text-text-muted">{r.reasonCategory ?? (r.revNo === 0 ? "최초 확정" : "")}</span>
                <span className="flex-1 truncate">{r.reasonText ?? ""}</span>
                <span className="tnum text-text-muted">{fmtDateTime(r.confirmedAt ?? r.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <PlanWorkspace
        planId={ctx.plan.id}
        input={ctx.input}
        revisions={ctx.revisions}
        selected={ctx.selected}
        periods={ctx.periods}
        uploadedAt={{ shipment: ctx.ops.uploadedAt.shipment, inventory: ctx.ops.uploadedAt.inventory }}
        downtimeRows={[]}
        canWrite={session.role !== "viewer"}
        viewerMode
      />
    </>
  );
}
