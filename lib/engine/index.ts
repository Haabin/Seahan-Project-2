/**
 * 계산 엔진 진입점. 순수 함수만 포함하며 브라우저·서버·테스트에서 동일하게 동작한다.
 */
import type { EngineInput, EngineResult, PriorityWeights, Settings } from "./types";
import { dateRange } from "./calendar";
import { buildProductionIndex, computeProduction } from "./production";
import { checkConstraints } from "./constraints";
import { computeSupply } from "./supply";
import { computeSilo } from "./seabulk";
import { recommendOrder } from "./ordering";

export * from "./types";
export * from "./calendar";
export * from "./production";
export * from "./constraints";
export * from "./supply";
export * from "./seabulk";
export * from "./ordering";
export * from "./diff";

function nowMs(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return perf?.now?.() ?? Date.now();
}

/** OPEN_QUESTIONS 의 기본값 (Q2, Q4, Q5 등) */
export function defaultSettings(): Settings {
  return {
    weekendFactor: 0.8,
    dailyChangeoverLimit: 3,
    defaultChangeoverType: "BM",
    siloLowerBoundTon: 30,
    siloUpperBoundTon: 160,
    leadTimeDays: 30,
    receiptUnitTon: 22,
    surplusDays: 14,
  };
}

/** FR-11 우선순위 가중치 기본값 (3 / 2 / 1) */
export function defaultPriorityWeights(): PriorityWeights {
  return { dueSoon: 3, majorCustomer: 2, belowSafety: 1 };
}

/** 전체 재계산 (FR-07/08/09/11/14/15/16) */
export function recalc(input: EngineInput): EngineResult {
  const t0 = nowMs();
  const periodDates = dateRange(input.periodStart, input.periodDays);
  const horizonDates = dateRange(input.periodStart, input.horizonDays);

  const index = buildProductionIndex(input);
  const cells = computeProduction(input, index, periodDates);
  const violations = checkConstraints(input, cells, index);
  const supply = computeSupply(input, cells, periodDates);
  const silo = computeSilo(input, cells, horizonDates, periodDates);
  const order = recommendOrder(silo, input.settings);

  return {
    periodDates,
    horizonDates,
    cells,
    violations,
    supply,
    silo,
    order,
    computedMs: Math.round((nowMs() - t0) * 100) / 100,
  };
}
