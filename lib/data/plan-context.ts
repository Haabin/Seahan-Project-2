import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays, thisWeekThursday } from "@/lib/engine/calendar";
import type { EngineInput, PlanCell } from "@/lib/engine/types";
import {
  loadCells,
  loadMasterData,
  loadOperationalData,
  mapRevision,
  type MasterData,
  type OperationalData,
  type PlanHeader,
  type RevisionHeader,
} from "@/lib/data/load-engine-input";

export interface PlanContext {
  plan: PlanHeader;
  revisions: RevisionHeader[];
  selected: RevisionHeader;
  input: EngineInput;
  master: MasterData;
  ops: OperationalData;
  /** 선택 가능한 계획 기간(목요일) 목록 */
  periods: string[];
}

/** 같은 공정의 계획 하나를 기간·Rev 요약으로 (초안 자동 생성의 과거 계획 고르기에 쓴다) */
export interface PlanSummary {
  id: string;
  periodStart: string;
  revisions: { id: string; revNo: number | null; status: string }[];
}

/** 1단계 결과: 어느 계획·Rev 를 보여줄지. 이것만으로 다음 조회(셀·기준정보·운용 데이터)를 시작할 수 있다 */
export interface PlanSelection {
  plan: PlanHeader;
  revisions: RevisionHeader[];
  selected: RevisionHeader;
  periods: string[];
  boundaryRevId: string | null;
  /** 1STAGE 계획 전체 (plans 조회 결과 그대로, period_start 내림차순) */
  plans: PlanSummary[];
}

/**
 * 화면용 계획 컨텍스트. DB 왕복을 최소화한다: ① plans+revisions(중첩 1회) ② cells ‖ 기준정보 ‖ 운용 데이터(병렬).
 * - periodStart 미지정: 이번 주 목요일 plan → 없으면 가장 최근 plan
 * - revisionId 미지정: 작성 권한이면 초안, 조회 권한이면 최신 확정본
 * ①은 selectPlan, ②는 loadPlanData. /plan 은 ①과 ② 사이에 다른 조회를 함께 시작하려고 둘을 따로 부른다.
 */
export async function loadPlanContext(
  db: SupabaseClient,
  opts: { periodStart?: string; revisionId?: string; preferDraft: boolean; today?: string },
): Promise<PlanContext | null> {
  const sel = await selectPlan(db, opts);
  if (!sel) return null;
  return loadPlanData(db, sel);
}

/** ① plans + plan_revisions 중첩 조회 1회로 보여줄 계획·Rev 를 고른다. 계획이 없으면 null */
export async function selectPlan(
  db: SupabaseClient,
  opts: { periodStart?: string; revisionId?: string; preferDraft: boolean; today?: string },
): Promise<PlanSelection | null> {
  const { data: plans, error } = await db
    .from("plans")
    .select("id, factory_id, process_tab, period_start, period_end, factories(code), plan_revisions(*)")
    .eq("process_tab", "1STAGE")
    .order("period_start", { ascending: false });
  if (error) throw new Error(error.message);
  if (!plans?.length) return null;

  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const wanted = opts.periodStart ?? thisWeekThursday(today);
  const row = plans.find((p) => p.period_start === wanted) ?? plans[0];

  const f = row.factories as unknown as { code: string } | { code: string }[] | null;
  const plan: PlanHeader = {
    id: row.id,
    factoryId: row.factory_id,
    factoryCode: (Array.isArray(f) ? f[0]?.code : f?.code) ?? "F1",
    processTab: row.process_tab,
    periodStart: row.period_start,
    periodEnd: row.period_end,
  };
  const revisions = ((row.plan_revisions ?? []) as Record<string, unknown>[])
    .map(mapRevision)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!revisions.length) return null;

  let selected: RevisionHeader | undefined;
  if (opts.revisionId) selected = revisions.find((r) => r.id === opts.revisionId);
  if (!selected && opts.preferDraft) selected = revisions.find((r) => r.status === "draft");
  if (!selected) selected = revisions.filter((r) => r.status === "confirmed").sort((a, b) => (b.revNo ?? -1) - (a.revNo ?? -1))[0];
  if (!selected) selected = revisions[0];

  const all = plans.map((p) => ({
    id: p.id as string,
    factoryId: p.factory_id as string,
    periodStart: p.period_start as string,
    periodEnd: p.period_end as string,
    revisions: ((p.plan_revisions ?? []) as Record<string, unknown>[]).map(mapRevision),
  }));
  const boundaryRevId = pickBoundaryRevisionId(all, { factoryId: plan.factoryId, periodStart: plan.periodStart });
  return {
    plan,
    revisions,
    selected,
    periods: plans.map((p) => p.period_start),
    boundaryRevId,
    plans: all.map((p) => ({ id: p.id, periodStart: p.periodStart, revisions: p.revisions.map((r) => ({ id: r.id, revNo: r.revNo, status: r.status })) })),
  };
}

