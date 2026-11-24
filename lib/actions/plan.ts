"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createSupabaseServer } from "@/lib/supabase/server";
import { requireAdmin, requireWriter } from "@/lib/auth/session";
import { canDeleteDraftPlan, nearestPeriod } from "@/lib/plan/delete-rules";
import { interpretSaveRow, migrationMissingMessage, rejectedErrorText, type DraftConflict, type SavePlanDraftRow } from "@/lib/plan/draft-save";
import { addDays } from "@/lib/engine/calendar";
import type { PlanCell } from "@/lib/engine/types";

const cellSchema = z.object({
  lineId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  productId: z.string().uuid().nullable(),
  qty: z.number().nonnegative().nullable(),
  changeoverType: z.enum(["NONE", "BM", "FULL"]),
  memo: z.string().nullable().optional(),
  /** 그날 전체 비가동 시간 직접 입력 (0~24 정수) */
  lostHoursOverride: z.number().int().min(0).max(24).nullable().optional(),
  moldId: z.string().uuid().nullable().optional(),
  origin: z.enum(["auto", "manual", "imported"]).optional(),
  basis: z.string().max(300).nullable().optional(),
  orderId: z.string().uuid().nullable().optional(),
});

/**
 * 비가동 시간 직접 입력 열. 값이 있는 칸만 열을 넣는다 →
 * 아무도 입력하지 않았으면 0004 마이그레이션 전 DB 에서도 저장이 그대로 동작한다.
 */
function lostHoursColumn(v: number | null | undefined): { lost_hours_override?: number } {
  return v != null ? { lost_hours_override: v } : {};
}

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
            .select("*") // 0004 적용 전 DB 에서도 동작 (lost_hours_override 가 없으면 null)
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
            lostHoursOverride: c.lost_hours_override ?? null,
            moldId: c.mold_id,
            origin: c.origin,
            basis: c.basis,
            orderId: c.order_id,
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
      .select("*") // 0004 적용 전 DB 에서도 동작 (lost_hours_override 가 없으면 null)
      .eq("revision_id", latest.id);
    cells = (data ?? []).map((c) => ({
      lineId: c.line_id,
      date: c.date,
      productId: c.product_id,
      qty: c.qty === null ? null : Number(c.qty),
      changeoverType: c.changeover_type,
      memo: c.memo,
      lostHoursOverride: c.lost_hours_override ?? null,
      moldId: c.mold_id,
      origin: c.origin,
      basis: c.basis,
      orderId: c.order_id,
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
        ...lostHoursColumn(c.lostHoursOverride),
        mold_id: c.moldId ?? null,
        origin: c.origin ?? "manual",
        basis: c.basis ?? null,
        order_id: c.orderId ?? null,
      })),
    );
    if (error) throw new Error(error.message);
  }
  return ins.data.id;
}

const saveBaseSchema = z.object({
  revisionId: z.string().uuid(),
  /** 화면이 마지막으로 본 version. null 이면 확인 없이 저장(「내 것으로 덮어쓰기」) */
  expectedVersion: z.number().int().nullable(),
  token: z.string().uuid(),
});

export type SavePlanDraftResult =
  | { ok: true; data: { draftId: string; count: number; version: number } }
  | { ok: false; error: string; conflict?: DraftConflict };

/**
 * FR-02 초안 저장: 초안 셀 전체를 교체한다. DB 함수 save_plan_draft(0011) 한 번으로 버전 확인·지우기·넣기를 함께 한다.
 * - base 를 주면(생산계획표 자동 저장): 그 Rev 가 이 계획의 Rev 인지 확인한 뒤, 화면이 본 version 과 같을 때만 저장한다.
 *   다른 저장이 먼저 있었거나 확정·삭제됐으면 conflict 로 돌려준다(덮어쓰지 않는다).
 * - base 가 없으면(엑셀 가져오기): 지금 초안을 확인 없이 교체한다. 열려 있던 다른 화면은 다음 저장 때 충돌로 알게 된다.
 */
