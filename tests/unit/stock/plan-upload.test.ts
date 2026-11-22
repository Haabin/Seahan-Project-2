import { describe, expect, it } from "vitest";
import { planStockUpload, type ExistingStockItem } from "../../../lib/stock/plan-upload";
import type { StockLedgerRow } from "../../../lib/excel/stock-ledger";

const row = (over: Partial<StockLedgerRow>): StockLedgerRow => ({
  section: "PS",
  process: "P S",
  machineLabel: "BNP",
  itemCode: null,
  name: "PE 5L 말통",
  dupIndex: 0,
  opening: 100,
  packUnit: 10,
  unitsPerPallet: 5,
  days: [{ day: 1, produced: 50, shipped: 20 }],
  ...over,
});
const item = (over: Partial<ExistingStockItem>): ExistingStockItem => ({
  id: "i1",
  section: "PS",
  process: "P S",
  machineLabel: "BNP",
  itemCode: null,
  name: "PE 5L 말통",
  dupIndex: 0,
  productId: null,
  ...over,
});
const PRODUCTS = [
  { id: "p1", name: "PE 5L 말통" },
  { id: "p2", name: "300ml 원형 A" },
];

describe("수불표 업로드 미리보기", () => {
  it("기존 품목은 공정+호기+품명으로 찾고, 없으면 새 품목", () => {
    const p = planStockUpload([row({}), row({ name: "새 품목" })], [item({})], PRODUCTS);
    expect(p.plans.map((x) => [x.existingId, x.matchedBy])).toEqual([
      ["i1", "key"],
      [null, null],
    ]);
    expect(p.newItems).toEqual(["새 품목"]);
    expect(p.rowCount).toBe(2);
    expect(p.totals).toEqual({ opening: 200, produced: 100, shipped: 40, current: 260 });
  });

  it("품번이 있으면 품번을 우선한다 (품명이 바뀌어도 같은 품목)", () => {
    const p = planStockUpload([row({ itemCode: "A-1", name: "PE 5L 말통 (신형)" })], [item({ id: "i9", itemCode: "A-1" })], PRODUCTS);
    expect(p.plans[0]).toMatchObject({ existingId: "i9", matchedBy: "item_code" });
    expect(p.newItems).toEqual([]);
  });

  it("같은 품명 두 번은 순번으로 따로 맞춘다", () => {
    const p = planStockUpload([row({}), row({ dupIndex: 1 })], [item({ id: "a" }), item({ id: "b", dupIndex: 1 })], PRODUCTS);
    expect(p.plans.map((x) => x.existingId)).toEqual(["a", "b"]);
  });

  it("제품 연결: 이미 연결된 것은 유지, 품명이 같으면 제안, 아니면 매칭 안 됨", () => {
    const p = planStockUpload([row({}), row({ name: " 300ML  원형 a " }), row({ name: "참소주 1.8L 15.5%" })], [item({ productId: "p2" })], PRODUCTS);
    expect(p.plans[0]).toMatchObject({ linkedProductId: "p2", suggestedProductId: null });
    expect(p.plans[1]).toMatchObject({ linkedProductId: null, suggestedProductId: "p2" });
    expect(p.plans[2]).toMatchObject({ linkedProductId: null, suggestedProductId: null });
    expect(p.suggestions).toEqual([{ name: " 300ML  원형 a ", productName: "300ml 원형 A", kind: "auto" }]);
    expect(p.unlinkedItems).toEqual(["참소주 1.8L 15.5%"]);
  });

  it("품명이 완전히 같지 않아도 제안한다 (낱말 순서 · 단위 생략 · 윗 품목과 같은 줄)", () => {
    const products = [
      { id: "ng15", name: "15L 뉴그린" },
      { id: "kim", name: "대상 김치 1.5kg" },
      { id: "hdr", name: "1.8L HD - N - RED" },
      { id: "hdy", name: "1.8L HD - N - YELLOW" },
    ];
    const p = planStockUpload([row({ name: "뉴그린 15L" }), row({ name: "대상 김치 1.5" }), row({ name: "반 품(10/8일)" }), row({ name: "1.8L HD N" })], [], products);
    expect(p.plans.map((x) => x.suggestedProductId)).toEqual(["ng15", "kim", "kim", null]);
    expect(p.suggestions.map((s) => [s.name, s.productName, s.kind])).toEqual([
      ["뉴그린 15L", "15L 뉴그린", "auto"],
      ["대상 김치 1.5", "대상 김치 1.5kg", "auto"],
      ["반 품(10/8일)", "대상 김치 1.5kg", "parent"],
    ]);
    // 후보가 둘이라 자동으로 정하지 않고 따로 알린다
    expect(p.ambiguousItems).toEqual([{ name: "1.8L HD N", candidates: ["1.8L HD - N - RED", "1.8L HD - N - YELLOW"] }]);
    expect(p.unlinkedItems).toEqual([]);
  });

  it("삭제된 제품에 걸린 연결은 무시하고 다시 제안한다", () => {
    const p = planStockUpload([row({})], [item({ productId: "gone" })], PRODUCTS);
    expect(p.plans[0]).toMatchObject({ linkedProductId: null, suggestedProductId: "p1" });
  });
});
