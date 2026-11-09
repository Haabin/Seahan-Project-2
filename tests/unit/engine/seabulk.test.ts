import { describe, expect, it } from "vitest";
import { recalc, dateRange } from "@/lib/engine";
import { cell, makeInput, PERIOD_START } from "./fixtures";

const periodDates = dateRange(PERIOD_START, 15);

describe("FR-14/FR-15 씨벌크 사일로 예측", () => {
  it("FR-14 계획 기반 사용량 = 예상 생산량 × 프리폼 중량 (+ 외부 고정 사용량)", () => {
    const input = makeInput({
      siloMeasurements: [
        { date: "2026-11-11", siloCode: "S55", measuredTon: 20 },
        { date: "2026-11-11", siloCode: "S150", measuredTon: 100 },
        { date: "2026-11-01", siloCode: "S150", measuredTon: 999 }, // 더 오래된 실측치 → 무시
      ],
      cells: [cell("L1", PERIOD_START, "P1")], // 100,000 × 20g = 2t
      externalUsage: [
        { label: "A1", factoryCode: "F1", weekdayTon: 1.5, weekendTon: 1.2 },
        { label: "2공장 P1~4", factoryCode: "F2", weekdayTon: 4.0, weekendTon: 3.0 },
      ],
    });
    const r = recalc(input);
    expect(r.silo).toHaveLength(42);
    const d0 = r.silo[0];
    expect(d0.date).toBe(PERIOD_START);
    expect(d0.basis).toBe("plan");
    expect(d0.opening).toBe(120);
    expect(d0.receipt).toBe(0);
    expect(d0.usageF1).toBeCloseTo(3.5, 6);
    expect(d0.usageF2).toBeCloseTo(4.0, 6);
    expect(d0.usageTotal).toBeCloseTo(7.5, 6);
    expect(d0.closing).toBeCloseTo(112.5, 6);
    expect(d0.status).toBe("ok");
    expect(d0.explain.map((e) => e.label)).toEqual(
      expect.arrayContaining(["기초", "입고", "1공장 사용", "2공장 사용"]),
    );
    // 주말(11/14): 외부 사용량은 주말 톤
    const sat = r.silo[2];
    expect(sat.usageF1).toBeCloseTo(1.2, 6);
    expect(sat.usageF2).toBeCloseTo(3.0, 6);
  });

  it("FR-14 천본(KEA) 단위 제품은 ×1000", () => {
    const products = makeInput().products.map((p) =>
      p.id === "P1" ? { ...p, unit: "KEA" as const, defaultDailyCapa: 100 } : p,
    );
    const input = makeInput({
      products,
      capacities: [],
      cells: [cell("L1", PERIOD_START, "P1")], // 100천본 = 100,000본 × 20g = 2t
      siloMeasurements: [{ date: PERIOD_START, siloCode: "S55", measuredTon: 50 }],
    });
    const r = recalc(input);
    expect(r.silo[0].usageF1).toBeCloseTo(2, 6);
    expect(r.silo[0].closing).toBeCloseTo(48, 6);
  });

  it("FR-15 입고는 취소 건 제외, 상한 초과 감지", () => {
    const input = makeInput({
      siloMeasurements: [{ date: "2026-11-11", siloCode: "S150", measuredTon: 150 }],
      siloReceipts: [
        { id: "r1", supplier: "롯데케미칼", plannedDate: PERIOD_START, qtyTon: 22, status: "planned" },
        { id: "r2", supplier: "롯데케미칼", plannedDate: PERIOD_START, qtyTon: 22, status: "cancelled" },
      ],
    });
    const r = recalc(input);
    expect(r.silo[0].receipt).toBe(22);
    expect(r.silo[0].closing).toBe(172);
    expect(r.silo[0].status).toBe("above_upper");
  });

  it("FR-15 하한 미달 감지, 실측치 없으면 0 가정", () => {
    const input = makeInput({
      externalUsage: [{ label: "A1", factoryCode: "F1", weekdayTon: 5, weekendTon: 5 }],
    });
    const r = recalc(input);
    expect(r.silo[0].opening).toBe(0);
    expect(r.silo[0].explain[0].note).toContain("실측치 없음");
    expect(r.silo[0].status).toBe("below_lower");
    expect(r.silo[0].closing).toBe(-5);
  });

  it("FR-15 기간 밖(3~6주)은 월 운용안 기반 추정", () => {
    const input = makeInput({
      siloMeasurements: [{ date: "2026-11-11", siloCode: "S150", measuredTon: 150 }],
      cells: periodDates.map((d) => cell("L1", d, "P1")),
      externalUsage: [{ label: "A1", factoryCode: "F1", weekdayTon: 1.5, weekendTon: 1.2 }],
      monthlyPlans: [
        // 11월: 2,000,000본 ÷ 20일 = 100,000본/일 → 2t (주말 1.6t)
        { productId: "P1", lineId: "L1", yearMonth: "2026-11", qty: 2_000_000, workingDays: 20 },
        // 12월: 1,000,000본 ÷ 20일 = 50,000본/일 → 1t (주말 0.8t)
        { productId: "P1", lineId: "L1", yearMonth: "2026-12", qty: 1_000_000, workingDays: 20 },
      ],
    });
    const r = recalc(input);
    const byDate = new Map(r.silo.map((d) => [d.date, d] as const));

    // 기간 내 마지막 날(11/26 목) 계획 기반
    const lastPlan = byDate.get("2026-11-26")!;
    expect(lastPlan.basis).toBe("plan");
    expect(lastPlan.usageF1).toBeCloseTo(2 + 1.5, 6);

    // 11/27 (금) 추정 기반: 11월 운용안
    const nov = byDate.get("2026-11-27")!;
    expect(nov.basis).toBe("estimate");
    expect(nov.usageF1).toBeCloseTo(2 + 1.5, 6);
    expect(nov.explain.some((e) => e.label === "추정 근거" && String(e.value).includes("2026-11"))).toBe(true);

    // 11/28 (토) 추정: 주말 계수 0.8
    const novSat = byDate.get("2026-11-28")!;
    expect(novSat.usageF1).toBeCloseTo(1.6 + 1.2, 6);

    // 12/1 (화) 추정: 12월 운용안
    const dec = byDate.get("2026-12-01")!;
    expect(dec.basis).toBe("estimate");
    expect(dec.usageF1).toBeCloseTo(1 + 1.5, 6);

    // 재고 연속성
    for (let i = 1; i < r.silo.length; i++) {
      expect(r.silo[i].opening).toBeCloseTo(r.silo[i - 1].closing, 6);
    }
  });

  it("FR-15 운용안이 없는 월은 계획 설비 사용량 0 (외부 사용량만)", () => {
    const input = makeInput({
      siloMeasurements: [{ date: "2026-11-11", siloCode: "S150", measuredTon: 150 }],
      externalUsage: [{ label: "A1", factoryCode: "F1", weekdayTon: 1.5, weekendTon: 1.2 }],
    });
    const r = recalc(input);
    const dec = r.silo.find((d) => d.date === "2026-12-01")!;
    expect(dec.basis).toBe("estimate");
    expect(dec.usageF1).toBeCloseTo(1.5, 6);
    expect(dec.explain.find((e) => e.label === "추정 근거")?.note).toContain("운용안 없음");
  });
});

