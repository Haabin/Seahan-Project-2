import type { PlanCell } from "@/lib/engine/types";
import { serverDecision, type SaveSync, type ServerDraft } from "@/components/gantt/save-sync";

/**
 * 생산계획표 되돌리기·다시 하기 기록. 순수 함수 (React·DB 없음).
 *
 * - 한 번의 사용자 동작 = 한 단계. 단계에는 바뀐 칸만 담는다(이전·이후 칸 객체를 복사하지 않고 그대로).
 *   빈 칸(Map 에 없음)은 null 로 담아 되돌릴 때 지운다.
 * - side 는 셀과 함께 움직여야 하는 화면 상태(초안 자동 생성의 "확인 필요" 목록). 바뀐 단계에만 담는다.
 * - 기록은 화면에만 있고 저장하지 않는다. 상한(HISTORY_LIMIT)을 넘으면 오래된 것부터 버린다.
 * - 서버 값으로 화면이 다시 맞춰지거나 다른 사람의 저장이 감지되면 기록을 비운다(historyOnServer):
 *   그 이전으로 되돌리면 다른 사람의 저장을 조용히 지우게 되기 때문이다.
 */

export const HISTORY_LIMIT = 50;

export interface CellChange {
  key: string;
  before: PlanCell | null;
  after: PlanCell | null;
}

export interface UndoStep<S> {
  changes: CellChange[];
  side?: { before: S; after: S };
}

export interface UndoHistory<S> {
  /** 되돌릴 단계 (마지막이 가장 최근) */
  past: UndoStep<S>[];
  /** 다시 할 단계 (마지막이 가장 먼저 다시 할 것) */
  future: UndoStep<S>[];
}

/** 화면의 계획 상태: 셀 + 셀과 함께 움직이는 화면 상태 + 기록 */
export interface UndoDoc<S> {
  cells: Map<string, PlanCell>;
  side: S;
  history: UndoHistory<S>;
}

export function emptyHistory<S>(): UndoHistory<S> {
  return { past: [], future: [] };
}

export const canUndo = <S>(h: UndoHistory<S>) => h.past.length > 0;
export const canRedo = <S>(h: UndoHistory<S>) => h.future.length > 0;

/** 기록 비우기. 이미 비어 있으면 같은 객체(다시 그리지 않게) */
export function clearHistory<S>(h: UndoHistory<S>): UndoHistory<S> {
  return h.past.length === 0 && h.future.length === 0 ? h : emptyHistory<S>();
}

/** 칸 값이 같은가. 저장되는 모든 필드를 본다 (없음과 null 은 같게 본다) */
export function sameCellValue(a: PlanCell, b: PlanCell): boolean {
  return (
    a.lineId === b.lineId &&
    a.date === b.date &&
    a.productId === b.productId &&
    a.qty === b.qty &&
    a.changeoverType === b.changeoverType &&
    (a.memo ?? null) === (b.memo ?? null) &&
    (a.lostHoursOverride ?? null) === (b.lostHoursOverride ?? null) &&
    (a.moldId ?? null) === (b.moldId ?? null) &&
    (a.origin ?? null) === (b.origin ?? null) &&
    (a.basis ?? null) === (b.basis ?? null) &&
    (a.orderId ?? null) === (b.orderId ?? null)
  );
}

/** 두 셀 맵에서 바뀐 칸만 고른다 */
export function diffCells(prev: ReadonlyMap<string, PlanCell>, next: ReadonlyMap<string, PlanCell>): CellChange[] {
  if (prev === next) return [];
  const out: CellChange[] = [];
  const keys = new Set([...prev.keys(), ...next.keys()]);
  for (const k of keys) {
    const a = prev.get(k) ?? null;
    const b = next.get(k) ?? null;
    if (a === b) continue;
    if (a && b && sameCellValue(a, b)) continue;
    out.push({ key: k, before: a, after: b });
  }
  return out;
}

/**
 * 사용자 동작 하나를 기록한다. 바뀐 것이 없으면 받은 기록을 그대로 돌려준다.
 * 새 단계를 쌓으면 다시 하기 기록은 사라지고, 상한을 넘으면 오래된 것부터 버린다.
 */
export function recordStep<S>(
  h: UndoHistory<S>,
  prev: { cells: ReadonlyMap<string, PlanCell>; side: S },
  next: { cells: ReadonlyMap<string, PlanCell>; side: S },
  limit = HISTORY_LIMIT,
): UndoHistory<S> {
  const changes = diffCells(prev.cells, next.cells);
  const sideChanged = prev.side !== next.side;
  if (changes.length === 0 && !sideChanged) return h;
  const step: UndoStep<S> = sideChanged ? { changes, side: { before: prev.side, after: next.side } } : { changes };
  const past = [...h.past, step];
  return { past: past.length > limit ? past.slice(past.length - limit) : past, future: [] };
}

