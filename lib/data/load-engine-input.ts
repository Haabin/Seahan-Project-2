/**
 * Supabase 테이블 → lib/engine EngineInput 매핑.
 * DB는 snake_case, 엔진은 camelCase. 이 파일이 유일한 변환 지점이다.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AllowedMold,
  ChangeoverCoefficient,
  Downtime,
  EngineInput,
  ExternalUsage,
  InventorySnapshot,
  Line,
  LineProductCapacity,
  MonthlyOperationPlan,
  PlanCell,
  PriorityWeights,
  Product,
  Settings,
  Shipment,
  SiloMeasurement,
  SiloReceipt,
} from "@/lib/engine/types";
import { addDays } from "@/lib/engine/calendar";

type DB = SupabaseClient;

export interface PlanHeader {
  id: string;
  factoryId: string;
  factoryCode: string;
  processTab: string;
  periodStart: string;
  periodEnd: string;
}

export interface RevisionHeader {
  id: string;
  planId: string;
  revNo: number | null;
  status: "draft" | "confirmed";
  reasonCategory: string | null;
  reasonText: string | null;
  parentRevisionId: string | null;
  createdBy: string | null;
  createdAt: string;
  confirmedAt: string | null;
}

export interface MasterData {
  lines: Line[];
  products: Product[];
  allowedMolds: AllowedMold[];
  capacities: LineProductCapacity[];
  changeoverCoefficients: ChangeoverCoefficient[];
  settings: Settings;
  priorityWeights: PriorityWeights;
}

const num = (v: unknown, d = 0) => (v === null || v === undefined ? d : Number(v));

export function settingsFromRows(rows: { key: string; value: unknown }[]): Settings {
  const m = new Map(rows.map((r) => [r.key, r.value]));
  const get = <T,>(k: string, d: T): T => (m.has(k) ? (m.get(k) as T) : d);
  return {
    weekendFactor: num(get("weekend_factor", 0.8)),
    dailyChangeoverLimit: num(get("daily_changeover_limit", 3)),
    defaultChangeoverType: get("default_changeover_type", "BM") as Settings["defaultChangeoverType"],
    siloLowerBoundTon: num(get("silo_lower_bound_ton", 30)),
    siloUpperBoundTon: num(get("silo_upper_bound_ton", 160)),
    leadTimeDays: num(get("lead_time_days", 30)),
    receiptUnitTon: num(get("receipt_unit_ton", 22)),
    surplusDays: num(get("surplus_days", 14)),
  };
}

export async function loadMasterData(db: DB): Promise<MasterData> {
  const [lines, products, molds, caps, coefs, settings, weights, factories] = await Promise.all([
    db.from("lines").select("*").order("sort_order"),
    db.from("products").select("*").order("name"),
    db.from("line_allowed_molds").select("line_id, product_id"),
    db.from("line_product_capacity").select("line_id, product_id, daily_capa"),
    db.from("changeover_coefficients").select("*"),
    db.from("settings").select("key, value"),
    db.from("priority_weights").select("key, weight"),
    db.from("factories").select("id, code"),
  ]);
  for (const r of [lines, products, molds, caps, coefs, settings, weights, factories]) {
    if (r.error) throw new Error(`기준정보 조회 실패: ${r.error.message}`);
  }
  const factoryCode = new Map((factories.data ?? []).map((f) => [f.id as string, f.code as string]));
  const w = new Map((weights.data ?? []).map((r) => [r.key as string, Number(r.weight)]));

  return {
    lines: (lines.data ?? []).map((l) => ({
      id: l.id,
      code: l.code,
      name: l.name,
      factoryCode: factoryCode.get(l.factory_id) ?? "F1",
      processType: l.process_type,
      usesSeabulk: !!l.uses_seabulk,
      sortOrder: l.sort_order ?? 0,
      isPlanTarget: !!l.is_plan_target,
    })),
    products: (products.data ?? []).map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      cavity: p.cavity ?? null,
      packUnit: p.pack_unit ?? null,
      preformWeightG: num(p.preform_weight_g),
      safetyStock: num(p.safety_stock),
      surplusDays: p.surplus_days ?? null,
      defaultDailyCapa: num(p.default_daily_capa),
      unit: (p.unit ?? "EA") as Product["unit"],
    })),
    allowedMolds: (molds.data ?? []).map((m) => ({ lineId: m.line_id, productId: m.product_id })),
    capacities: (caps.data ?? []).map((c) => ({
      lineId: c.line_id,
      productId: c.product_id,
      dailyCapa: num(c.daily_capa),
    })),
    changeoverCoefficients: (coefs.data ?? []).map((c) => ({
      processType: c.process_type,
      changeoverType: c.changeover_type,
      hours: num(c.hours),
      factor: num(c.factor, 1),
      nextDayStart: !!c.next_day_start,
    })),
    settings: settingsFromRows(settings.data ?? []),
    priorityWeights: {
      dueSoon: w.get("due_soon") ?? 3,
      majorCustomer: w.get("major_customer") ?? 2,
      belowSafety: w.get("below_safety") ?? 1,
    },
  };
}

export async function loadPlanHeader(db: DB, planId: string): Promise<PlanHeader | null> {
  const { data, error } = await db
    .from("plans")
    .select("id, factory_id, process_tab, period_start, period_end, factories(code)")
    .eq("id", planId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const f = data.factories as unknown as { code: string } | { code: string }[] | null;
  const code = Array.isArray(f) ? f[0]?.code : f?.code;
  return {
    id: data.id,
    factoryId: data.factory_id,
    factoryCode: code ?? "F1",
    processTab: data.process_tab,
    periodStart: data.period_start,
    periodEnd: data.period_end,
  };
}

export function mapRevision(r: Record<string, unknown>): RevisionHeader {
  return {
    id: r.id as string,
    planId: r.plan_id as string,
    revNo: (r.rev_no as number | null) ?? null,
    status: r.status as RevisionHeader["status"],
    reasonCategory: (r.reason_category as string | null) ?? null,
    reasonText: (r.reason_text as string | null) ?? null,
    parentRevisionId: (r.parent_revision_id as string | null) ?? null,
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: r.created_at as string,
    confirmedAt: (r.confirmed_at as string | null) ?? null,
  };
}

export async function loadRevisions(db: DB, planId: string): Promise<RevisionHeader[]> {
  const { data, error } = await db
    .from("plan_revisions")
    .select("*")
    .eq("plan_id", planId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(mapRevision);
}

export async function loadCells(db: DB, revisionId: string): Promise<PlanCell[]> {
  const { data, error } = await db
    .from("plan_cells")
    .select("line_id, date, product_id, qty, changeover_type, memo")
    .eq("revision_id", revisionId);
  if (error) throw new Error(error.message);
  return (data ?? []).map((c) => ({
    lineId: c.line_id,
    date: c.date,
    productId: c.product_id ?? null,
    qty: c.qty === null || c.qty === undefined ? null : Number(c.qty),
    changeoverType: c.changeover_type,
    memo: c.memo ?? null,
  }));
}

export interface OperationalData {
  downtimes: Downtime[];
  shipments: Shipment[];
  inventory: InventorySnapshot[];
  siloMeasurements: SiloMeasurement[];
  siloReceipts: SiloReceipt[];
  externalUsage: ExternalUsage[];
  monthlyPlans: MonthlyOperationPlan[];
  /** 수요·재고 기준 시각 (FR-05) */
  uploadedAt: { shipment: string | null; inventory: string | null; plan: string | null; master: string | null };
}

