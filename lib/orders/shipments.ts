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

/**
 * 출고일정표로 올린 출고와 주문에서 온 출고를 합친다.
 * 같은 수요를 두 군데에 넣은 경우(제품·날짜·수량이 모두 같음)에는 한 번만 센다.
 * 돌려주는 duplicates 는 그렇게 한 번만 센 건수다.
 */
export function mergeShipments(uploaded: Shipment[], fromOrders: Shipment[]): { shipments: Shipment[]; duplicates: number } {
  const key = (s: Shipment) => `${s.productId}|${s.shipDate}|${s.qty}`;
  const left = new Map<string, number>();
  for (const s of uploaded) left.set(key(s), (left.get(key(s)) ?? 0) + 1);
  const extra: Shipment[] = [];
  let duplicates = 0;
  for (const s of fromOrders) {
    const n = left.get(key(s)) ?? 0;
    if (n > 0) {
      left.set(key(s), n - 1);
      duplicates++;
    } else extra.push(s);
  }
  return { shipments: [...uploaded, ...extra], duplicates };
}
