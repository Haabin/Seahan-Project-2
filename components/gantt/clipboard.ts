import type { PlanCell } from "@/lib/engine/types";
import { addDays } from "@/lib/engine";
import { cellMapKey as key } from "@/components/gantt/cell-edit-session";
import { applyDragTo, hasContent, inspectDrag, isNotAllowed, toAffected, type AffectedCell, type AllowRules, type Drag, type DragInspection } from "@/components/gantt/drag-plan";
import { sameCellValue } from "@/components/gantt/undo-history";

/**
 * 생산계획표 복사·잘라내기·붙여넣기 (마우스 오른쪽 버튼 메뉴). 순수 함수 (React·DB 없음).
 *
 * - 복사 단위는 막대(같은 호기에서 같은 제품이 이어지는 구간, plan-workspace 의 runAt). 메모만 있는 칸은 복사하지 않는다.
 * - 복사 기록은 복사한 시점의 칸(스냅숏)을 담는다. 화면에만 있고 저장하지 않으며, 되돌리기 기록에도 넣지 않는다.
 * - 복사 붙여넣기: 새 칸은 사람이 넣은 칸(manual). 첫 칸 교체 유형은 NONE(붙여넣은 자리의 앞 칸을 보고 엔진이 정한다),
 *   주문 연결·근거는 비운다. 비가동 시간 직접 입력 등 나머지는 그대로. 원래 막대는 그대로.
 * - 잘라내기 붙여넣기: 원래 막대를 그 자리로 "드래그 이동"한 것과 완전히 같다(applyDragTo · inspectDrag 를 그대로 쓴다).
 *   원래 자리의 칸이 잘라낸 때와 모두 같을 때만 붙여넣을 수 있다.
 */

export interface ClipSource {
  revisionId: string;
  periodStart: string;
  lineId: string;
  startIdx: number;
  endIdx: number;
  productId: string;
}

export interface Clip {
  mode: "copy" | "cut";
  /** 막대 첫 칸부터 순서대로, 복사한 시점 그대로 */
  cells: PlanCell[];
  source: ClipSource;
  productName: string;
}

export interface BarRun {
  startIdx: number;
  endIdx: number;
  productId: string;
}

export interface PasteTarget {
  lineId: string;
  idx: number;
}

/** 막대(run)를 복사 기록으로 만든다 */
export function makeClip(
  mode: "copy" | "cut",
  cells: ReadonlyMap<string, PlanCell>,
  dates: string[],
  lineId: string,
  run: BarRun,
  meta: { revisionId: string; periodStart: string; productName: string },
): Clip {
  const out: PlanCell[] = [];
  for (let i = run.startIdx; i <= run.endIdx; i++) {
    const c = cells.get(key(lineId, dates[i]));
    if (c) out.push(c);
  }
  return {
    mode,
    cells: out,
    source: { revisionId: meta.revisionId, periodStart: meta.periodStart, lineId, startIdx: run.startIdx, endIdx: run.endIdx, productId: run.productId },
    productName: meta.productName,
  };
}

/** 지금 화면(이 Rev)의 원래 자리 칸이 복사한 때와 모두 같은가 */
export function sourceMatches(clip: Clip, cells: ReadonlyMap<string, PlanCell>, dates: string[], revisionId: string): boolean {
  const s = clip.source;
  if (s.revisionId !== revisionId || s.endIdx >= dates.length) return false;
  if (clip.cells.length !== s.endIdx - s.startIdx + 1) return false;
  for (let j = 0; j < clip.cells.length; j++) {
    const cur = cells.get(key(s.lineId, dates[s.startIdx + j]));
    if (!cur || !sameCellValue(cur, clip.cells[j])) return false;
  }
  return true;
}

/** 잘라내기를 아직 붙여넣을 수 있는가 (복사는 언제나 true) */
export function clipPastable(clip: Clip, cells: ReadonlyMap<string, PlanCell>, dates: string[], revisionId: string): boolean {
  return clip.mode === "copy" || sourceMatches(clip, cells, dates, revisionId);
}

/** 다른 기간·Rev 로 옮겼을 때: 잘라내기는 원래 칸이 다른 Rev 에 있으므로 복사로 바꾼다 */
export function clipOnRevision(clip: Clip, revisionId: string): { clip: Clip; converted: boolean } {
  if (clip.mode === "cut" && clip.source.revisionId !== revisionId) return { clip: { ...clip, mode: "copy" }, converted: true };
  return { clip, converted: false };
}

/** 잘라내기 붙여넣기 = 원래 막대를 붙여넣을 칸으로 옮기는 드래그 */
export function cutAsDrag(clip: Clip, target: PasteTarget): Drag {
  const s = clip.source;
  return { kind: "move", lineId: s.lineId, startIdx: s.startIdx, endIdx: s.endIdx, productId: s.productId, grabIdx: s.startIdx, hoverIdx: target.idx, hoverLineId: target.lineId };
}

/** 복사본 한 칸 */
export function copiedCell(c: PlanCell, lineId: string, date: string, first: boolean): PlanCell {
  return {
    ...c,
    lineId,
    date,
    changeoverType: first ? "NONE" : c.changeoverType,
    origin: "manual",
    basis: null,
    orderId: null,
  };
}

