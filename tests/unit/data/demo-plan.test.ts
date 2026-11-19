/**
 * 데모 계획 생성 (lib/data/demo-plan.ts) · 가상 id 만 쓴다
 */
import { describe, expect, it } from "vitest";
import { buildDemoPlanCells } from "../../../lib/data/demo-plan";
import { resolveChangeover } from "../../../lib/engine/production";
import { addDays, dateRange } from "../../../lib/excel/common";
import type { PlanCell } from "../../../lib/engine/types";

const lines = Array.from({ length: 18 }, (_, i) => ({ id: `L${i + 1}` }));
// L9: 허용 제품 1개(교체 없음), L18: 허용 금형 없음
const allowedByLine = new Map(lines.map((l, i) => [l.id, i === 8 ? ["P-only"] : i === 17 ? [] : ["P-a", "P-b", "P-c"]]));
const dates = dateRange("2026-11-19", 15);

/** 화면 배지와 같은 규칙으로 분류: 'BM' | 'FULL' | 'BM?' | null */
function badges(cells: PlanCell[]) {
  const byKey = new Map(cells.map((c) => [`${c.lineId}|${c.date}`, c]));
  return cells.map((c) => {
    const r = resolveChangeover(c, byKey.get(`${c.lineId}|${addDays(c.date, -1)}`), "BM");
    return { cell: c, kind: r.type === "NONE" ? null : r.defaulted ? "BM?" : r.type };
  });
}

/** 같은 호기에서 직전에 만든 셀과 제품이 다른 셀 = 교체 */
function changes(cells: PlanCell[]) {
  const out: PlanCell[] = [];
  const last = new Map<string, string>();
  for (const c of cells) {
    const prev = last.get(c.lineId);
    if (prev !== undefined && prev !== c.productId) out.push(c);
    last.set(c.lineId, c.productId!);
  }
  return out;
}

describe("데모 계획 (lib/data/demo-plan.ts)", () => {
  it("허용 제품만 쓰고, 허용 금형이 없는 호기는 비우며, 수량은 비운다", () => {
    const cells = buildDemoPlanCells({ lines, allowedByLine, dates });
    expect(cells).toHaveLength(17 * 15);
    for (const c of cells) expect(allowedByLine.get(c.lineId)).toContain(c.productId);
    expect(cells.every((c) => c.qty === null)).toBe(true);
  });

  it("제품이 바뀌는 날에만 교체 표시가 있고, 하루 교체 수는 3 이하", () => {
    const cells = buildDemoPlanCells({ lines, allowedByLine, dates });
    const changed = new Set(changes(cells));
    for (const c of cells) if (!changed.has(c)) expect(c.changeoverType).toBe("NONE");
    for (const { cell, kind } of badges(cells)) expect(kind !== null).toBe(changed.has(cell));
    for (const d of dates) expect([...changed].filter((c) => c.date === d).length).toBeLessThanOrEqual(3);
    expect(cells.filter((c) => c.lineId === "L9").every((c) => c.changeoverType === "NONE")).toBe(true);
  });

  it("교체 배지 B/M · FULL · B/M?(미입력) 가 모두 2건 이상 나온다", () => {
    const kinds = badges(buildDemoPlanCells({ lines, allowedByLine, dates })).map((b) => b.kind);
    for (const k of ["BM", "FULL", "BM?"]) expect(kinds.filter((x) => x === k).length).toBeGreaterThanOrEqual(2);
  });

  it("다운타임 날짜에는 셀이 없음", () => {
    const downtimes = [
      { lineId: "L12", startDate: "2026-11-20", endDate: "2026-11-20" },
      { lineId: "L3", startDate: "2026-11-23", endDate: "2026-11-25" },
      { lineId: "L1", startDate: "2026-11-10", endDate: "2026-11-19" }, // 기간 시작일과 겹침
    ];
    const cells = buildDemoPlanCells({ lines, allowedByLine, dates, downtimes });
    const has = (lineId: string, date: string) => cells.some((c) => c.lineId === lineId && c.date === date);
    expect(has("L12", "2026-11-20")).toBe(false);
    for (const d of ["2026-11-23", "2026-11-24", "2026-11-25"]) expect(has("L3", d)).toBe(false);
    expect(has("L1", "2026-11-19")).toBe(false);
    expect(cells).toHaveLength(17 * 15 - 5);
    // 다운타임이 없는 날·호기는 그대로
    expect(has("L12", "2026-11-21")).toBe(true);
    expect(has("L4", "2026-11-20")).toBe(true);
  });

  it("다운타임 바로 다음 날 교체는 미입력 대신 명시 유형이라 배지가 사라지지 않는다", () => {
    // L3(순번 2): 7일 주기에서 offset 2 → 첫 교체일 11/24. 11/23~11/24 다운타임이면 교체는 11/25 로 밀린다
    const downtimes = [{ lineId: "L3", startDate: "2026-11-23", endDate: "2026-11-24" }];
    const cells = buildDemoPlanCells({ lines, allowedByLine, dates, downtimes });
    const after = cells.find((c) => c.lineId === "L3" && c.date === "2026-11-25")!;
    const before = cells.find((c) => c.lineId === "L3" && c.date === "2026-11-22")!;
    expect(after.productId).not.toBe(before.productId);
    expect(after.changeoverType).not.toBe("NONE");
    const b = badges(cells).find((x) => x.cell === after)!;
    expect(b.kind).not.toBeNull();
  });
});