/** ② 고른 Rev 의 셀 ‖ 기준정보 ‖ 운용 데이터 ‖ 경계 셀 (병렬 1단계) */
export async function loadPlanData(db: SupabaseClient, sel: PlanSelection): Promise<PlanContext> {
  const { plan, revisions, selected, periods, boundaryRevId } = sel;
  const periodDays = 15;
  const horizonDays = 42;
  const [cells, master, ops, boundaryCells] = await Promise.all([
    loadCells(db, selected.id),
    loadMasterData(db),
    loadOperationalData(db, plan.periodStart, horizonDays),
    boundaryRevId ? loadCellsOn(db, boundaryRevId, addDays(plan.periodStart, -1)) : Promise.resolve([] as PlanCell[]),
  ]);

  const input: EngineInput = {
    periodStart: plan.periodStart,
    periodDays,
    horizonDays,
    lines: master.lines,
    products: master.products,
    allowedMolds: master.allowedMolds,
    capacities: master.capacities,
    changeoverCoefficients: master.changeoverCoefficients,
    settings: master.settings,
    priorityWeights: master.priorityWeights,
    cells,
    boundaryCells,
    downtimes: ops.downtimes,
    shipments: ops.shipments,
    inventory: ops.inventory,
    siloMeasurements: ops.siloMeasurements,
    siloReceipts: ops.siloReceipts,
    externalUsage: ops.externalUsage,
    resinUsage: ops.resinUsage,
    monthlyPlans: ops.monthlyPlans,
  };
  return { plan, revisions, selected, input, master, ops, periods };
}

/**
 * 기간 첫날 교체 판단에 쓸 직전 계획의 Rev.
 * 같은 공장·공정에서 시작일이 이 계획보다 앞서고 이번 기간 시작 전날을 포함하는 계획 중 가장 늦게 시작한 것,
 * 그 계획의 최신 확정 Rev (새 기간 이어받기 규칙과 같다). 없으면 null.
 */
export function pickBoundaryRevisionId(
  plans: { factoryId: string; periodStart: string; periodEnd: string; revisions: Pick<RevisionHeader, "id" | "status" | "revNo">[] }[],
  current: { factoryId: string; periodStart: string },
): string | null {
  const dayBefore = addDays(current.periodStart, -1);
  const prev = plans
    .filter((p) => p.factoryId === current.factoryId && p.periodStart < current.periodStart && p.periodEnd >= dayBefore)
    .sort((a, b) => b.periodStart.localeCompare(a.periodStart))[0];
  if (!prev) return null;
  const confirmed = prev.revisions.filter((r) => r.status === "confirmed").sort((a, b) => (b.revNo ?? -1) - (a.revNo ?? -1));
  return confirmed[0]?.id ?? null;
}

/** 한 Rev 의 특정 날짜 셀만 */
async function loadCellsOn(db: SupabaseClient, revisionId: string, date: string): Promise<PlanCell[]> {
  const { data, error } = await db
    .from("plan_cells")
    .select("*") // 0004 적용 전 DB 에서도 동작 (lost_hours_override 가 없으면 null)
    .eq("revision_id", revisionId)
    .eq("date", date);
  if (error) throw new Error(error.message);
  return (data ?? []).map((c) => ({
    lineId: c.line_id,
    date: c.date,
    productId: c.product_id ?? null,
    qty: c.qty === null || c.qty === undefined ? null : Number(c.qty),
    changeoverType: c.changeover_type,
    memo: c.memo ?? null,
    lostHoursOverride: c.lost_hours_override ?? null,
  }));
}
