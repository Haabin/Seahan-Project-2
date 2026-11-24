import { describe, expect, it } from "vitest";
import { ordersToShipments } from "../../../lib/orders/shipments";
import { recalc } from "@/lib/engine";
import { cell, makeInput, PERIOD_START } from "../engine/fixtures";

const o = (over: Partial<Parameters<typeof ordersToShipments>[0][number]>) => ({ productId: "P1", customerId: null, isMajorCustomer: false, qty: 1000, dueDate: "2026-11-16", status: "open", ...over });

describe("주문 → 수급 검증의 나가는 양", () => {
  it("진행 중이고 제품이 연결된 주문만, 납기일에 그 수량으로", () => {
    const s = ordersToShipments([o({}), o({ status: "done" }), o({ status: "cancelled" }), o({ productId: null }), o({ qty: 0 }), o({ productId: "P2", dueDate: "2026-11-20", qty: 500, isMajorCustomer: true })]);
    expect(s).toEqual([
      { productId: "P1", customerId: null, isMajorCustomer: false, shipDate: "2026-11-16", qty: 1000 },
      { productId: "P2", customerId: null, isMajorCustomer: true, shipDate: "2026-11-20", qty: 500 },
    ]);
  });

  it("수급 검증: 주문 납기일에 재고가 줄고, 계획 생산이 없으면 부족으로 잡힌다", () => {
    const shipments = ordersToShipments([o({ qty: 150_000, dueDate: "2026-11-14" })]);
    const none = recalc(makeInput({ shipments, inventory: [{ productId: "P1", asOfDate: PERIOD_START, qty: 100_000 }] }));
    const row = none.supply.find((r) => r.productId === "P1")!;
    expect(row.status).toBe("shortage");
    expect(row.firstShortageDate).toBe("2026-11-14");
    expect(row.firstShortageQty).toBe(50_000);
    // 그 전에 하루 생산(100,000)을 넣으면 부족이 사라진다
    const planned = recalc(makeInput({ shipments, inventory: [{ productId: "P1", asOfDate: PERIOD_START, qty: 100_000 }], cells: [cell("L1", "2026-11-13", "P1")] }));
    expect(planned.supply.find((r) => r.productId === "P1")!.status).not.toBe("shortage");
  });
});

describe("출고일정표 + 주문 합치기", () => {
  it("제품·날짜·수량이 모두 같으면 한 번만 세고, 다르면 더한다", async () => {
    const { mergeShipments } = await import("../../../lib/orders/shipments");
    const s = (productId: string, shipDate: string, qty: number) => ({ productId, customerId: null, isMajorCustomer: false, shipDate, qty });
    const r = mergeShipments(
      [s("P1", "2026-11-25", 1000), s("P2", "2026-11-25", 3000)],
      [s("P1", "2026-11-25", 1000), s("P2", "2026-11-25", 5000), s("P3", "2026-11-27", 250_000)],
    );
    expect(r.duplicates).toBe(1);
    expect(r.shipments.map((x) => `${x.productId}:${x.qty}`)).toEqual(["P1:1000", "P2:3000", "P2:5000", "P3:250000"]);
  });

  it("같은 주문이 두 건이면 올린 출고 한 건과만 짝을 짓는다", async () => {
    const { mergeShipments } = await import("../../../lib/orders/shipments");
    const s = (qty: number) => ({ productId: "P1", customerId: null, isMajorCustomer: false, shipDate: "2026-11-25", qty });
    const r = mergeShipments([s(500)], [s(500), s(500)]);
    expect(r.duplicates).toBe(1);
    expect(r.shipments).toHaveLength(2);
  });
});
