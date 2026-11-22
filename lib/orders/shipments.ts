/**
 * 주문 → 수급 검증의 출고(나가는 양).
 * 진행 중이고 제품이 연결된 주문은 납기일에 그 수량이 나가는 것으로 본다.
 * 완료·취소한 주문과 제품 매칭이 안 된 주문은 넣지 않는다.
 */
import type { Shipment } from "../engine/types";

export interface OrderForShipment {
  productId: string | null;
  customerId: string | null;
  isMajorCustomer: boolean;
  qty: number;
  dueDate: string;
  status: string;
}

export function ordersToShipments(orders: OrderForShipment[]): Shipment[] {
  return orders
    .filter((o) => o.status === "open" && !!o.productId && o.qty > 0)
    .map((o) => ({ productId: o.productId as string, customerId: o.customerId, isMajorCustomer: o.isMajorCustomer, shipDate: o.dueDate, qty: o.qty }));
}
