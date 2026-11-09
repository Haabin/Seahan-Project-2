/**
 * FR-04 Rev 비교. (lineId, date) 키로 전/후 셀을 대조한다.
 * 양쪽 모두 제품이 없는 셀은 무시한다.
 */
import type { CellDiff, PlanCell } from "./types";
import { cellKey } from "./production";

type DiffField = CellDiff["changedFields"][number];

function normMemo(m: string | null | undefined): string | null {
  return m == null || m === "" ? null : m;
}

function isEmpty(cell: PlanCell | undefined): boolean {
  return !cell || cell.productId == null;
}

export function diffCells(before: PlanCell[], after: PlanCell[]): CellDiff[] {
  const beforeMap = new Map<string, PlanCell>();
  for (const c of before) beforeMap.set(cellKey(c.lineId, c.date), c);
  const afterMap = new Map<string, PlanCell>();
  for (const c of after) afterMap.set(cellKey(c.lineId, c.date), c);

  const keys = new Set<string>();
  beforeMap.forEach((_, k) => keys.add(k));
  afterMap.forEach((_, k) => keys.add(k));

  const out: CellDiff[] = [];
  const sortedKeys = Array.from(keys).sort();
  for (const key of sortedKeys) {
    const b = beforeMap.get(key);
    const a = afterMap.get(key);
    const bEmpty = isEmpty(b);
    const aEmpty = isEmpty(a);
    if (bEmpty && aEmpty) continue;

    const sep = key.indexOf("|");
    const lineId = key.slice(0, sep);
    const date = key.slice(sep + 1);

    if (bEmpty && !aEmpty) {
      out.push({ lineId, date, kind: "added", before: b ?? null, after: a as PlanCell, changedFields: ["productId"] });
      continue;
    }
    if (!bEmpty && aEmpty) {
      out.push({ lineId, date, kind: "removed", before: b as PlanCell, after: a ?? null, changedFields: ["productId"] });
      continue;
    }

    const bc = b as PlanCell;
    const ac = a as PlanCell;
    const changed: DiffField[] = [];
    if (bc.productId !== ac.productId) changed.push("productId");
    if ((bc.qty ?? null) !== (ac.qty ?? null)) changed.push("qty");
    if (bc.changeoverType !== ac.changeoverType) changed.push("changeoverType");
    if (normMemo(bc.memo) !== normMemo(ac.memo)) changed.push("memo");
    if (changed.length > 0) {
      out.push({ lineId, date, kind: "changed", before: bc, after: ac, changedFields: changed });
    }
  }
  return out;
}
