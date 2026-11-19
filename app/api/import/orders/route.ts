import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { getSession, canWrite } from "@/lib/auth/session";
import { matchOrderProduct, parseOrdersWorkbook } from "@/lib/excel/orders";

export const runtime = "nodejs";

/** 주문내역 엑셀 업로드. multipart: file(.xlsx), replace('1' 이면 진행 중(open) 주문을 지우고 넣는다) */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session || !canWrite(session.role)) return NextResponse.json({ error: "작성 권한이 필요합니다" }, { status: 403 });
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "파일이 없습니다" }, { status: 400 });

  let parsed;
  try {
    parsed = await parseOrdersWorkbook(Buffer.from(await file.arrayBuffer()));
  } catch (e) {
    return NextResponse.json({ error: `엑셀을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}` }, { status: 400 });
  }
  if (!parsed.rows.length) return NextResponse.json({ error: parsed.warnings[0] ?? "읽은 주문이 없습니다", warnings: parsed.warnings }, { status: 400 });

  const db = await createSupabaseServer();
  const [{ data: products }, { data: customers }] = await Promise.all([db.from("products").select("id, code, name"), db.from("customers").select("id, name")]);
  const customerByName = new Map((customers ?? []).map((c) => [c.name, c.id] as const));

  const upload = await db
    .from("uploads")
    .insert({ kind: "orders", filename: file.name, uploaded_by: session.userId, row_count: parsed.rows.length, warnings: parsed.warnings })
    .select("id")
    .single();
  if (upload.error) return NextResponse.json({ error: upload.error.message }, { status: 400 });

  if (form.get("replace") === "1") {
    const del = await db.from("orders").delete().eq("status", "open");
    if (del.error) return NextResponse.json({ error: del.error.message }, { status: 400 });
  }

  const unmatched: string[] = [];
  const rows = parsed.rows.map((r) => {
    const productId = matchOrderProduct(r, products ?? []);
    if (!productId) unmatched.push(r.productName);
    return {
      order_no: r.orderNo,
      product_id: productId,
      product_name_raw: r.productName,
      item_code_raw: r.itemCode,
      customer_id: r.customerName ? (customerByName.get(r.customerName) ?? null) : null,
      customer_name_raw: r.customerName,
      qty: r.qty,
      due_date: r.dueDate,
      memo: r.memo,
      upload_id: upload.data.id,
      created_by: session.userId,
    };
  });
  const ins = await db.from("orders").insert(rows);
  if (ins.error) return NextResponse.json({ error: ins.error.message }, { status: 400 });
  return NextResponse.json({ inserted: rows.length, unmatched: [...new Set(unmatched)], warnings: parsed.warnings });
}
