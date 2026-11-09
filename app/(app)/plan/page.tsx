import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { canWrite, requireSession } from "@/lib/auth/session";
import { loadPlanContext } from "@/lib/data/plan-context";
import { PlanWorkspace } from "@/components/gantt/plan-workspace";
import { Card, PageHeader } from "@/components/ui";
import { NewPlanButton } from "@/components/gantt/new-plan-button";
import { thisWeekThursday } from "@/lib/engine/calendar";

export default async function PlanPage({ searchParams }: { searchParams: Promise<{ period?: string; rev?: string }> }) {
  const session = await requireSession();
  if (!canWrite(session.role)) redirect("/view");
  const { period, rev } = await searchParams;
  const db = await createSupabaseServer();
  const ctx = await loadPlanContext(db, { periodStart: period, revisionId: rev, preferDraft: true });

  const today = new Date().toISOString().slice(0, 10);
  const thursday = thisWeekThursday(today);

  if (!ctx) {
    return (
      <>
        <PageHeader title="계획 간트" />
        <Card className="p-6 text-sm">
          <p className="text-text-muted">아직 계획이 없습니다. 이번 주 목요일({thursday})부터 15일 계획을 새로 만듭니다.</p>
          <div className="mt-3">
            <NewPlanButton defaultPeriod={thursday} />
          </div>
        </Card>
      </>
    );
  }

  const { data: downtimeRows } = await db
    .from("downtimes")
    .select("id, line_id, start_date, end_date, reason")
    .lte("start_date", ctx.plan.periodEnd)
    .gte("end_date", ctx.plan.periodStart)
    .order("start_date");

  return (
    <>
      <PageHeader
        title="계획 간트"
        sub={`${ctx.plan.periodStart} (목) ~ ${ctx.plan.periodEnd} · 호기 × 15일 · 수정 즉시 재계산`}
        right={ctx.periods[0] < thursday || !ctx.periods.includes(thursday) ? <NewPlanButton defaultPeriod={thursday} compact /> : null}
      />
      <PlanWorkspace
        planId={ctx.plan.id}
        input={ctx.input}
        revisions={ctx.revisions}
        selected={ctx.selected}
        periods={ctx.periods}
        uploadedAt={{ shipment: ctx.ops.uploadedAt.shipment, inventory: ctx.ops.uploadedAt.inventory }}
        downtimeRows={(downtimeRows ?? []).map((d) => ({ id: d.id, lineId: d.line_id, startDate: d.start_date, endDate: d.end_date, reason: d.reason }))}
        canWrite
      />
    </>
  );
}
