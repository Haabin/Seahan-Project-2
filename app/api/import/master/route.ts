import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { getSession, isAdmin } from "@/lib/auth/session";
import { parseMasterWorkbook } from "@/lib/excel/import-master";

export const runtime = "nodejs";

/** FR-01 제품배치 운용안 일괄 등록: 제품 upsert, 호기별 허용 금형·Capa·월별 물량 교체 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session || !isAdmin(session.role)) return NextResponse.json({ error: "관리자 권한이 필요합니다" }, { status: 403 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "파일이 없습니다" }, { status: 400 });

  let parsed;
  try {
    parsed = await parseMasterWorkbook(Buffer.from(await file.arrayBuffer()));
  } catch (e) {
    return NextResponse.json({ error: `엑셀을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}` }, { status: 400 });
  }

  const db = await createSupabaseServer();
  const { data: lines } = await db.from("lines").select("id, code, name");
  const lineByCode = new Map((lines ?? []).flatMap((l) => [[norm(l.code), l.id], [norm(l.name), l.id]]));
  const warnings = [...parsed.warnings];

  // 1) 제품 upsert (code 기준)
  const productRows = new Map<string, (typeof parsed.rows)[number]>();
  for (const r of parsed.rows) if (!productRows.has(r.productCode)) productRows.set(r.productCode, r);
  const upsert = await db
    .from("products")
    .upsert(
      [...productRows.values()].map((r) => ({
        code: r.productCode,
        name: r.productName,
        cavity: r.cavity,
        pack_unit: r.packUnit,
        preform_weight_g: r.weightG,
        default_daily_capa: r.dailyCapa,
        safety_stock: r.safetyStock ?? 0,
        updated_by: session.userId,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "code" },
    )
    .select("id, code");
  if (upsert.error) return NextResponse.json({ error: upsert.error.message }, { status: 400 });
  const productId = new Map((upsert.data ?? []).map((p) => [p.code, p.id]));

  // 2) 허용 금형 · Capa · 월별 물량 (파일에 등장한 호기만 교체)
  const touchedLines = new Set<string>();
  const molds: { line_id: string; product_id: string }[] = [];
  const caps: { line_id: string; product_id: string; daily_capa: number }[] = [];
  const monthly: { line_id: string; product_id: string; year_month: string; qty: number; working_days: number }[] = [];
  for (const r of parsed.rows) {
    const lid = lineByCode.get(norm(r.lineCode));
    const pid = productId.get(r.productCode);
    if (!lid) {
      warnings.push(`호기 "${r.lineCode}" 를 찾지 못해 건너뜀`);
      continue;
    }
    if (!pid) continue;
    touchedLines.add(lid);
    molds.push({ line_id: lid, product_id: pid });
    if (r.dailyCapa > 0) caps.push({ line_id: lid, product_id: pid, daily_capa: r.dailyCapa });
    for (const m of r.monthly) monthly.push({ line_id: lid, product_id: pid, year_month: m.yearMonth, qty: m.qty, working_days: m.workingDays });
  }
  const lineIds = [...touchedLines];
  if (lineIds.length) {
    for (const t of ["line_allowed_molds", "line_product_capacity", "monthly_operation_plan"] as const) {
      const del = await db.from(t).delete().in("line_id", lineIds);
      if (del.error) return NextResponse.json({ error: del.error.message }, { status: 400 });
    }
    const r1 = await db.from("line_allowed_molds").upsert(molds, { onConflict: "line_id,product_id" });
    const r2 = await db.from("line_product_capacity").upsert(caps, { onConflict: "line_id,product_id" });
    const r3 = await db.from("monthly_operation_plan").upsert(monthly, { onConflict: "product_id,line_id,year_month" });
    const err = r1.error ?? r2.error ?? r3.error;
    if (err) return NextResponse.json({ error: err.message }, { status: 400 });
  }

  await db.from("uploads").insert({ kind: "master", filename: file.name, uploaded_by: session.userId, row_count: parsed.rows.length, warnings });
  return NextResponse.json({ products: productRows.size, lines: lineIds.length, molds: molds.length, capacities: caps.length, monthly: monthly.length, warnings });
}

function norm(s: string) {
  return s.replace(/\s+/g, "").toLowerCase().replace(/호기$/, "");
}
