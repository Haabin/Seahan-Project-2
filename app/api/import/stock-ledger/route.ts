import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { getSession, canWrite } from "@/lib/auth/session";
import { parseStockLedgerWorkbook } from "@/lib/excel/stock-ledger";
import { planStockUpload, type ExistingStockItem } from "@/lib/stock/plan-upload";
import { fetchAll, ymRange } from "@/lib/data/stock";

export const runtime = "nodejs";

/**
 * 제품수불표 업로드.
 * multipart: file(.xlsx), mode('preview' | 'apply'), year, month, applySuggestions('1' 이면 품명이 같은 제품과 연결)
 *  - preview: 아무것도 쓰지 않고 반영될 내용만 돌려준다.
 *  - apply  : 그 월 데이터를 통째로 교체하고 uploads 에 기록한다.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session || !canWrite(session.role)) return NextResponse.json({ error: "작성 권한이 필요합니다" }, { status: 403 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "파일이 없습니다" }, { status: 400 });
  const mode = form.get("mode") === "apply" ? "apply" : "preview";

  let parsed;
  try {
    parsed = await parseStockLedgerWorkbook(Buffer.from(await file.arrayBuffer()), { filename: file.name });
  } catch (e) {
    return NextResponse.json({ error: `엑셀을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}` }, { status: 400 });
  }
  if (!parsed.rows.length) return NextResponse.json({ error: parsed.warnings[0] ?? "읽은 품목이 없습니다", warnings: parsed.warnings }, { status: 400 });

  const year = Number(form.get("year")) || parsed.year;
  const month = Number(form.get("month")) || parsed.month;

  const db = await createSupabaseServer();
  const [itemRows, { data: products }] = await Promise.all([
    fetchAll<{ id: string; section: string; process: string; machine_label: string; item_code: string | null; name: string; dup_index: number; product_id: string | null }>(
      (from, to) => db.from("stock_items").select("id, section, process, machine_label, item_code, name, dup_index, product_id").order("id").range(from, to),
    ),
    db.from("products").select("id, name"),
  ]);
  const existing: ExistingStockItem[] = itemRows.map((i) => ({
    id: i.id,
    section: i.section,
    process: i.process,
    machineLabel: i.machine_label,
    itemCode: i.item_code,
    name: i.name,
    dupIndex: i.dup_index,
    productId: i.product_id,
  }));
  const preview = planStockUpload(parsed.rows, existing, products ?? []);

  const summary = {
    sheetName: parsed.sheetName,
    year: year ?? null,
    month: month ?? null,
    detectedYear: parsed.year,
    detectedMonth: parsed.month,
    rowCount: preview.rowCount,
    dayValueCount: preview.dayValueCount,
    newItems: preview.newItems,
    unlinkedItems: preview.unlinkedItems,
    suggestions: preview.suggestions,
    totals: preview.totals,
    sections: parsed.sections,
    warnings: parsed.warnings,
  };
  if (mode === "preview") return NextResponse.json({ mode, ...summary });

  if (!year || !month || month < 1 || month > 12) return NextResponse.json({ error: "연도와 월을 골라 주세요" }, { status: 400 });
  const yearMonth = `${year}-${String(month).padStart(2, "0")}`;
  const { start, end, days: monthDays } = ymRange(yearMonth);
  const applySuggestions = form.get("applySuggestions") === "1";
  const now = new Date().toISOString();

  const upload = await db
    .from("uploads")
    .insert({ kind: "stock_ledger", filename: file.name, uploaded_by: session.userId, row_count: parsed.rows.length, warnings: parsed.warnings })
    .select("id")
    .single();
  if (upload.error) return NextResponse.json({ error: upload.error.message }, { status: 400 });

  // 그 월 데이터 교체
  const delDays = await db.from("stock_ledger_days").delete().gte("date", start).lte("date", end);
  if (delDays.error) return NextResponse.json({ error: delDays.error.message }, { status: 400 });
  const delMonths = await db.from("stock_ledger_months").delete().eq("year_month", yearMonth);
  if (delMonths.error) return NextResponse.json({ error: delMonths.error.message }, { status: 400 });

  const ids: string[] = [];
  const itemUpserts = preview.plans.map((p) => {
    const id = p.existingId ?? randomUUID();
    ids.push(id);
    return {
      id,
      section: p.row.section,
      process: p.row.process,
      machine_label: p.row.machineLabel,
      item_code: p.row.itemCode,
      name: p.row.name,
      dup_index: p.row.dupIndex,
      pack_unit: p.row.packUnit,
      units_per_pallet: p.row.unitsPerPallet,
      product_id: p.linkedProductId ?? (applySuggestions ? p.suggestedProductId : null),
      updated_by: session.userId,
      updated_at: now,
    };
  });
  for (let i = 0; i < itemUpserts.length; i += 500) {
    const { error } = await db.from("stock_items").upsert(itemUpserts.slice(i, i + 500), { onConflict: "id" });
    if (error) return NextResponse.json({ error: `품목 저장 실패: ${error.message}` }, { status: 400 });
  }

  const monthRows = preview.plans.map((p, i) => ({
    item_id: ids[i],
    year_month: yearMonth,
    opening_qty: Math.round(p.row.opening),
    sort_order: i,
    upload_id: upload.data.id,
    updated_by: session.userId,
    updated_at: now,
  }));
  for (let i = 0; i < monthRows.length; i += 500) {
    const { error } = await db.from("stock_ledger_months").insert(monthRows.slice(i, i + 500));
    if (error) return NextResponse.json({ error: `기초재고 저장 실패: ${error.message}` }, { status: 400 });
  }

  const dayRows = preview.plans.flatMap((p, i) =>
    p.row.days
      .filter((d) => d.day <= monthDays)
      .map((d) => ({
        item_id: ids[i],
        date: `${yearMonth}-${String(d.day).padStart(2, "0")}`,
        produced: Math.round(d.produced),
        shipped: Math.round(d.shipped),
        updated_by: session.userId,
        updated_at: now,
      })),
  );
  for (let i = 0; i < dayRows.length; i += 1000) {
    const { error } = await db.from("stock_ledger_days").insert(dayRows.slice(i, i + 1000));
    if (error) return NextResponse.json({ error: `일자별 수량 저장 실패: ${error.message}` }, { status: 400 });
  }

  const sync = await db.rpc("sync_inventory_from_ledger", { p_year_month: yearMonth });
  const warnings = [...parsed.warnings];
  if (sync.error) warnings.push(`수급 검증용 재고 동기화 실패: ${sync.error.message}`);

  return NextResponse.json({ mode, ...summary, warnings, yearMonth, applied: preview.rowCount, snapshots: Number(sync.data ?? 0) });
}
