"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createSupabaseServer } from "@/lib/supabase/server";
import { requireWriter } from "@/lib/auth/session";
import { isYearMonth, ymRange } from "@/lib/data/stock";

/**
 * 품목·제품 id. 8-4-4-4-12 모양이면 받는다.
 * zod 의 .uuid() 는 버전 자리까지 검사해서, 시드·적재 스크립트가 md5 로 만든 id 를 "Invalid UUID" 로 거부했다.
 */
const idSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "id 형식이 올바르지 않습니다");

type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };
const fail = (error: string): ActionResult<never> => ({ ok: false, error });

const rowSchema = z.object({
  /** 기존 품목 id. 새 행이면 null */
  id: idSchema.nullable(),
  section: z.string().max(40),
  process: z.string().max(40),
  machineLabel: z.string().max(40),
  itemCode: z.string().max(60).nullable(),
  name: z.string().trim().min(1, "품명을 입력하세요").max(200),
  opening: z.number().finite().min(0, "기초재고에는 음수를 넣을 수 없습니다"),
  packUnit: z.number().positive().nullable(),
  unitsPerPallet: z.number().positive().nullable(),
  productId: idSchema.nullable(),
  sortOrder: z.number().int(),
  days: z.array(z.object({ day: z.number().int().min(1).max(31), produced: z.number().finite(), shipped: z.number().finite() })),
});

const saveSchema = z.object({
  yearMonth: z.string().refine(isYearMonth, "연월 형식이 아닙니다"),
  upserts: z.array(rowSchema).max(2000),
  deletes: z.array(idSchema).max(2000),
});

/**
 * 재고현황 직접 입력 저장. 바뀐 행만 받는다.
 * 저장 뒤 수급 검증이 쓰는 inventory_snapshots 를 다시 맞춘다(sync_inventory_from_ledger).
 */
export async function saveStockMonth(input: unknown): Promise<ActionResult<{ saved: number; deleted: number; snapshots: number }>> {
  try {
    const s = await requireWriter();
    const { yearMonth, upserts, deletes } = saveSchema.parse(input);
    const { start, end, days: monthDays } = ymRange(yearMonth);
    const db = await createSupabaseServer();
    const now = new Date().toISOString();

    for (const id of deletes) {
      const delDays = await db.from("stock_ledger_days").delete().eq("item_id", id).gte("date", start).lte("date", end);
      if (delDays.error) return fail(delDays.error.message);
      const delMonth = await db.from("stock_ledger_months").delete().eq("item_id", id).eq("year_month", yearMonth);
      if (delMonth.error) return fail(delMonth.error.message);
      // 다른 달 기록이 없으면 품목 자체도 지운다
      const { count } = await db.from("stock_ledger_months").select("item_id", { count: "exact", head: true }).eq("item_id", id);
      if (!count) {
        const delItem = await db.from("stock_items").delete().eq("id", id);
        if (delItem.error) return fail(delItem.error.message);
      }
    }

    for (const r of upserts) {
      const fields = {
        section: r.section.trim(),
        process: r.process.trim(),
        machine_label: r.machineLabel.trim(),
        item_code: r.itemCode?.trim() || null,
        name: r.name.normalize("NFC").replace(/\s+/g, " ").trim(),
        pack_unit: r.packUnit,
        units_per_pallet: r.unitsPerPallet,
        product_id: r.productId,
        updated_by: s.userId,
        updated_at: now,
      };
      let itemId = r.id;
      if (itemId) {
        const upd = await db.from("stock_items").update(fields).eq("id", itemId);
        if (upd.error) {
          return fail(upd.error.code === "23505" ? `"${fields.name}": 같은 구간·공정·호기에 같은 품명이 이미 있습니다` : upd.error.message);
        }
      } else {
        // 같은 품명이 이미 있으면 순번을 늘려 따로 둔다
        const { data: same } = await db
          .from("stock_items")
          .select("dup_index")
          .eq("section", fields.section)
          .eq("process", fields.process)
          .eq("machine_label", fields.machine_label)
          .eq("name", fields.name);
        const dupIndex = (same ?? []).reduce((m, x) => Math.max(m, x.dup_index + 1), 0);
        const ins = await db.from("stock_items").insert({ ...fields, dup_index: dupIndex }).select("id").single();
        if (ins.error) return fail(ins.error.message);
        itemId = ins.data.id as string;
      }

      const month = await db
        .from("stock_ledger_months")
        .upsert(
          { item_id: itemId, year_month: yearMonth, opening_qty: Math.round(r.opening), sort_order: r.sortOrder, updated_by: s.userId, updated_at: now },
          { onConflict: "item_id,year_month" },
        );
      if (month.error) return fail(month.error.message);

      const del = await db.from("stock_ledger_days").delete().eq("item_id", itemId).gte("date", start).lte("date", end);
      if (del.error) return fail(del.error.message);
      const dayRows = r.days
        .filter((d) => d.day <= monthDays && (d.produced !== 0 || d.shipped !== 0))
        .map((d) => ({
          item_id: itemId,
          date: `${yearMonth}-${String(d.day).padStart(2, "0")}`,
          produced: Math.round(d.produced),
          shipped: Math.round(d.shipped),
          updated_by: s.userId,
          updated_at: now,
        }));
      if (dayRows.length) {
        const ins = await db.from("stock_ledger_days").insert(dayRows);
        if (ins.error) return fail(ins.error.message);
      }
    }

    const sync = await db.rpc("sync_inventory_from_ledger", { p_year_month: yearMonth });
    if (sync.error) return fail(`저장은 됐지만 수급 검증용 재고 동기화에 실패했습니다: ${sync.error.message}`);

    revalidatePath("/inventory");
    revalidatePath("/supply");
    revalidatePath("/plan");
    return { ok: true, data: { saved: upserts.length, deleted: deletes.length, snapshots: Number(sync.data ?? 0) } };
  } catch (e) {
    if (e instanceof z.ZodError) return fail(e.issues[0]?.message ?? "입력값이 올바르지 않습니다");
    return fail(e instanceof Error ? e.message : String(e));
  }
}

