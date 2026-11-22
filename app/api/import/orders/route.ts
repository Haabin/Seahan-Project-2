import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { getSession, canWrite } from "@/lib/auth/session";
import { matchOrderProduct, parseOrdersWorkbook, planOrderUpsert } from "@/lib/excel/orders";

export const runtime = "nodejs";

/**
 * 주문내역 엑셀 업로드. multipart: file(.xlsx), replace('1' 이면 진행 중(open) 주문을 지우고 넣는다)
 * 주문번호가 이미 있는 주문과 같으면 새로 넣지 않고 그 주문을 덮어쓴다(같은 파일을 다시 올려도 두 배가 되지 않는다).
 */
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

  const { data: existing } = await db.from("orders").select("id, order_no").not("order_no", "is", null);
  const plan = planOrderUpsert(parsed.rows, (existing ?? []).map((e) => ({ id: e.id as string, orderNo: e.order_no as string | null })));
  const warnings = [...parsed.warnings];
  if (plan.duplicateNos.length) warnings.push(`파일에 같은 주문번호가 두 번 있어 아래쪽 행으로 넣었습니다: ${plan.duplicateNos.slice(0, 5).join(", ")}`);

  const unmatched: string[] = [];
  const toRow = (r: (typeof parsed.rows)[number]) => {
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
    };
  };
  if (plan.inserts.length) {
    const ins = await db.from("orders").insert(plan.inserts.map((r) => ({ ...toRow(r), created_by: session.userId })));
    if (ins.error) return NextResponse.json({ error: ins.error.message }, { status: 400 });
  }
  // 덮어쓰기: 주문 id 와 상태(진행 중/완료)는 그대로 두고 내용만 바꾼다. 이 주문으로 만든 초안 셀과의 연결이 유지된다
  for (const u of plan.updates) {
    const upd = await db.from("orders").update({ ...toRow(u.row), updated_at: new Date().toISOString() }).eq("id", u.id);
    if (upd.error) return NextResponse.json({ error: `주문 ${u.row.orderNo} 덮어쓰기 실패: ${upd.error.message}` }, { status: 400 });
  }
  return NextResponse.json({ inserted: plan.inserts.length, updated: plan.updates.length, unmatched: [...new Set(unmatched)], warnings });
}
