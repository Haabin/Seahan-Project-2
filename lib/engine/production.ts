/**
 * FR-08 예상 생산량 계산.
 * 계획 대상 설비 × 기간 내 모든 날짜에 대해 CellResult 를 만든다.
 * 계산 근거(NFR-04)는 explain 에 단계별로 남긴다.
 */
import type {
  CellResult,
  ChangeoverCoefficient,
  ChangeoverKind,
  ChangeoverType,
  Downtime,
  EngineInput,
  ExplainStep,
  ISODate,
  Line,
  PlanCell,
  ProcessType,
  Product,
} from "./types";
import { addDays, dateRange, isWeekend as isWeekendDate, shortDate } from "./calendar";
import { DEFAULT_FACTOR_TABLE, describeRate, rateFromLostHours } from "./changeover";

export const CHANGEOVER_LABEL: Record<ChangeoverKind, string> = {
  BM: "B/M",
  FULL: "Full set",
};

export function cellKey(lineId: string, date: ISODate): string {
  return `${lineId}|${date}`;
}

/** 입력 데이터를 빠르게 찾기 위한 인덱스 */
export interface ProductionIndex {
  lineById: Map<string, Line>;
  productById: Map<string, Product>;
  cellByKey: Map<string, PlanCell>;
  /** 직전 계획의 기간 시작 전날 셀 (첫날 교체 판단용) */
  boundaryByKey: Map<string, PlanCell>;
  capaByKey: Map<string, number>;
  coefByKey: Map<string, ChangeoverCoefficient>;
  downtimesByLine: Map<string, Downtime[]>;
}

export function buildProductionIndex(input: EngineInput): ProductionIndex {
  const lineById = new Map<string, Line>();
  for (const l of input.lines) lineById.set(l.id, l);

  const productById = new Map<string, Product>();
  for (const p of input.products) productById.set(p.id, p);

  const cellByKey = new Map<string, PlanCell>();
  for (const c of input.cells) cellByKey.set(cellKey(c.lineId, c.date), c);

  const boundaryByKey = new Map<string, PlanCell>();
  for (const c of input.boundaryCells ?? []) boundaryByKey.set(cellKey(c.lineId, c.date), c);

  const capaByKey = new Map<string, number>();
  for (const c of input.capacities) capaByKey.set(cellKey(c.lineId, c.productId), c.dailyCapa);

  const coefByKey = new Map<string, ChangeoverCoefficient>();
  for (const c of input.changeoverCoefficients) {
    coefByKey.set(`${c.processType}|${c.changeoverType}`, c);
  }

  const downtimesByLine = new Map<string, Downtime[]>();
  for (const d of input.downtimes) {
    const arr = downtimesByLine.get(d.lineId);
    if (arr) arr.push(d);
    else downtimesByLine.set(d.lineId, [d]);
  }

  return { lineById, productById, cellByKey, boundaryByKey, capaByKey, coefByKey, downtimesByLine };
}

/** 해당 날짜가 설비의 가동 불가 기간(양끝 포함)에 속하는지 */
export function findDowntime(
  index: ProductionIndex,
  lineId: string,
  date: ISODate,
): Downtime | null {
  const list = index.downtimesByLine.get(lineId);
  if (!list) return null;
  for (const d of list) {
    if (d.startDate <= date && date <= d.endDate) return d;
  }
  return null;
}

export function lookupCapa(
  index: ProductionIndex,
  lineId: string,
  product: Product,
): { capa: number; source: "line_product" | "product_default" } {
  const specific = index.capaByKey.get(cellKey(lineId, product.id));
  if (specific != null) return { capa: specific, source: "line_product" };
  return { capa: product.defaultDailyCapa, source: "product_default" };
}

export function lookupCoefficient(
  index: ProductionIndex,
  processType: ProcessType,
  type: ChangeoverKind,
): ChangeoverCoefficient | null {
  return index.coefByKey.get(`${processType}|${type}`) ?? null;
}

/**
 * 실제 적용 교체유형 결정.
 * - 셀에 입력된 교체유형이 있으면 그대로.
 * - 없고, 전일(기간 내) 셀에 제품이 있으며 오늘 제품과 다르면 기본 교체유형(기본값 적용 표시).
 * - 그 외 'NONE'.
 */
export function resolveChangeover(
  cell: PlanCell,
  prevCell: PlanCell | undefined,
  defaultType: ChangeoverKind,
): { type: ChangeoverType; defaulted: boolean } {
  if (cell.changeoverType !== "NONE") return { type: cell.changeoverType, defaulted: false };
  if (prevCell && prevCell.productId != null && cell.productId != null && prevCell.productId !== cell.productId) {
    return { type: defaultType, defaulted: true };
  }
  return { type: "NONE", defaulted: false };
}