const linkSchema = z.object({
  yearMonth: z.string().refine(isYearMonth, "연월 형식이 아닙니다"),
  links: z.array(z.object({ id: idSchema, productId: idSchema.nullable() })).min(1).max(2000),
});

/**
 * 수불표 품목을 생산계획 제품에 한꺼번에 연결한다(제품 자동 연결 창에서 사람이 확인한 것만).
 * 연결 뒤 수급 검증용 재고(inventory_snapshots)를 다시 맞춘다.
 */
export async function linkStockItems(input: unknown): Promise<ActionResult<{ linked: number; snapshots: number }>> {
  try {
    const s = await requireWriter();
    const { yearMonth, links } = linkSchema.parse(input);
    const db = await createSupabaseServer();
    const now = new Date().toISOString();
    // 같은 제품끼리 묶어 한 번에 고친다
    const byProduct = new Map<string, string[]>();
    for (const l of links) byProduct.set(l.productId ?? "", [...(byProduct.get(l.productId ?? "") ?? []), l.id]);
    for (const [productId, ids] of byProduct) {
      const { error } = await db.from("stock_items").update({ product_id: productId || null, updated_by: s.userId, updated_at: now }).in("id", ids);
      if (error) return fail(error.message);
    }
    const sync = await db.rpc("sync_inventory_from_ledger", { p_year_month: yearMonth });
    if (sync.error) return fail(`연결은 됐지만 수급 검증용 재고 동기화에 실패했습니다: ${sync.error.message}`);
    revalidatePath("/inventory");
    revalidatePath("/supply");
    revalidatePath("/plan");
    return { ok: true, data: { linked: links.length, snapshots: Number(sync.data ?? 0) } };
  } catch (e) {
    if (e instanceof z.ZodError) return fail(e.issues[0]?.message ?? "입력값이 올바르지 않습니다");
    return fail(e instanceof Error ? e.message : String(e));
  }
}
