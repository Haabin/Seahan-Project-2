/**
 * 생산계획표 되돌리기·다시 하기 (components/gantt/undo-history.ts, cell-patch.ts).
 * - 한 번의 사용자 동작 = 한 단계. 되돌린 셀은 그 동작 이전과 완전히 같아야 한다(모든 필드, 메모만 있는 칸, 빈 칸 자리).
 * - 저장 충돌 감지(save-sync.ts)와 함께: 내 저장의 메아리로는 기록이 지워지지 않고, 다른 사람의 저장이 감지되면 지워진다.
 *   아래 Screen 은 plan-workspace.tsx 가 두 순수 모듈을 엮는 방식을 그대로 따라 한 시험용 화면이다.
 */
import { describe, expect, it } from "vitest";
import {
  canRedo,
  canUndo,
  clearHistory,
  diffCells,
  emptyHistory,
  HISTORY_LIMIT,
  historyOnEditable,
  historyOnServer,
  recordStep,
  redoDoc,
  shortcutAction,
  shortcutBlocked,
  undoDoc,
  type ShortcutContext,
  type ShortcutKey,
  type UndoDoc,
} from "@/components/gantt/undo-history";
import { patchCellInto, patchCellsInto } from "@/components/gantt/cell-patch";
import { cellMapKey as key, closeCellEdit, openCellEdit, patchCellEdit } from "@/components/gantt/cell-edit-session";
import { applyDragTo, type Drag } from "@/components/gantt/drag-plan";
import { canAutoSave, initSaveSync, reduceSaveSync, saveBadge, serverDecision, type SaveEvent, type SaveSync, type ServerDraft } from "@/components/gantt/save-sync";
import { addDays } from "@/lib/engine";
import { EDITED_AUTO_PREFIX, type PlanCell } from "@/lib/engine/types";
import type { DraftConflict } from "@/lib/plan/draft-save";

const START = "2026-11-26";
const dates = Array.from({ length: 15 }, (_, i) => addDays(START, i));
const D = (i: number) => dates[i];
const L1 = "line-1";
const L2 = "line-2";

function c(lineId: string, i: number, productId: string | null, extra: Partial<PlanCell> = {}): PlanCell {
  return { lineId, date: D(i), productId, qty: null, changeoverType: "NONE", memo: null, origin: "manual", ...extra };
}
const mapOf = (cells: PlanCell[]) => new Map(cells.map((x) => [key(x.lineId, x.date), x]));
const docOf = <S = null>(cells: PlanCell[], side: S = null as S): UndoDoc<S> => ({ cells: mapOf(cells), side, history: emptyHistory<S>() });
/** 칸 값을 (객체 동일성과 상관없이) 그대로 비교할 수 있게 정렬한 목록 */
const snapshot = (m: ReadonlyMap<string, PlanCell>) => [...m.entries()].sort(([a], [b]) => a.localeCompare(b));

/** 사용자 동작 하나 (plan-workspace 의 commit 과 같다) */
function act<S>(d: UndoDoc<S>, make: (m: Map<string, PlanCell>) => void, side: S = d.side): UndoDoc<S> {
  const m = new Map(d.cells);
  make(m);
  return { cells: m, side, history: recordStep(d.history, d, { cells: m, side }) };
}
const undo = <S>(d: UndoDoc<S>) => undoDoc(d)?.doc ?? d;
const redo = <S>(d: UndoDoc<S>) => redoDoc(d)?.doc ?? d;

// 모든 필드가 채워진 자동 생성 칸, 메모만 있는 칸
const FULL = c(L1, 2, "P1", { qty: 1200, changeoverType: "BM", memo: "주의", lostHoursOverride: 3, moldId: "M1", origin: "auto", basis: "10월 5주 Rev 1 과 동일", orderId: "O1" });
const MEMO_ONLY = c(L1, 5, null, { memo: "점검 예정" });

