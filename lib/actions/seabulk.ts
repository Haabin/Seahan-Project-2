"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createSupabaseServer } from "@/lib/supabase/server";
import { requireWriter } from "@/lib/auth/session";

type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };
const fail = (error: string): ActionResult<never> => ({ ok: false, error });
const dateRe = /^\d{4}-\d{2}-\d{2}$/;

const receiptSchema = z.object({
  id: z.string().uuid().optional(),
  supplier: z.string().min(1).max(100),
  plannedDate: z.string().regex(dateRe),
  qtyTon: z.number().positive().max(200),
  orderDate: z.string().regex(dateRe).nullable().optional(),
  status: z.enum(["planned", "received", "cancelled"]).default("planned"),
});

/** FR-17 입고 일정 등록·수정 */
export async function upsertSiloReceipt(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const s = await requireWriter();
    const r = receiptSchema.parse(input);
    const db = await createSupabaseServer();
    const row = {
      supplier: r.supplier,
      planned_date: r.plannedDate,
      qty_ton: r.qtyTon,
      order_date: r.orderDate ?? null,
      status: r.status,
      created_by: s.userId,
    };
    const q = r.id
      ? db.from("silo_receipts").update(row).eq("id", r.id).select("id").single()
      : db.from("silo_receipts").insert(row).select("id").single();
    const { data, error } = await q;
    if (error) return fail(error.message);
    revalidatePath("/seabulk");
    return { ok: true, data: { id: data.id } };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function deleteSiloReceipt(id: string): Promise<ActionResult> {
  try {
    await requireWriter();
    const db = await createSupabaseServer();
    const { error } = await db.from("silo_receipts").delete().eq("id", id);
    if (error) return fail(error.message);
    revalidatePath("/seabulk");
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

const measurementSchema = z.object({
  date: z.string().regex(dateRe),
  values: z.array(z.object({ siloCode: z.string(), measuredTon: z.number().min(0).max(200) })),
});

/** 사일로 아침 실측 재고 입력 (5.4 일자별 기초재고) */
export async function upsertSiloMeasurement(input: unknown): Promise<ActionResult> {
  try {
    const s = await requireWriter();
    const m = measurementSchema.parse(input);
    const db = await createSupabaseServer();
    const { data: silos, error: sErr } = await db.from("silos").select("id, code");
    if (sErr) return fail(sErr.message);
    const idByCode = new Map((silos ?? []).map((x) => [x.code, x.id]));
    const rows = m.values
      .filter((v) => idByCode.has(v.siloCode))
      .map((v) => ({ date: m.date, silo_id: idByCode.get(v.siloCode)!, measured_ton: v.measuredTon, updated_by: s.userId }));
    const { error } = await db.from("silo_stock_measurements").upsert(rows, { onConflict: "date,silo_id" });
    if (error) return fail(error.message);
    revalidatePath("/seabulk");
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

const externalSchema = z.object({
  id: z.string().uuid(),
  weekdayTon: z.number().min(0).max(100),
  weekendTon: z.number().min(0).max(100),
});

/** Q9 계획 밖 사출 설비 고정 사용량 */
export async function updateExternalUsage(input: unknown): Promise<ActionResult> {
  try {
    const s = await requireWriter();
    const e = externalSchema.parse(input);
    const db = await createSupabaseServer();
    const { error } = await db
      .from("silo_external_usage")
      .update({ weekday_ton: e.weekdayTon, weekend_ton: e.weekendTon, updated_by: s.userId, updated_at: new Date().toISOString() })
      .eq("id", e.id);
    if (error) return fail(error.message);
    revalidatePath("/seabulk");
    return { ok: true, data: undefined };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
