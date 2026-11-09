"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createSupabaseServer } from "@/lib/supabase/server";
import { requireAdmin, requireWriter } from "@/lib/auth/session";

type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };
const fail = (error: string): ActionResult<never> => ({ ok: false, error });

function revalidateAll() {
  for (const p of ["/plan", "/supply", "/seabulk", "/master", "/view"]) revalidatePath(p);
}

/** NFR-07 설정값 변경 (기준정보 화면). 값은 JSON으로 저장 */
export async function updateSetting(key: string, value: unknown): Promise<ActionResult> {
  try {
    const s = await requireAdmin();
    const k = z.string().regex(/^[a-z_]+$/).parse(key);
    const db = await createSupabaseServer();
    const { error } = await db
      .from("settings")
      .update({ value, updated_by: s.userId, updated_at: new Date().toISOString() })
      .eq("key", k);
    if (error) return fail(error.message);
    revalidateAll();
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/** FR-11 가중치 — 계획 작성자도 조정할 수 있다 */
export async function updatePriorityWeights(input: unknown): Promise<ActionResult> {
  try {
    const s = await requireWriter();
    const w = z
      .object({ due_soon: z.number().min(0).max(100), major_customer: z.number().min(0).max(100), below_safety: z.number().min(0).max(100) })
      .parse(input);
    const db = await createSupabaseServer();
    const rows = Object.entries(w).map(([key, weight]) => ({ key, weight, updated_by: s.userId, updated_at: new Date().toISOString() }));
    const { error } = await db.from("priority_weights").upsert(rows, { onConflict: "key" });
    if (error) return fail(error.message);
    revalidatePath("/supply");
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

const productSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  cavity: z.number().int().nullable(),
  packUnit: z.number().int().nullable(),
  preformWeightG: z.number().min(0),
  safetyStock: z.number().min(0),
  surplusDays: z.number().int().min(1).nullable(),
  defaultDailyCapa: z.number().min(0),
  unit: z.enum(["EA", "KEA"]),
});

export async function updateProduct(input: unknown): Promise<ActionResult> {
  try {
    const s = await requireAdmin();
    const p = productSchema.parse(input);
    const db = await createSupabaseServer();
    const { error } = await db
      .from("products")
      .update({
        name: p.name,
        cavity: p.cavity,
        pack_unit: p.packUnit,
        preform_weight_g: p.preformWeightG,
        safety_stock: p.safetyStock,
        surplus_days: p.surplusDays,
        default_daily_capa: p.defaultDailyCapa,
        unit: p.unit,
        updated_by: s.userId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", p.id);
    if (error) return fail(error.message);
    revalidateAll();
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

const coefSchema = z.object({
  processType: z.enum(["PET1_1STAGE", "PET2_INJ", "PET2_BLOW", "PE"]),
  changeoverType: z.enum(["BM", "FULL"]),
  hours: z.number().min(0).max(24),
  factor: z.number().min(0).max(1),
  nextDayStart: z.boolean(),
});

export async function updateChangeoverCoefficient(input: unknown): Promise<ActionResult> {
  try {
    const s = await requireAdmin();
    const c = coefSchema.parse(input);
    const db = await createSupabaseServer();
    const { error } = await db
      .from("changeover_coefficients")
      .update({ hours: c.hours, factor: c.factor, next_day_start: c.nextDayStart, updated_by: s.userId, updated_at: new Date().toISOString() })
      .eq("process_type", c.processType)
      .eq("changeover_type", c.changeoverType);
    if (error) return fail(error.message);
    revalidateAll();
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/** 호기별 허용 금형 전체 교체 */
export async function setAllowedMolds(lineId: string, productIds: string[]): Promise<ActionResult> {
  try {
    await requireAdmin();
    z.string().uuid().parse(lineId);
    const ids = z.array(z.string().uuid()).parse(productIds);
    const db = await createSupabaseServer();
    const del = await db.from("line_allowed_molds").delete().eq("line_id", lineId);
    if (del.error) return fail(del.error.message);
    if (ids.length) {
      const ins = await db.from("line_allowed_molds").insert(ids.map((product_id) => ({ line_id: lineId, product_id })));
      if (ins.error) return fail(ins.error.message);
    }
    revalidateAll();
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function setLineProductCapacity(lineId: string, productId: string, dailyCapa: number | null): Promise<ActionResult> {
  try {
    await requireAdmin();
    const db = await createSupabaseServer();
    if (dailyCapa === null) {
      const { error } = await db.from("line_product_capacity").delete().eq("line_id", lineId).eq("product_id", productId);
      if (error) return fail(error.message);
    } else {
      const { error } = await db
        .from("line_product_capacity")
        .upsert({ line_id: lineId, product_id: productId, daily_capa: dailyCapa }, { onConflict: "line_id,product_id" });
      if (error) return fail(error.message);
    }
    revalidateAll();
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function setUserRole(userId: string, role: "viewer" | "planner" | "admin"): Promise<ActionResult> {
  try {
    await requireAdmin();
    const db = await createSupabaseServer();
    const { error } = await db.from("profiles").update({ role, updated_at: new Date().toISOString() }).eq("user_id", userId);
    if (error) return fail(error.message);
    revalidatePath("/master");
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function setCustomerMajor(customerId: string, isMajor: boolean): Promise<ActionResult> {
  try {
    await requireAdmin();
    const db = await createSupabaseServer();
    const { error } = await db.from("customers").update({ is_major: isMajor }).eq("id", customerId);
    if (error) return fail(error.message);
    revalidateAll();
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