describe("기록 쌓기 · 되돌리기 · 다시 하기", () => {
  it("빈 기록에서 되돌리기·다시 하기는 아무 일도 하지 않는다", () => {
    const d = docOf([FULL]);
    expect(undoDoc(d)).toBeNull();
    expect(redoDoc(d)).toBeNull();
    expect(canUndo(d.history)).toBe(false);
    expect(canRedo(d.history)).toBe(false);
  });

  it("바뀐 것이 없는 동작은 기록하지 않는다 (같은 Map · 내용이 같은 새 객체)", () => {
    const d = docOf([FULL, MEMO_ONLY]);
    expect(recordStep(d.history, d, { cells: d.cells, side: null })).toBe(d.history);
    const copy = mapOf([{ ...FULL }, { ...MEMO_ONLY, lostHoursOverride: undefined }]);
    expect(recordStep(d.history, d, { cells: copy, side: null })).toBe(d.history);
    // 바뀐 것 없는 편집창 「완료」도 기록되지 않는다
    const r = closeCellEdit(d.cells, openCellEdit(d.cells, L1, D(2)), "done");
    expect(r.changed).toBe(false);
  });

  it("저장되는 필드 하나만 바뀌어도 바뀐 것으로 잡는다 (필드 누락 방지)", () => {
    const changes: Partial<PlanCell>[] = [
      { productId: "P2" },
      { qty: 1 },
      { changeoverType: "FULL" },
      { memo: "다름" },
      { lostHoursOverride: 4 },
      { moldId: "M2" },
      { origin: "manual" },
      { basis: "다름" },
      { orderId: "O2" },
    ];
    for (const ch of changes) {
      const diff = diffCells(mapOf([FULL]), mapOf([{ ...FULL, ...ch }]));
      expect(diff, JSON.stringify(ch)).toHaveLength(1);
    }
  });

  it("편집창 「완료」를 되돌리면 그 칸이 이전과 완전히 같다 (모든 필드, 같은 객체)", () => {
    let d = docOf([FULL, MEMO_ONLY]);
    const before = d.cells;
    const s = patchCellEdit(openCellEdit(d.cells, L1, D(2)), { productId: "P2", qty: 500, memo: null });
    const r = closeCellEdit(d.cells, s, "done");
    d = act(d, (m) => {
      m.clear();
      for (const [k, v] of r.cells) m.set(k, v);
    });
    expect(d.cells.get(key(L1, D(2)))?.basis?.startsWith(EDITED_AUTO_PREFIX)).toBe(true);
    d = undo(d);
    expect(d.cells.get(key(L1, D(2)))).toBe(FULL);
    expect(snapshot(d.cells)).toEqual(snapshot(before));
  });

  it("「빈 셀로」를 되돌리면 메모만 있는 칸과 빈 칸 자리가 정확히 돌아온다", () => {
    let d = docOf([FULL, MEMO_ONLY]);
    // 메모만 있는 칸을 비움 → 칸이 사라짐
    d = act(d, (m) => patchCellInto(m, L1, D(5), { productId: null, memo: null }, []));
    expect(d.cells.has(key(L1, D(5)))).toBe(false);
    // 빈 칸이었던 자리에 넣었다가
    d = act(d, (m) => patchCellInto(m, L1, D(9), { productId: "P1" }, []));
    expect(d.cells.has(key(L1, D(9)))).toBe(true);
    d = undo(d);
    expect(d.cells.has(key(L1, D(9)))).toBe(false);
    d = undo(d);
    expect(d.cells.get(key(L1, D(5)))).toBe(MEMO_ONLY);
  });

  it("드래그 한 번(여러 칸 이동)은 한 단계, 한 번에 되돌아간다", () => {
    const block = [0, 1, 2, 3].map((i) => c(L1, i, "P1", { origin: "auto", basis: "근거" }));
    const target = c(L2, 3, "P9", { memo: "덮어써질 칸" });
    let d = docOf([...block, target]);
    const before = snapshot(d.cells);
    const mv: Drag = { kind: "move", lineId: L1, startIdx: 0, endIdx: 3, productId: "P1", grabIdx: 1, hoverIdx: 2, hoverLineId: L2 };
    d = act(d, (m) => applyDragTo(m, mv, dates));
    expect(d.history.past).toHaveLength(1);
    d = undo(d);
    expect(snapshot(d.cells)).toEqual(before);
    d = redo(d);
    expect(d.cells.get(key(L2, D(1)))?.productId).toBe("P1");
  });

  it("끝 늘리기·줄이기도 각각 한 단계", () => {
    let d = docOf([0, 1, 2].map((i) => c(L1, i, "P1", { memo: "m" })));
    const before = snapshot(d.cells);
    const grow: Drag = { kind: "resize", lineId: L1, startIdx: 0, endIdx: 2, productId: "P1", hoverIdx: 6 };
    d = act(d, (m) => applyDragTo(m, grow, dates));
    const grown = snapshot(d.cells);
    const shrink: Drag = { kind: "resize", lineId: L1, startIdx: 0, endIdx: 6, productId: "P1", hoverIdx: 1 };
    d = act(d, (m) => applyDragTo(m, shrink, dates));
    expect(d.cells.size).toBe(2);
    d = undo(d);
    expect(snapshot(d.cells)).toEqual(grown);
    d = undo(d);
    expect(snapshot(d.cells)).toEqual(before);
  });

  it("되돌린 뒤 새로 수정하면 다시 하기 기록이 사라진다", () => {
    let d = docOf([FULL]);
    d = act(d, (m) => patchCellInto(m, L1, D(2), { qty: 1 }, []));
    d = act(d, (m) => patchCellInto(m, L1, D(2), { qty: 2 }, []));
    d = undo(d);
    expect(canRedo(d.history)).toBe(true);
    d = act(d, (m) => patchCellInto(m, L1, D(2), { qty: 3 }, []));
    expect(canRedo(d.history)).toBe(false);
    expect(d.history.past).toHaveLength(2);
  });

  it(`상한(${HISTORY_LIMIT}단계)을 넘으면 오래된 것부터 버린다`, () => {
    let d = docOf([c(L1, 0, "P1", { qty: 0 })]);
    for (let i = 1; i <= HISTORY_LIMIT + 1; i++) d = act(d, (m) => patchCellInto(m, L1, D(0), { qty: i }, []));
    expect(d.history.past).toHaveLength(HISTORY_LIMIT);
    for (let i = 0; i < HISTORY_LIMIT; i++) d = undo(d);
    // 첫 단계(0 → 1)는 버려졌으므로 1 까지만 돌아간다
    expect(d.cells.get(key(L1, D(0)))?.qty).toBe(1);
    expect(undoDoc(d)).toBeNull();
  });

  it("연속 되돌리기 뒤 연속 다시 하기로 원래 상태가 된다", () => {
    let d = docOf([FULL, MEMO_ONLY]);
    const start = snapshot(d.cells);
    d = act(d, (m) => patchCellInto(m, L1, D(2), { qty: 10 }, []));
    d = act(d, (m) => patchCellInto(m, L1, D(5), { productId: null, memo: null }, []));
    d = act(d, (m) => applyDragTo(m, { kind: "resize", lineId: L1, startIdx: 2, endIdx: 2, productId: "P1", hoverIdx: 4 }, dates));
    const end = snapshot(d.cells);
    d = undo(undo(undo(d)));
    expect(snapshot(d.cells)).toEqual(start);
    d = redo(redo(redo(d)));
    expect(snapshot(d.cells)).toEqual(end);
    expect(canRedo(d.history)).toBe(false);
  });
});

