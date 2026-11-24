/**
 * 드래그 적용·사전 검사 (components/gantt/drag-plan.ts).
 * - applyDragTo 는 예전 plan-workspace 의 applyDrag 와 결과가 완전히 같아야 한다 → 아래 legacyApply(옛 코드 그대로)와 비교.
 * - inspectDrag 는 덮어써지는 칸 · 기간 밖으로 지워지는 칸 · 허용되지 않는 호기를 적용 전에 알려준다.
 * - 허용 판정은 엔진 MOLD_NOT_ALLOWED 와 같아야 한다 → recalc 결과와 비교.
 */
import { describe, expect, it } from "vitest";
import { applyDragTo, buildAllowRules, confirmLabel, dragIsNoop, inspectDrag, moveTargetNotAllowed, type Drag } from "@/components/gantt/drag-plan";
import { cellMapKey as key } from "@/components/gantt/cell-edit-session";
import { addDays, recalc } from "@/lib/engine";
import { EDITED_AUTO_PREFIX, type PlanCell } from "@/lib/engine/types";
import { makeInput, PERIOD_START, PRODUCTS } from "../engine/fixtures";

const dates = Array.from({ length: 15 }, (_, i) => addDays(PERIOD_START, i));
const D = (i: number) => dates[i];
const input = makeInput();
const rules = buildAllowRules(input.allowedMolds, PRODUCTS.map((p) => p.id));

function c(lineId: string, i: number, productId: string | null, extra: Partial<PlanCell> = {}): PlanCell {
  return { lineId, date: D(i), productId, qty: null, changeoverType: "NONE", memo: null, origin: "manual", ...extra };
}
function block(lineId: string, from: number, to: number, productId: string, extra: Partial<PlanCell> = {}): PlanCell[] {
  return Array.from({ length: to - from + 1 }, (_, k) => c(lineId, from + k, productId, extra));
}
const mapOf = (cells: PlanCell[]) => new Map(cells.map((x) => [key(x.lineId, x.date), x]));
const move = (lineId: string, startIdx: number, endIdx: number, productId: string, grabIdx: number, hoverIdx: number, hoverLineId = lineId): Drag => ({ kind: "move", lineId, startIdx, endIdx, productId, grabIdx, hoverIdx, hoverLineId });
const resize = (lineId: string, startIdx: number, endIdx: number, productId: string, hoverIdx: number): Drag => ({ kind: "resize", lineId, startIdx, endIdx, productId, hoverIdx });

/** 예전 plan-workspace.tsx applyDrag 본문 그대로 (main 2786385). 비교 기준 */
function legacyApply(m: Map<string, PlanCell>, d: Drag) {
  const idxOf = new Map(dates.map((x, i) => [x, i]));
  if (d.kind === "resize") {
    const newEnd = d.hoverIdx;
    if (newEnd > d.endIdx) {
      const template = m.get(key(d.lineId, dates[d.endIdx]));
      for (let i = d.endIdx + 1; i <= newEnd; i++) {
        m.set(key(d.lineId, dates[i]), { lineId: d.lineId, date: dates[i], productId: d.productId, qty: null, changeoverType: "NONE", memo: template?.memo ?? null, moldId: template?.moldId ?? null, origin: "manual", basis: null });
      }
    } else if (newEnd < d.endIdx) {
      for (let i = newEnd + 1; i <= d.endIdx; i++) m.delete(key(d.lineId, dates[i]));
    }
    return;
  }
  const delta = d.hoverIdx - d.grabIdx;
  const targetLine = d.hoverLineId;
  if (delta === 0 && targetLine === d.lineId) return;
  const moving: PlanCell[] = [];
  for (let i = d.startIdx; i <= d.endIdx; i++) {
    const x = m.get(key(d.lineId, dates[i]));
    if (x) moving.push(x);
    m.delete(key(d.lineId, dates[i]));
  }
  for (const x of moving) {
    const ni = idxOf.get(x.date)! + delta;
    if (ni < 0 || ni >= dates.length) continue;
    m.set(key(targetLine, dates[ni]), { ...x, lineId: targetLine, date: dates[ni], origin: "manual", basis: x.origin === "auto" ? `${EDITED_AUTO_PREFIX} · ${x.basis ?? ""}`.slice(0, 300) : x.basis });
  }
}

