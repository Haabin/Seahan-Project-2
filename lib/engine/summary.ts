/**
 * 생산계획표 합계: 호기별 기간 합계, 일자별 합계, 일자별 교체 횟수.
 * 수량은 셀에 보이는 값과 같다(입력 수량이 있으면 그 값, 없으면 예상 생산량. 가동 불가일은 0).
 * 교체 횟수는 하루 교체 한도 검사(constraints.ts)와 같은 규칙: 실제 적용 교체유형이 있고 가동 불가일이 아닌 칸.
 */
import type { CellResult, ISODate } from "./types";

export interface PlanSummary {
  /** 호기 id → 기간 합계 */
  byLine: Map<string, number>;
  /** 날짜 → 그날 계획 대상 호기 합계 */
  byDate: Map<ISODate, number>;
  /** 날짜 → 그날 교체 횟수 */
  changeoversByDate: Map<ISODate, number>;
  /** 기간 전체 합계 */
  total: number;
}

export function summarizePlan(cells: CellResult[], lineIds: readonly string[], dates: readonly ISODate[]): PlanSummary {
  const lineSet = new Set(lineIds);
  const byLine = new Map<string, number>(lineIds.map((id) => [id, 0]));
  const byDate = new Map<ISODate, number>(dates.map((d) => [d, 0]));
  const changeoversByDate = new Map<ISODate, number>(dates.map((d) => [d, 0]));
  let total = 0;
  for (const c of cells) {
    if (!lineSet.has(c.lineId) || !byDate.has(c.date)) continue;
    const qty = c.productId ? c.expectedQty : 0;
    byLine.set(c.lineId, byLine.get(c.lineId)! + qty);
    byDate.set(c.date, byDate.get(c.date)! + qty);
    total += qty;
    if (c.effectiveChangeover !== "NONE" && !c.isDowntime) changeoversByDate.set(c.date, changeoversByDate.get(c.date)! + 1);
  }
  return { byLine, byDate, changeoversByDate, total };
}
