import { EDITED_AUTO_PREFIX, type AllowedMold, type PlanCell } from "@/lib/engine/types";
import { cellMapKey as key } from "@/components/gantt/cell-edit-session";

/**
 * 생산계획표 드래그(블록 옮기기 · 끝 늘리기/줄이기)의 적용과 사전 검사. 순수 함수.
 * 적용 규칙은 plan-workspace 의 applyDrag 에 있던 것을 그대로 옮겼다.
 */
export type Drag =
  | { kind: "move"; lineId: string; startIdx: number; endIdx: number; productId: string; grabIdx: number; hoverIdx: number; hoverLineId: string }
  | { kind: "resize"; lineId: string; startIdx: number; endIdx: number; productId: string; hoverIdx: number };

/** 제자리에 놓은 옮기기: 아무것도 하지 않는다 (저장 대상도 아니다) */
export function dragIsNoop(d: Drag): boolean {
  return d.kind === "move" && d.hoverIdx - d.grabIdx === 0 && d.hoverLineId === d.lineId;
}

/** 드래그를 셀 맵에 적용한다 (m 을 직접 바꾼다) */
export function applyDragTo(m: Map<string, PlanCell>, d: Drag, dates: string[]): void {
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
  if (dragIsNoop(d)) return;
  const delta = d.hoverIdx - d.grabIdx;
  const targetLine = d.hoverLineId;
  const idxOf = new Map(dates.map((x, i) => [x, i]));
  const moving: PlanCell[] = [];
  for (let i = d.startIdx; i <= d.endIdx; i++) {
    const c = m.get(key(d.lineId, dates[i]));
    if (c) moving.push(c);
    m.delete(key(d.lineId, dates[i]));
  }
  for (const c of moving) {
    const ni = idxOf.get(c.date)! + delta;
    if (ni < 0 || ni >= dates.length) continue;
    m.set(key(targetLine, dates[ni]), { ...c, lineId: targetLine, date: dates[ni], origin: "manual", basis: c.origin === "auto" ? `${EDITED_AUTO_PREFIX} · ${c.basis ?? ""}`.slice(0, 300) : c.basis });
  }
}

/** 허용 금형 기준: 엔진 MOLD_NOT_ALLOWED 와 같은 판정 (기준정보에 있는 제품 + (호기, 제품) 쌍이 허용 목록에 없음) */
export interface AllowRules {
  allowed: Set<string>;
  productIds: Set<string>;
}

export function buildAllowRules(allowedMolds: AllowedMold[], productIds: Iterable<string>): AllowRules {
  return { allowed: new Set(allowedMolds.map((m) => `${m.lineId}|${m.productId}`)), productIds: new Set(productIds) };
}

/** 이 호기에 이 제품을 두면 엔진이 MOLD_NOT_ALLOWED 로 판정하는가 */
export function isNotAllowed(rules: AllowRules, lineId: string, productId: string): boolean {
  return rules.productIds.has(productId) && !rules.allowed.has(`${lineId}|${productId}`);
}

/** 드래그 중 미리보기: 다른 호기로 옮기는데 그 호기에서 허용되지 않으면 true */
export function moveTargetNotAllowed(d: Drag, rules: AllowRules): boolean {
  return d.kind === "move" && d.hoverLineId !== d.lineId && isNotAllowed(rules, d.hoverLineId, d.productId);
}

export interface AffectedCell {
  lineId: string;
  date: string;
  productId: string | null;
  memo: string | null;
}

export interface DragInspection {
  /** 지금 내용(제품 또는 메모)이 있는데 다른 내용으로 바뀌거나 사라지는 칸. 옮기는 블록의 원래 칸은 세지 않는다 */
  overwritten: AffectedCell[];
  /** 옮기기로 기간 밖으로 밀려나 지워지는 칸 (원래 위치 기준) */
  droppedOutside: AffectedCell[];
  /** 다른 호기로 옮겼는데 허용되지 않는 칸 (옮긴 뒤 위치 기준) */
  notAllowed: { lineId: string; productId: string; dates: string[] }[];
  needsConfirm: boolean;
}

const hasContent = (c: PlanCell | undefined): c is PlanCell => !!c && (c.productId !== null || !!c.memo);
const toAffected = (c: PlanCell): AffectedCell => ({ lineId: c.lineId, date: c.date, productId: c.productId, memo: c.memo ?? null });

/** 이 드래그를 적용하면 무엇이 덮어써지고, 무엇이 지워지고, 어디가 허용되지 않는지. 판단은 실제 적용 결과(applyDragTo)와 비교해서 한다 */
export function inspectDrag(cells: Map<string, PlanCell>, d: Drag, dates: string[], rules: AllowRules): DragInspection {
  const empty: DragInspection = { overwritten: [], droppedOutside: [], notAllowed: [], needsConfirm: false };
  if (dragIsNoop(d)) return empty;

  const after = new Map(cells);
  applyDragTo(after, d, dates);
  const own = new Set<string>();
  for (let i = d.startIdx; i <= d.endIdx; i++) own.add(key(d.lineId, dates[i]));
  const order = new Map(dates.map((x, i) => [x, i]));
  const byPos = (a: AffectedCell, b: AffectedCell) => (order.get(a.date) ?? 0) - (order.get(b.date) ?? 0) || a.lineId.localeCompare(b.lineId);

  const overwritten: AffectedCell[] = [];
  for (const [k, before] of cells) {
    if (own.has(k) || !hasContent(before)) continue;
    if (after.get(k) !== before) overwritten.push(toAffected(before));
  }
  overwritten.sort(byPos);

  const droppedOutside: AffectedCell[] = [];
  const notAllowedDates = new Map<string, string[]>();
  if (d.kind === "move") {
    const delta = d.hoverIdx - d.grabIdx;
    for (let i = d.startIdx; i <= d.endIdx; i++) {
      const c = cells.get(key(d.lineId, dates[i]));
      if (!c) continue;
      const ni = i + delta;
      if (ni < 0 || ni >= dates.length) {
        if (hasContent(c)) droppedOutside.push(toAffected(c));
        continue;
      }
      if (d.hoverLineId !== d.lineId && c.productId && isNotAllowed(rules, d.hoverLineId, c.productId)) {
        notAllowedDates.set(c.productId, [...(notAllowedDates.get(c.productId) ?? []), dates[ni]]);
      }
    }
  }
  droppedOutside.sort(byPos);
  const notAllowed = [...notAllowedDates].map(([productId, ds]) => ({ lineId: (d as Extract<Drag, { kind: "move" }>).hoverLineId, productId, dates: ds }));

  return { overwritten, droppedOutside, notAllowed, needsConfirm: overwritten.length > 0 || droppedOutside.length > 0 || notAllowed.length > 0 };
}

/** 확인 버튼 문구: 덮어쓰기와 허용 경고 중 해당하는 것. 기간 밖만 있으면 「그래도 옮기기」 */
export function confirmLabel(i: DragInspection): "덮어쓰기" | "그래도 옮기기" | "덮어쓰고 옮기기" {
  if (i.overwritten.length && i.notAllowed.length) return "덮어쓰고 옮기기";
  if (i.overwritten.length) return "덮어쓰기";
  return "그래도 옮기기";
}