/** 새 적용 결과(정렬된 셀 목록). 예전 결과와 같은지 함께 확인한다 */
function run(cells: PlanCell[], d: Drag) {
  const next = mapOf(cells);
  applyDragTo(next, d, dates);
  const old = mapOf(cells);
  legacyApply(old, d);
  const sorted = (m: Map<string, PlanCell>) => [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  expect(sorted(next)).toEqual(sorted(old));
  return { after: next, insp: inspectDrag(mapOf(cells), d, dates, rules) };
}
const pos = (xs: { lineId: string; date: string }[]) => xs.map((x) => `${x.lineId}@${x.date}`);

describe("빈 곳 · 겹침 · 제자리", () => {
  it("빈 곳으로 이동 → 확인 없음, 블록이 그대로 옮겨진다", () => {
    const { after, insp } = run(block("L1", 0, 2, "P1"), move("L1", 0, 2, "P1", 0, 5));
    expect(insp.needsConfirm).toBe(false);
    expect([...after.keys()].sort()).toEqual([key("L1", D(5)), key("L1", D(6)), key("L1", D(7))]);
  });

  it("자기 자신과 겹치는 이동(한 칸 뒤로) → 덮어쓰기로 세지 않는다", () => {
    const { after, insp } = run(block("L1", 0, 3, "P1"), move("L1", 0, 3, "P1", 1, 2));
    expect(insp.overwritten).toEqual([]);
    expect(insp.needsConfirm).toBe(false);
    expect(after.has(key("L1", D(0)))).toBe(false);
    expect(after.get(key("L1", D(4)))?.productId).toBe("P1");
  });

  it("제자리에 놓으면 아무것도 바뀌지 않는다", () => {
    const d = move("L1", 0, 1, "P1", 0, 0);
    expect(dragIsNoop(d)).toBe(true);
    const cells = block("L1", 0, 1, "P1");
    const { after, insp } = run(cells, d);
    expect([...after.values()]).toEqual(cells);
    expect(insp.needsConfirm).toBe(false);
  });
});

describe("덮어쓰기", () => {
  it("다른 블록 위로 이동 → 그 블록의 칸이 덮어써진다", () => {
    const cells = [...block("L1", 0, 1, "P1"), ...block("L1", 4, 5, "P2")];
    const { insp } = run(cells, move("L1", 0, 1, "P1", 0, 4));
    expect(pos(insp.overwritten)).toEqual([`L1@${D(4)}`, `L1@${D(5)}`]);
    expect(insp.overwritten.map((x) => x.productId)).toEqual(["P2", "P2"]);
    expect(confirmLabel(insp)).toBe("덮어쓰기");
  });

  it("메모만 있는 칸도 내용이 있는 칸으로 센다", () => {
    const cells = [...block("L1", 0, 1, "P1"), c("L1", 5, null, { memo: "정기 점검" })];
    const { insp } = run(cells, move("L1", 0, 1, "P1", 0, 4));
    expect(insp.overwritten).toEqual([{ lineId: "L1", date: D(5), productId: null, memo: "정기 점검" }]);
  });

  it("제품도 메모도 없는 칸은 세지 않는다", () => {
    const cells = [...block("L1", 0, 1, "P1"), c("L1", 5, null, { memo: "" })];
    expect(run(cells, move("L1", 0, 1, "P1", 0, 4)).insp.overwritten).toEqual([]);
  });

  it("끝 늘리기로 다음 블록을 덮어쓴다 → 메모·금형은 끝 칸에서 복사, 수량·교체는 비움", () => {
    const cells = [...block("L1", 0, 1, "P1", { memo: "m", moldId: "M1" }), ...block("L1", 2, 3, "P2", { qty: 5000, changeoverType: "BM" })];
    const { after, insp } = run(cells, resize("L1", 0, 1, "P1", 3));
    expect(pos(insp.overwritten)).toEqual([`L1@${D(2)}`, `L1@${D(3)}`]);
    expect(after.get(key("L1", D(3)))).toEqual({ lineId: "L1", date: D(3), productId: "P1", qty: null, changeoverType: "NONE", memo: "m", moldId: "M1", origin: "manual", basis: null });
  });

  it("끝 늘리기로 메모만 있는 칸을 덮어쓴다", () => {
    const cells = [...block("L1", 0, 1, "P1"), c("L1", 2, null, { memo: "점검" })];
    expect(run(cells, resize("L1", 0, 1, "P1", 2)).insp.overwritten.map((x) => x.memo)).toEqual(["점검"]);
  });

  it("끝 줄이기 → 자기 블록 칸만 지우므로 확인 없음", () => {
    const { after, insp } = run(block("L1", 0, 3, "P1"), resize("L1", 0, 3, "P1", 1));
    expect(insp.needsConfirm).toBe(false);
    expect([...after.keys()].sort()).toEqual([key("L1", D(0)), key("L1", D(1))]);
  });
});

describe("기간 밖", () => {
  it("일부만 기간 밖으로 나감 → 밀려난 칸만 지워지는 칸으로", () => {
    const { after, insp } = run(block("L1", 12, 14, "P1"), move("L1", 12, 14, "P1", 12, 13));
    expect(pos(insp.droppedOutside)).toEqual([`L1@${D(14)}`]);
    expect(insp.overwritten).toEqual([]);
    expect(confirmLabel(insp)).toBe("그래도 옮기기");
    expect([...after.keys()].sort()).toEqual([key("L1", D(13)), key("L1", D(14))]);
  });

  it("앞쪽으로 밀려나도 같다", () => {
    const { insp } = run(block("L1", 0, 2, "P1"), move("L1", 0, 2, "P1", 2, 0));
    expect(pos(insp.droppedOutside)).toEqual([`L1@${D(0)}`, `L1@${D(1)}`]);
  });

  it("전부 기간 밖으로 나감 → 블록 전체가 지워지는 칸 (화면 드래그로는 잡은 칸이 항상 안에 남지만 함수는 처리한다)", () => {
    const { after, insp } = run(block("L1", 13, 14, "P1"), move("L1", 13, 14, "P1", 13, 15));
    expect(pos(insp.droppedOutside)).toEqual([`L1@${D(13)}`, `L1@${D(14)}`]);
    expect(after.size).toBe(0);
  });

  it("기간 밖 + 덮어쓰기 동시 → 둘 다 보이고 버튼은 「덮어쓰기」", () => {
    const cells = [...block("L1", 12, 14, "P1"), c("L2", 13, "P3")];
    const { insp } = run(cells, move("L1", 12, 14, "P1", 12, 13, "L2"));
    expect(pos(insp.droppedOutside)).toEqual([`L1@${D(14)}`]);
    expect(pos(insp.overwritten)).toEqual([`L2@${D(13)}`]);
    expect(insp.notAllowed).toEqual([]); // L2 는 P1 허용
    expect(confirmLabel(insp)).toBe("덮어쓰기");
  });
});

describe("다른 호기 · 허용 금형 (엔진 MOLD_NOT_ALLOWED 와 같은 기준)", () => {
  it("허용된 호기로 이동 → 확인 없음", () => {
    const d = move("L1", 0, 1, "P1", 0, 0, "L2");
    expect(moveTargetNotAllowed(d, rules)).toBe(false);
    expect(run(block("L1", 0, 1, "P1"), d).insp.needsConfirm).toBe(false);
  });

  it("허용되지 않는 호기로 이동 → 경고, 버튼은 「그래도 옮기기」, 엔진도 같은 칸을 MOLD_NOT_ALLOWED 로 본다", () => {
    const d = move("L1", 0, 2, "P1", 0, 1, "L3");
    expect(moveTargetNotAllowed(d, rules)).toBe(true);
    const { after, insp } = run(block("L1", 0, 2, "P1"), d);
    expect(insp.notAllowed).toEqual([{ lineId: "L3", productId: "P1", dates: [D(1), D(2), D(3)] }]);
    expect(confirmLabel(insp)).toBe("그래도 옮기기");
    const engine = recalc(makeInput({ cells: [...after.values()] })).violations.filter((v) => v.code === "MOLD_NOT_ALLOWED");
    expect(engine.map((v) => `${v.lineId}@${v.date}`)).toEqual(insp.notAllowed[0].dates.map((x) => `L3@${x}`));
  });

  it("허용 안 됨 + 덮어쓰기 → 「덮어쓰고 옮기기」, 기간 밖이 함께 있어도 같다", () => {
    const cells = [...block("L1", 12, 14, "P1"), c("L3", 13, "P2")];
    const { insp } = run(cells, move("L1", 12, 14, "P1", 12, 13, "L3"));
    expect(insp.overwritten.length).toBe(1);
    expect(insp.droppedOutside.length).toBe(1);
    expect(insp.notAllowed.length).toBe(1);
    expect(confirmLabel(insp)).toBe("덮어쓰고 옮기기");
  });

  it("기준정보에 없는 제품은 허용 경고를 내지 않는다 (엔진도 UNKNOWN_PRODUCT 로 따로 본다)", () => {
    const { after, insp } = run(block("L1", 0, 1, "PX"), move("L1", 0, 1, "PX", 0, 0, "L3"));
    expect(insp.notAllowed).toEqual([]);
    expect(recalc(makeInput({ cells: [...after.values()] })).violations.some((v) => v.code === "MOLD_NOT_ALLOWED")).toBe(false);
  });

  it("같은 호기 안의 이동은 허용 경고를 내지 않는다 (원래부터 그 호기에 있던 블록)", () => {
    expect(run(block("L3", 0, 1, "P1"), move("L3", 0, 1, "P1", 0, 3)).insp.notAllowed).toEqual([]);
  });
});

describe("적용 규칙 유지", () => {
  it("자동 생성 셀을 옮기면 「사람이 수정」으로 표시되고 금형·수량·메모는 그대로", () => {
    const cells = block("L1", 0, 1, "P1", { origin: "auto", basis: "주문 A", moldId: "M9", qty: 1000, memo: "메모" });
    const { after } = run(cells, move("L1", 0, 1, "P1", 0, 3, "L2"));
    expect(after.get(key("L2", D(3)))).toEqual({ lineId: "L2", date: D(3), productId: "P1", qty: 1000, changeoverType: "NONE", memo: "메모", moldId: "M9", origin: "manual", basis: `${EDITED_AUTO_PREFIX} · 주문 A` });
  });

  it("사람이 넣은 셀의 근거는 바꾸지 않는다", () => {
    const { after } = run(block("L1", 0, 0, "P1", { basis: "직접" }), move("L1", 0, 0, "P1", 0, 2));
    expect(after.get(key("L1", D(2)))?.basis).toBe("직접");
  });
});
