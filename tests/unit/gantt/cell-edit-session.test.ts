/**
 * 셀 편집창: "완료"만 반영, X · Esc · 바깥 클릭은 취소 (components/gantt/cell-edit-session.ts)
 * 계획표(plan-workspace)는 closeCellEdit 가 changed=true 일 때만 셀을 바꾸고 dirty(자동 저장 대상)로 표시한다.
 */
import { describe, expect, it } from "vitest";
import { cellMapKey, closeCellEdit, openCellEdit, patchCellEdit, previewCells, type CloseVia } from "@/components/gantt/cell-edit-session";
import { addDays, buildProductionIndex, computeCell } from "@/lib/engine";
import type { PlanCell } from "@/lib/engine/types";
import { LINES, makeInput, PERIOD_START, cell } from "../engine/fixtures";

const D = "2026-11-13";
const original: PlanCell = { ...cell("L1", D, "P1", { qty: 90_000 }), memo: "원래 메모" };

function plan(): Map<string, PlanCell> {
  return new Map([
    [cellMapKey("L1", PERIOD_START), cell("L1", PERIOD_START, "P1")],
    [cellMapKey("L1", D), original],
  ]);
}

/** 편집창에서 금형·수량·교체유형·메모를 모두 바꾼 세션 */
function editedSession(cells: Map<string, PlanCell>) {
  let s = openCellEdit(cells, "L1", D);
  s = patchCellEdit(s, { productId: "P2" });
  s = patchCellEdit(s, { qty: 50_000 });
  s = patchCellEdit(s, { changeoverType: "FULL" });
  s = patchCellEdit(s, { memo: "바꾼 메모" });
  return s;
}

describe("셀 편집창 닫기", () => {
  for (const via of ["x", "escape", "outside"] as CloseVia[]) {
    it(`값을 바꾸고 ${via === "x" ? "X" : via === "escape" ? "Esc" : "바깥 클릭"} → 원래 값 유지, 저장 대상 아님`, () => {
      const cells = plan();
      const r = closeCellEdit(cells, editedSession(cells), via);
      expect(r.changed).toBe(false); // dirty 가 되지 않음 → 자동 저장도 없음
      expect(r.cells).toBe(cells); // 같은 객체 그대로
      expect(r.cells.get(cellMapKey("L1", D))).toEqual(original);
    });
  }

  it("값을 바꾸고 완료 → 새 값 적용, 저장 대상", () => {
    const cells = plan();
    const r = closeCellEdit(cells, editedSession(cells), "done");
    expect(r.changed).toBe(true);
    expect(r.cells.get(cellMapKey("L1", D))).toEqual({ lineId: "L1", date: D, productId: "P2", qty: 50_000, changeoverType: "FULL", memo: "바꾼 메모" });
    expect(cells.get(cellMapKey("L1", D))).toEqual(original); // 원본 Map 은 그대로
  });

  it("편집 중에는 계획표 셀이 바뀌지 않는다 (draft 에만 담김)", () => {
    const cells = plan();
    const s = editedSession(cells);
    expect(cells.get(cellMapKey("L1", D))).toEqual(original);
    expect(s.original).toEqual(original);
    expect(s.draft.productId).toBe("P2");
  });

  it("바꿨다가 원래 값으로 되돌리고 완료 → 바뀐 것 없음, 저장 대상 아님", () => {
    const cells = plan();
    let s = openCellEdit(cells, "L1", D);
    s = patchCellEdit(s, { qty: 1 });
    s = patchCellEdit(s, { qty: 90_000 });
    const r = closeCellEdit(cells, s, "done");
    expect(r.changed).toBe(false);
    expect(r.cells).toBe(cells);
  });

  it("빈 칸에서 제품을 고르고 완료 → 새 칸 생성 / 취소 → 칸 없음", () => {
    const cells = plan();
    const s = patchCellEdit(openCellEdit(cells, "L2", D), { productId: "P1" });
    expect(closeCellEdit(cells, s, "escape").cells.has(cellMapKey("L2", D))).toBe(false);
    expect(closeCellEdit(cells, s, "done").cells.get(cellMapKey("L2", D))?.productId).toBe("P1");
  });

  it("편집창에서 제품을 비우고 완료 → 수량·교체유형도 비고, 메모가 없으면 칸 삭제", () => {
    const cells = plan();
    const s = patchCellEdit(patchCellEdit(openCellEdit(cells, "L1", D), { productId: null }), { memo: null });
    expect(s.draft.qty).toBeNull();
    expect(s.draft.changeoverType).toBe("NONE");
    expect(closeCellEdit(cells, s, "done").cells.has(cellMapKey("L1", D))).toBe(false);
  });
});

describe("편집창 미리보기 (생산 가능시간·계산 근거)", () => {
  it("draft 기준으로 다시 계산되지만 계획표 셀 목록은 그대로", () => {
    const cells = plan();
    let s = openCellEdit(cells, "L1", D);
    s = patchCellEdit(s, { qty: null, changeoverType: "BM" });
    const before = [...cells.values()];
    const input = makeInput({ cells: previewCells(cells, s) });
    const r = computeCell(input, buildProductionIndex(input), LINES[0], D, addDays(D, -1));
    expect(r.effectiveChangeover).toBe("BM");
    expect(r.expectedQty).toBe(87_000); // 100,000 × 0.87 (B/M 3h → 생산 가능 21h)
    expect([...cells.values()]).toEqual(before);
    const committed = makeInput({ cells: before });
    const now = computeCell(committed, buildProductionIndex(committed), LINES[0], D, addDays(D, -1));
    expect(now.expectedQty).toBe(90_000); // 계획표 기준은 여전히 입력 수량
  });
});
