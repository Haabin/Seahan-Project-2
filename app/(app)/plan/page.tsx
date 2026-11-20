import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { canWrite, requireSession } from "@/lib/auth/session";
import { loadPlanContext } from "@/lib/data/plan-context";
import { PlanWorkspace } from "@/components/gantt/plan-workspace";
import { Card, PageHeader } from "@/components/ui";
import { NewPlanButton } from "@/components/gantt/new-plan-button";
import { nextUnplannedThursday, thisWeekThursday } from "@/lib/engine/calendar";
import { equipmentLabelsByLine } from "@/lib/data/line-specs";

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
        <PageHeader title="생산계획표" />
        <Card className="p-6 text-sm">
          <p className="text-text-muted">아직 계획이 없습니다. 이번 주 목요일({thursday})부터 15일 계획을 새로 만듭니다.</p>
          <div className="mt-3">
            <NewPlanButton defaultPeriod={thursday} />
          </div>
        </Card>
      </>
    );
  }

  const [{ data: downtimeRows }, specs] = await Promise.all([
    db
      .from("downtimes")
      .select("id, line_id, start_date, end_date, reason")
      .lte("start_date", ctx.plan.periodEnd)
      .gte("end_date", ctx.plan.periodStart)
      .order("start_date"),
    db.from("line_specs").select("line_id, maker, model"),
  ]);
  // 0003_line_specs.sql 적용 전이면 테이블이 없어 오류 → 설비 표시 없이 그대로 동작
  if (specs.error) console.warn(`line_specs 조회 실패: ${specs.error.message}`);

  const nextPeriod = nextUnplannedThursday(ctx.periods, thursday);

  return (
    <>
      <PageHeader
        title="생산계획표"
        sub={`${ctx.plan.periodStart} (목) ~ ${ctx.plan.periodEnd} · 호기 × 15일 · 수정 즉시 재계산`}
        // 항상 보인다: 이번 주 계획이 있어도 다음 주 계획을 미리 만들 수 있게 (기본값 = 계획이 없는 가장 가까운 목요일)
        right={<NewPlanButton key={nextPeriod} defaultPeriod={nextPeriod} compact />}
      />
      <PlanWorkspace
        planId={ctx.plan.id}
        input={ctx.input}
        revisions={ctx.revisions}
        selected={ctx.selected}
        periods={ctx.periods}
        uploadedAt={{ shipment: ctx.ops.uploadedAt.shipment, inventory: ctx.ops.uploadedAt.inventory }}
        downtimeRows={(downtimeRows ?? []).map((d) => ({ id: d.id, lineId: d.line_id, startDate: d.start_date, endDate: d.end_date, reason: d.reason }))}
        lineEquipment={specs.error ? {} : equipmentLabelsByLine(specs.data ?? [])}
        canWrite
      />
    </>
  );
}