export async function savePlanDraft(planId: string, cellsInput: unknown, baseInput?: unknown): Promise<SavePlanDraftResult> {
  try {
    await requireWriter();
    const cells = z.array(cellSchema).parse(cellsInput);
    const base = baseInput === undefined ? null : saveBaseSchema.parse(baseInput);
    const db = await createSupabaseServer();

    let draftId: string;
    if (base) {
      // 화면이 보낸 Rev 가 이 계획의 Rev 인지 확인한다 (다른 계획의 Rev 에 저장되지 않게)
      const { data: rev, error } = await db.from("plan_revisions").select("id, plan_id").eq("id", base.revisionId).maybeSingle();
      if (error) return fail(error.message);
      if (!rev) {
        const conflict: DraftConflict = { kind: "missing", version: null, updatedAt: null, updatedBy: null, updatedByName: null, revNo: null };
        return { ok: false, error: rejectedErrorText(conflict), conflict };
      }
      if (rev.plan_id !== planId) return fail("이 계획의 초안이 아닙니다. 화면을 새로 고친 뒤 다시 시도하세요");
      draftId = rev.id;
    } else {
      draftId = await ensureDraft(db, planId);
    }

    const rows = toDraftRows(cells);
    const { data, error } = await db.rpc("save_plan_draft", {
      p_revision_id: draftId,
      p_expected_version: base ? base.expectedVersion : null,
      p_token: base ? base.token : null,
      p_cells: rows,
    });
    if (error) return fail(migrationMissingMessage(error) ?? error.message);
    const outcome = interpretSaveRow((Array.isArray(data) ? data[0] : data) as SavePlanDraftRow | null);
    if (outcome.kind === "rejected") return { ok: false, error: rejectedErrorText(outcome.conflict), conflict: outcome.conflict };

    revalidatePath("/plan");
    return { ok: true, data: { draftId, count: rows.length, version: outcome.version } };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/** 저장할 셀 행 (save_plan_draft 의 p_cells). 제품도 메모도 없는 칸은 저장하지 않는다 (예전과 같은 규칙) */
function toDraftRows(cells: z.infer<typeof cellSchema>[]) {
  return cells
    .filter((c) => c.productId !== null || (c.memo && c.memo.length > 0))
    .map((c) => ({
      line_id: c.lineId,
      date: c.date,
      product_id: c.productId,
      qty: c.qty,
      changeover_type: c.changeoverType,
      memo: c.memo ?? null,
      lost_hours_override: c.lostHoursOverride ?? null,
      mold_id: c.moldId ?? null,
      origin: c.origin ?? "manual",
      basis: c.basis ?? null,
      order_id: c.orderId ?? null,
    }));
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

/**
 * 초안 계획 삭제 (admin). 확정된 Rev 가 하나라도 있으면 거부한다(NFR-09).
 * plans 를 지우면 plan_revisions → plan_cells 가 on delete cascade 로 함께 지워진다.
 * 확정 Rev 가 있으면 DB 트리거(plan_revisions_immutable)도 삭제 전체를 되돌린다.
 * 주문(orders)은 건드리지 않는다(plan_cells.order_id 는 FK 없이 값만 보관).
 * 감사 기록은 0010 마이그레이션의 audit_plans 트리거가 남긴다.
 */
export async function deleteDraftPlan(planIdInput: unknown): Promise<ActionResult<{ periodStart: string; periodEnd: string; cellCount: number; nextPeriod: string | null }>> {
  try {
    const s = await requireAdmin();
    const planId = z.string().uuid().parse(planIdInput);
    const db = await createSupabaseServer();

    const { data: plan, error } = await db
      .from("plans")
      .select("id, process_tab, period_start, period_end, plan_revisions(id, status)")
      .eq("id", planId)
      .maybeSingle();
    if (error) return fail(error.message);
    if (!plan) return fail("계획을 찾을 수 없습니다");

    const revisions = (plan.plan_revisions ?? []) as { id: string; status: string }[];
    const verdict = canDeleteDraftPlan({ role: s.role, revisions });
    if (!verdict.ok) return fail(verdict.reason);

    let cellCount = 0;
    if (revisions.length) {
      const counted = await db
        .from("plan_cells")
        .select("revision_id", { count: "exact", head: true })
        .in(
          "revision_id",
          revisions.map((r) => r.id),
        );
      if (counted.error) return fail(counted.error.message);
      cellCount = counted.count ?? 0;
    }

    const del = await db.from("plans").delete().eq("id", planId).select("id");
    if (del.error) return fail(del.error.message);
    // RLS 에 막히면 오류 없이 0행이 지워진다
    if (!del.data?.length) return fail("삭제되지 않았습니다. 권한을 확인하세요");

    const { data: rest } = await db.from("plans").select("period_start").eq("process_tab", plan.process_tab);
    const nextPeriod = nearestPeriod(
      (rest ?? []).map((r) => r.period_start as string),
      plan.period_start,
    );

    for (const path of ["/plan", "/view", "/revisions", "/supply", "/seabulk"]) revalidatePath(path);
    return { ok: true, data: { periodStart: plan.period_start, periodEnd: plan.period_end, cellCount, nextPeriod } };
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
