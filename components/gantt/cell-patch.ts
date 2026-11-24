import { EDITED_AUTO_PREFIX, type PlanCell } from "@/lib/engine/types";
import { cellMapKey as key } from "@/components/gantt/cell-edit-session";

/**
 * 계획표 셀 직접 수정(「빈 셀로」, 품번별 표의 금형·교체유형 선택). 순수 함수.
 * plan-workspace 의 patchCell 에 있던 규칙을 그대로 옮겼다. 여러 칸을 한 번에 받아도 규칙은 칸마다 따로 적용한다.
 */
export interface CellTarget {
  lineId: string;
  date: string;
}

/** 금형 후보 (제품이 바뀌면 금형을 다시 고를 때 쓴다) */
export interface PatchMold {
  id: string;
  productIds: string[];
}

/** 한 칸에 patch 를 적용한다 (m 을 직접 바꾼다) */
export function patchCellInto(m: Map<string, PlanCell>, lineId: string, date: string, patch: Partial<PlanCell>, molds: readonly PatchMold[]): void {
  const k = key(lineId, date);
  const cur = m.get(k) ?? { lineId, date, productId: null, qty: null, changeoverType: "NONE" as const, memo: null };
  const next = { ...cur, ...patch };
  // 사람이 고친 셀로 표시한다. 자동 생성 셀이었으면 근거 앞에 표시를 남겨 나중에 수정 비율을 센다
  if (cur.origin === "auto") next.basis = `${EDITED_AUTO_PREFIX} · ${cur.basis ?? ""}`.slice(0, 300);
  next.origin = "manual";
  // 제품을 바꾸면 금형은 다시 골라야 한다(그 제품의 금형이 하나뿐이면 자동으로 넣는다)
  if (patch.productId !== undefined && patch.productId !== cur.productId && patch.moldId === undefined) {
    const options = molds.filter((x) => patch.productId && x.productIds.includes(patch.productId));
    next.moldId = options.length === 1 ? options[0].id : null;
  }
  if (next.productId === null) {
    next.qty = null;
    next.changeoverType = "NONE";
    next.lostHoursOverride = null;
    next.moldId = null;
  }
  if (next.productId === null && !next.memo) m.delete(k);
  else m.set(k, next);
}

/** 여러 칸에 같은 patch 를 칸마다 적용한다 (m 을 직접 바꾼다) */
export function patchCellsInto(m: Map<string, PlanCell>, targets: readonly CellTarget[], patch: Partial<PlanCell>, molds: readonly PatchMold[]): void {
  for (const t of targets) patchCellInto(m, t.lineId, t.date, patch, molds);
}