/** 기록에 따라 셀과 함께 움직이는 상태까지 바꾼 doc 과 바뀐 칸 수. 할 것이 없으면 null */
export interface UndoOutcome<S> {
  doc: UndoDoc<S>;
  changedCells: number;
}

function applyChanges(cells: ReadonlyMap<string, PlanCell>, changes: CellChange[], dir: "undo" | "redo"): Map<string, PlanCell> {
  const m = new Map(cells);
  for (const c of changes) {
    const v = dir === "undo" ? c.before : c.after;
    if (v) m.set(c.key, v);
    else m.delete(c.key);
  }
  return m;
}

export function undoDoc<S>(doc: UndoDoc<S>): UndoOutcome<S> | null {
  const step = doc.history.past.at(-1);
  if (!step) return null;
  return {
    doc: {
      cells: step.changes.length ? applyChanges(doc.cells, step.changes, "undo") : doc.cells,
      side: step.side ? step.side.before : doc.side,
      history: { past: doc.history.past.slice(0, -1), future: [...doc.history.future, step] },
    },
    changedCells: step.changes.length,
  };
}

export function redoDoc<S>(doc: UndoDoc<S>): UndoOutcome<S> | null {
  const step = doc.history.future.at(-1);
  if (!step) return null;
  return {
    doc: {
      cells: step.changes.length ? applyChanges(doc.cells, step.changes, "redo") : doc.cells,
      side: step.side ? step.side.after : doc.side,
      history: { past: [...doc.history.past, step], future: doc.history.future.slice(0, -1) },
    },
    changedCells: step.changes.length,
  };
}

/**
 * 서버 값이 새로 내려왔을 때 기록을 어떻게 할지. sync 는 이 서버 값을 반영하기 "전" 상태.
 *  - 화면을 서버 값으로 바꾸는데(adopt) Rev 가 바뀌었거나, 「최신 내용 불러오기」였거나, version 이 달라졌거나(다른 사람·다른 경로),
 *    확정됐으면 → 비운다
 *  - 다른 사람의 저장이 감지돼 충돌로 멈추면(conflict) → 비운다. 그 뒤의 수정은 다시 쌓인다
 *  - 내 저장의 메아리(같은 Rev·같은 version), 저장 중에 온 값(keep), 내 직전 저장을 알아본 경우(rebase) → 그대로
 */
export function historyOnServer<S>(h: UndoHistory<S>, sync: SaveSync, server: ServerDraft): UndoHistory<S> {
  const d = serverDecision(sync, server);
  if (d === "conflict") return clearHistory(h);
  if (d !== "adopt") return h;
  const replaced =
    sync.reloadRequested || server.revisionId !== sync.base.revisionId || server.version !== sync.base.version || server.status === "confirmed";
  return replaced ? clearHistory(h) : h;
}

/** 화면이 읽기 전용이 되면 비운다 */
export function historyOnEditable<S>(h: UndoHistory<S>, editable: boolean): UndoHistory<S> {
  return editable ? h : clearHistory(h);
}

// ---- 단축키 ----

export interface ShortcutKey {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Ctrl/⌘+Z = 되돌리기, Ctrl/⌘+Y · Ctrl/⌘+Shift+Z = 다시 하기. 한글 입력 상태에서는 key 가 'ㅋ' 등이라 code 도 본다 */
export function shortcutAction(e: ShortcutKey): "undo" | "redo" | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const k = e.key.toLowerCase();
  const isZ = k === "z" || e.code === "KeyZ";
  const isY = k === "y" || e.code === "KeyY";
  if (isZ) return e.shiftKey ? "redo" : "undo";
  if (isY && !e.shiftKey) return "redo";
  return null;
}

export interface ShortcutContext {
  editable: boolean;
  /** 한글 등 입력 조합 중 */
  isComposing: boolean;
  /** 포커스가 있는 요소 */
  targetTag: string | null;
  targetEditable: boolean;
  targetRole: string | null;
  /** 셀 편집창 · 확인창 · 다른 창이 열려 있거나 드래그 중 */
  overlayOpen: boolean;
}

/** 계획표 되돌리기가 단축키를 가로채면 안 되는가 (입력 칸 · 조합 중 · 창 · 읽기 전용) */
export function shortcutBlocked(c: ShortcutContext): boolean {
  if (!c.editable || c.overlayOpen || c.isComposing) return true;
  const tag = (c.targetTag ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (c.targetEditable) return true;
  return c.targetRole === "combobox" || c.targetRole === "textbox" || c.targetRole === "searchbox";
}