function emptyResult(
  lineId: string,
  date: ISODate,
  weekend: boolean,
  isDowntime: boolean,
  explain: ExplainStep[],
): CellResult {
  return {
    lineId,
    date,
    productId: null,
    productName: null,
    plannedQty: null,
    expectedQty: 0,
    isDowntime,
    isWeekend: weekend,
    effectiveChangeover: "NONE",
    changeoverDefaulted: false,
    explain,
    violations: [],
  };
}

/** 계수표 시간의 기준표 출처 표시: '기준표' / '기준표 밖 → 계산값' (0h 는 표시 없음) */
function coefRateNote(hours: number, input: EngineInput): string | null {
  const r = rateFromLostHours(hours, input.settings.factorTable ?? DEFAULT_FACTOR_TABLE);
  return r.source === "table" ? "기준표" : r.source === "outside" ? "기준표 밖 → 계산값" : null;
}

/** 한 셀의 예상 생산량 계산 */
export function computeCell(
  input: EngineInput,
  index: ProductionIndex,
  line: Line,
  date: ISODate,
  prevDate: ISODate | null,
): CellResult {
  const weekend = isWeekendDate(date);
  const cell = index.cellByKey.get(cellKey(line.id, date));
  const downtime = findDowntime(index, line.id, date);
  const hasProduct = !!cell && cell.productId != null;

  // ① 가동 불가일: 제품이 있어도 0
  if (downtime) {
    const explain: ExplainStep[] = [
      { label: "가동 불가", value: 0, note: downtime.reason ? `사유: ${downtime.reason}` : undefined },
    ];
    const r = emptyResult(line.id, date, weekend, true, explain);
    if (cell && hasProduct) {
      const product = index.productById.get(cell.productId as string);
      r.productId = cell.productId;
      r.productName = product?.name ?? null;
      r.plannedQty = cell.qty ?? null;
      r.effectiveChangeover = cell.changeoverType;
      explain.push({
        label: "가동 불가일 배치",
        value: product?.name ?? (cell.productId as string),
        note: "가동 불가일에 제품이 배치되어 생산량 0으로 처리",
      });
    }
    return r;
  }

  // ② 빈 셀
  if (!cell || !hasProduct) {
    return emptyResult(line.id, date, weekend, false, [{ label: "계획 없음", value: 0 }]);
  }

  const productId = cell.productId as string;
  const product = index.productById.get(productId);
  const explain: ExplainStep[] = [];

  // 기준정보에 없는 제품
  if (!product) {
    explain.push({ label: "제품 정보 없음", value: productId, note: "기준정보에 없는 제품 id" });
    const r: CellResult = {
      lineId: line.id,
      date,
      productId,
      productName: null,
      plannedQty: cell.qty ?? null,
      expectedQty: cell.qty ?? 0,
      isDowntime: false,
      isWeekend: weekend,
      effectiveChangeover: cell.changeoverType,
      changeoverDefaulted: false,
      explain,
      violations: [],
    };
    if (cell.qty != null) explain.push({ label: "입력 수량 우선", value: cell.qty });
    return r;
  }

  // ③ Capa
  const { capa, source } = lookupCapa(index, line.id, product);
  explain.push({
    label: "일일 Capa",
    value: capa,
    note: source === "line_product" ? "호기×제품 Capa" : "제품 기본 Capa",
  });
  let value = capa;

  // ④ 교체유형
  // 전날 셀: 기간 안이면 이 계획, 기간 첫날이면 직전 계획(boundaryCells)
  const inPlanPrev = prevDate ? index.cellByKey.get(cellKey(line.id, prevDate)) : undefined;
  const boundaryPrev = prevDate && !inPlanPrev ? index.boundaryByKey.get(cellKey(line.id, prevDate)) : undefined;
  const prevCell = inPlanPrev ?? boundaryPrev;
  const { type: effType, defaulted } = resolveChangeover(
    cell,
    prevCell,
    input.settings.defaultChangeoverType,
  );
  let nextDayStart = false;
  const table = input.settings.factorTable ?? DEFAULT_FACTOR_TABLE;
  const coef = effType !== "NONE" ? lookupCoefficient(index, line.processType, effType) : undefined;
  const defaultedNote = [
    defaulted ? "교체유형 미입력 → 기본값 적용" : null,
    defaulted && boundaryPrev ? "직전 계획 전날 제품과 다름" : null,
  ]
    .filter(Boolean)
    .join(" · ") || undefined;
  /** 교체유형 기준 시간 (교체 없음·계수 없음·익일가동이면 null) */
  const standardLostHours = coef && !coef.nextDayStart ? coef.hours : null;
  let lostHours: number | null = null;
  let lostHoursSource: CellResult["lostHoursSource"] = null;
  let outsideFactorTable = false;
  const override = cell.lostHoursOverride ?? null;

  if (override !== null) {
    // ④-1 비가동 시간 직접 입력: 그날 전체 비가동 시간으로 교체 기준 시간을 대신한다 (더하지 않음)
    const rate = rateFromLostHours(override, table);
    value = value * rate.factor;
    lostHours = rate.hours;
    lostHoursSource = "override";
    outsideFactorTable = rate.source === "outside";
    const std = effType === "NONE" ? null : coef?.nextDayStart ? "기준 익일가동" : standardLostHours !== null ? `기준 ${standardLostHours}h` : null;
    explain.push({
      label: "비가동 시간(직접 입력)",
      value: rate.factor,
      note: [defaultedNote, describeRate(rate), std ? `${std} 대신` : null].filter(Boolean).join(" · "),
    });
  } else if (effType !== "NONE") {
    const label = CHANGEOVER_LABEL[effType];
    if (!coef) {
      explain.push({
        label: `교체 계수(${label})`,
        value: 1,
        note: [defaultedNote, "계수 정보 없음, 손실 미적용"].filter(Boolean).join(" · "),
      });
    } else if (coef.nextDayStart) {
      nextDayStart = true;
      value = 0;
      explain.push({
        label: `교체 계수(${label})`,
        value: 0,
        note: [defaultedNote, "Full set 교체 · 익일 가동"].filter(Boolean).join(" · "),
      });
    } else {
      value = value * coef.factor;
      lostHours = coef.hours;
      lostHoursSource = "standard";
      outsideFactorTable = rateFromLostHours(coef.hours, table).source === "outside";
      explain.push({
        label: `교체 계수(${label})`,
        value: coef.factor,
        note: [defaultedNote, `교체 ${coef.hours}시간 → ×${coef.factor}`, coefRateNote(coef.hours, input)].filter(Boolean).join(" · "),
      });
    }
  }

  // ⑤ 주말 계수
  if (weekend && !nextDayStart) {
    value = value * input.settings.weekendFactor;
    explain.push({ label: "주말 계수", value: input.settings.weekendFactor, note: `${shortDate(date)} 주말` });
  } else if (weekend) {
    explain.push({ label: "주말 계수", value: input.settings.weekendFactor, note: "익일 가동이라 생산 0" });
  }

  const computed = Math.round(value);
  let expectedQty = computed;
  explain.push({ label: "예상 생산량", value: computed });

  // ⑥ 입력 수량 우선
  if (cell.qty != null) {
    expectedQty = cell.qty;
    explain.push({
      label: "입력 수량 우선",
      value: cell.qty,
      note: `계산 참고값 ${computed.toLocaleString("ko-KR")}`,
    });
  }

  const result: CellResult = {
    lineId: line.id,
    date,
    productId,
    productName: product.name,
    plannedQty: cell.qty ?? null,
    expectedQty,
    isDowntime: false,
    isWeekend: weekend,
    effectiveChangeover: effType,
    changeoverDefaulted: defaulted,
    explain,
    violations: defaulted ? ["CHANGEOVER_DEFAULTED"] : [],
    lostHours,
    lostHoursSource,
    standardLostHours: lostHoursSource === "override" ? standardLostHours : null,
    outsideFactorTable,
  };
  return result;
}

/** 계획 대상 설비 전체의 셀 계산 */
export function computeProduction(
  input: EngineInput,
  index: ProductionIndex = buildProductionIndex(input),
  periodDates: ISODate[] = dateRange(input.periodStart, input.periodDays),
): CellResult[] {
  const results: CellResult[] = [];
  const targetLines = input.lines
    .filter((l) => l.isPlanTarget)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder);
  for (const line of targetLines) {
    for (let i = 0; i < periodDates.length; i++) {
      const date = periodDates[i];
      // 첫날도 전날과 비교한다 (전날 셀은 직전 계획의 boundaryCells 에서 찾는다)
      const prevDate = i > 0 ? periodDates[i - 1] : addDays(date, -1);
      results.push(computeCell(input, index, line, date, prevDate));
    }
  }
  return results;
}
