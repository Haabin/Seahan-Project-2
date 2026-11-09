import { describe, expect, it } from "vitest";
import { recalc } from "@/lib/engine";
import { cell, makeInput, PERIOD_START, SAT } from "./fixtures";

function findCell(result: ReturnType<typeof recalc>, lineId: string, date: string) {
  const c = result.cells.find((x) => x.lineId === lineId && x.date === date);
  if (!c) throw new Error(`cell not found ${lineId} ${date}`);
  return c;
}

describe("FR-08 예상 생산량", () => {
  it("FR-08 일일 Capa 100,000 + B/M 교체 → 87,000", () => {
    const input = makeInput({
      cells: [cell("L1", PERIOD_START, "P1", { changeoverType: "BM" })],
    });
    const r = recalc(input);
    const c = findCell(r, "L1", PERIOD_START);
    expect(c.expectedQty).toBe(87_000);
    expect(c.plannedQty).toBeNull();
    expect(c.effectiveChangeover).toBe("BM");
    expect(c.changeoverDefaulted).toBe(false);
    expect(c.explain.map((e) => e.label)).toEqual(
      expect.arrayContaining(["일일 Capa", "교체 계수(B/M)"]),
    );
    expect(c.explain.find((e) => e.label === "일일 Capa")?.value).toBe(100_000);
    expect(c.explain.find((e) => e.label === "교체 계수(B/M)")?.value).toBe(0.87);
  });

  it("FR-08 주말 계수 0.8 → 토요일 80,000, 평일은 100,000", () => {
    const input = makeInput({
      cells: [
        cell("L1", "2026-11-12", "P1"),
        cell("L1", "2026-11-13", "P1"),
        cell("L1", SAT, "P1"),
      ],
    });
    const r = recalc(input);
    expect(findCell(r, "L1", "2026-11-13").expectedQty).toBe(100_000);
    expect(findCell(r, "L1", "2026-11-13").isWeekend).toBe(false);
    const sat = findCell(r, "L1", SAT);
    expect(sat.isWeekend).toBe(true);
    expect(sat.expectedQty).toBe(80_000);
    expect(sat.explain.find((e) => e.label === "주말 계수")?.value).toBe(0.8);
  });

  it("FR-08 주말 + B/M 교체 → 100,000 × 0.87 × 0.8 = 69,600", () => {
    const input = makeInput({ cells: [cell("L1", SAT, "P1", { changeoverType: "BM" })] });
    expect(findCell(recalc(input), "L1", SAT).expectedQty).toBe(69_600);
  });

  it("FR-08 PET1 Full set 교체 → 교체일 생산 0, 익일 정상", () => {
    const input = makeInput({
      cells: [
        cell("L1", "2026-11-12", "P1"),
        cell("L1", "2026-11-13", "P2", { changeoverType: "FULL" }),
        cell("L1", "2026-11-16", "P2"),
      ],
    });
    const r = recalc(input);
    const full = findCell(r, "L1", "2026-11-13");
    expect(full.expectedQty).toBe(0);
    expect(full.effectiveChangeover).toBe("FULL");
    const step = full.explain.find((e) => e.label === "교체 계수(Full set)");
    expect(step?.value).toBe(0);
    expect(step?.note).toContain("익일 가동");
    expect(findCell(r, "L1", "2026-11-16").expectedQty).toBe(60_000);
  });

  it("FR-08 Capa 우선순위: 호기×제품 Capa → 없으면 제품 기본 Capa", () => {
    const input = makeInput({
      cells: [cell("L2", PERIOD_START, "P1"), cell("L3", PERIOD_START, "P2")],
    });
    const r = recalc(input);
    expect(findCell(r, "L2", PERIOD_START).expectedQty).toBe(90_000);
    expect(findCell(r, "L3", PERIOD_START).expectedQty).toBe(60_000);
    expect(findCell(r, "L3", PERIOD_START).explain[0].note).toContain("제품 기본");
  });

  it("FR-08/FR-06 가동 불가일 → 0, 설명에 '가동 불가'", () => {
    const input = makeInput({
      cells: [cell("L1", "2026-11-13", "P1"), cell("L1", "2026-11-17", "P1")],
      downtimes: [{ lineId: "L1", startDate: "2026-11-13", endDate: "2026-11-16", reason: "금형 정비" }],
    });
    const r = recalc(input);
    const d1 = findCell(r, "L1", "2026-11-13");
    expect(d1.expectedQty).toBe(0);
    expect(d1.isDowntime).toBe(true);
    expect(d1.productId).toBe("P1");
    expect(d1.explain.some((e) => e.label === "가동 불가")).toBe(true);
    // 셀이 없어도 가동 불가 표시, 끝 날짜 포함
    const d2 = findCell(r, "L1", "2026-11-16");
    expect(d2.isDowntime).toBe(true);
    expect(d2.expectedQty).toBe(0);
    // 종료 다음날은 정상
    const after = findCell(r, "L1", "2026-11-17");
    expect(after.isDowntime).toBe(false);
    expect(after.expectedQty).toBe(100_000);
  });

  it("FR-08 빈 셀 → 0, '계획 없음'", () => {
    const r = recalc(makeInput());
    const c = findCell(r, "L1", PERIOD_START);
    expect(c.expectedQty).toBe(0);
    expect(c.productId).toBeNull();
    expect(c.explain[0].label).toBe("계획 없음");
    // 계획 대상 3개 설비 × 15일
    expect(r.cells).toHaveLength(45);
  });

  it("FR-08 입력 수량이 계산값보다 우선", () => {
    const input = makeInput({
      cells: [cell("L1", PERIOD_START, "P1", { qty: 55_000, changeoverType: "BM" })],
    });
    const c = findCell(recalc(input), "L1", PERIOD_START);
    expect(c.expectedQty).toBe(55_000);
    expect(c.plannedQty).toBe(55_000);
    const step = c.explain.find((e) => e.label === "입력 수량 우선");
    expect(step?.value).toBe(55_000);
    expect(step?.note).toContain("87,000");
  });

  it("FR-08 계획 대상이 아닌 설비는 결과에 포함하지 않는다", () => {
    const input = makeInput({
      lines: [
        ...makeInput().lines,
        { id: "A1", code: "A1", name: "A1 사출기", factoryCode: "F1", processType: "PET2_INJ", usesSeabulk: true, sortOrder: 99, isPlanTarget: false },
      ],
      cells: [cell("A1", PERIOD_START, "P1")],
    });
    const r = recalc(input);
    expect(r.cells.some((c) => c.lineId === "A1")).toBe(false);
  });
});