describe("셀과 함께 움직이는 상태 (초안 자동 생성의 확인 필요 목록)", () => {
  it("자동 생성 적용을 되돌리면 목록도 이전으로, 다시 하기면 그 결과가 돌아온다", () => {
    let d = docOf<string | null>([c(L1, 0, "P1")], null);
    d = act(d, (m) => m.set(key(L1, D(1)), c(L1, 1, "P2", { origin: "auto" })), "result-A");
    d = act(d, (m) => patchCellInto(m, L1, D(1), { qty: 5 }, [])); // 셀만 바꾸는 단계는 목록을 건드리지 않는다
    expect(d.history.past[1].side).toBeUndefined();
    d = undo(d);
    expect(d.side).toBe("result-A");
    d = undo(d);
    expect(d.side).toBeNull();
    expect(d.cells.has(key(L1, D(1)))).toBe(false);
    d = redo(d);
    expect(d.side).toBe("result-A");
  });

  it("「자동 생성 셀 지우기」를 되돌리면 셀과 목록이 함께 돌아온다", () => {
    const auto = c(L1, 1, "P2", { origin: "auto" });
    let d = docOf<string | null>([c(L1, 0, "P1"), auto], "result-A");
    d = act(d, (m) => m.delete(key(L1, D(1))), null);
    d = undo(d);
    expect(d.side).toBe("result-A");
    expect(d.cells.get(key(L1, D(1)))).toBe(auto);
  });
});

