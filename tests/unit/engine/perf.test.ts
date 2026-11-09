import { describe, expect, it } from "vitest";
import { recalc, dateRange, addDays } from "@/lib/engine";
import type {
  AllowedMold,
  InventorySnapshot,
  Line,
  LineProductCapacity,
  MonthlyOperationPlan,
  PlanCell,
  Product,
  Shipment,
} from "@/lib/engine/types";
import { makeInput, PERIOD_START } from "./fixtures";

function buildLargeInput() {
  const lineCount = 40;
  const productCount = 40;
  const periodDays = 15;
  const horizonDays = 42;

  const lines: Line[] = [];
  for (let i = 1; i <= lineCount; i++) {
    lines.push({
      id: `L${i}`,
      code: `PET${i}`,
      name: `PET ${i}호기`,
      factoryCode: i <= 20 ? "F1" : "F2",
      processType: i % 3 === 0 ? "PET2_INJ" : "PET1_1STAGE",
      usesSeabulk: true,
      sortOrder: i,
      isPlanTarget: true,
    });
  }

  const products: Product[] = [];
  for (let i = 1; i <= productCount; i++) {
    products.push({
      id: `P${i}`,
      code: `C${i}`,
      name: `제품 ${i}`,
      cavity: 24,
      packUnit: 500,
      preformWeightG: 15 + (i % 30),
      safetyStock: (i % 5) * 10_000,
      surplusDays: i % 4 === 0 ? 7 : null,
      defaultDailyCapa: 50_000 + (i % 7) * 10_000,
      unit: "EA",
    });
  }

  const allowedMolds: AllowedMold[] = [];
  const capacities: LineProductCapacity[] = [];
  for (const l of lines) {
    for (const p of products) {
      allowedMolds.push({ lineId: l.id, productId: p.id });
      capacities.push({ lineId: l.id, productId: p.id, dailyCapa: 80_000 + (Number(l.id.slice(1)) % 5) * 5_000 });
    }
  }

  const dates = dateRange(PERIOD_START, periodDays);
  const cells: PlanCell[] = [];
  lines.forEach((l, li) => {
    dates.forEach((d, di) => {
      // 3일마다 제품 교체 → 교체 횟수 제한 위반도 섞인다
      const productIdx = (li + Math.floor(di / 3)) % productCount;
      cells.push({
        lineId: l.id,
        date: d,
        productId: `P${productIdx + 1}`,
        qty: di % 7 === 0 ? 60_000 : null,
        changeoverType: di % 3 === 0 && di > 0 ? (li % 2 === 0 ? "BM" : "FULL") : "NONE",
        memo: null,
      });
    });
  });

  const shipments: Shipment[] = [];
  const horizon = dateRange(PERIOD_START, horizonDays);
  products.forEach((p, pi) => {
    horizon.forEach((d, di) => {
      if ((pi + di) % 2 === 0) {
        shipments.push({ productId: p.id, customerId: `C${pi % 6}`, isMajorCustomer: pi % 6 === 0, shipDate: d, qty: 20_000 + (di % 5) * 5_000 });
      }
    });
  });

  const inventory: InventorySnapshot[] = products.map((p, i) => ({
    productId: p.id,
    asOfDate: addDays(PERIOD_START, -1),
    qty: 50_000 + i * 3_000,
  }));

  const monthlyPlans: MonthlyOperationPlan[] = [];
  for (const ym of ["2026-11", "2026-12"]) {
    lines.forEach((l, li) => {
      monthlyPlans.push({ productId: `P${(li % productCount) + 1}`, lineId: l.id, yearMonth: ym, qty: 1_500_000, workingDays: 22 });
    });
  }

  return makeInput({
    periodDays,
    horizonDays,
    lines,
    products,
    allowedMolds,
    capacities,
    cells,
    downtimes: [{ lineId: "L5", startDate: "2026-11-14", endDate: "2026-11-15", reason: "정비" }],
    shipments,
    inventory,
    siloMeasurements: [
      { date: addDays(PERIOD_START, -1), siloCode: "S55", measuredTon: 40 },
      { date: addDays(PERIOD_START, -1), siloCode: "S150", measuredTon: 100 },
    ],
    siloReceipts: [{ id: "r1", supplier: "공급사", plannedDate: addDays(PERIOD_START, 3), qtyTon: 22, status: "planned" }],
    externalUsage: [
      { label: "A1", factoryCode: "F1", weekdayTon: 1.5, weekendTon: 1.2 },
      { label: "2공장 P1~4", factoryCode: "F2", weekdayTon: 4, weekendTon: 3 },
    ],
    monthlyPlans,
  });
}

describe("NFR-05 성능", () => {
  it("NFR-05 40호기 × 15일 × 40제품 + 42일 사일로 예측 재계산 1초 이내", () => {
    const input = buildLargeInput();
    // 워밍업 1회 후 측정
    recalc(input);
    const t0 = Date.now();
    const result = recalc(input);
    const wall = Date.now() - t0;
    console.log(`[NFR-05] recalc: computedMs=${result.computedMs}ms wall=${wall}ms cells=${result.cells.length} violations=${result.violations.length} supply=${result.supply.length} silo=${result.silo.length}`);

    expect(result.cells).toHaveLength(40 * 15);
    expect(result.supply.length).toBeGreaterThanOrEqual(40);
    expect(result.silo).toHaveLength(42);
    expect(result.computedMs).toBeLessThan(1000);
    expect(wall).toBeLessThan(1000);
  });
});