export async function loadOperationalData(db: DB, periodStart: string, horizonDays = 42): Promise<OperationalData> {
  const horizonEnd = addDays(periodStart, horizonDays + 7);
  const lookback = addDays(periodStart, -45);
  const [dt, sh, inv, sm, sr, eu, mp, up, factories] = await Promise.all([
    db.from("downtimes").select("line_id, start_date, end_date, reason").lte("start_date", horizonEnd).gte("end_date", lookback),
    db
      .from("shipments")
      .select("product_id, customer_id, ship_date, qty, customers(is_major)")
      .gte("ship_date", lookback)
      .lte("ship_date", horizonEnd),
    db.from("inventory_snapshots").select("product_id, as_of_date, qty").lte("as_of_date", periodStart).gte("as_of_date", lookback),
    db.from("silo_stock_measurements").select("date, measured_ton, silos(code)").lte("date", periodStart).gte("date", lookback),
    db.from("silo_receipts").select("id, supplier, planned_date, qty_ton, status").gte("planned_date", lookback).lte("planned_date", horizonEnd),
    db.from("silo_external_usage").select("label, weekday_ton, weekend_ton, factory_id"),
    db.from("monthly_operation_plan").select("product_id, line_id, year_month, qty, working_days"),
    db.from("uploads").select("kind, uploaded_at").order("uploaded_at", { ascending: false }),
    db.from("factories").select("id, code"),
  ]);
  for (const r of [dt, sh, inv, sm, sr, eu, mp, up, factories]) {
    if (r.error) throw new Error(`운용 데이터 조회 실패: ${r.error.message}`);
  }
  const factoryCode = new Map((factories.data ?? []).map((f) => [f.id as string, f.code as string]));
  const latest = (kind: string) => (up.data ?? []).find((u) => u.kind === kind)?.uploaded_at ?? null;
  const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

  return {
    downtimes: (dt.data ?? []).map((d) => ({ lineId: d.line_id, startDate: d.start_date, endDate: d.end_date, reason: d.reason })),
    shipments: (sh.data ?? []).map((s) => ({
      productId: s.product_id,
      customerId: s.customer_id ?? null,
      isMajorCustomer: !!one(s.customers as unknown as { is_major: boolean } | null)?.is_major,
      shipDate: s.ship_date,
      qty: num(s.qty),
    })),
    inventory: (inv.data ?? []).map((i) => ({ productId: i.product_id, asOfDate: i.as_of_date, qty: num(i.qty) })),
    siloMeasurements: (sm.data ?? []).map((m) => ({
      date: m.date,
      siloCode: one(m.silos as unknown as { code: string } | null)?.code ?? "",
      measuredTon: num(m.measured_ton),
    })),
    siloReceipts: (sr.data ?? []).map((r) => ({
      id: r.id,
      supplier: r.supplier,
      plannedDate: r.planned_date,
      qtyTon: num(r.qty_ton),
      status: r.status,
    })),
    externalUsage: (eu.data ?? []).map((e) => ({
      label: e.label,
      factoryCode: factoryCode.get(e.factory_id) ?? "F1",
      weekdayTon: num(e.weekday_ton),
      weekendTon: num(e.weekend_ton),
    })),
    monthlyPlans: (mp.data ?? []).map((m) => ({
      productId: m.product_id,
      lineId: m.line_id,
      yearMonth: m.year_month,
      qty: num(m.qty),
      workingDays: num(m.working_days, 30),
    })),
    uploadedAt: { shipment: latest("shipment"), inventory: latest("inventory"), plan: latest("plan"), master: latest("master") },
  };
}

/** 한 Rev의 엔진 입력 전체를 조립한다 */
export async function buildEngineInput(
  db: DB,
  plan: PlanHeader,
  cells: PlanCell[],
  opts: { periodDays?: number; horizonDays?: number } = {},
): Promise<{ input: EngineInput; master: MasterData; ops: OperationalData }> {
  const periodDays = opts.periodDays ?? 15;
  const horizonDays = opts.horizonDays ?? 42;
  const [master, ops] = await Promise.all([loadMasterData(db), loadOperationalData(db, plan.periodStart, horizonDays)]);
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
  return { input, master, ops };
}
