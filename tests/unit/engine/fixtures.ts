/**
 * 엔진 테스트용 입력 빌더.
 * 기본: PET1~PET3 (1공장, PET1_1STAGE, 씨벌크 사용), 제품 3종, 기간 2026-11-12(목)부터 15일, 사일로 42일.
 */
import type {
  ChangeoverCoefficient,
  EngineInput,
  Line,
  PlanCell,
  Product,
} from "@/lib/engine/types";
import { defaultPriorityWeights, defaultSettings } from "@/lib/engine";

export const PERIOD_START = "2026-11-12"; // 목요일
export const SAT = "2026-11-14";
export const SUN = "2026-11-15";

export const LINES: Line[] = [
  { id: "L1", code: "PET1", name: "PET 1호기", factoryCode: "F1", processType: "PET1_1STAGE", usesSeabulk: true, sortOrder: 1, isPlanTarget: true },
  { id: "L2", code: "PET2", name: "PET 2호기", factoryCode: "F1", processType: "PET1_1STAGE", usesSeabulk: true, sortOrder: 2, isPlanTarget: true },
  { id: "L3", code: "PET3", name: "PET 3호기", factoryCode: "F1", processType: "PET1_1STAGE", usesSeabulk: true, sortOrder: 3, isPlanTarget: true },
];

export const PRODUCTS: Product[] = [
  { id: "P1", code: "A500", name: "500ml 원형", cavity: 48, packUnit: 1000, preformWeightG: 20, safetyStock: 0, surplusDays: null, defaultDailyCapa: 100_000, unit: "EA" },
  { id: "P2", code: "B1500", name: "1.5L 사각", cavity: 24, packUnit: 500, preformWeightG: 35, safetyStock: 50_000, surplusDays: null, defaultDailyCapa: 60_000, unit: "EA" },
  { id: "P3", code: "C2000", name: "2L 생수", cavity: 16, packUnit: 500, preformWeightG: 40, safetyStock: 0, surplusDays: 7, defaultDailyCapa: 40_000, unit: "EA" },
];

export const COEFFICIENTS: ChangeoverCoefficient[] = [
  { processType: "PET1_1STAGE", changeoverType: "BM", hours: 3, factor: 0.87, nextDayStart: false },
  { processType: "PET1_1STAGE", changeoverType: "FULL", hours: 24, factor: 0, nextDayStart: true },
  { processType: "PET2_INJ", changeoverType: "BM", hours: 2, factor: 0.91, nextDayStart: false },
  { processType: "PET2_INJ", changeoverType: "FULL", hours: 4, factor: 0.83, nextDayStart: false },
  { processType: "PET2_BLOW", changeoverType: "BM", hours: 2, factor: 0.91, nextDayStart: false },
  { processType: "PET2_BLOW", changeoverType: "FULL", hours: 4, factor: 0.83, nextDayStart: false },
  { processType: "PE", changeoverType: "BM", hours: 6, factor: 0.75, nextDayStart: false },
  { processType: "PE", changeoverType: "FULL", hours: 6, factor: 0.75, nextDayStart: false },
];

export function cell(
  lineId: string,
  date: string,
  productId: string | null,
  opts: Partial<Pick<PlanCell, "qty" | "changeoverType" | "memo">> = {},
): PlanCell {
  return {
    lineId,
    date,
    productId,
    qty: opts.qty ?? null,
    changeoverType: opts.changeoverType ?? "NONE",
    memo: opts.memo ?? null,
  };
}

export function makeInput(overrides: Partial<EngineInput> = {}): EngineInput {
  const base: EngineInput = {
    periodStart: PERIOD_START,
    periodDays: 15,
    horizonDays: 42,
    lines: LINES,
    products: PRODUCTS,
    allowedMolds: [
      { lineId: "L1", productId: "P1" },
      { lineId: "L1", productId: "P2" },
      { lineId: "L2", productId: "P1" },
      { lineId: "L2", productId: "P2" },
      { lineId: "L2", productId: "P3" },
      { lineId: "L3", productId: "P2" },
      { lineId: "L3", productId: "P3" },
    ],
    capacities: [
      { lineId: "L1", productId: "P1", dailyCapa: 100_000 },
      { lineId: "L2", productId: "P1", dailyCapa: 90_000 },
    ],
    changeoverCoefficients: COEFFICIENTS,
    settings: defaultSettings(),
    priorityWeights: defaultPriorityWeights(),
    cells: [],
    downtimes: [],
    shipments: [],
    inventory: [],
    siloMeasurements: [],
    siloReceipts: [],
    externalUsage: [],
    monthlyPlans: [],
  };
  return { ...base, ...overrides };
}
