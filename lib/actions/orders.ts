"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createSupabaseServer } from "@/lib/supabase/server";
import { requireWriter } from "@/lib/auth/session";

type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };
const fail = (error: string): ActionResult<never> => ({ ok: false, error });

const orderSchema = z.object({
  id: z.string().uuid().optional(),
  orderNo: z.string().max(60).nullable().optional(),
  productId: z.string().uuid().nullable(),
  productNameRaw: z.string().trim().min(1, "품명을 입력하세요").max(200),
  customerName: z.string().max(100).nullable().optional(),
  qty: z.number().positive("수량은 0보다 커야 합니다"),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "납기일을 고르세요"),
  memo: z.string().max(300).nullable().optional(),
});

async function customerIdFor(db: Awaited<ReturnType<typeof createSupabaseServer>>, name: string | null | undefined): Promise<string | null> {
  const n = name?.trim();
  if (!n) return null;
  const { data } = await db.from("customers").select("id").eq("name", n).maybeSingle();
  return data?.id ?? null;
}

/** 주문 등록·수정 */
export async function upsertOrder(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const s = await requireWriter();
    const o = orderSchema.parse(input);
    const db = await createSupabaseServer();
    const row = {
      order_no: o.orderNo?.trim() || null,
      product_id: o.productId,
      product_name_raw: o.productNameRaw,
      customer_id: await customerIdFor(db, o.customerName),
      customer_name_raw: o.customerName?.trim() || null,
      qty: Math.round(o.qty),
      due_date: o.dueDate,
      memo: o.memo?.trim() || null,
      updated_at: new Date().toISOString(),
    };
    const q = o.id ? db.from("orders").update(row).eq("id", o.id).select("id").single() : db.from("orders").insert({ ...row, created_by: s.userId }).select("id").single();
    const { data, error } = await q;
    if (error) return fail(error.message);
    revalidatePath("/orders");
    revalidatePath("/plan");
    return { ok: true, data: { id: data.id } };
  } catch (e) {
    if (e instanceof z.ZodError) return fail(e.issues[0]?.message ?? "입력값이 올바르지 않습니다");
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function setOrderStatus(id: string, status: "open" | "done" | "cancelled"): Promise<ActionResult> {
  try {
    await requireWriter();
    const db = await createSupabaseServer();
    const { error } = await db.from("orders").update({ status, updated_at: new Date().toISOString() }).eq("id", z.string().uuid().parse(id));
    if (error) return fail(error.message);
    revalidatePath("/orders");
    revalidatePath("/plan");
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function deleteOrder(id: string): Promise<ActionResult> {
  try {
    await requireWriter();
    const db = await createSupabaseServer();
    const { error } = await db.from("orders").delete().eq("id", z.string().uuid().parse(id));
    if (error) return fail(error.message);
    revalidatePath("/orders");
    revalidatePath("/plan");
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
