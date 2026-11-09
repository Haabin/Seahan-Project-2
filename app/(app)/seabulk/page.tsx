import { createSupabaseServer } from "@/lib/supabase/server";
import { canWrite, requireSession } from "@/lib/auth/session";
import { loadPlanContext } from "@/lib/data/plan-context";
import { SeabulkView } from "@/components/seabulk/seabulk-view";
import { Card, PageHeader } from "@/components/ui";

export default async function SeabulkPage({ searchParams }: { searchParams: Promise<{ period?: string; rev?: string }> }) {
  const session = await requireSession();
  const { period, rev } = await searchParams;
  const db = await createSupabaseServer();
  const ctx = await loadPlanContext(db, { periodStart: period, revisionId: rev, preferDraft: canWrite(session.role) });

  if (!ctx) {
    return (
      <>
        <PageHeader title="씨벌크 원료" />
        <Card className="p-6 text-sm text-text-muted">계획이 없습니다. 생산계획표에서 먼저 계획을 만드세요.</Card>
      </>
    );
  }

  const [{ data: ext }, { data: silos }, { data: factories }] = await Promise.all([
    db.from("silo_external_usage").select("id, label, weekday_ton, weekend_ton, factory_id"),
    db.from("silos").select("code").order("code"),
    db.from("factories").select("id, code"),
  ]);
  const fcode = new Map((factories ?? []).map((f) => [f.id, f.code]));

  return (
    <>
      <PageHeader
        title="씨벌크 원료"
        sub={`${ctx.selected.status === "draft" ? "초안" : `Rev ${ctx.selected.revNo}`} 기준 · 사용량 = Σ(사출 설비 계획 수량 × 프리폼 중량) · 사일로 재고 = 전일 + 입고 − 사용`}
      />
      <SeabulkView
        input={ctx.input}
        canWrite={canWrite(session.role)}
        externalRows={(ext ?? []).map((e) => ({ id: e.id, label: e.label, factoryCode: fcode.get(e.factory_id) ?? "F1", weekdayTon: Number(e.weekday_ton), weekendTon: Number(e.weekend_ton) }))}
        siloCodes={(silos ?? []).map((s) => s.code)}
      />
    </>
  );
}
