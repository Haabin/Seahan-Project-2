/**
 * 수불표 업로드 미리보기 계산 (순수 함수, DB 없음).
 * 파일에서 읽은 행을 기존 품목과 맞추고, 생산계획 제품과의 연결을 "제안"한다. 연결 확정은 사람이 한다.
 *
 * 품목 식별: 품번이 있으면 품번 우선, 없으면 구간+공정+호기 라벨+품명+순번.
 * 제품 연결 제안: 재고현황의 「제품 자동 연결」과 같은 규칙(lib/stock/match-products.ts)을 쓴다.
 *   낱말 단위 비교라 품명이 완전히 같지 않아도 된다. 확실한 것(자동 제안 · 윗 품목과 동일)만 연결 제안에 넣고,
 *   후보가 여럿이라 사람이 골라야 하는 것은 따로 알려준다.
 */
import { proposeProductLinks } from "./match-products";
import { stockItemKey, stockTotals, type StockLedgerRow } from "../excel/stock-ledger";

export interface ExistingStockItem {
  id: string;
  section: string;
  process: string;
  machineLabel: string;
  itemCode: string | null;
  name: string;
  dupIndex: number;
  productId: string | null;
}

export interface UploadProduct {
  id: string;
  name: string;
}

export interface StockUploadRowPlan {
  row: StockLedgerRow;
  /** 기존 품목 id. 없으면 새 품목 */
  existingId: string | null;
  matchedBy: "item_code" | "key" | null;
  /** 이미 연결돼 있는 제품 */
  linkedProductId: string | null;
  /** 품명 일치로 제안하는 제품(아직 연결 안 된 품목만) */
  suggestedProductId: string | null;
}

export interface StockUploadPreview {
  rowCount: number;
  dayValueCount: number;
  newItems: string[];
  /** 생산계획 제품과 연결되지 않는 품목(제안도 없음) */
  unlinkedItems: string[];
  /** 확실해서 바로 연결을 제안하는 것 */
  suggestions: { name: string; productName: string; kind: "auto" | "parent" }[];
  /** 후보가 여럿이라 올린 뒤 「제품 자동 연결」에서 골라야 하는 것 */
  ambiguousItems: { name: string; candidates: string[] }[];
  totals: { opening: number; produced: number; shipped: number; current: number };
  plans: StockUploadRowPlan[];
}

export function planStockUpload(rows: StockLedgerRow[], existing: ExistingStockItem[], products: UploadProduct[]): StockUploadPreview {
  const byKey = new Map(existing.map((e) => [stockItemKey(e), e] as const));
  const byCode = new Map<string, ExistingStockItem>();
  for (const e of existing) if (e.itemCode && !byCode.has(e.itemCode)) byCode.set(e.itemCode, e);
  const productById = new Map(products.map((p) => [p.id, p] as const));

  const usedIds = new Set<string>();
  const plans: StockUploadRowPlan[] = [];
  const preview: StockUploadPreview = {
    rowCount: rows.length,
    dayValueCount: 0,
    newItems: [],
    unlinkedItems: [],
    suggestions: [],
    ambiguousItems: [],
    totals: { opening: 0, produced: 0, shipped: 0, current: 0 },
    plans,
  };

  for (const row of rows) {
    let found: ExistingStockItem | undefined;
    let matchedBy: StockUploadRowPlan["matchedBy"] = null;
    if (row.itemCode) {
      const c = byCode.get(row.itemCode);
      if (c && !usedIds.has(c.id)) {
        found = c;
        matchedBy = "item_code";
      }
    }
    if (!found) {
      const k = byKey.get(stockItemKey(row));
      if (k && !usedIds.has(k.id)) {
        found = k;
        matchedBy = "key";
      }
    }
    if (found) usedIds.add(found.id);
    else preview.newItems.push(row.name);

    const linked = found?.productId && productById.has(found.productId) ? found.productId : null;

    const t = stockTotals(row);
    preview.totals.opening += row.opening;
    preview.totals.produced += t.produced;
    preview.totals.shipped += t.shipped;
    preview.totals.current += t.current;
    preview.dayValueCount += row.days.length;
    plans.push({ row, existingId: found?.id ?? null, matchedBy, linkedProductId: linked, suggestedProductId: null });
  }

  // 제품 연결 제안: 표에 나오는 순서대로 한꺼번에 본다(윗 품목과 같은 제품인 줄을 알아보려면 순서가 필요하다)
  const match = proposeProductLinks(
    plans.map((p, i) => ({ key: String(i), name: p.row.name, productId: p.linkedProductId })),
    products,
  );
  const proposed = new Set<number>();
  for (const pr of match.proposals) {
    const i = Number(pr.key);
    proposed.add(i);
    if (pr.kind === "candidates") {
      preview.ambiguousItems.push({ name: pr.name, candidates: pr.candidates.map((c) => productById.get(c.productId)?.name ?? "") });
    } else {
      plans[i].suggestedProductId = pr.productId;
      preview.suggestions.push({ name: pr.name, productName: productById.get(pr.productId)?.name ?? "", kind: pr.kind });
    }
  }
  plans.forEach((p, i) => {
    if (!p.linkedProductId && !proposed.has(i)) preview.unlinkedItems.push(p.row.name);
  });
  return preview;
}