describe("품번별 표: 여러 칸 수정 (cell-patch.ts)", () => {
  const molds = [
    { id: "M-A", productIds: ["P1"] },
    { id: "M-B", productIds: ["P1"] },
    { id: "M-C", productIds: ["P2"] },
  ];

  it("칸 목록으로 한 번에 적용해도 칸마다 하나씩 적용한 것과 결과가 같다", () => {
    const cells = [c(L1, 0, "P1", { origin: "auto", basis: "근거" }), c(L1, 1, "P1"), c(L1, 2, "P1", { origin: "auto", basis: null })];
    const targets = cells.map((x) => ({ lineId: x.lineId, date: x.date }));
    const one = mapOf(cells);
    targets.forEach((t) => patchCellInto(one, t.lineId, t.date, { moldId: "M-B" }, molds));
    const many = mapOf(cells);
    patchCellsInto(many, targets, { moldId: "M-B" }, molds);
    expect(snapshot(many)).toEqual(snapshot(one));
    expect(many.get(key(L1, D(0)))?.basis).toBe(`${EDITED_AUTO_PREFIX} · 근거`);
    expect(many.get(key(L1, D(2)))?.basis).toBe(`${EDITED_AUTO_PREFIX} · `);
    expect([...many.values()].every((x) => x.origin === "manual" && x.moldId === "M-B")).toBe(true);
  });

  it("칸마다 규칙: 제품이 바뀌면 금형 다시 고르기, 제품을 비우면 빈 칸 정리", () => {
    const m = mapOf([c(L1, 0, "P1", { moldId: "M-A", qty: 9 }), c(L1, 1, "P1", { moldId: "M-A", memo: "남는 메모" })]);
    patchCellsInto(m, [{ lineId: L1, date: D(0) }], { productId: "P2" }, molds);
    expect(m.get(key(L1, D(0)))?.moldId).toBe("M-C"); // P2 금형이 하나뿐 → 자동
    patchCellsInto(m, [{ lineId: L1, date: D(0) }, { lineId: L1, date: D(1) }], { productId: null }, molds);
    expect(m.has(key(L1, D(0)))).toBe(false); // 메모도 없으면 칸이 사라진다
    expect(m.get(key(L1, D(1)))).toMatchObject({ productId: null, qty: null, changeoverType: "NONE", moldId: null, memo: "남는 메모" });
  });

  it("금형을 한 번 바꾼 것은 한 단계로 기록되고, 한 번에 되돌아간다", () => {
    const cells = [0, 1, 2, 3].map((i) => c(L1, i, "P1", { moldId: "M-A" }));
    let d = docOf(cells);
    const before = snapshot(d.cells);
    d = act(d, (m) => patchCellsInto(m, cells.map((x) => ({ lineId: x.lineId, date: x.date })), { moldId: "M-B" }, molds));
    expect(d.history.past).toHaveLength(1);
    expect(d.history.past[0].changes).toHaveLength(4);
    d = undo(d);
    expect(snapshot(d.cells)).toEqual(before);
    expect(canUndo(d.history)).toBe(false);
  });
});