/** 붙여넣기를 셀 맵에 적용한다 (m 을 직접 바꾼다) */
export function applyPasteTo(m: Map<string, PlanCell>, clip: Clip, target: PasteTarget, dates: string[]): void {
  if (clip.mode === "cut") {
    applyDragTo(m, cutAsDrag(clip, target), dates);
    return;
  }
  clip.cells.forEach((c, j) => {
    const ni = target.idx + j;
    if (ni >= dates.length) return;
    m.set(key(target.lineId, dates[ni]), copiedCell(c, target.lineId, dates[ni], j === 0));
  });
}

/** 기간 안에 들어가는 칸 수 */
export function pastedCount(clip: Clip, target: PasteTarget, dates: string[]): number {
  return Math.max(0, Math.min(clip.cells.length, dates.length - target.idx));
}

/** 붙여넣기 전 검사: 덮어써지는 칸 · 기간 밖 · 허용되지 않는 호기. 잘라내기는 드래그 검사 그대로 */
export function inspectPaste(cells: Map<string, PlanCell>, clip: Clip, target: PasteTarget, dates: string[], rules: AllowRules): DragInspection {
  if (clip.mode === "cut") return inspectDrag(cells, cutAsDrag(clip, target), dates, rules);

  const after = new Map(cells);
  applyPasteTo(after, clip, target, dates);
  const order = new Map(dates.map((x, i) => [x, i]));
  const byPos = (a: AffectedCell, b: AffectedCell) => (order.get(a.date) ?? 0) - (order.get(b.date) ?? 0) || a.lineId.localeCompare(b.lineId);

  // 내용이 실제로 바뀌는 칸만 (같은 막대를 제자리에 붙여넣어 값이 같으면 덮어쓰기가 아니다)
  const overwritten: AffectedCell[] = [];
  for (const [k, before] of cells) {
    if (!hasContent(before)) continue;
    const now = after.get(k);
    if (now && now !== before && !sameCellValue(now, before)) overwritten.push(toAffected(before));
  }
  overwritten.sort(byPos);

  const last = dates.length - 1;
  const droppedOutside: AffectedCell[] = [];
  const notAllowedDates = new Map<string, string[]>();
  clip.cells.forEach((c, j) => {
    const ni = target.idx + j;
    if (ni > last) {
      // 기간 끝 뒤의 날짜로 보여 준다 (붙여넣지 않는 칸)
      droppedOutside.push({ lineId: target.lineId, date: addDays(dates[last], ni - last), productId: c.productId, memo: c.memo ?? null });
      return;
    }
    if (target.lineId !== clip.source.lineId && c.productId && isNotAllowed(rules, target.lineId, c.productId)) {
      notAllowedDates.set(c.productId, [...(notAllowedDates.get(c.productId) ?? []), dates[ni]]);
    }
  });
  const notAllowed = [...notAllowedDates].map(([productId, ds]) => ({ lineId: target.lineId, productId, dates: ds }));

  return { overwritten, droppedOutside, notAllowed, needsConfirm: overwritten.length > 0 || droppedOutside.length > 0 || notAllowed.length > 0 };
}

// ---- 메뉴 ----

export const REASON_NO_CLIP = "복사하거나 잘라낸 막대가 없습니다";
export const REASON_CUT_CHANGED = "잘라낸 원래 막대가 바뀌어 붙여넣을 수 없습니다. 복사 취소 후 다시 잘라내세요";

export type MenuAction = "copy" | "cut" | "paste" | "cancel";
export interface MenuItem {
  action: MenuAction;
  label: string;
  enabled: boolean;
  /** 비활성 이유 (마우스를 올리면 보인다) */
  reason?: string;
}

/**
 * 오른쪽 클릭한 칸의 메뉴 항목. 막대 칸: 복사 · 잘라내기 · 붙여넣기, 빈 칸(메모만 있는 칸 포함): 붙여넣기.
 * 복사한 것이 있으면 어디서든 「복사 취소」. 할 수 없는 항목은 숨기지 않고 비활성.
 */
export function menuItems(ctx: { hasBar: boolean; clip: Clip | null; pastable: boolean }): MenuItem[] {
  const items: MenuItem[] = [];
  if (ctx.hasBar) {
    items.push({ action: "copy", label: "복사", enabled: true });
    items.push({ action: "cut", label: "잘라내기", enabled: true });
  }
  if (!ctx.clip) items.push({ action: "paste", label: "붙여넣기", enabled: false, reason: REASON_NO_CLIP });
  else if (!ctx.pastable) items.push({ action: "paste", label: "붙여넣기", enabled: false, reason: REASON_CUT_CHANGED });
  else items.push({ action: "paste", label: "붙여넣기", enabled: true });
  if (ctx.clip) items.push({ action: "cancel", label: "복사 취소", enabled: true });
  return items;
}

/** 도구 줄 표시 */
export function clipLabel(clip: Clip, pastable: boolean): string {
  if (clip.mode === "cut" && !pastable) return "잘라냄 · 원래 막대가 바뀌어 붙여넣을 수 없습니다";
  return `${clip.mode === "cut" ? "잘라냄" : "복사됨"} · ${clip.productName} ${clip.cells.length}칸`;
}
