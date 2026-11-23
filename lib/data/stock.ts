/**
 * 재고현황(제품수불표) 조회. RLS 가 적용된 서버 클라이언트로 읽는다.
 * Supabase 는 한 번에 1,000행까지만 돌려주므로 일자 데이터는 나눠 읽는다.
 */
import type { createSupabaseServer } from "@/lib/supabase/server";
import { daysInMonth, type StockLedgerRow } from "@/lib/excel/stock-ledger";

type DB = Awaited<ReturnType<typeof createSupabaseServer>>;

export interface StockRowView extends StockLedgerRow {
  id: string;
  productId: string | null;
}

export interface StockMonthData {
  yearMonth: string;
  rows: StockRowView[];
  /** 데이터 기준 시각: 이 달 마지막 업로드 */
  uploadedAt: string | null;
  uploadFilename: string | null;
  /** 마지막 직접 수정 시각 */
  editedAt: string | null;
}

export function ymRange(yearMonth: string): { start: string; end: string; year: number; month: number; days: number } {
  const [y, m] = yearMonth.split("-").map(Number);
  const days = daysInMonth(y, m);
  return { start: `${yearMonth}-01`, end: `${yearMonth}-${String(days).padStart(2, "0")}`, year: y, month: m, days };
}

export function isYearMonth(s: string | null | undefined): s is string {
  return !!s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/** 1,000행 제한을 넘는 조회를 나눠 읽는다 */
export async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, size = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += size) {
    const { data, error } = await page(from, from + size - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < size) break;
  }
  return out;
}

export async function listStockMonths(db: DB): Promise<string[]> {
  const rows = await fetchAll<{ year_month: string }>((from, to) => db.from("stock_ledger_months").select("year_month").order("year_month", { ascending: false }).range(from, to));
  return Array.from(new Set(rows.map((r) => r.year_month)));
}

export async function loadStockMonth(db: DB, yearMonth: string): Promise<StockMonthData> {
  const { start, end } = ymRange(yearMonth);
  const months = await fetchAll<{
    item_id: string;
    opening_qty: number | string;
    sort_order: number;
    upload_id: string | null;
    updated_at: string;
  }>((from, to) =>
    db.from("stock_ledger_months").select("item_id, opening_qty, sort_order, upload_id, updated_at").eq("year_month", yearMonth).order("sort_order").range(from, to),
  );
  if (!months.length) return { yearMonth, rows: [], uploadedAt: null, uploadFilename: null, editedAt: null };

  const [items, days] = await Promise.all([
    fetchAll<{
      id: string;
      section: string;
      process: string;
      machine_label: string;
      item_code: string | null;
      name: string;
      dup_index: number;
      pack_unit: number | string | null;
      units_per_pallet: number | string | null;
      product_id: string | null;
      updated_at: string;
    }>((from, to) =>
      db.from("stock_items").select("id, section, process, machine_label, item_code, name, dup_index, pack_unit, units_per_pallet, product_id, updated_at").order("id").range(from, to),
    ),
    fetchAll<{ item_id: string; date: string; produced: number | string; shipped: number | string; updated_at: string }>((from, to) =>
      db.from("stock_ledger_days").select("item_id, date, produced, shipped, updated_at").gte("date", start).lte("date", end).order("item_id").order("date").range(from, to),
    ),
  ]);
  const itemById = new Map(items.map((i) => [i.id, i] as const));
  const daysByItem = new Map<string, StockLedgerRow["days"]>();
  let editedAt: string | null = null;
  const bump = (t: string | null | undefined) => {
    if (t && (!editedAt || t > editedAt)) editedAt = t;
  };
  for (const d of days) {
    const arr = daysByItem.get(d.item_id) ?? [];
    arr.push({ day: Number(d.date.slice(8, 10)), produced: Number(d.produced), shipped: Number(d.shipped) });
    daysByItem.set(d.item_id, arr);
    bump(d.updated_at);
  }

  const rows: StockRowView[] = [];
  const uploadIds = new Set<string>();
  for (const m of months) {
    const it = itemById.get(m.item_id);
    if (!it) continue;
    if (m.upload_id) uploadIds.add(m.upload_id);
    bump(m.updated_at);
    rows.push({
      id: it.id,
      section: it.section,
      process: it.process,
      machineLabel: it.machine_label,
      itemCode: it.item_code,
      name: it.name,
      dupIndex: it.dup_index,
      opening: Number(m.opening_qty),
      packUnit: it.pack_unit === null ? null : Number(it.pack_unit),
      unitsPerPallet: it.units_per_pallet === null ? null : Number(it.units_per_pallet),
      days: daysByItem.get(it.id) ?? [],
      productId: it.product_id,
    });
  }

  let uploadedAt: string | null = null;
  let uploadFilename: string | null = null;
  if (uploadIds.size) {
    const { data } = await db.from("uploads").select("uploaded_at, filename").in("id", Array.from(uploadIds)).order("uploaded_at", { ascending: false }).limit(1);
    uploadedAt = data?.[0]?.uploaded_at ?? null;
    uploadFilename = data?.[0]?.filename ?? null;
  }
  return { yearMonth, rows, uploadedAt, uploadFilename, editedAt };
}
