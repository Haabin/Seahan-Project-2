"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createSupabaseServer } from "@/lib/supabase/server";
import { requireWriter } from "@/lib/auth/session";
import { removeDraftCellsOfOrder } from "@/lib/data/order-cells";
import { planPurchaseOrders, purchaseCodeKey, type PurchaseOrderRow } from "@/lib/orders/from-purchase";
import { orderNoKey, todayKst } from "@/lib/orders/validate";

type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };
const fail = (error: string): ActionResult<never> => ({ ok: false, error });

const sendSchema = z.object({
  requestId: z.string().uuid(),
  links: z.array(z.object({ line: z.number().int().positive(), productId: z.string().uuid().nullable() })).max(5000),
});

export interface SendPurchaseResult {
  inserted: number;
  updated: number;
  removed: number;
  /** 제품을 연결하지 않고 보낸 품목 수 */
  unlinked: number;
}

/**
 * 저장된 발주서 검토본의 품목을 주문(orders)으로 보낸다.
 * 품목 하나 = 주문 한 건(주문번호 "발주번호-행번호"). 다시 보내면 같은 주문을 고친다.
 * 고른 제품 연결은 "품번 → 제품"으로 저장해 다음 발주서에서 먼저 채운다.
 */
export async function sendPurchaseToOrders(input: unknown): Promise<ActionResult<SendPurchaseResult>> {
  try {
    const s = await requireWriter();
    const { requestId, links } = sendSchema.parse(input);
    const db = await createSupabaseServer();

    // 발주서는 작성자 본인 것만 읽힌다(RLS)
    const { data: request, error: reqError } = await db.from("purchase_requests").select("id, request_number, customer_name").eq("id", requestId).maybeSingle();
    if (reqError) return fail(reqError.message);
    if (!request) return fail("발주서를 찾을 수 없습니다. 검토본을 먼저 저장하세요.");

    const { data: itemRows, error: itemError } = await db
      .from("purchase_request_items")
      .select("line_number, product_code, product_name, quantity, requested_date, customer_name, note")
      .eq("request_id", requestId)
      .order("line_number");
    if (itemError) return fail(itemError.message);

    const { data: existing, error: exError } = await db.from("orders").select("id, purchase_line, status").eq("purchase_request_id", requestId);
    if (exError) return fail(exError.message);

    const linkByLine: Record<number, string | null> = {};
    for (const l of links) linkByLine[l.line] = l.productId;

    const plan = planPurchaseOrders({
      requestNumber: request.request_number as string,
      customer: (request.customer_name as string) ?? "",
      items: (itemRows ?? []).map((r) => ({
        line: Number(r.line_number),
        productCode: (r.product_code as string) ?? "",
        productName: (r.product_name as string) ?? "",
        quantity: Number(r.quantity),
        requestedDate: (r.requested_date as string | null) ?? null,
        customer: (r.customer_name as string) ?? "",
        note: (r.note as string) ?? "",
      })),
      links: linkByLine,
      existing: (existing ?? []).map((e) => ({ id: e.id as string, line: e.purchase_line === null ? null : Number(e.purchase_line), status: e.status as string })),
      today: todayKst(),
    });
    if (plan.errors.length) return fail(plan.errors.slice(0, 8).join("\n"));

    // 이 발주서와 무관한 주문이 같은 주문번호를 쓰고 있으면 받지 않는다
    const ownIds = new Set((existing ?? []).map((e) => e.id as string));
    const { data: numbered, error: noError } = await db.from("orders").select("id, order_no").not("order_no", "is", null);
    if (noError) return fail(noError.message);
    const taken = new Set((numbered ?? []).filter((o) => !ownIds.has(o.id as string)).map((o) => orderNoKey(o.order_no as string)));
    const clash = [...plan.inserts, ...plan.updates.map((u) => u.row)].find((r) => taken.has(orderNoKey(r.orderNo)));
    if (clash) return fail(`주문번호 "${clash.orderNo}" 은(는) 다른 주문이 이미 쓰고 있습니다. 발주번호를 바꾸거나 기존 주문을 정리하세요.`);

    // 거래처 이름 → 거래처
    const names = [...new Set([...plan.inserts, ...plan.updates.map((u) => u.row)].map((r) => r.customerName).filter((n): n is string => !!n))];
    const customerIdByName = new Map<string, string>();
    if (names.length) {
      const { data: customers } = await db.from("customers").select("id, name").in("name", names);
      for (const c of customers ?? []) customerIdByName.set(c.name as string, c.id as string);
    }
    const toRow = (r: PurchaseOrderRow) => ({
      order_no: r.orderNo,
      product_id: r.productId,
      product_name_raw: r.productNameRaw,
      item_code_raw: r.itemCodeRaw,
      customer_id: r.customerName ? (customerIdByName.get(r.customerName) ?? null) : null,
      customer_name_raw: r.customerName,
      qty: r.qty,
      due_date: r.dueDate,
      memo: r.memo,
      purchase_request_id: requestId,
      purchase_line: r.line,
    });

    // 고른 연결을 기억한다 (품번이 있는 품목만)
    const rememberByCode = new Map<string, { product_code: string; product_id: string; product_name_raw: string; updated_by: string; updated_at: string }>();
    for (const r of [...plan.inserts, ...plan.updates.map((u) => u.row)]) {
      const code = purchaseCodeKey(r.itemCodeRaw);
      if (code && r.productId) rememberByCode.set(code, { product_code: code, product_id: r.productId, product_name_raw: r.productNameRaw, updated_by: s.userId, updated_at: new Date().toISOString() });
    }
    if (rememberByCode.size) {
      const { error } = await db.from("purchase_product_links").upsert([...rememberByCode.values()], { onConflict: "product_code" });
      if (error) return fail(error.message);
    }

    if (plan.inserts.length) {
      const { error } = await db.from("orders").insert(plan.inserts.map((r) => ({ ...toRow(r), created_by: s.userId })));
      if (error) return fail(error.message);
    }
    for (const u of plan.updates) {
      const { error } = await db.from("orders").update({ ...toRow(u.row), updated_at: new Date().toISOString() }).eq("id", u.id);
      if (error) return fail(error.message);
    }
    for (const id of plan.removes) {
      await removeDraftCellsOfOrder(db, id);
      const { error } = await db.from("orders").delete().eq("id", id);
      if (error) return fail(error.message);
    }

    revalidatePath("/orders");
    revalidatePath("/plan");
    return { ok: true, data: { inserted: plan.inserts.length, updated: plan.updates.length, removed: plan.removes.length, unlinked: plan.unlinked } };
  } catch (e) {
    if (e instanceof z.ZodError) return fail(e.issues[0]?.message ?? "입력값이 올바르지 않습니다");
    return fail(e instanceof Error ? e.message : String(e));
  }
}
