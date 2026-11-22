import { describe, expect, it } from "vitest";
import { buildOrderListWorkbook, matchOrderProduct, parseOrdersWorkbook, type OrderListRow } from "../../../lib/excel/orders";

const ROWS: OrderListRow[] = [
  { orderNo: "SO-1", itemCode: "P0073", productName: "대상 김치 1.5kg", qty: 250000, dueDate: "2026-11-27", customerName: "진미식품", memo: "예시 주문" },
  { orderNo: null, itemCode: null, productName: "기준정보에 없는 품명", qty: 500, dueDate: "2026-12-01", customerName: null, memo: null },
];

describe("주문목록 엑셀", () => {
  it("내려받은 주문목록을 다시 읽으면 같은 주문이 나온다 (직접 입력·업로드한 주문 모두 포함)", async () => {
    const parsed = await parseOrdersWorkbook(await buildOrderListWorkbook(ROWS));
    expect(parsed.warnings).toEqual([]);
    expect(parsed.rows.map((r) => ({ orderNo: r.orderNo, itemCode: r.itemCode, productName: r.productName, qty: r.qty, dueDate: r.dueDate, customerName: r.customerName, memo: r.memo }))).toEqual(ROWS);
  });

  it("주문이 없으면 예시 행이 든 빈 양식을 준다", async () => {
    const parsed = await parseOrdersWorkbook(await buildOrderListWorkbook([], [{ itemCode: "P0001", productName: "15L 과실주" }]));
    // 예시 행은 납기일이 비어 있어 주문으로 읽히지 않는다
    expect(parsed.rows).toEqual([]);
    expect(parsed.warnings.some((w) => w.includes("납기일"))).toBe(true);
  });

  it("제품 연결: 품번(제품 코드) 우선, 없으면 품명", () => {
    const products = [
      { id: "a", code: "P0073", name: "대상 김치 1.5kg" },
      { id: "b", code: "P0120", name: "1.8L HD - N" },
    ];
    expect(matchOrderProduct({ itemCode: "p0120", productName: "아무 이름" }, products)).toBe("b");
    expect(matchOrderProduct({ itemCode: null, productName: " 대상  김치 1.5KG " }, products)).toBe("a");
    expect(matchOrderProduct({ itemCode: "X", productName: "없는 제품" }, products)).toBeNull();
  });
});
