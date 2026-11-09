import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { getSession, canWrite } from "@/lib/auth/session";
import { parseShipmentsWorkbook } from "@/lib/excel/import-shipments";

export const runtime = "nodejs";

/** FR-05 출고일정표 업로드: 파일에 포함된 날짜 범위의 출고계획을 전체 교체한다 (Q13) */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session || !canWrite(session.role)) return NextResponse.json({ error: "작성 권한이 필요합니다" }, { status: 403 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "파일이 없습니다" }, { status: 400 });

  let parsed;
  try {
    parsed = await parseShipmentsWorkbook(Buffer.from(await file.arrayBuffer()));
  } catch (e) {
    return NextResponse.json({ error: `엑셀을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}` }, { status: 400 });
  }
  if (parsed.rows.length === 0) return NextResponse.json({ error: "읽은 행이 없습니다" }, { status: 400 });

  const db = await createSupabaseServer();
  const [{ data: products }, { data: customers }] = await Promise.all([
    db.from("products").select("id, name"),
    db.from("customers").select("id, name"),
  ]);
  const pid = new Map((products ?? []).map((p) => [norm(p.name), p.id]));
  const cid = new Map((customers ?? []).map((c) => [norm(c.name), c.id]));
  const warnings = [...parsed.warnings];

  // 신규 거래처 생성
  const newCustomers = [...new Set(parsed.rows.map((r) => r.customerName).filter((n) => n && !cid.has(norm(n))))];
  if (newCustomers.length) {
    const ins = await db
      .from("customers")
      .insert(newCustomers.map((name) => ({ name, is_major: parsed.rows.some((r) => r.customerName === name && r.isMajor) })))
      .select("id, name");
    if (ins.error) return NextResponse.json({ error: ins.error.message }, { status: 400 });
    for (const c of ins.data ?? []) cid.set(norm(c.name), c.id);
  }

  const upload = await db
    .from("uploads")
    .insert({ kind: "shipment", filename: file.name, uploaded_by: session.userId, row_count: parsed.rows.length, warnings })
    .select("id")
    .single();
  if (upload.error) return NextResponse.json({ error: upload.error.message }, { status: 400 });

  const rows = [];
  const unmatched: string[] = [];
  for (const r of parsed.rows) {
    const p = pid.get(norm(r.productName));
    if (!p) {
      unmatched.push(r.productName);
      continue;
    }
    rows.push({ product_id: p, customer_id: cid.get(norm(r.customerName)) ?? null, ship_date: r.shipDate, qty: r.qty, upload_id: upload.data.id });
  }
  const dates = rows.map((r) => r.ship_date).sort();
  if (rows.length) {
    const del = await db.from("shipments").delete().gte("ship_date", dates[0]).lte("ship_date", dates[dates.length - 1]);
    if (del.error) return NextResponse.json({ error: del.error.message }, { status: 400 });
    const ins = await db.from("shipments").insert(rows);
    if (ins.error) return NextResponse.json({ error: ins.error.message }, { status: 400 });
  }
  const uniqUnmatched = [...new Set(unmatched)];
  if (uniqUnmatched.length) {
    await db.from("uploads").update({ warnings: [...warnings, ...uniqUnmatched.map((n) => `제품 "${n}" 매칭 실패`)] }).eq("id", upload.data.id);
  }
  return NextResponse.json({ inserted: rows.length, range: dates.length ? [dates[0], dates[dates.length - 1]] : null, unmatched: uniqUnmatched, warnings });
}

function norm(s: string) {
  return (s ?? "").normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}
