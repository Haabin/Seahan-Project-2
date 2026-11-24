import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { canWrite, requireSession } from "@/lib/auth/session";
import { canDeleteDraftPlan } from "@/lib/plan/delete-rules";
import { loadPlanData, selectPlan } from "@/lib/data/plan-context";
import { PlanWorkspace } from "@/components/gantt/plan-workspace";
import { Card, PageHeader } from "@/components/ui";
import { NewPlanButton } from "@/components/gantt/new-plan-button";
import { nextUnplannedThursday, thisWeekThursday } from "@/lib/engine/calendar";
import { equipmentLabelsByLine } from "@/lib/data/line-specs";
import { loadDraftData } from "@/lib/data/draft-data";
import { unwrapInOrder } from "@/lib/data/settle";

export default async function PlanPage({ searchParams }: { searchParams: Promise<{ period?: string; rev?: string }> }) {
  const session = await requireSession();
  if (!canWrite(session.role)) redirect("/view");
  const { period, rev } = await searchParams;
  const db = await createSupabaseServer();
  // 조회 단계: ① 계획 고르기 ‖ settings → ② 엔진 입력 ‖ 초안 자동 생성 데이터 ‖ 가동 불가 ‖ 설비 사양
  // 서로 독립인 조회를 함께 시작하되, 실패하면 예전 차례(계획 → settings → 초안 데이터 → 가동 불가·설비) 순으로 던져 같은 오류가 보이게 한다
  const first = await Promise.allSettled([
    selectPlan(db, { periodStart: period, revisionId: rev, preferDraft: true }),
    db.from("settings").select("key, value").in("key", ["draft_history_weeks", "draft_use_net_requirement"]),
  ]);
  if (first[0].status === "rejected") throw first[0].reason;
  const sel = first[0].value;

  const today = new Date().toISOString().slice(0, 10);
  const thursday = thisWeekThursday(today);

  if (!sel) {
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

  // settings 조회 오류는 예전처럼 무시하고 기본값을 쓴다 (data 만 읽는다)
  if (first[1].status === "rejected") throw first[1].reason;
  const settingRows = first[1].value.data;

  const [ctx, draftData, { data: downtimeRows }, specs] = unwrapInOrder(await Promise.allSettled([
    loadPlanData(db, sel),
    loadDraftData(db, sel.plan.periodStart, settingRows ?? [], sel.plans),
    db
      .from("downtimes")
      .select("id, line_id, start_date, end_date, reason")
      .lte("start_date", sel.plan.periodEnd)
      .gte("end_date", sel.plan.periodStart)
      .order("start_date"),
    db.from("line_specs").select("line_id, maker, model"),
  ]));
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
        draftData={draftData}
        canDeletePlan={canDeleteDraftPlan({ role: session.role, revisions: ctx.revisions }).ok}
        periodEnd={ctx.plan.periodEnd}
        currentUserId={session.userId}
      />
    </>
  );
}