describe("FR-16 발주 추천", () => {
  it("FR-16 하한 미달 없으면 발주 불필요", () => {
    const input = makeInput({
      siloMeasurements: [{ date: "2026-11-11", siloCode: "S150", measuredTon: 150 }],
      externalUsage: [{ label: "A1", factoryCode: "F1", weekdayTon: 1, weekendTon: 1 }],
    });
    const r = recalc(input);
    expect(r.order.needed).toBe(false);
    expect(r.order.qtyTon).toBe(0);
    expect(r.order.orderBy).toBeNull();
    expect(r.order.explain[0]).toBe("6주 내 하한 미달 없음");
    expect(r.order.avgDailyUsageWeekday).toBe(1);
  });

  it("FR-16 발주 기한 = 최초 미달일 − 30일, 추천량은 22톤 단위 올림", () => {
    // 기초 100t, 매일 5t 사용 → 15일차(11/26) 기말 25t < 30 → 최초 미달
    const input = makeInput({
      siloMeasurements: [{ date: "2026-11-11", siloCode: "S150", measuredTon: 100 }],
      externalUsage: [{ label: "A1", factoryCode: "F1", weekdayTon: 5, weekendTon: 5 }],
    });
    const r = recalc(input);
    expect(r.order.needed).toBe(true);
    expect(r.order.firstBelowDate).toBe("2026-11-26");
    expect(r.order.orderBy).toBe("2026-10-27");
    // 리드타임 구간 [11/26, 12/26] ∩ 예측 범위(~12/23): 최저 = 12/23 기말 = 100 − 5×42 = −110
    expect(r.order.minProjected).toBe(-110);
    // 부족분 30 − (−110) = 140 → ceil(140/22) = 7 → 154t
    expect(r.order.qtyTon).toBe(154);
    expect(r.order.qtyTon % 22).toBe(0);
    expect(r.order.avgDailyUsageWeekday).toBe(5);
    expect(r.order.avgDailyUsageWeekend).toBe(5);
    expect(r.order.explain).toEqual(
      expect.arrayContaining([
        "11/26 하한(30톤) 미달 예상",
        expect.stringContaining("리드타임 30일 → 10/27까지 발주"),
        "일평균 사용량 평일 5.0톤 · 주말 5.0톤",
      ]),
    );
  });

  it("FR-16 최소 1단위(22톤) 추천", () => {
    // 기초 31t, 하루 1t → 11/13 기말 29t 미달. 구간 최저 = 12/23 기말 31 − 42 = −11 → 부족 41 → 2단위 44t
    const input = makeInput({
      siloMeasurements: [{ date: "2026-11-11", siloCode: "S150", measuredTon: 31 }],
      externalUsage: [{ label: "A1", factoryCode: "F1", weekdayTon: 1, weekendTon: 1 }],
      horizonDays: 5, // 범위를 줄여 최저 = 31 − 5 = 26 → 부족 4 → 1단위
    });
    const r = recalc(input);
    expect(r.order.firstBelowDate).toBe("2026-11-13");
    expect(r.order.minProjected).toBe(26);
    expect(r.order.qtyTon).toBe(22);
  });
});
