import { describe, expect, it } from "vitest";
import { recalc } from "@/lib/engine";
import type { Line } from "@/lib/engine/types";
import { cell, LINES, makeInput, PERIOD_START } from "./fixtures";

function findCell(result: ReturnType<typeof recalc>, lineId: string, date: string) {
  const c = result.cells.find((x) => x.lineId === lineId && x.date === date);
  if (!c) throw new Error(`cell not found ${lineId} ${date}`);
  return c;
}

describe("FR-07 제약 검사", () => {
  it("FR-07 제품이 바뀌었는데 교체유형 미입력 → 기본 B/M 적용(0.87) + CHANGEOVER_DEFAULTED 주의", () => {
    const input = makeInput({
      cells: [cell("L1", "2026-11-12", "P1"), cell("L1", "2026-11-13", "P2")],
    });
    const r = recalc(input);
    const c = findCell(r, "L1", "2026-11-13");
    expect(c.effectiveChangeover).toBe("BM");
    expect(c.changeoverDefaulted).toBe(true);
    expect(c.expectedQty).toBe(52_200); // 60,000 × 0.87
    expect(c.violations).toContain("CHANGEOVER_DEFAULTED");
    const v = r.violations.find((x) => x.code === "CHANGEOVER_DEFAULTED");
    expect(v).toBeDefined();
    expect(v?.severity).toBe("notice");
    expect(v?.lineId).toBe("L1");
    expect(v?.date).toBe("2026-11-13");
    expect(v?.message).toContain("기본값");
    // 첫날은 전일이 없으므로 교체 아님
    const first = findCell(r, "L1", "2026-11-12");
    expect(first.effectiveChangeover).toBe("NONE");
    expect(first.expectedQty).toBe(100_000);
  });

  it("FR-07 전일과 같은 제품이면 교체 아님, 전일이 빈 셀이면 교체 아님", () => {
    const input = makeInput({
      cells: [
        cell("L1", "2026-11-12", "P1"),
        cell("L1", "2026-11-13", "P1"),
        // 11/14 빈 셀
        cell("L1", "2026-11-15", "P2"),
      ],
    });
    const r = recalc(input);
    expect(findCell(r, "L1", "2026-11-13").effectiveChangeover).toBe("NONE");
    expect(findCell(r, "L1", "2026-11-15").effectiveChangeover).toBe("NONE");
    expect(r.violations.filter((v) => v.code === "CHANGEOVER_DEFAULTED")).toHaveLength(0);
  });

  it("FR-07 같은 제품이라도 교체유형이 입력되어 있으면 입력대로 적용", () => {
    const input = makeInput({
      cells: [cell("L1", "2026-11-12", "P1"), cell("L1", "2026-11-13", "P1", { changeoverType: "BM" })],
    });
    const c = findCell(recalc(input), "L1", "2026-11-13");
    expect(c.effectiveChangeover).toBe("BM");
    expect(c.changeoverDefaulted).toBe(false);
    expect(c.expectedQty).toBe(87_000);
  });

  it("FR-07 ① MOLD_NOT_ALLOWED: 허용 목록 밖 금형", () => {
    const input = makeInput({ cells: [cell("L3", "2026-11-14", "P1")] }); // L3 에는 P1 미허용
    const r = recalc(input);
    const v = r.violations.find((x) => x.code === "MOLD_NOT_ALLOWED");
    expect(v).toBeDefined();
    expect(v?.severity).toBe("error");
    expect(v?.lineId).toBe("L3");
    expect(v?.productId).toBe("P1");
    expect(v?.message).toBe("PET 3호기 11/14: 허용되지 않은 금형(500ml 원형)");
    expect(findCell(r, "L3", "2026-11-14").violations).toContain("MOLD_NOT_ALLOWED");
    // 허용된 금형은 위반 없음
    const ok = recalc(makeInput({ cells: [cell("L3", "2026-11-14", "P2")] }));
    expect(ok.violations.filter((x) => x.code === "MOLD_NOT_ALLOWED")).toHaveLength(0);
  });

  it("FR-07 ③ DOWNTIME_ASSIGNED: 가동 불가일에 제품 배치", () => {
    const input = makeInput({
      cells: [cell("L1", "2026-11-13", "P1")],
      downtimes: [{ lineId: "L1", startDate: "2026-11-13", endDate: "2026-11-13", reason: "정비" }],
    });
    const r = recalc(input);
    const v = r.violations.find((x) => x.code === "DOWNTIME_ASSIGNED");
    expect(v).toBeDefined();
    expect(v?.severity).toBe("error");
    expect(v?.lineId).toBe("L1");
    expect(v?.date).toBe("2026-11-13");
    expect(findCell(r, "L1", "2026-11-13").violations).toContain("DOWNTIME_ASSIGNED");
    expect(findCell(r, "L1", "2026-11-13").expectedQty).toBe(0);
  });

  it("FR-07 ② CHANGEOVER_LIMIT: 한도 3, 같은 날 같은 공장 교체 4회", () => {
    const l4: Line = { id: "L4", code: "PET4", name: "PET 4호기", factoryCode: "F1", processType: "PET1_1STAGE", usesSeabulk: true, sortOrder: 4, isPlanTarget: true };
    const lines = [...LINES, l4];
    const allowedMolds = lines.map((l) => ({ lineId: l.id, productId: "P2" }));
    const day = "2026-11-13";
    const input = makeInput({
      lines,
      allowedMolds,
      cells: lines.map((l) => cell(l.id, day, "P2", { changeoverType: "BM" })),
    });
    const r = recalc(input);
    const limitViolations = r.violations.filter((x) => x.code === "CHANGEOVER_LIMIT");
    expect(limitViolations).toHaveLength(1);
    const v = limitViolations[0];
    expect(v.severity).toBe("error");
    expect(v.lineId).toBeNull();
    expect(v.date).toBe(day);
    expect(v.detail).toEqual({ count: 4, limit: 3, factoryCode: "F1" });
    for (const l of lines) {
      expect(findCell(r, l.id, day).violations).toContain("CHANGEOVER_LIMIT");
    }

    // 3회면 위반 없음
    const ok = recalc(
      makeInput({
        lines,
        allowedMolds,
        cells: lines.slice(0, 3).map((l) => cell(l.id, day, "P2", { changeoverType: "BM" })),
      }),
    );
    expect(ok.violations.filter((x) => x.code === "CHANGEOVER_LIMIT")).toHaveLength(0);
  });

  it("FR-07 ② 교체 횟수는 공장 단위로 집계 (다른 공장은 별도)", () => {
    const l4: Line = { id: "L4", code: "PET4", name: "PET 4호기", factoryCode: "F2", processType: "PET1_1STAGE", usesSeabulk: true, sortOrder: 4, isPlanTarget: true };
    const lines = [...LINES, l4];
    const allowedMolds = lines.map((l) => ({ lineId: l.id, productId: "P2" }));
    const day = "2026-11-13";
    const r = recalc(
      makeInput({
        lines,
        allowedMolds,
        cells: lines.map((l) => cell(l.id, day, "P2", { changeoverType: "BM" })),
      }),
    );
    expect(r.violations.filter((x) => x.code === "CHANGEOVER_LIMIT")).toHaveLength(0);
  });

  it("FR-07 UNKNOWN_PRODUCT: 기준정보에 없는 제품 id", () => {
    const r = recalc(makeInput({ cells: [cell("L1", PERIOD_START, "ZZZ", { qty: 1000 })] }));
    const v = r.violations.find((x) => x.code === "UNKNOWN_PRODUCT");
    expect(v?.severity).toBe("notice");
    expect(v?.productId).toBe("ZZZ");
    const c = findCell(r, "L1", PERIOD_START);
    expect(c.violations).toContain("UNKNOWN_PRODUCT");
    expect(c.expectedQty).toBe(1000); // 입력 수량은 그대로
  });
});
