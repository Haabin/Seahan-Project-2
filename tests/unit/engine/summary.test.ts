import { describe, expect, it } from "vitest";
import { recalc, summarizePlan } from "@/lib/engine";
import { cell, makeInput, PERIOD_START, SAT } from "./fixtures";

const D2 = "2026-11-13";

describe("생산계획표 합계 (summarizePlan)", () => {
  it("호기별·일자별 합계는 셀에 보이는 수량(입력 우선, 없으면 예상)과 같다", () => {
    const r = recalc(
      makeInput({
        cells: [
          cell("L1", PERIOD_START, "P1"), // 100,000
          cell("L1", D2, "P1", { qty: 90_000 }), // 입력 우선
          cell("L2", PERIOD_START, "P3"), // 40,000
          cell("L2", SAT, "P3"), // 주말 0.8 → 32,000
        ],
      }),
    );
    const s = summarizePlan(r.cells, ["L1", "L2", "L3"], [PERIOD_START, D2, SAT]);
    expect(s.byLine.get("L1")).toBe(190_000);
    expect(s.byLine.get("L2")).toBe(72_000);
    expect(s.byLine.get("L3")).toBe(0);
    expect(s.byDate.get(PERIOD_START)).toBe(140_000);
    expect(s.byDate.get(D2)).toBe(90_000);
    expect(s.byDate.get(SAT)).toBe(32_000);
    expect(s.total).toBe(262_000);
  });

  it("교체 횟수는 하루 교체 한도 검사와 같은 규칙(입력·기본값 적용 모두, 가동 불가일 제외)", () => {
    const r = recalc(
      makeInput({
        cells: [
          cell("L1", PERIOD_START, "P1"),
          cell("L1", D2, "P2"), // 미입력 → 기본 BM
          cell("L2", PERIOD_START, "P1"),
          cell("L2", D2, "P1", { changeoverType: "FULL" }), // 같은 제품이어도 입력대로
          cell("L3", D2, "P2", { changeoverType: "BM" }),
        ],
        downtimes: [{ lineId: "L3", startDate: D2, endDate: D2, reason: "점검" }],
      }),
    );
    const s = summarizePlan(r.cells, ["L1", "L2", "L3"], [PERIOD_START, D2]);
    expect(s.changeoversByDate.get(PERIOD_START)).toBe(0);
    expect(s.changeoversByDate.get(D2)).toBe(2);
    expect(s.byLine.get("L3")).toBe(0);
  });
});
