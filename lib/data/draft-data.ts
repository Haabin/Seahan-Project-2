/**
 * 초안 자동 생성에 필요한 데이터 모음: 주문, 금형, 과거 확정 계획, 재고현황의 현재고.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays } from "@/lib/engine/calendar";
import type { DraftHistoryCell, DraftMold, DraftOrder } from "@/lib/engine/draft";
import { stockTotals } from "@/lib/excel/stock-ledger";
import { fetchAll, listStockMonths, loadStockMonth } from "@/lib/data/stock";

export interface OrderRow extends DraftOrder {
  orderNo: string | null;
  status: "open" | "done" | "cancelled";
  memo: string | null;
  createdAt: string;
}

export interface DraftData {
  orders: OrderRow[];
  molds: DraftMold[];
  history: DraftHistoryCell[];
  /** 참고한 과거 계획 (화면 표시용) */
  historySources: { label: string; periodStart: string; cellCount: number }[];
  stockByProduct: Record<string, number>;
  stockAsOf: string | null;
  prevLastProductByLine: Record<string, string>;
  historyWeeks: number;
  useNetRequirementDefault: boolean;
}

export async function loadOrders(db: SupabaseClient): Promise<OrderRow[]> {
  const { data, error } = await db
    .from("orders")
    .select("id, order_no, product_id, product_name_raw, customer_name_raw, qty, due_date, status, memo, created_at, customers(name, is_major)")
    .order("due_date")
    .order("created_at");
  if (error) throw new Error(error.message);
  return (data ?? []).map((o) => {
    const c = o.customers as unknown as { name: string; is_major: boolean } | { name: string; is_major: boolean }[] | null;
    const cust = Array.isArray(c) ? c[0] : c;
    return {
      id: o.id,
      orderNo: o.order_no,
      productId: o.product_id,
      productNameRaw: o.product_name_raw,
      qty: Number(o.qty),
      dueDate: o.due_date,
      isMajorCustomer: !!cust?.is_major,
      customerName: cust?.name ?? o.customer_name_raw ?? null,
      status: o.status,
      memo: o.memo,
      createdAt: o.created_at,
    };
  });
}

export async function loadMolds(db: SupabaseClient): Promise<DraftMold[]> {
  const [molds, links] = await Promise.all([db.from("molds").select("id, mold_no, name, status").order("mold_no"), db.from("mold_products").select("mold_id, product_id")]);
  if (molds.error) throw new Error(molds.error.message);
  const byMold = new Map<string, string[]>();
  for (const l of links.data ?? []) byMold.set(l.mold_id, [...(byMold.get(l.mold_id) ?? []), l.product_id]);
  return (molds.data ?? []).filter((m) => m.status !== "retired").map((m) => ({ id: m.id, moldNo: m.mold_no, name: m.name, productIds: byMold.get(m.id) ?? [] }));
}

export async function loadDraftData(db: SupabaseClient, periodStart: string, settings: { key: string; value: unknown }[]): Promise<DraftData> {
  const get = (k: string) => settings.find((s) => s.key === k)?.value;
  const historyWeeks = Number(get("draft_history_weeks") ?? 8) || 8;
  const useNetRequirementDefault = get("draft_use_net_requirement") !== false;
  const from = addDays(periodStart, -7 * historyWeeks);

  const [orders, molds, plans, months] = await Promise.all([
    loadOrders(db),
    loadMolds(db),
    db.from("plans").select("id, period_start, plan_revisions(id, rev_no, status)").eq("process_tab", "1STAGE").gte("period_start", from).lt("period_start", periodStart).order("period_start"),
    listStockMonths(db),
  ]);
  if (plans.error) throw new Error(plans.error.message);

  // 계획마다 최신 확정 Rev
  const sources: { revId: string; label: string; periodStart: string }[] = [];
  for (const p of plans.data ?? []) {
    const revs = ((p.plan_revisions ?? []) as { id: string; rev_no: number | null; status: string }[]).filter((r) => r.status === "confirmed" && r.rev_no !== null);
    if (!revs.length) continue;
    const latest = revs.sort((a, b) => (b.rev_no ?? 0) - (a.rev_no ?? 0))[0];
    sources.push({ revId: latest.id, periodStart: p.period_start, label: `${Number(p.period_start.slice(5, 7))}/${Number(p.period_start.slice(8, 10))} 주 Rev ${latest.rev_no}` });
  }
  const history: DraftHistoryCell[] = [];
  const historySources: DraftData["historySources"] = [];
  for (const s of sources) {
    const cells = await fetchAll<{ line_id: string; date: string; product_id: string | null; changeover_type: "NONE" | "BM" | "FULL"; mold_id: string | null }>((a, b) =>
      db.from("plan_cells").select("line_id, date, product_id, changeover_type, mold_id").eq("revision_id", s.revId).order("line_id").order("date").range(a, b),
    );
    let n = 0;
    for (const c of cells) {
      // 이번 기간과 겹치는 날짜는 과거가 아니므로 뺀다
      if (!c.product_id || c.date >= periodStart) continue;
      history.push({ lineId: c.line_id, date: c.date, productId: c.product_id, changeoverType: c.changeover_type, moldId: c.mold_id, sourceLabel: s.label });
      n++;
    }
    historySources.push({ label: s.label, periodStart: s.periodStart, cellCount: n });
  }
  const prevLastProductByLine: Record<string, string> = {};
  const lastDate: Record<string, string> = {};
  for (const h of history) {
    if (!lastDate[h.lineId] || lastDate[h.lineId] <= h.date) {
      lastDate[h.lineId] = h.date;
      prevLastProductByLine[h.lineId] = h.productId;
    }
  }

  // 재고현황 최신 월의 현재고(제품에 연결된 품목 합)
  const stockByProduct: Record<string, number> = {};
  let stockAsOf: string | null = null;
  if (months[0]) {
    const month = await loadStockMonth(db, months[0]);
    stockAsOf = months[0];
    for (const r of month.rows) {
      if (!r.productId) continue;
      stockByProduct[r.productId] = (stockByProduct[r.productId] ?? 0) + stockTotals(r).current;
    }
  }
  return { orders, molds, history, historySources, stockByProduct, stockAsOf, prevLastProductByLine, historyWeeks, useNetRequirementDefault };
}