// ---- 저장 충돌 감지와 함께 ----

const OTHER = "user-other";
const server = (over: Partial<ServerDraft> = {}): ServerDraft => ({ revisionId: "R1", version: 4, status: "draft", updatedAt: null, updatedBy: null, saveToken: null, ...over });
const conflict = (over: Partial<DraftConflict> = {}): DraftConflict => ({ kind: "conflict", version: 9, updatedAt: null, updatedBy: OTHER, updatedByName: null, revNo: null, ...over });

/** plan-workspace 가 셀·기록과 저장 상태를 엮는 방식 그대로 */
class Screen {
  doc: UndoDoc<null>;
  sync: SaveSync;
  editable = true;
  constructor(cells: PlanCell[]) {
    this.doc = docOf(cells);
    this.sync = initSaveSync(server(), "T0");
  }
  private dispatch(e: SaveEvent) {
    this.sync = reduceSaveSync(this.sync, e);
  }
  edit(make: (m: Map<string, PlanCell>) => void) {
    this.doc = act(this.doc, make);
    this.dispatch({ type: "edit" });
  }
  /** Ctrl+Z / 버튼: 할 것이 있을 때만 셀을 바꾸고 edit */
  undo(): boolean {
    const out = undoDoc(this.doc);
    if (!this.editable || !out) return false;
    this.doc = out.doc;
    this.dispatch({ type: "edit" });
    return true;
  }
  saveStart() {
    this.dispatch({ type: "saveStart" });
  }
  saveOk(version: number) {
    this.dispatch({ type: "saveOk", version, nextToken: `T${version}` });
  }
  saveRejected(cf: DraftConflict) {
    this.dispatch({ type: "saveRejected", conflict: cf });
    this.doc = { ...this.doc, history: clearHistory(this.doc.history) };
  }
  /** 서버 값이 내려옴 (router.refresh · revalidatePath) */
  serverArrives(sv: ServerDraft, cells: PlanCell[] = [...this.doc.cells.values()]) {
    const adopt = serverDecision(this.sync, sv) === "adopt";
    const history = historyOnServer(this.doc.history, this.sync, sv);
    this.doc = { ...this.doc, cells: adopt ? mapOf(cells) : this.doc.cells, history };
    this.dispatch({ type: "server", server: sv, nextToken: "N" });
  }
}

