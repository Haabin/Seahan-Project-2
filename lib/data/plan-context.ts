import type { SupabaseClient } from "@supabase/supabase-js";
import { thisWeekThursday } from "@/lib/engine/calendar";
import type { EngineInput } from "@/lib/engine/types";
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

/**
 * 화면용 계획 컨텍스트. DB 왕복을 최소화한다: ① plans+revisions(중첩 1회) ② cells ‖ 기준정보 ‖ 운용 데이터(병렬).
 * - periodStart 미지정: 이번 주 목요일 plan → 없으면 가장 최근 plan
 * - revisionId 미지정: 작성 권한이면 초안, 조회 권한이면 최신 확정본
 */
export async function loadPlanContext(
  db: SupabaseClient,
  opts: { periodStart?: string; revisionId?: string; preferDraft: boolean; today?: string },
): Promise<PlanContext | null> {
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

  const periodDays = 15;
  const horizonDays = 42;
  const [cells, master, ops] = await Promise.all([loadCells(db, selected.id), loadMasterData(db), loadOperationalData(db, plan.periodStart, horizonDays)]);

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
    downtimes: ops.downtimes,
    shipments: ops.shipments,
    inventory: ops.inventory,
    siloMeasurements: ops.siloMeasurements,
    siloReceipts: ops.siloReceipts,
    externalUsage: ops.externalUsage,
    monthlyPlans: ops.monthlyPlans,
  };
  return { plan, revisions, selected, input, master, ops, periods: plans.map((p) => p.period_start) };
}
