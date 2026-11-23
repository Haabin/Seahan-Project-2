/**
 * 재고현황에 보여줄 "생산 예정": 확정된 생산계획(Rev)의 날짜별 계획 수량을 제품별로 모은다.
 * 실적(수불표의 생산 칸)은 건드리지 않는다. 화면에 회색으로만 보여준다.
 *  - 계획마다 최신 확정 Rev 만 쓴다. 초안은 쓰지 않는다.
 *  - 계획 기간이 겹치는 날짜는 더 나중에 시작한 계획을 쓴다(15일 계획이 매주 겹친다).
 *  - 수량을 비워 둔 칸은 엔진의 예상 생산량(Capa × 교체 계수 × 주말 계수)을 쓴다.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { recalc } from "@/lib/engine";
import { buildEngineInput, loadCells, type PlanHeader } from "@/lib/data/load-engine-input";
import { ymRange } from "@/lib/data/stock";

export interface PlannedProduction {
  /** 제품 id → 일(1~31) → 계획 수량 */
  byProduct: Record<string, Record<number, number>>;
  /** 참고한 확정 계획 (예: "11/19 주 Rev 0") */
  sources: string[];
}

export async function loadPlannedProduction(db: SupabaseClient, yearMonth: string): Promise<PlannedProduction> {
  const { start, end } = ymRange(yearMonth);
  const { data: plans, error } = await db
    .from("plans")
    .select("id, factory_id, process_tab, period_start, period_end, factories(code), plan_revisions(id, rev_no, status)")
    .eq("process_tab", "1STAGE")
    .lte("period_start", end)
    .gte("period_end", start)
    .order("period_start");
  if (error) throw new Error(error.message);

  // 날짜 → 제품 → 수량
  const byDate = new Map<string, Map<string, number>>();
  const sources: string[] = [];
  for (const p of plans ?? []) {
    const revs = ((p.plan_revisions ?? []) as { id: string; rev_no: number | null; status: string }[]).filter((r) => r.status === "confirmed" && r.rev_no !== null);
    if (!revs.length) continue;
    const latest = revs.sort((a, b) => (b.rev_no ?? 0) - (a.rev_no ?? 0))[0];
    const f = p.factories as unknown as { code: string } | { code: string }[] | null;
    const header: PlanHeader = {
      id: p.id,
      factoryId: p.factory_id,
      factoryCode: (Array.isArray(f) ? f[0]?.code : f?.code) ?? "F1",
      processTab: p.process_tab,
      periodStart: p.period_start,
      periodEnd: p.period_end,
    };
    const cells = await loadCells(db, latest.id);
    const { input } = await buildEngineInput(db, header, cells);
    const result = recalc(input);
    // 이 계획이 덮는 날짜는 앞선 계획 값을 지우고 다시 넣는다
    for (const d of result.periodDates) byDate.delete(d);
    for (const c of result.cells) {
      if (!c.productId || c.expectedQty <= 0) continue;
      const m = byDate.get(c.date) ?? new Map<string, number>();
      m.set(c.productId, (m.get(c.productId) ?? 0) + c.expectedQty);
      byDate.set(c.date, m);
    }
    sources.push(`${Number(p.period_start.slice(5, 7))}/${Number(p.period_start.slice(8, 10))} 주 Rev ${latest.rev_no}`);
  }

  const byProduct: PlannedProduction["byProduct"] = {};
  for (const [date, m] of byDate) {
    if (date < start || date > end) continue;
    const day = Number(date.slice(8, 10));
    for (const [productId, qty] of m) {
      (byProduct[productId] ??= {})[day] = Math.round(qty);
    }
  }
  return { byProduct, sources };
}
