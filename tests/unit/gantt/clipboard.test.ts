/**
 * 생산계획표 복사·잘라내기·붙여넣기 (components/gantt/clipboard.ts, confirm-text.ts).
 * - 잘라내기 붙여넣기는 같은 막대를 드래그로 옮긴 결과(applyDragTo · inspectDrag)와 완전히 같아야 한다 → 직접 비교.
 * - 복사 붙여넣기: 첫 칸 교체 유형 NONE, 주문 연결 · 근거는 비우고 manual. 비가동 시간 직접 입력은 그대로. 원래 막대는 그대로.
 * - 붙여넣기 한 번 = 되돌리기 한 단계 (undo-history.ts 의 recordStep).
 * - 드래그 확인창의 문구는 예전과 한 글자도 다르지 않아야 한다.
 */
import { describe, expect, it } from "vitest";
import {
  applyPasteTo,
  clipLabel,
  clipOnRevision,
  clipPastable,
  copiedCell,
  inspectPaste,
  makeClip,
  menuItems,
  pastedCount,
  REASON_CUT_CHANGED,
  REASON_NO_CLIP,
  sourceMatches,
  type BarRun,
  type Clip,
  type PasteTarget,
} from "@/components/gantt/clipboard";
import { dragConfirmText, pasteConfirmLabel, pasteConfirmText } from "@/components/gantt/confirm-text";
import { applyDragTo, buildAllowRules, confirmLabel, inspectDrag, type Drag, type DragInspection } from "@/components/gantt/drag-plan";
import { cellMapKey as key } from "@/components/gantt/cell-edit-session";
import { emptyHistory, recordStep, redoDoc, undoDoc, type UndoDoc } from "@/components/gantt/undo-history";
import { addDays, recalc } from "@/lib/engine";
import { EDITED_AUTO_PREFIX, type PlanCell } from "@/lib/engine/types";
import { makeInput, PERIOD_START, PRODUCTS } from "../engine/fixtures";

const dates = Array.from({ length: 15 }, (_, i) => addDays(PERIOD_START, i));
const D = (i: number) => dates[i];
const input = makeInput();
const rules = buildAllowRules(input.allowedMolds, PRODUCTS.map((p) => p.id)); // L3 에는 P1 이 허용되지 않는다
const REV = "R-draft";

