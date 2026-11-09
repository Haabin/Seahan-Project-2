import type { SupabaseClient } from "@supabase/supabase-js";
import { thisWeekThursday } from "@/lib/engine/calendar";
import type { EngineInput } from "@/lib/engine/types";
import {
  buildEngineInput,
  loadCells,
  loadPlanHeader,
  loadRevisions,
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
 * 화면용 계획 컨텍스트.
 * - periodStart 미지정: 이번 주 목요일 plan → 없으면 가장 최근 plan
 * - revisionId 미지정: 작성 권한이면 초안, 조회 권한이면 최신 확정본
 */
export async function loadPlanContext(
  db: SupabaseClient,
  opts: { periodStart?: string; revisionId?: string; preferDraft: boolean; today?: string },
): Promise<PlanContext | null> {
  const { data: plans, error } = await db
    .from("plans")
    .select("id, period_start")
    .eq("process_tab", "1STAGE")
    .order("period_start", { ascending: false });
  if (error) throw new Error(error.message);
  if (!plans?.length) return null;

  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const wanted = opts.periodStart ?? thisWeekThursday(today);
  const planRow = plans.find((p) => p.period_start === wanted) ?? plans[0];

  const plan = await loadPlanHeader(db, planRow.id);
  if (!plan) return null;
  const revisions = await loadRevisions(db, plan.id);
  if (!revisions.length) return null;

  let selected: RevisionHeader | undefined;
  if (opts.revisionId) selected = revisions.find((r) => r.id === opts.revisionId);
  if (!selected && opts.preferDraft) selected = revisions.find((r) => r.status === "draft");
  if (!selected) selected = revisions.filter((r) => r.status === "confirmed").sort((a, b) => (b.revNo ?? -1) - (a.revNo ?? -1))[0];
  if (!selected) selected = revisions[0];

  const cells = await loadCells(db, selected.id);
  const { input, master, ops } = await buildEngineInput(db, plan, cells);
  return { plan, revisions, selected, input, master, ops, periods: plans.map((p) => p.period_start) };
}