describe("저장 충돌 감지와 함께", () => {
  const base = () => new Screen([c(L1, 0, "P1", { qty: 1 })]);
  const setQty = (q: number) => (m: Map<string, PlanCell>) => patchCellInto(m, L1, D(0), { qty: q }, []);

  it("자동 저장이 끝나고 같은 version 의 서버 값(내 저장의 메아리)이 돌아온 뒤에도 그 전 수정을 되돌릴 수 있다", () => {
    const s = base();
    s.edit(setQty(2));
    s.saveStart();
    s.serverArrives(server({ version: 5 })); // 저장 중 도착 → keep
    s.saveOk(5);
    s.serverArrives(server({ version: 5 })); // 저장 뒤 도착 → 같은 내용으로 adopt
    expect(canUndo(s.doc.history)).toBe(true);
    expect(s.undo()).toBe(true);
    expect(s.doc.cells.get(key(L1, D(0)))?.qty).toBe(1);
    expect(canAutoSave(s.sync)).toBe(true); // 되돌린 결과도 저장된다
  });

  it("되돌린 직후 다른 사람의 저장이 감지되면(version 증가) 기록이 비워지고, 그 뒤 Ctrl+Z 는 아무 일도 하지 않는다", () => {
    const s = base();
    s.edit(setQty(2));
    s.edit(setQty(3));
    s.undo();
    s.serverArrives(server({ version: 7, updatedBy: OTHER })); // dirty 상태에서 감지 → 충돌
    expect(saveBadge(s.sync)).toBe("conflict");
    expect(canUndo(s.doc.history)).toBe(false);
    expect(canRedo(s.doc.history)).toBe(false);
    const cellsBefore = s.doc.cells;
    expect(s.undo()).toBe(false);
    expect(s.doc.cells).toBe(cellsBefore);
  });

  it("저장하지 않은 수정이 없을 때 다른 사람의 저장을 받으면(adopt) 기록이 비워진다", () => {
    const s = base();
    s.edit(setQty(2));
    s.saveStart();
    s.saveOk(5);
    s.serverArrives(server({ version: 8, updatedBy: OTHER }), [c(L1, 0, "P1", { qty: 99 })]);
    expect(s.doc.cells.get(key(L1, D(0)))?.qty).toBe(99);
    expect(canUndo(s.doc.history)).toBe(false);
  });

  it("저장이 거부되면(충돌) 기록이 비워진다", () => {
    const s = base();
    s.edit(setQty(2));
    s.saveStart();
    s.saveRejected(conflict());
    expect(canUndo(s.doc.history)).toBe(false);
  });

  it("충돌 상태에서 되돌리기: 충돌 상태가 유지되고 자동 저장은 나가지 않는다", () => {
    const s = base();
    s.edit(setQty(2));
    s.saveStart();
    s.saveRejected(conflict());
    s.edit(setQty(5)); // 충돌 뒤의 수정은 기록된다
    expect(s.undo()).toBe(true);
    expect(s.doc.cells.get(key(L1, D(0)))?.qty).toBe(2);
    expect(s.sync.phase).toBe("conflict");
    expect(saveBadge(s.sync)).toBe("conflict");
    expect(canAutoSave(s.sync)).toBe(false);
  });

  it("저장 중에 되돌리면 저장이 끝난 뒤 다시 저장한다 (저장 중 수정과 같은 규칙), 나 자신과 충돌하지 않는다", () => {
    const s = base();
    s.edit(setQty(2));
    s.saveStart();
    s.undo();
    expect(s.sync.editedDuringSave).toBe(true);
    s.serverArrives(server({ version: 5 })); // 저장 중 도착 → keep, 기록 유지
    expect(canRedo(s.doc.history)).toBe(true);
    s.saveOk(5);
    expect(s.sync.dirty).toBe(true);
    expect(canAutoSave(s.sync)).toBe(true);
    expect(s.sync.base.version).toBe(5); // 다음 저장은 내 저장이 돌려준 version 기준
    s.serverArrives(server({ version: 5 })); // 메아리, 아직 저장 안 된 되돌리기가 있어 내 화면을 지킨다
    expect(s.doc.cells.get(key(L1, D(0)))?.qty).toBe(1);
    expect(s.sync.phase).not.toBe("conflict");
  });

  it("historyOnServer: Rev 이동 · 불러오기 · 확정은 비우고, 메아리 · 오래된 값 · 저장 중 · rebase 는 그대로", () => {
    const h = recordStep(emptyHistory<null>(), { cells: mapOf([]), side: null }, { cells: mapOf([c(L1, 0, "P1")]), side: null });
    const clean = initSaveSync(server(), "T0");
    const dirty = reduceSaveSync(clean, { type: "edit" });
    expect(historyOnServer(h, clean, server({ revisionId: "R2" }))).not.toBe(h);
    expect(historyOnServer(h, dirty, server({ revisionId: "R2" }))).not.toBe(h);
    expect(historyOnServer(h, reduceSaveSync(dirty, { type: "reloadRequested" }), server())).not.toBe(h);
    expect(historyOnServer(h, clean, server({ status: "confirmed" }))).not.toBe(h);
    expect(historyOnServer(h, clean, server())).toBe(h); // 같은 version (가동 불가 등록 뒤 새로 읽기 등)
    expect(historyOnServer(h, clean, server({ version: 3 }))).toBe(h);
    expect(historyOnServer(h, reduceSaveSync(dirty, { type: "saveStart" }), server({ version: 9 }))).toBe(h);
    const lost = reduceSaveSync(reduceSaveSync(dirty, { type: "saveStart" }), { type: "saveError", message: "x" });
    expect(historyOnServer(h, lost, server({ version: 5, saveToken: "T0" }))).toBe(h); // 결과를 못 받은 내 저장
  });

  it("화면이 읽기 전용이 되면 비운다", () => {
    const h = recordStep(emptyHistory<null>(), { cells: mapOf([]), side: null }, { cells: mapOf([c(L1, 0, "P1")]), side: null });
    expect(historyOnEditable(h, true)).toBe(h);
    expect(canUndo(historyOnEditable(h, false))).toBe(false);
    const empty = emptyHistory<null>();
    expect(clearHistory(empty)).toBe(empty); // 이미 비어 있으면 같은 객체 (다시 그리지 않음)
  });
});

