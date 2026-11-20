/**
 * 기간 첫날 교체 감지: 직전 계획(최신 확정 Rev)의 기간 시작 전날 셀과 비교
 */
import { describe, expect, it } from "vitest";
import { recalc } from "@/lib/engine";
import { pickBoundaryRevisionId } from "@/lib/data/plan-context";
import { cell, makeInput, PERIOD_START } from "./fixtures";

const DAY_BEFORE = "2026-11-11";

function first(r: ReturnType<typeof recalc>, lineId = "L1") {
  return r.cells.find((c) => c.lineId === lineId && c.date === PERIOD_START)!;
}

describe("기간 첫날 교체 감지", () => {
  it("직전 계획 전날 제품과 다르고 교체유형이 비어 있으면 기본 교체유형 적용 + 주의", () => {
    const r = recalc(makeInput({ cells: [cell("L1", PERIOD_START, "P1")], boundaryCells: [cell("L1", DAY_BEFORE, "P2")] }));
    const c = first(r);
    expect(c.effectiveChangeover).toBe("BM");
    expect(c.changeoverDefaulted).toBe(true);
    expect(c.expectedQty).toBe(87_000);
    expect(c.violations).toContain("CHANGEOVER_DEFAULTED");
    expect(c.explain.some((e) => e.note?.includes("직전 계획 전날 제품과 다름"))).toBe(true);
  });

  it("직전 계획 전날 제품과 같으면 교체 없음", () => {
    const c = first(recalc(makeInput({ cells: [cell("L1", PERIOD_START, "P1")], boundaryCells: [cell("L1", DAY_BEFORE, "P1")] })));
    expect(c.effectiveChangeover).toBe("NONE");
    expect(c.expectedQty).toBe(100_000);
  });

  it("직전 계획이 없거나 그 호기 전날이 비어 있으면 예전처럼 교체 없음", () => {
    expect(first(recalc(makeInput({ cells: [cell("L1", PERIOD_START, "P1")] }))).effectiveChangeover).toBe("NONE");
    const r = recalc(makeInput({ cells: [cell("L1", PERIOD_START, "P1")], boundaryCells: [cell("L2", DAY_BEFORE, "P2")] }));
    expect(first(r).effectiveChangeover).toBe("NONE");
  });

  it("교체유형을 직접 넣었으면 그대로, 둘째 날부터는 이 계획 안에서 비교", () => {
    const r = recalc(
      makeInput({
        cells: [cell("L1", PERIOD_START, "P1", { changeoverType: "FULL" }), cell("L1", "2026-11-13", "P1")],
        boundaryCells: [cell("L1", DAY_BEFORE, "P2"), cell("L1", PERIOD_START, "P3")],
      }),
    );
    expect(first(r).effectiveChangeover).toBe("FULL");
    expect(first(r).changeoverDefaulted).toBe(false);
    expect(r.cells.find((c) => c.lineId === "L1" && c.date === "2026-11-13")!.effectiveChangeover).toBe("NONE");
  });

  it("첫날 교체도 하루 교체 횟수에 들어간다", () => {
    const lines = ["L1", "L2", "L3"];
    const base = makeInput({
      cells: lines.map((l) => cell(l, PERIOD_START, "P1")),
      boundaryCells: lines.map((l) => cell(l, DAY_BEFORE, "P2")),
    });
    const r = recalc({ ...base, settings: { ...base.settings, dailyChangeoverLimit: 2 } });
    expect(r.cells.filter((c) => c.date === PERIOD_START && c.effectiveChangeover !== "NONE")).toHaveLength(3);
    expect(r.cells.some((c) => c.date === PERIOD_START && c.violations.includes("CHANGEOVER_LIMIT"))).toBe(true);
  });
});

describe("pickBoundaryRevisionId", () => {
  const rev = (id: string, status: "draft" | "confirmed", revNo: number | null) => ({ id, status, revNo });
  const plans = [
    { factoryId: "F1", periodStart: "2026-11-26", periodEnd: "2026-12-10", revisions: [rev("d26", "draft", null)] },
    { factoryId: "F1", periodStart: "2026-11-19", periodEnd: "2026-12-03", revisions: [rev("r0", "confirmed", 0), rev("r1", "confirmed", 1), rev("d19", "draft", null)] },
    { factoryId: "F1", periodStart: "2026-11-12", periodEnd: "2026-11-26", revisions: [rev("old", "confirmed", 0)] },
    { factoryId: "F2", periodStart: "2026-11-19", periodEnd: "2026-12-03", revisions: [rev("f2", "confirmed", 0)] },
  ];

  it("전날을 포함하는 직전 계획의 최신 확정 Rev", () => {
    expect(pickBoundaryRevisionId(plans, { factoryId: "F1", periodStart: "2026-11-26" })).toBe("r1");
  });

  it("직전 계획에 확정 Rev 가 없거나 전날을 포함하지 않으면 null", () => {
    expect(pickBoundaryRevisionId(plans, { factoryId: "F1", periodStart: "2026-12-03" })).toBeNull(); // 11/26 계획은 초안뿐
    expect(pickBoundaryRevisionId(plans, { factoryId: "F1", periodStart: "2026-11-12" })).toBeNull();
    expect(pickBoundaryRevisionId(plans.slice(2), { factoryId: "F1", periodStart: "2026-12-10" })).toBeNull(); // 11/12~11/26 은 12/09 미포함
  });
});
