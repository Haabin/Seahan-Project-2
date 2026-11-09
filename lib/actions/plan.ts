"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createSupabaseServer } from "@/lib/supabase/server";
import { requireWriter } from "@/lib/auth/session";
import { addDays } from "@/lib/engine/calendar";
import type { PlanCell } from "@/lib/engine/types";

const cellSchema = z.object({
  lineId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  productId: z.string().uuid().nullable(),
  qty: z.number().nonnegative().nullable(),
  changeoverType: z.enum(["NONE", "BM", "FULL"]),
  memo: z.string().nullable().optional(),
});

type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

function fail(error: string): ActionResult<never> {
  return { ok: false, error };
}

/** 기간(목요일 시작)에 해당하는 plan을 찾거나 만든다. 새 plan이면 직전 확정 Rev의 겹치는 날짜 셀을 이어받는다 (3.1) */
export async function ensurePlan(periodStart: string): Promise<ActionResult<{ planId: string; draftId: string }>> {
  try {
    await requireWriter();
    const db = await createSupabaseServer();
    const periodEnd = addDays(periodStart, 14);

    const { data: factory } = await db.from("factories").select("id").eq("code", "F1").single();
    if (!factory) return fail("1공장 기준정보가 없습니다");

    let { data: plan } = await db
      .from("plans")
      .select("id")
      .eq("factory_id", factory.id)
      .eq("process_tab", "1STAGE")
      .eq("period_start", periodStart)
      .maybeSingle();

    let carried: PlanCell[] = [];
    if (!plan) {
      // 직전 plan의 최신 확정 Rev에서 겹치는 날짜를 이어받는다
      const { data: prevPlan } = await db
        .from("plans")
        .select("id")
        .eq("factory_id", factory.id)
        .eq("process_tab", "1STAGE")
        .lt("period_start", periodStart)
        .order("period_start", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (prevPlan) {
        const { data: prevRev } = await db
          .from("plan_revisions")
          .select("id")
          .eq("plan_id", prevPlan.id)
          .eq("status", "confirmed")
          .order("rev_no", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (prevRev) {
          const { data: cells } = await db
            .from("plan_cells")
            .select("line_id, date, product_id, qty, changeover_type, memo")
            .eq("revision_id", prevRev.id)
            .gte("date", periodStart)
            .lte("date", periodEnd);
          carried = (cells ?? []).map((c) => ({
            lineId: c.line_id,
            date: c.date,
            productId: c.product_id,
            qty: c.qty === null ? null : Number(c.qty),
            changeoverType: c.changeover_type,
            memo: c.memo,
          }));
        }
      }
      const ins = await db
        .from("plans")
        .insert({ factory_id: factory.id, process_tab: "1STAGE", period_start: periodStart, period_end: periodEnd })
        .select("id")
        .single();
      if (ins.error) return fail(ins.error.message);
      plan = ins.data;
    }

    const draftId = await ensureDraft(db, plan.id, carried);
    return { ok: true, data: { planId: plan.id, draftId } };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

type DB = Awaited<ReturnType<typeof createSupabaseServer>>;

async function ensureDraft(db: DB, planId: string, seedCells: PlanCell[] = []): Promise<string> {
  const { data: draft } = await db
    .from("plan_revisions")
    .select("id")
    .eq("plan_id", planId)
    .eq("status", "draft")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (draft) return draft.id;

  // 최신 확정본을 부모로 하는 초안 생성 + 셀 복사
  const { data: latest } = await db
    .from("plan_revisions")
    .select("id")
    .eq("plan_id", planId)
    .eq("status", "confirmed")
    .order("rev_no", { ascending: false })
    .limit(1)
    .maybeSingle();

  const ins = await db
    .from("plan_revisions")
    .insert({ plan_id: planId, status: "draft", parent_revision_id: latest?.id ?? null })
    .select("id")
    .single();
  if (ins.error) throw new Error(ins.error.message);

  let cells = seedCells;
  if (latest) {
    const { data } = await db
      .from("plan_cells")
      .select("line_id, date, product_id, qty, changeover_type, memo")
      .eq("revision_id", latest.id);
    cells = (data ?? []).map((c) => ({
      lineId: c.line_id,
      date: c.date,
      productId: c.product_id,
      qty: c.qty === null ? null : Number(c.qty),
      changeoverType: c.changeover_type,
      memo: c.memo,
    }));
  }
  if (cells.length) {
    const { error } = await db.from("plan_cells").insert(
      cells.map((c) => ({
        revision_id: ins.data.id,
        line_id: c.lineId,
        date: c.date,
        product_id: c.productId,
        qty: c.qty,
        changeover_type: c.changeoverType,
        memo: c.memo ?? null,
      })),
    );
    if (error) throw new Error(error.message);
  }
  return ins.data.id;
}

/** FR-02 초안 저장: 초안 셀 전체를 교체한다 */
export async function savePlanDraft(planId: string, cellsInput: unknown): Promise<ActionResult<{ draftId: string; count: number }>> {
  try {
    await requireWriter();
    const cells = z.array(cellSchema).parse(cellsInput);
    const db = await createSupabaseServer();
    const draftId = await ensureDraft(db, planId);

    const del = await db.from("plan_cells").delete().eq("revision_id", draftId);
    if (del.error) return fail(del.error.message);

    const rows = cells
      .filter((c) => c.productId !== null || (c.memo && c.memo.length > 0))
      .map((c) => ({
        revision_id: draftId,
        line_id: c.lineId,
        date: c.date,
        product_id: c.productId,
        qty: c.qty,
        changeover_type: c.changeoverType,
        memo: c.memo ?? null,
      }));
    if (rows.length) {
      const ins = await db.from("plan_cells").insert(rows);
      if (ins.error) return fail(ins.error.message);
    }
    revalidatePath("/plan");
    return { ok: true, data: { draftId, count: rows.length } };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

const confirmSchema = z.object({
  planId: z.string().uuid(),
  reasonCategory: z.enum(["설비", "품질", "인원", "출고계획", "급발주", "기타"]).nullable().optional(),
  reasonText: z.string().max(500).nullable().optional(),
});

/** FR-04 확정/변경 저장: 초안을 Rev N으로 확정하고 새 초안을 만든다. Rev 1 이상은 사유 필수 */
export async function confirmRevision(input: unknown): Promise<ActionResult<{ revNo: number; revisionId: string; newDraftId: string }>> {
  try {
    await requireWriter();
    const { planId, reasonCategory, reasonText } = confirmSchema.parse(input);
    const db = await createSupabaseServer();
    const draftId = await ensureDraft(db, planId);

    const { data: confirmed } = await db
      .from("plan_revisions")
      .select("rev_no")
      .eq("plan_id", planId)
      .eq("status", "confirmed")
      .order("rev_no", { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextRev = confirmed && confirmed.rev_no !== null ? confirmed.rev_no + 1 : 0;

    if (nextRev > 0 && (!reasonCategory || !reasonText || reasonText.trim().length === 0)) {
      return fail("변경 사유(구분과 내용)를 입력해야 저장할 수 있습니다 (FR-04)");
    }

    const upd = await db
      .from("plan_revisions")
      .update({
        status: "confirmed",
        rev_no: nextRev,
        reason_category: nextRev > 0 ? reasonCategory : null,
        reason_text: nextRev > 0 ? reasonText : null,
        confirmed_at: new Date().toISOString(),
      })
      .eq("id", draftId);
    if (upd.error) return fail(upd.error.message);

    const newDraftId = await ensureDraft(db, planId);
    revalidatePath("/plan");
    revalidatePath("/revisions");
    revalidatePath("/view");
    return { ok: true, data: { revNo: nextRev, revisionId: draftId, newDraftId } };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

const downtimeSchema = z.object({
  id: z.string().uuid().optional(),
  lineId: z.string().uuid(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().max(200),
});

/** FR-06 가동 불가일 등록·수정 */
export async function upsertDowntime(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const s = await requireWriter();
    const d = downtimeSchema.parse(input);
    if (d.endDate < d.startDate) return fail("종료일이 시작일보다 빠릅니다");
    const db = await createSupabaseServer();
    const row = { line_id: d.lineId, start_date: d.startDate, end_date: d.endDate, reason: d.reason, created_by: s.userId };
    const q = d.id
      ? db.from("downtimes").update(row).eq("id", d.id).select("id").single()
      : db.from("downtimes").insert(row).select("id").single();
    const { data, error } = await q;
    if (error) return fail(error.message);
    revalidatePath("/plan");
    return { ok: true, data: { id: data.id } };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export async function deleteDowntime(id: string): Promise<ActionResult> {
  try {
    await requireWriter();
    const db = await createSupabaseServer();
    const { error } = await db.from("downtimes").delete().eq("id", id);
    if (error) return fail(error.message);
    revalidatePath("/plan");
    return { ok: true, data: undefined };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