describe("단축키", () => {
  const k = (over: Partial<ShortcutKey>): ShortcutKey => ({ key: "z", code: "KeyZ", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, ...over });
  it("Ctrl/⌘+Z 되돌리기, Ctrl/⌘+Y · Ctrl/⌘+Shift+Z 다시 하기", () => {
    expect(shortcutAction(k({}))).toBe("undo");
    expect(shortcutAction(k({ ctrlKey: false, metaKey: true }))).toBe("undo");
    expect(shortcutAction(k({ key: "Z", shiftKey: true }))).toBe("redo");
    expect(shortcutAction(k({ ctrlKey: false, metaKey: true, key: "Z", shiftKey: true }))).toBe("redo");
    expect(shortcutAction(k({ key: "y", code: "KeyY" }))).toBe("redo");
  });
  it("한글 입력 상태(key 가 'ㅋ')도 code 로 알아본다, 수정키 없음 · Alt 는 무시", () => {
    expect(shortcutAction(k({ key: "ㅋ" }))).toBe("undo");
    expect(shortcutAction(k({ key: "ㅛ", code: "KeyY" }))).toBe("redo");
    expect(shortcutAction(k({ ctrlKey: false }))).toBeNull();
    expect(shortcutAction(k({ altKey: true }))).toBeNull();
    expect(shortcutAction(k({ key: "x", code: "KeyX" }))).toBeNull();
  });
  it("입력 칸 · 한글 조합 중 · 창 · 읽기 전용이면 가로채지 않는다", () => {
    const ctx = (over: Partial<ShortcutContext>): ShortcutContext => ({ editable: true, isComposing: false, targetTag: "BODY", targetEditable: false, targetRole: null, overlayOpen: false, ...over });
    expect(shortcutBlocked(ctx({}))).toBe(false);
    expect(shortcutBlocked(ctx({ targetTag: "BUTTON" }))).toBe(false);
    for (const tag of ["INPUT", "TEXTAREA", "SELECT", "input"]) expect(shortcutBlocked(ctx({ targetTag: tag }))).toBe(true);
    expect(shortcutBlocked(ctx({ targetEditable: true }))).toBe(true);
    expect(shortcutBlocked(ctx({ targetTag: "DIV", targetRole: "combobox" }))).toBe(true);
    expect(shortcutBlocked(ctx({ isComposing: true }))).toBe(true);
    expect(shortcutBlocked(ctx({ overlayOpen: true }))).toBe(true);
    expect(shortcutBlocked(ctx({ editable: false }))).toBe(true);
  });
});
