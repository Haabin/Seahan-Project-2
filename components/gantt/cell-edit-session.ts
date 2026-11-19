/**
 * 셀 편집창 세션 (순수 함수, React·DB 없음).
 *
 * 편집창에서 바꾸는 값은 계획표 셀(cells)이 아니라 세션의 draft 에만 담는다.
 *   - "완료"(done)로 닫을 때만 draft 를 계획표에 반영한다 → 그때만 자동 저장 대상이 된다
 *   - X · Esc · 편집창 바깥 클릭은 모두 취소: 계획표는 열기 전 그대로(같은 Map 객체)
 * 편집창 안의 생산 가능시간·계산 근거는 previewCells() 로 draft 를 끼운 셀 목록을 따로 계산해 보여 준다.
 */
import type { PlanCell } from "@/lib/engine/types";

export const cellMapKey = (lineId: string, date: string) => `${lineId}|${date}`;

export interface CellEditSession {
  lineId: string;
  date: string;
  /** 편집창을 열 때의 셀 (없으면 빈 칸) */
  original: PlanCell | null;
  /** 편집 중인 값 */
  draft: PlanCell;
}

/** 편집창을 닫는 방법. 'done' 만 반영, 나머지는 취소 */
export type CloseVia = "done" | "x" | "escape" | "outside";

export type CellPatch = Partial<Pick<PlanCell, "productId" | "qty" | "changeoverType" | "memo">>;

function emptyCell(lineId: string, date: string): PlanCell {
  return { lineId, date, productId: null, qty: null, changeoverType: "NONE", memo: null };
}

export function openCellEdit(cells: ReadonlyMap<string, PlanCell>, lineId: string, date: string): CellEditSession {
  const original = cells.get(cellMapKey(lineId, date)) ?? null;
  return { lineId, date, original, draft: original ? { ...original } : emptyCell(lineId, date) };
}

/** 계획표의 patchCell 과 같은 정리: 제품을 비우면 수량·교체유형도 비운다 */
export function patchCellEdit(s: CellEditSession, patch: CellPatch): CellEditSession {
  const draft: PlanCell = { ...s.draft, ...patch };
  if (draft.productId === null) {
    draft.qty = null;
    draft.changeoverType = "NONE";
  }
  return { ...s, draft };
}

function sameCell(a: PlanCell | null, b: PlanCell | null): boolean {
  if (!a || !b) return a === b;
  return a.productId === b.productId && a.qty === b.qty && a.changeoverType === b.changeoverType && (a.memo ?? null) === (b.memo ?? null);
}

/** 제품도 메모도 없는 칸은 저장하지 않는다(빈 칸) */
function storedForm(c: PlanCell): PlanCell | null {
  return c.productId === null && !c.memo ? null : c;
}

/**
 * 편집창 닫기. 'done' 이고 값이 실제로 바뀌었을 때만 새 Map 과 changed=true.
 * 그 밖에는 받은 cells 를 그대로 돌려준다(취소 · 바뀐 것 없음).
 */
export function closeCellEdit(
  cells: ReadonlyMap<string, PlanCell>,
  s: CellEditSession,
  via: CloseVia,
): { cells: ReadonlyMap<string, PlanCell>; changed: boolean } {
  if (via !== "done") return { cells, changed: false };
  const next = storedForm(s.draft);
  if (sameCell(s.original, next)) return { cells, changed: false };
  const m = new Map(cells);
  const k = cellMapKey(s.lineId, s.date);
  if (next) m.set(k, next);
  else m.delete(k);
  return { cells: m, changed: true };
}

/** 편집창 미리보기용: 계획표 셀에 draft 만 끼운 목록 (계획표 자체는 바꾸지 않음) */
export function previewCells(cells: ReadonlyMap<string, PlanCell>, s: CellEditSession): PlanCell[] {
  const k = cellMapKey(s.lineId, s.date);
  const out = [...cells.entries()].filter(([key]) => key !== k).map(([, c]) => c);
  const draft = storedForm(s.draft);
  if (draft) out.push(draft);
  return out;
}
