import { describe, expect, it } from "vitest";
import { recalc } from "@/lib/engine";
import type { Shipment } from "@/lib/engine/types";
import { cell, makeInput } from "./fixtures";

function ship(productId: string, shipDate: string, qty: number, isMajorCustomer = false): Shipment {
  return { productId, customerId: isMajorCustomer ? "MAJOR" : "C1", isMajorCustomer, shipDate, qty };
}

function row(r: ReturnType<typeof recalc>, productId: string) {
  const x = r.supply.find((s) => s.productId === productId);
  if (!x) throw new Error(`row not found ${productId}`);
  return x;
}

describe("FR-09 제품별 수급", () => {
  it("FR-09 기초재고는 기간 시작일 이전 최신 스냅샷", () => {
    const input = makeInput({
      inventory: [
        { productId: "P1", asOfDate: "2026-11-01", qty: 999_999 },
        { productId: "P1", asOfDate: "2026-11-10", qty: 20_000 },
        { productId: "P1", asOfDate: "2026-11-20", qty: 5 }, // 기간 시작 이후 → 무시
      ],
    });
    expect(row(recalc(input), "P1").openingStock).toBe(20_000);
  });

  it("FR-09 최초 부족일과 부족량", () => {
    const input = makeInput({
      inventory: [{ productId: "P1", asOfDate: "2026-11-10", qty: 20_000 }],
      shipments: [ship("P1", "2026-11-12", 15_000), ship("P1", "2026-11-13", 10_000), ship("P1", "2026-11-14", 3_000)],
    });
    const p1 = row(recalc(input), "P1");
    expect(p1.days[0]).toMatchObject({ opening: 20_000, production: 0, shipment: 15_000, closing: 5_000, status: "ok" });
    expect(p1.days[1]).toMatchObject({ opening: 5_000, closing: -5_000, status: "shortage" });
    expect(p1.days[2]).toMatchObject({ closing: -8_000, status: "shortage" });
    expect(p1.firstShortageDate).toBe("2026-11-13");
    expect(p1.firstShortageQty).toBe(5_000);
    expect(p1.status).toBe("shortage");
    expect(p1.totalShipment).toBe(28_000);
    expect(p1.hasMajorCustomer).toBe(false);
  });

  it("FR-09 생산량이 재고에 더해진다 (예상 생산량 기준)", () => {
    const input = makeInput({
      cells: [cell("L1", "2026-11-12", "P1"), cell("L2", "2026-11-12", "P1")],
      inventory: [{ productId: "P1", asOfDate: "2026-11-12", qty: 1_000 }],
      shipments: [ship("P1", "2026-11-12", 150_000)],
    });
    const p1 = row(recalc(input), "P1");
    // 100,000 (L1) + 90,000 (L2)
    expect(p1.days[0].production).toBe(190_000);
    expect(p1.days[0].closing).toBe(41_000);
    expect(p1.days[1].opening).toBe(41_000);
  });

  it("FR-09 안전재고 미달 → warning", () => {
    const input = makeInput({
      inventory: [{ productId: "P2", asOfDate: "2026-11-10", qty: 60_000 }],
      shipments: [ship("P2", "2026-11-12", 20_000)],
    });
    const p2 = row(recalc(input), "P2"); // 안전재고 50,000
    expect(p2.safetyStock).toBe(50_000);
    expect(p2.days[0].status).toBe("warning");
    expect(p2.firstWarningDate).toBe("2026-11-12");
    expect(p2.firstShortageDate).toBeNull();
    expect(p2.status).toBe("warning");
  });

  it("FR-09 과잉: 예상재고 > 향후 N일 출고 합계 (제품별 N 재정의)", () => {
    const input = makeInput({
      inventory: [{ productId: "P3", asOfDate: "2026-11-10", qty: 100_000 }],
      shipments: [ship("P3", "2026-11-13", 1_000), ship("P3", "2026-12-01", 1_000)],
    });
    const p3 = row(recalc(input), "P3"); // surplusDays 7
    expect(p3.days[0].status).toBe("surplus"); // 11/12: 향후 7일 출고 1,000 < 100,000
    // 11/14: 향후 7일(11/15~11/21) 출고 0 → 과잉 아님 → ok
    expect(p3.days[2].status).toBe("ok");
    // 마지막 날 11/26: 향후 7일(11/27~12/03) 출고 1,000 → 과잉
    expect(p3.days[14].status).toBe("surplus");
    expect(p3.status).toBe("surplus");
  });

  it("FR-09 향후 출고가 전혀 없는 제품 → no_shipment", () => {
    const input = makeInput({
      inventory: [{ productId: "P1", asOfDate: "2026-11-10", qty: 10_000 }],
    });
    const p1 = row(recalc(input), "P1");
    expect(p1.status).toBe("no_shipment");
    expect(p1.days.every((d) => d.status === "ok")).toBe(true);
  });

  it("FR-09 기간 밖 출고만 있는 제품은 행에 포함되지 않는다", () => {
    const input = makeInput({ shipments: [ship("P1", "2027-01-05", 1)] });
    expect(recalc(input).supply.find((s) => s.productId === "P1")).toBeUndefined();
  });
});

describe("FR-11 우선순위", () => {
  const baseInput = () =>
    makeInput({
      inventory: [
        { productId: "P1", asOfDate: "2026-11-10", qty: 20_000 },
        { productId: "P2", asOfDate: "2026-11-10", qty: 500_000 },
      ],
      shipments: [
        ship("P1", "2026-11-12", 15_000),
        ship("P1", "2026-11-13", 10_000), // 11/13 부족 → dueSoon 1/(1+1)=0.5
        ship("P2", "2026-11-12", 10_000, true), // 대형 거래선, 부족 없음
      ],
    });

  it("FR-11 점수 분해: w1·1/(일수+1) + w2·대형거래선 + w3·안전재고 미달", () => {
    const r = recalc(baseInput());
    const p1 = row(r, "P1");
    expect(p1.priority).toEqual({ dueSoon: 1.5, majorCustomer: 0, belowSafety: 1, total: 2.5 });
    const p2 = row(r, "P2");
    expect(p2.hasMajorCustomer).toBe(true);
    expect(p2.priority).toEqual({ dueSoon: 0, majorCustomer: 2, belowSafety: 0, total: 2 });
    expect(r.supply.map((s) => s.productId)).toEqual(["P1", "P2"]);
  });

  it("FR-11 가중치를 바꾸면 순서가 바뀐다", () => {
    const input = baseInput();
    input.priorityWeights = { dueSoon: 3, majorCustomer: 10, belowSafety: 1 };
    const r = recalc(input);
    expect(row(r, "P2").priority.total).toBe(10);
    expect(r.supply.map((s) => s.productId)).toEqual(["P2", "P1"]);
  });

  it("FR-11 동점이면 최초 부족일 빠른 순, 그다음 이름 순", () => {
    const input = makeInput({
      inventory: [
        { productId: "P1", asOfDate: "2026-11-10", qty: 0 },
        { productId: "P3", asOfDate: "2026-11-10", qty: 0 },
      ],
      shipments: [ship("P1", "2026-11-13", 1), ship("P3", "2026-11-12", 1)],
      priorityWeights: { dueSoon: 0, majorCustomer: 0, belowSafety: 1 },
    });
    const r = recalc(input);
    expect(r.supply.map((s) => s.productId)).toEqual(["P3", "P1"]);
  });
});
