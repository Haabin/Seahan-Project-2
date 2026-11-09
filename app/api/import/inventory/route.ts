import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { getSession, canWrite } from "@/lib/auth/session";
import { parseInventoryWorkbook } from "@/lib/excel/import-inventory";

export const runtime = "nodejs";

/** FR-05 제품수불일보 업로드: (제품, 기준일) 기준 upsert */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session || !canWrite(session.role)) return NextResponse.json({ error: "작성 권한이 필요합니다" }, { status: 403 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "파일이 없습니다" }, { status: 400 });

  let parsed;
  try {
    parsed = await parseInventoryWorkbook(Buffer.from(await file.arrayBuffer()));
  } catch (e) {
    return NextResponse.json({ error: `엑셀을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}` }, { status: 400 });
  }
  if (parsed.rows.length === 0) return NextResponse.json({ error: "읽은 행이 없습니다" }, { status: 400 });

  const db = await createSupabaseServer();
  const { data: products } = await db.from("products").select("id, code, name");
  const byCode = new Map((products ?? []).map((p) => [p.code, p.id]));
  const byName = new Map((products ?? []).map((p) => [norm(p.name), p.id]));

  const upload = await db
    .from("uploads")
    .insert({ kind: "inventory", filename: file.name, uploaded_by: session.userId, row_count: parsed.rows.length, warnings: parsed.warnings })
    .select("id")
    .single();
  if (upload.error) return NextResponse.json({ error: upload.error.message }, { status: 400 });

  const rows = [];
  const unmatched: string[] = [];
  for (const r of parsed.rows) {
    const p = (r.productCode && byCode.get(r.productCode)) || byName.get(norm(r.productName));
    if (!p) {
      unmatched.push(r.productName || r.productCode);
      continue;
    }
    rows.push({ product_id: p, as_of_date: r.asOfDate, qty: r.qty, upload_id: upload.data.id });
  }
  if (rows.length) {
    const { error } = await db.from("inventory_snapshots").upsert(rows, { onConflict: "product_id,as_of_date" });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  }
  const uniqUnmatched = [...new Set(unmatched)];
  if (uniqUnmatched.length) {
    await db.from("uploads").update({ warnings: [...parsed.warnings, ...uniqUnmatched.map((n) => `제품 "${n}" 매칭 실패`)] }).eq("id", upload.data.id);
  }
  return NextResponse.json({ upserted: rows.length, unmatched: uniqUnmatched, warnings: parsed.warnings });
}

function norm(s: string) {
  return (s ?? "").normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}
