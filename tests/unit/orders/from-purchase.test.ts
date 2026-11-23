import { describe, expect, it } from "vitest";
import { planPurchaseOrders, purchaseCodeKey, purchaseOrderNo, suggestPurchaseLinks, type PurchaseItemForOrder } from "@/lib/orders/from-purchase";

const TODAY = "2026-11-24";
const PRODUCTS = [
  { id: "p-yellow", code: "RP-D609698F", name: "# 1.8L HD - N - YELLOW" },
  { id: "p-red", code: "RP-3D8FA87E", name: "# 1.8L HD - N - RED" },
  { id: "p-10l", code: "RP-D8178942", name: "# 10L 원형" },
  { id: "p-10sq", code: "RP-A5153B40", name: "# 10L 사각" },
];
const item = (line: number, over: Partial<PurchaseItemForOrder> = {}): PurchaseItemForOrder => ({
  line,
  productCode: "TM00730",
  productName: "10L 원형",
  quantity: 1200,
  requestedDate: "2026-12-01",
  customer: "",
  note: "",
  ...over,
});

describe("발주서 품목 → 제품 연결 제안", () => {
  it("저장된 연결(품번 → 제품)이 가장 먼저", () => {
    const s = suggestPurchaseLinks([item(1, { productCode: " tm00648 ", productName: "HD 1.8 N -노랑" })], PRODUCTS, { TM00648: "p-yellow" });
    expect(s[1]).toEqual({ productId: "p-yellow", source: "saved" });
  });

  it("저장된 연결이 가리키는 제품이 없어졌으면 쓰지 않는다", () => {
    const s = suggestPurchaseLinks([item(1, { productCode: "TM00648", productName: "HD 1.8 N -노랑" })], PRODUCTS, { TM00648: "지워진-제품" });
    expect(s[1].source).not.toBe("saved");
  });

  it("품번이 제품 코드와 같으면 그 제품", () => {
    const s = suggestPurchaseLinks([item(1, { productCode: "rp-d8178942", productName: "아무 이름" })], PRODUCTS, {});
    expect(s[1]).toEqual({ productId: "p-10l", source: "code" });
  });

  it("품명이 뚜렷하게 맞으면 이름으로 제안", () => {
    const s = suggestPurchaseLinks([item(1, { productName: "10L 원형" })], PRODUCTS, {});
    expect(s[1]).toEqual({ productId: "p-10l", source: "name" });
  });

  it("비슷한 제품이 여럿이면 정하지 않고 사람이 고르게 한다", () => {
    const s = suggestPurchaseLinks([item(1, { productCode: "TM00999", productName: "10L" })], PRODUCTS, {});
    expect(s[1]).toEqual({ productId: null, source: "none" });
  });

  it("품번 키: 앞뒤 공백 정리 + 대문자", () => {
    expect(purchaseCodeKey("  tm00648 ")).toBe("TM00648");
    expect(purchaseCodeKey(null)).toBe("");
  });
});

describe("발주서 → 주문 계획", () => {
  const base = { requestNumber: " PO-2611-07 ", customer: "가상상사", today: TODAY };

  it("품목 하나가 주문 한 건, 주문번호는 발주번호-행번호", () => {
    expect(purchaseOrderNo(" PO-2611-07 ", 2)).toBe("PO-2611-07-2");
    const plan = planPurchaseOrders({ ...base, items: [item(1), item(2, { productCode: "TM00648", productName: "HD 1.8 N -노랑", quantity: 684, note: " 급함 " })], links: { 1: "p-10l" }, existing: [] });
    expect(plan.errors).toEqual([]);
    expect(plan.inserts).toEqual([
      { line: 1, orderNo: "PO-2611-07-1", productId: "p-10l", productNameRaw: "10L 원형", itemCodeRaw: "TM00730", customerName: "가상상사", qty: 1200, dueDate: "2026-12-01", memo: null },
      { line: 2, orderNo: "PO-2611-07-2", productId: null, productNameRaw: "HD 1.8 N -노랑", itemCodeRaw: "TM00648", customerName: "가상상사", qty: 684, dueDate: "2026-12-01", memo: "급함" },
    ]);
    expect(plan.updates).toEqual([]);
    expect(plan.removes).toEqual([]);
    expect(plan.unlinked).toBe(1);
  });

  it("품목에 적힌 거래처가 발주서 거래처보다 우선", () => {
    const plan = planPurchaseOrders({ ...base, items: [item(1, { customer: "다른상사" })], links: {}, existing: [] });
    expect(plan.inserts[0].customerName).toBe("다른상사");
  });

  it("다시 보내면 같은 품목의 주문을 고치고, 빠진 품목의 진행 중 주문만 지운다", () => {
    const plan = planPurchaseOrders({
      ...base,
      items: [item(1, { quantity: 2400 }), item(4)],
      links: { 1: "p-10l", 4: "p-10sq" },
      existing: [
        { id: "o1", line: 1, status: "done" },
        { id: "o2", line: 2, status: "open" },
        { id: "o3", line: 3, status: "done" },
      ],
    });
    expect(plan.updates.map((u) => [u.id, u.row.qty])).toEqual([["o1", 2400]]);
    expect(plan.inserts.map((r) => r.line)).toEqual([4]);
    expect(plan.removes).toEqual(["o2"]); // o3 은 완료한 주문이라 남긴다
  });

  it("수량·납기일이 이상하면 보내지 않고 행 번호와 함께 알린다", () => {
    const plan = planPurchaseOrders({
      ...base,
      items: [item(1, { quantity: 0 }), item(2, { quantity: 10.5 }), item(3, { requestedDate: null }), item(4, { requestedDate: "2020-01-01" }), item(5)],
      links: {},
      existing: [],
    });
    expect(plan.errors).toHaveLength(4);
    expect(plan.errors[0]).toContain("1행");
    expect(plan.errors[2]).toContain("납기일이 없습니다");
    expect(plan.errors[3]).toContain("4행");
    expect(plan.inserts.map((r) => r.line)).toEqual([5]);
  });

  it("품목이 없거나 발주번호가 없으면 오류", () => {
    expect(planPurchaseOrders({ ...base, items: [], links: {}, existing: [] }).errors).toHaveLength(1);
    expect(planPurchaseOrders({ ...base, requestNumber: " ", items: [item(1)], links: {}, existing: [] }).errors).toHaveLength(1);
  });
});