function c(lineId: string, i: number, productId: string | null, extra: Partial<PlanCell> = {}): PlanCell {
  return { lineId, date: D(i), productId, qty: null, changeoverType: "NONE", memo: null, origin: "manual", ...extra };
}
function block(lineId: string, from: number, to: number, productId: string, extra: Partial<PlanCell> = {}): PlanCell[] {
  return Array.from({ length: to - from + 1 }, (_, k) => c(lineId, from + k, productId, extra));
}
const mapOf = (cells: PlanCell[]) => new Map(cells.map((x) => [key(x.lineId, x.date), x]));
const snapshot = (m: ReadonlyMap<string, PlanCell>) => [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
const pos = (xs: { lineId: string; date: string }[]) => xs.map((x) => `${x.lineId}@${x.date}`);

/** plan-workspace 의 runAt 과 같은 막대 찾기 */
function runAt(cells: Map<string, PlanCell>, lineId: string, idx: number): BarRun | null {
  const cur = cells.get(key(lineId, D(idx)));
  if (!cur?.productId) return null;
  let s = idx;
  let e = idx;
  while (s > 0 && cells.get(key(lineId, D(s - 1)))?.productId === cur.productId) s--;
  while (e < dates.length - 1 && cells.get(key(lineId, D(e + 1)))?.productId === cur.productId) e++;
  return { startIdx: s, endIdx: e, productId: cur.productId };
}
function clipOf(cells: Map<string, PlanCell>, mode: "copy" | "cut", lineId: string, idx: number, revisionId = REV): Clip {
  return makeClip(mode, cells, dates, lineId, runAt(cells, lineId, idx)!, { revisionId, periodStart: PERIOD_START, productName: "제품" });
}
function paste(cells: Map<string, PlanCell>, clip: Clip, target: PasteTarget) {
  const after = new Map(cells);
  applyPasteTo(after, clip, target, dates);
  return { after, insp: inspectPaste(cells, clip, target, dates, rules) };
}

// 모든 필드가 채워진 3일 막대 (첫 칸에 교체 · 비가동 시간 직접 입력)
const BAR = [
  c("L1", 2, "P1", { qty: 90_000, changeoverType: "FULL", lostHoursOverride: 6, memo: "첫날", moldId: "M1", origin: "auto", basis: "10월 5주 Rev 1 과 동일", orderId: "O1" }),
  c("L1", 3, "P1", { qty: 100_000, moldId: "M1", origin: "auto", basis: "10월 5주 Rev 1 과 동일", orderId: "O1", lostHoursOverride: 2 }),
  c("L1", 4, "P1", { qty: 100_000, moldId: "M1", origin: "auto", basis: "10월 5주 Rev 1 과 동일", orderId: "O1" }),
];

describe("복사 단위: 막대", () => {
  it("막대의 어느 칸을 골라도 막대 전체가 복사되고, 원래 막대는 그대로다", () => {
    const cells = mapOf([...BAR, c("L1", 5, "P2")]);
    for (const i of [2, 3, 4]) {
      const clip = clipOf(cells, "copy", "L1", i);
      expect(clip.cells).toEqual(BAR);
      expect(clip.source).toMatchObject({ lineId: "L1", startIdx: 2, endIdx: 4, productId: "P1" });
    }
    expect(snapshot(cells)).toEqual(snapshot(mapOf([...BAR, c("L1", 5, "P2")])));
  });
});

describe("복사 붙여넣기", () => {
  it("빈 곳: 확인 없이 붙고, 필드 처리 — 첫 칸 교체 NONE · 주문·근거 비움 · manual, 나머지는 그대로", () => {
    const cells = mapOf(BAR);
    const clip = clipOf(cells, "copy", "L1", 3);
    const { after, insp } = paste(cells, clip, { lineId: "L2", idx: 8 });
    expect(insp.needsConfirm).toBe(false);
    const got = [8, 9, 10].map((i) => after.get(key("L2", D(i)))!);
    expect(got[0]).toEqual({ ...BAR[0], lineId: "L2", date: D(8), changeoverType: "NONE", origin: "manual", basis: null, orderId: null });
    expect(got[1]).toEqual({ ...BAR[1], lineId: "L2", date: D(9), origin: "manual", basis: null, orderId: null });
    for (const g of got) {
      expect(g.orderId).toBeNull();
      expect(g.basis).toBeNull();
      expect(g.origin).toBe("manual");
      // 복사본은 "자동 생성 후 사람이 수정" 칸이 아니다 (사람이 새로 넣은 칸)
      expect(g.basis?.startsWith(EDITED_AUTO_PREFIX) ?? false).toBe(false);
    }
    expect(got.map((g) => [g.qty, g.memo, g.moldId, g.productId])).toEqual(BAR.map((b) => [b.qty, b.memo, b.moldId, b.productId]));
    // 원래 막대는 그대로
    for (const b of BAR) expect(after.get(key(b.lineId, b.date))).toBe(b);
  });

  it("복사본에 비가동 시간 직접 입력(lostHoursOverride)이 그대로 들어가고, 원래 막대의 값도 그대로다", () => {
    const cells = mapOf(BAR);
    const { after } = paste(cells, clipOf(cells, "copy", "L1", 2), { lineId: "L2", idx: 8 });
    expect([8, 9, 10].map((i) => after.get(key("L2", D(i)))?.lostHoursOverride ?? null)).toEqual([6, 2, null]);
    expect(BAR.map((b) => after.get(key(b.lineId, b.date))?.lostHoursOverride ?? null)).toEqual([6, 2, null]);
  });

  it("다른 막대 위: 덮어써지는 칸을 알려 준다", () => {
    const cells = mapOf([...BAR, ...block("L2", 6, 7, "P2")]);
    const { after, insp } = paste(cells, clipOf(cells, "copy", "L1", 2), { lineId: "L2", idx: 5 });
    expect(pos(insp.overwritten)).toEqual([`L2@${D(6)}`, `L2@${D(7)}`]);
    expect(insp.needsConfirm).toBe(true);
    expect(after.get(key("L2", D(7)))?.productId).toBe("P1");
  });

  it("메모만 있는 칸 위: 덮어쓰기로 잡히고 확인창에 「메모」로 나온다", () => {
    const cells = mapOf([...BAR, c("L2", 9, null, { memo: "정기 점검" })]);
    const { insp } = paste(cells, clipOf(cells, "copy", "L1", 2), { lineId: "L2", idx: 8 });
    expect(insp.overwritten).toEqual([{ lineId: "L2", date: D(9), productId: null, memo: "정기 점검" }]);
  });

  it("자기 자신 위: 바뀌는 칸만 덮어쓰기로 잡는다. 값이 모두 같으면 바뀌는 것도 확인도 없다", () => {
    const cells = mapOf(BAR);
    const { insp } = paste(cells, clipOf(cells, "copy", "L1", 2), { lineId: "L1", idx: 2 });
    expect(pos(insp.overwritten)).toEqual(pos(BAR)); // 자동 생성 칸이 manual · 근거 없음으로 바뀐다
    const plain = mapOf(block("L1", 2, 4, "P1"));
    const r = paste(plain, clipOf(plain, "copy", "L1", 2), { lineId: "L1", idx: 2 });
    expect(r.insp.needsConfirm).toBe(false);
    expect(recordStep(emptyHistory<null>(), { cells: plain, side: null }, { cells: r.after, side: null }).past).toHaveLength(0);
  });

  it("자기 자신과 일부 겹치는 자리: 복사한 내용이 하루 밀려 들어가고 원래 첫 칸은 남는다", () => {
    const plain = mapOf(block("L1", 2, 4, "P1", { qty: 7 }));
    const { after } = paste(plain, clipOf(plain, "copy", "L1", 2), { lineId: "L1", idx: 3 });
    expect([2, 3, 4, 5].map((i) => after.get(key("L1", D(i)))?.productId)).toEqual(["P1", "P1", "P1", "P1"]);
    expect(after.get(key("L1", D(2)))).toBe(plain.get(key("L1", D(2))));
  });

  it("기간 끝을 넘는 칸은 버리고, 기간 뒤 날짜로 알린다", () => {
    const cells = mapOf(BAR);
    const clip = clipOf(cells, "copy", "L1", 2);
    const { after, insp } = paste(cells, clip, { lineId: "L2", idx: 13 });
    expect(pastedCount(clip, { lineId: "L2", idx: 13 }, dates)).toBe(2);
    expect(after.has(key("L2", D(13)))).toBe(true);
    expect(after.has(key("L2", D(14)))).toBe(true);
    expect(insp.droppedOutside).toEqual([{ lineId: "L2", date: addDays(D(14), 1), productId: "P1", memo: null }]);
    expect(insp.needsConfirm).toBe(true);
  });

  it("다른 호기: 허용되면 확인 없음, 허용되지 않으면 허용 안 됨 목록 (엔진 MOLD_NOT_ALLOWED 와 같은 판정)", () => {
    const cells = mapOf(block("L1", 0, 1, "P1"));
    const clip = clipOf(cells, "copy", "L1", 0);
    expect(paste(cells, clip, { lineId: "L2", idx: 0 }).insp.needsConfirm).toBe(false);
    const bad = paste(cells, clip, { lineId: "L3", idx: 5 });
    expect(bad.insp.notAllowed).toEqual([{ lineId: "L3", productId: "P1", dates: [D(5), D(6)] }]);
    const engine = recalc({ ...input, cells: [...bad.after.values()] });
    expect(engine.cells.find((r) => r.lineId === "L3" && r.date === D(5))?.violations).toContain("MOLD_NOT_ALLOWED");
  });

  it("기준정보에 없는 제품이어도 오류 없이 붙고, 엔진이 UNKNOWN_PRODUCT 로 표시한다", () => {
    const cells = mapOf(block("L1", 0, 1, "P-GONE"));
    const clip = clipOf(cells, "copy", "L1", 0);
    const { after, insp } = paste(cells, clip, { lineId: "L3", idx: 4 });
    expect(insp.notAllowed).toEqual([]); // 허용 판정은 기준정보에 있는 제품만 (엔진과 같음)
    const engine = recalc({ ...input, cells: [...after.values()] });
    expect(engine.cells.find((r) => r.lineId === "L3" && r.date === D(4))?.violations).toContain("UNKNOWN_PRODUCT");
  });

  it("두 번 붙여넣기: 두 번째도 복사한 때의 내용 그대로, 복사 기록은 남는다", () => {
    const cells = mapOf(BAR);
    const clip = clipOf(cells, "copy", "L1", 2);
    const once = paste(cells, clip, { lineId: "L2", idx: 0 }).after;
    const twice = paste(once, clip, { lineId: "L2", idx: 8 }).after;
    expect([0, 1, 2].map((i) => twice.get(key("L2", D(i)))?.qty)).toEqual([8, 9, 10].map((i) => twice.get(key("L2", D(i)))?.qty));
    expect(clipPastable(clip, twice, dates, REV)).toBe(true);
  });

  it("복사한 뒤 원래 막대를 고쳐도, 붙여넣으면 복사한 시점의 내용이 들어간다", () => {
    const cells = mapOf(BAR);
    const clip = clipOf(cells, "copy", "L1", 2);
    const edited = new Map(cells);
    edited.set(key("L1", D(3)), { ...BAR[1], qty: 1, memo: "고침" });
    const { after } = paste(edited, clip, { lineId: "L2", idx: 0 });
    expect(after.get(key("L2", D(1)))).toMatchObject({ qty: 100_000, memo: null });
    expect(sourceMatches(clip, edited, dates, REV)).toBe(false); // 원래 막대 표시는 사라진다
    expect(clipPastable(clip, edited, dates, REV)).toBe(true); // 복사는 그래도 붙여넣을 수 있다
  });
});

describe("잘라내기 붙여넣기 = 드래그 이동", () => {
  const scenarios: { name: string; cells: PlanCell[]; from: [string, number]; to: PasteTarget }[] = [
    { name: "같은 호기 빈 곳", cells: BAR, from: ["L1", 3], to: { lineId: "L1", idx: 9 } },
    { name: "다른 호기", cells: BAR, from: ["L1", 2], to: { lineId: "L2", idx: 6 } },
    { name: "허용되지 않는 호기", cells: BAR, from: ["L1", 2], to: { lineId: "L3", idx: 6 } },
    { name: "다른 막대 위", cells: [...BAR, ...block("L2", 6, 9, "P2"), c("L2", 10, null, { memo: "메모" })], from: ["L1", 4], to: { lineId: "L2", idx: 8 } },
    { name: "원래 자리와 겹치는 곳", cells: BAR, from: ["L1", 2], to: { lineId: "L1", idx: 3 } },
    { name: "원래 자리와 겹치는 곳(앞으로)", cells: BAR, from: ["L1", 4], to: { lineId: "L1", idx: 1 } },
    { name: "기간 끝을 넘김", cells: BAR, from: ["L1", 2], to: { lineId: "L2", idx: 13 } },
  ];
  for (const sc of scenarios) {
    it(`${sc.name}: 결과와 검사가 applyDragTo · inspectDrag 와 같다`, () => {
      const cells = mapOf(sc.cells);
      const clip = clipOf(cells, "cut", sc.from[0], sc.from[1]);
      const { after, insp } = paste(cells, clip, sc.to);
      const run = runAt(cells, sc.from[0], sc.from[1])!;
      // 막대 첫 칸을 잡고 붙여넣을 칸으로 옮긴 드래그
      const drag: Drag = { kind: "move", lineId: sc.from[0], ...run, grabIdx: run.startIdx, hoverIdx: sc.to.idx, hoverLineId: sc.to.lineId };
      const viaDrag = new Map(cells);
      applyDragTo(viaDrag, drag, dates);
      expect(snapshot(after)).toEqual(snapshot(viaDrag));
      expect(insp).toEqual(inspectDrag(cells, drag, dates, rules));
    });
  }

  it("필드는 드래그와 같다: 비가동 시간 직접 입력·교체 유형·주문 연결 유지, 자동 생성 칸은 「자동 생성 후 수정」", () => {
    const cells = mapOf(BAR);
    const { after } = paste(cells, clipOf(cells, "cut", "L1", 2), { lineId: "L2", idx: 7 });
    expect(after.get(key("L2", D(7)))).toMatchObject({ changeoverType: "FULL", lostHoursOverride: 6, orderId: "O1", origin: "manual", basis: `${EDITED_AUTO_PREFIX} · 10월 5주 Rev 1 과 동일` });
    expect(after.get(key("L2", D(8)))?.lostHoursOverride).toBe(2);
    for (const b of BAR) expect(after.has(key(b.lineId, b.date))).toBe(false); // 원래 막대는 비워진다
  });

  it("원래 자리에 붙여넣기: 아무 변화 없음", () => {
    const cells = mapOf(BAR);
    const { after, insp } = paste(cells, clipOf(cells, "cut", "L1", 3), { lineId: "L1", idx: 2 });
    expect(after.size).toBe(cells.size);
    expect(snapshot(after)).toEqual(snapshot(cells));
    expect(insp.needsConfirm).toBe(false);
  });

  it("원래 막대가 바뀌면 붙여넣을 수 없고, 되돌려 같아지면 다시 된다. 서버 값으로 같은 내용의 새 객체가 와도 유효", () => {
    const cells = mapOf(BAR);
    const clip = clipOf(cells, "cut", "L1", 2);
    expect(clipPastable(clip, cells, dates, REV)).toBe(true);
    const edited = new Map(cells);
    edited.set(key("L1", D(4)), { ...BAR[2], qty: 5 });
    expect(clipPastable(clip, edited, dates, REV)).toBe(false);
    const removed = new Map(cells);
    removed.delete(key("L1", D(3)));
    expect(clipPastable(clip, removed, dates, REV)).toBe(false);
    expect(clipPastable(clip, mapOf(BAR.map((b) => ({ ...b }))), dates, REV)).toBe(true);
    expect(clipPastable(clip, cells, dates, "R-other")).toBe(false);
  });

  it("다른 기간·Rev 로 옮기면 복사로 바뀐다 (복사는 그대로)", () => {
    const cells = mapOf(BAR);
    const cut = clipOf(cells, "cut", "L1", 2);
    expect(clipOnRevision(cut, REV)).toEqual({ clip: cut, converted: false });
    const moved = clipOnRevision(cut, "R-next");
    expect(moved.converted).toBe(true);
    expect(moved.clip.mode).toBe("copy");
    const copy = clipOf(cells, "copy", "L1", 2);
    expect(clipOnRevision(copy, "R-next").converted).toBe(false);
  });

  it("다른 기간에서 복사한 막대도 붙일 수 있다 (날짜는 붙여넣는 칸부터)", () => {
    const prevDates = dates.map((d) => addDays(d, -14));
    const prev = new Map(BAR.map((b, j) => [key("L1", prevDates[2 + j]), { ...b, date: prevDates[2 + j] }]));
    const clip = makeClip("copy", prev, prevDates, "L1", { startIdx: 2, endIdx: 4, productId: "P1" }, { revisionId: "R-prev", periodStart: prevDates[0], productName: "제품" });
    const { after } = paste(new Map(), clip, { lineId: "L1", idx: 0 });
    expect([...after.values()].map((x) => x.date)).toEqual([D(0), D(1), D(2)]);
  });
});

describe("되돌리기와 함께 (undo-history.ts)", () => {
  function act(d: UndoDoc<null>, clip: Clip, target: PasteTarget): UndoDoc<null> {
    const m = new Map(d.cells);
    applyPasteTo(m, clip, target, dates);
    return { cells: m, side: null, history: recordStep(d.history, d, { cells: m, side: null }) };
  }

  it("잘라내기 붙여넣기(원래 막대 비우기 + 새 자리)는 한 단계, 붙여넣기 → 되돌리기 → 다시 하기가 정확히 오간다", () => {
    let d: UndoDoc<null> = { cells: mapOf([...BAR, ...block("L2", 7, 8, "P2")]), side: null, history: emptyHistory() };
    const before = snapshot(d.cells);
    d = act(d, clipOf(d.cells, "cut", "L1", 2), { lineId: "L2", idx: 6 });
    const after = snapshot(d.cells);
    expect(d.history.past).toHaveLength(1);
    d = undoDoc(d)!.doc;
    expect(snapshot(d.cells)).toEqual(before);
    d = redoDoc(d)!.doc;
    expect(snapshot(d.cells)).toEqual(after);
  });

  it("복사는 되돌리기 뒤에도 다시 붙여넣을 수 있다", () => {
    let d: UndoDoc<null> = { cells: mapOf(BAR), side: null, history: emptyHistory() };
    const clip = clipOf(d.cells, "copy", "L1", 2);
    d = act(d, clip, { lineId: "L2", idx: 0 });
    const pasted = snapshot(d.cells);
    d = undoDoc(d)!.doc;
    expect(clipPastable(clip, d.cells, dates, REV)).toBe(true);
    d = act(d, clip, { lineId: "L2", idx: 0 });
    expect(snapshot(d.cells)).toEqual(pasted);
    expect(d.history.past).toHaveLength(1);
    expect(d.history.future).toHaveLength(0);
  });
});

describe("메뉴 항목", () => {
  const cells = mapOf(BAR);
  const copy = clipOf(cells, "copy", "L1", 2);
  const cut = clipOf(cells, "cut", "L1", 2);
  const view = (items: ReturnType<typeof menuItems>) => items.map((i) => `${i.label}${i.enabled ? "" : "(비활성)"}`);

  it("막대 칸: 복사 · 잘라내기 · 붙여넣기, 빈 칸(메모만 있는 칸 포함): 붙여넣기만", () => {
    expect(view(menuItems({ hasBar: true, clip: null, pastable: false }))).toEqual(["복사", "잘라내기", "붙여넣기(비활성)"]);
    expect(view(menuItems({ hasBar: false, clip: null, pastable: false }))).toEqual(["붙여넣기(비활성)"]);
  });
  it("복사한 것이 있으면 어디서든 「복사 취소」, 붙여넣기 활성", () => {
    expect(view(menuItems({ hasBar: true, clip: copy, pastable: true }))).toEqual(["복사", "잘라내기", "붙여넣기", "복사 취소"]);
    expect(view(menuItems({ hasBar: false, clip: copy, pastable: true }))).toEqual(["붙여넣기", "복사 취소"]);
  });
  it("비활성 이유 문구", () => {
    expect(menuItems({ hasBar: false, clip: null, pastable: false })[0].reason).toBe(REASON_NO_CLIP);
    expect(REASON_NO_CLIP).toBe("복사하거나 잘라낸 막대가 없습니다");
    const items = menuItems({ hasBar: false, clip: cut, pastable: false });
    expect(items[0]).toMatchObject({ label: "붙여넣기", enabled: false, reason: REASON_CUT_CHANGED });
    expect(REASON_CUT_CHANGED).toBe("잘라낸 원래 막대가 바뀌어 붙여넣을 수 없습니다. 복사 취소 후 다시 잘라내세요");
  });
  it("도구 줄 표시", () => {
    expect(clipLabel(copy, true)).toBe("복사됨 · 제품 3칸");
    expect(clipLabel(cut, true)).toBe("잘라냄 · 제품 3칸");
    expect(clipLabel(cut, false)).toBe("잘라냄 · 원래 막대가 바뀌어 붙여넣을 수 없습니다");
  });
  it("copiedCell 은 원래 칸 객체를 바꾸지 않는다", () => {
    const orig = { ...BAR[0] };
    copiedCell(BAR[0], "L2", D(0), true);
    expect(BAR[0]).toEqual(orig);
  });
});

describe("확인창 문구", () => {
  const insp = (o: number, dr: number, na: number): DragInspection => ({
    overwritten: Array.from({ length: o }, (_, i) => ({ lineId: "L1", date: D(i), productId: "P1", memo: null })),
    droppedOutside: Array.from({ length: dr }, (_, i) => ({ lineId: "L1", date: D(i), productId: "P1", memo: null })),
    notAllowed: Array.from({ length: na }, () => ({ lineId: "L3", productId: "P1", dates: [D(0)] })),
    needsConfirm: true,
  });

  it("드래그 문구(기본값)는 예전과 한 글자도 다르지 않다", () => {
    const i = insp(2, 3, 1);
    expect(dragConfirmText(i)).toEqual({
      title: "드래그 적용 전 확인",
      confirm: "덮어쓰고 옮기기",
      overwrittenTitle: "덮어써지는 칸 2개",
      overwrittenNote: "지금 들어 있는 내용이 바뀌거나 지워집니다.",
      droppedTitle: "기간 밖으로 나가 지워지는 칸 3개",
      droppedNote: "계획 기간(15일) 밖으로 밀려난 칸은 계획표에서 지워집니다.",
      notAllowedTail: "옮기면 「허용되지 않은 금형」 오류로 표시됩니다.",
    });
    for (const x of [insp(1, 0, 0), insp(0, 1, 0), insp(0, 0, 1), insp(1, 1, 1)]) expect(dragConfirmText(x).confirm).toBe(confirmLabel(x));
  });

  it("붙여넣기 문구: 제목·버튼, 복사는 기간 밖 칸을 붙이지 않는다는 안내, 잘라내기는 드래그와 같은 안내", () => {
    expect(pasteConfirmText(insp(1, 0, 0), "copy")).toMatchObject({ title: "붙여넣기 전 확인", confirm: "덮어쓰기" });
    expect(pasteConfirmLabel(insp(0, 1, 0))).toBe("그래도 붙여넣기");
    expect(pasteConfirmLabel(insp(1, 0, 1))).toBe("덮어쓰고 붙여넣기");
    expect(pasteConfirmText(insp(0, 2, 0), "copy").droppedTitle).toBe("기간 끝을 넘어 붙여넣지 않는 칸 2개");
    expect(pasteConfirmText(insp(0, 2, 0), "cut").droppedNote).toBe(dragConfirmText(insp(0, 2, 0)).droppedNote);
    expect(pasteConfirmText(insp(0, 0, 1), "copy").notAllowedTail).toBe("붙여넣으면 「허용되지 않은 금형」 오류로 표시됩니다.");
  });
});
