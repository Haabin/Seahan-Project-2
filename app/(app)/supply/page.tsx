import { createSupabaseServer } from "@/lib/supabase/server";
import { canWrite, requireSession } from "@/lib/auth/session";
import { loadPlanContext } from "@/lib/data/plan-context";
import { SupplyTable } from "@/components/supply/supply-table";
import { Card, PageHeader } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

export default async function SupplyPage({ searchParams }: { searchParams: Promise<{ period?: string; rev?: string }> }) {
  const session = await requireSession();
  const { period, rev } = await searchParams;
  const db = await createSupabaseServer();
  const ctx = await loadPlanContext(db, { periodStart: period, revisionId: rev, preferDraft: canWrite(session.role) });

  if (!ctx) {
    return (
      <>
        <PageHeader title="수급 검증" />
        <Card className="p-6 text-sm text-text-muted">계획이 없습니다. 생산계획표에서 먼저 계획을 만드세요.</Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="수급 검증"
        sub={`${ctx.selected.status === "draft" ? "초안" : `Rev ${ctx.selected.revNo}`} 기준 · 제품별 예상 재고 = 전일 재고 + 예상 생산 − 출고계획 · 출고 ${fmtDateTime(ctx.ops.uploadedAt.shipment)} / 재고 ${fmtDateTime(ctx.ops.uploadedAt.inventory)}`}
      />
      <SupplyTable input={ctx.input} canWrite={canWrite(session.role)} planPeriod={ctx.plan.periodStart} />
    </>
  );
}
