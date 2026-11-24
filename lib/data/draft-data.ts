/**
 * 초안 자동 생성에 필요한 데이터 모음: 주문, 금형, 과거 확정 계획, 재고현황의 현재고.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DraftHistoryCell, DraftMold, DraftOrder } from "@/lib/engine/draft";
import { stockTotals } from "@/lib/excel/stock-ledger";
import { fetchAll, loadStockMonth } from "@/lib/data/stock";
import { unwrapInOrder } from "@/lib/data/settle";
import { historyFrom, pickHistorySources, plansInHistoryWindow, type HistoryPlanInput } from "@/lib/data/draft-sources";

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

/**
 * 재고현황의 최신 월 = stock_ledger_months 전체에서 가장 큰 year_month (기간과 무관).
 * 예전 listStockMonths(전체 행을 year_month 내림차순으로 읽고 중복 제거) 의 첫 값과 같다. 표가 비면 null, 조회 오류는 같은 문구로 던진다.
 */
async function latestStockMonth(db: SupabaseClient): Promise<string | null> {
  const { data, error } = await db.from("stock_ledger_months").select("year_month").order("year_month", { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  return (data?.[0]?.year_month as string | undefined) ?? null;
}

/**
 * @param planList /plan 이 이미 읽은 1STAGE 계획 목록. 주면 과거 계획을 따로 조회하지 않고 여기서 고른다(같은 조건).
 */
export async function loadDraftData(db: SupabaseClient, periodStart: string, settings: { key: string; value: unknown }[], planList?: HistoryPlanInput[]): Promise<DraftData> {
  const get = (k: string) => settings.find((s) => s.key === k)?.value;
  const historyWeeks = Number(get("draft_history_weeks") ?? 8) || 8;
  const useNetRequirementDefault = get("draft_use_net_requirement") !== false;
  const from = historyFrom(periodStart, historyWeeks);

  const [orders, molds, plans, latestMonth] = await Promise.all([
    loadOrders(db),
    loadMolds(db),
    planList
      ? Promise.resolve({ data: null, error: null })
      : db.from("plans").select("id, period_start, plan_revisions(id, rev_no, status)").eq("process_tab", "1STAGE").gte("period_start", from).lt("period_start", periodStart).order("period_start"),
    latestStockMonth(db),
  ]);
  if (plans.error) throw new Error(plans.error.message);

  // 계획마다 최신 확정 Rev
  const windowPlans: HistoryPlanInput[] = planList
    ? plansInHistoryWindow(planList, periodStart, historyWeeks)
    : ((plans.data ?? []) as { period_start: string; plan_revisions: { id: string; rev_no: number | null; status: string }[] | null }[]).map((p) => ({
        periodStart: p.period_start,
        revisions: (p.plan_revisions ?? []).map((r) => ({ id: r.id, revNo: r.rev_no, status: r.status })),
      }));
  const sources = pickHistorySources(windowPlans);

  // 과거 계획 셀(계획마다)과 재고 최신 월은 서로 독립이라 함께 읽는다. 오류는 예전 순서(과거 계획 차례 → 재고)대로 던진다
  const historyTask = Promise.allSettled(
    sources.map((s) =>
      fetchAll<{ line_id: string; date: string; product_id: string | null; changeover_type: "NONE" | "BM" | "FULL"; mold_id: string | null }>((a, b) =>
        db.from("plan_cells").select("line_id, date, product_id, changeover_type, mold_id").eq("revision_id", s.revId).order("line_id").order("date").range(a, b),
      ),
    ),
  );
  const stockTask = latestMonth ? loadStockMonth(db, latestMonth) : Promise.resolve(null);
  // allSettled 는 실패하지 않으므로 과거 계획 셀의 실패는 historyCells 를 풀 때 계획 순서대로 던진다 → 그다음 재고
  const [historySettled, month] = unwrapInOrder(await Promise.allSettled([historyTask, stockTask]));
  const historyCells = unwrapInOrder(historySettled);

  const history: DraftHistoryCell[] = [];
  const historySources: DraftData["historySources"] = [];
  sources.forEach((s, i) => {
    let n = 0;
    for (const c of historyCells[i]) {
      // 이번 기간과 겹치는 날짜는 과거가 아니므로 뺀다
      if (!c.product_id || c.date >= periodStart) continue;
      history.push({ lineId: c.line_id, date: c.date, productId: c.product_id, changeoverType: c.changeover_type, moldId: c.mold_id, sourceLabel: s.label });
      n++;
    }
    historySources.push({ label: s.label, periodStart: s.periodStart, cellCount: n });
  });
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
  if (latestMonth && month) {
    stockAsOf = latestMonth;
    for (const r of month.rows) {
      if (!r.productId) continue;
      stockByProduct[r.productId] = (stockByProduct[r.productId] ?? 0) + stockTotals(r).current;
    }
  }
  return { orders, molds, history, historySources, stockByProduct, stockAsOf, prevLastProductByLine, historyWeeks, useNetRequirementDefault };
}
