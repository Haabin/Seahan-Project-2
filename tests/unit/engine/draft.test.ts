import { describe, expect, it } from "vitest";
import { generateDraft, learnTransitions, recalc, type DraftHistoryCell, type DraftInput, type DraftMold, type DraftOrder } from "@/lib/engine";
import type { ChangeoverCoefficient, EngineInput, Line, Product } from "@/lib/engine/types";
import { cell, COEFFICIENTS, LINES, makeInput as baseMakeInput, PERIOD_START, PRODUCTS } from "./fixtures";

// 초안 테스트는 회의 확인값(PET1 B/M 2h → 0.91, FULLSET 6h → 0.75, 익일가동 없음)으로 계산한다.
// PET2·PE 는 공용 fixtures 값 그대로. 가동률은 기준표 둘째 자리 내림값(0.915 → 0.91).
const DRAFT_COEFFICIENTS: ChangeoverCoefficient[] = COEFFICIENTS.map((c) =>
  c.processType !== "PET1_1STAGE" ? c : c.changeoverType === "BM" ? { ...c, hours: 2, factor: 0.91, nextDayStart: false } : { ...c, hours: 6, factor: 0.75, nextDayStart: false },
);
const makeInput = (overrides: Partial<EngineInput> = {}): EngineInput => baseMakeInput({ changeoverCoefficients: DRAFT_COEFFICIENTS, ...overrides });

// P1 = 500ml 원형 (L1 100,000 / L2 90,000), P2 = 1.5L 사각 (60,000, L1·L2·L3), P3 = 2L 생수 (40,000, L2·L3)
const MOLDS: DraftMold[] = PRODUCTS.map((p) => ({ id: `M-${p.id}`, moldNo: p.code, name: p.name, productIds: [p.id] }));
const hist = (lineId: string, date: string, productId: string, changeoverType: "NONE" | "BM" | "FULL" = "NONE"): DraftHistoryCell => ({
  lineId,
  date,
  productId,
  changeoverType,
  moldId: `M-${productId}`,
  sourceLabel: "10/22 주 Rev 1",
});
const order = (id: string, productId: string | null, qty: number, dueDate: string, extra: Partial<DraftOrder> = {}): DraftOrder => ({
  id,
  productId,
  productNameRaw: PRODUCTS.find((p) => p.id === productId)?.name ?? "모르는 제품",
  qty,
  dueDate,
  ...extra,
});
function draftInput(over: Partial<DraftInput> = {}): DraftInput {
  return {
    engine: makeInput(),
    existingCells: [],
    mode: "fill",
    orders: [],
    history: [],
    molds: MOLDS,
    stockByProduct: {},
    useNetRequirement: false,
    prevLastProductByLine: {},
    ...over,
  };
}
const at = (r: ReturnType<typeof generateDraft>, lineId: string) => r.cells.filter((c) => c.lineId === lineId).map((c) => `${c.date.slice(5)}:${c.productId}:${c.qty}:${c.changeoverType}`);

describe("초안 자동 생성", () => {
  it("과거 이력 우선: 그 제품을 생산했던 호기에 배정하고 근거를 남긴다", () => {
    // P2 는 L1·L2·L3 모두 가능하지만 이력은 L3
    const r = generateDraft(draftInput({ orders: [order("o1", "P2", 100_000, "2026-11-20")], history: [hist("L3", "2026-10-22", "P2"), hist("L3", "2026-10-23", "P2")] }));
    expect(r.cells.every((c) => c.lineId === "L3")).toBe(true);
    expect(r.cells[0]).toMatchObject({ origin: "auto", moldId: "M-P2", basis: "10/22 주 Rev 1 PET 3호기와 동일" });
    expect(r.exceptions.filter((e) => e.code === "NEW_PRODUCT")).toHaveLength(0);
  });

  it("여러 호기면 최근에 많이 쓴 호기가 먼저", () => {
    const history = [hist("L1", "2026-10-01", "P2"), hist("L1", "2026-10-02", "P2"), hist("L3", "2026-10-28", "P2"), hist("L3", "2026-10-29", "P2"), hist("L3", "2026-10-30", "P2")];
    const r = generateDraft(draftInput({ orders: [order("o1", "P2", 60_000, "2026-11-20")], history }));
    expect(r.cells[0].lineId).toBe("L3");
  });

  it("납기 순: 납기 빠른 주문이 앞 날짜를 차지한다. 동점이면 대형 거래선 먼저", () => {
    const history = [hist("L1", "2026-10-22", "P1"), hist("L1", "2026-10-23", "P2", "BM")];
    const r = generateDraft(
      draftInput({
        history,
        orders: [order("late", "P1", 100_000, "2026-11-25"), order("early", "P2", 60_000, "2026-11-13")],
      }),
    );
    const early = r.orders.find((o) => o.orderId === "early")!;
    expect(early.assignments[0].date).toBe(PERIOD_START);
    expect(early.onTime).toBe(true);
    expect(r.orders.map((o) => o.orderId)).toEqual(["early", "late"]);

    const tie = generateDraft(
      draftInput({ orders: [order("a", "P3", 10_000, "2026-11-20"), order("b", "P3", 10_000, "2026-11-20", { isMajorCustomer: true })] }),
    );
    expect(tie.orders.map((o) => o.orderId)).toEqual(["b", "a"]);
  });

  it("Capa 준수: 하루 수량은 Capa × 주말 계수를 넘지 않고, 넘치면 여러 날로 나눈다", () => {
    const r = generateDraft(draftInput({ orders: [order("o1", "P1", 350_000, "2026-11-26")], history: [hist("L1", "2026-10-22", "P1")] }));
    // 11/12(목) 100,000 · 11/13(금) 100,000 · 11/14(토) 80,000 · 11/15(일) 70,000(남은 수량)
    expect(at(r, "L1")).toEqual(["11-12:P1:100000:NONE", "11-13:P1:100000:NONE", "11-14:P1:80000:NONE", "11-15:P1:70000:NONE"]);
    expect(r.orders[0]).toMatchObject({ planned: 350_000, shortage: 0, onTime: true, status: "ok" });
    // 엔진 예상 생산량보다 크지 않다
    const calc = recalc({ ...makeInput(), cells: r.cells.map((c) => ({ ...c, qty: null })) });
    for (const c of r.cells) expect(c.qty!).toBeLessThanOrEqual(calc.cells.find((x) => x.lineId === c.lineId && x.date === c.date)!.expectedQty);
  });

  it("납기 안에 한 호기로 모자라면 다른 허용 호기로 나눈다. 가동 불가일은 건너뛴다", () => {
    const engine = makeInput({ downtimes: [{ lineId: "L1", startDate: "2026-11-12", endDate: "2026-11-12", reason: "점검" }] });
    const r = generateDraft(draftInput({ engine, orders: [order("o1", "P1", 180_000, "2026-11-13")], history: [hist("L1", "2026-10-22", "P1")] }));
    expect(at(r, "L1")).toEqual(["11-13:P1:100000:NONE"]);
    expect(at(r, "L2")).toEqual(["11-12:P1:80000:NONE"]);
    expect(r.orders[0].onTime).toBe(true);
  });

  it("교체 최소화: 같은 제품은 이어 붙이고, 전환은 이력의 교체유형(B/M)을 따른다", () => {
    const history = [hist("L1", "2026-10-22", "P1"), hist("L1", "2026-10-23", "P2", "BM"), hist("L1", "2026-10-24", "P2")];
    expect(learnTransitions(history)).toEqual({ "P1>P2": "BM" });
    const r = generateDraft(
      draftInput({ history, prevLastProductByLine: { L1: "P1" }, orders: [order("o1", "P1", 200_000, "2026-11-20"), order("o2", "P2", 100_000, "2026-11-20")] }),
    );
    // P1 은 직전 제품과 같아 교체 없이 시작, P2 로 넘어가는 날만 B/M (60,000 × 0.91 × 주말 0.8)
    expect(at(r, "L1")).toEqual(["11-12:P1:100000:NONE", "11-13:P1:100000:NONE", "11-14:P2:43680:BM", "11-15:P2:48000:NONE", "11-16:P2:8320:NONE"]);
    expect(r.exceptions.filter((e) => e.code === "CHANGEOVER_ASSUMED")).toHaveLength(0);
  });

  it("B/M 과 Full 이 모두 이력에 있으면 손실이 적은 B/M", () => {
    const history = [hist("L1", "2026-10-01", "P1"), hist("L1", "2026-10-02", "P2", "FULL"), hist("L1", "2026-10-03", "P1", "FULL"), hist("L1", "2026-10-04", "P2", "BM")];
    expect(learnTransitions(history)["P1>P2"]).toBe("BM");
  });

  it("예외 ① 신규 제품: 이력이 없으면 Capa 최대 호기에 임시 배정 + 표시", () => {
    const r = generateDraft(draftInput({ orders: [order("o1", "P1", 50_000, "2026-11-20")] }));
    expect(r.cells[0]).toMatchObject({ lineId: "L1", basis: "이력 없음 – Capa 최대 호기" });
    expect(r.exceptions.map((e) => e.code)).toContain("NEW_PRODUCT");
  });

  it("예외 ② 같은 날 같은 금형이 두 호기에 배정되면 충돌", () => {
    const engine = makeInput({ downtimes: [] });
    const r = generateDraft(draftInput({ engine, orders: [order("o1", "P1", 190_000, "2026-11-12")], history: [hist("L1", "2026-10-22", "P1")] }));
    expect(new Set(r.cells.map((c) => c.lineId))).toEqual(new Set(["L1", "L2"]));
    const conflict = r.exceptions.find((e) => e.code === "MOLD_CONFLICT");
    expect(conflict?.date).toBe("2026-11-12");
    expect(conflict?.message).toContain("PET 1호기, PET 2호기");
  });

  it("예외 ③ 납기 내 수량 부족: 부족 수량을 알리고 나머지는 납기 뒤에 배정", () => {
    const r = generateDraft(draftInput({ orders: [order("o1", "P3", 100_000, "2026-11-12")], history: [hist("L3", "2026-10-22", "P3")] }));
    // 납기일 하루에 L3 40,000 + L2 40,000 = 80,000 → 20,000 부족
    expect(r.orders[0]).toMatchObject({ plannedByDue: 80_000, shortage: 20_000, onTime: false, status: "late", planned: 100_000 });
    expect(r.exceptions.find((e) => e.code === "SHORTAGE")?.message).toContain("20,000");
  });

  it("예외 ④ 금형 정보 없음 / 후보 여럿이면 금형 칸을 비운다", () => {
    const none = generateDraft(draftInput({ molds: [], orders: [order("o1", "P1", 10_000, "2026-11-20")] }));
    expect(none.cells[0].moldId).toBeNull();
    expect(none.exceptions.find((e) => e.code === "MOLD_UNKNOWN")?.message).toContain("등록된 금형이 없어");
    const two = generateDraft(
      draftInput({ molds: [...MOLDS, { id: "M-P1b", moldNo: "A500-2", name: "500ml 원형 2호", productIds: ["P1"] }], orders: [order("o1", "P1", 10_000, "2026-11-20")] }),
    );
    expect(two.cells[0].moldId).toBeNull();
    expect(two.exceptions.find((e) => e.code === "MOLD_UNKNOWN")?.message).toContain("후보가 2개");
  });

  it("예외 ⑤ 교체유형을 이력으로 판단 못 하면 Full 로 가정하고 표시", () => {
    const r = generateDraft(draftInput({ prevLastProductByLine: { L3: "P2" }, orders: [order("o1", "P3", 30_000, "2026-11-20")], history: [hist("L3", "2026-10-22", "P3")] }));
    expect(r.cells[0]).toMatchObject({ lineId: "L3", changeoverType: "FULL", qty: 30_000 });
    expect(r.exceptions.map((e) => e.code)).toContain("CHANGEOVER_ASSUMED");
  });

  it("예외 ⑥ 기준정보와 매칭 안 된 주문은 초안에서 빼고 목록에 남긴다", () => {
    const r = generateDraft(draftInput({ orders: [order("x", null, 5_000, "2026-11-20")] }));
    expect(r.cells).toEqual([]);
    expect(r.orders[0].status).toBe("unmatched");
    expect(r.exceptions[0]).toMatchObject({ code: "UNMATCHED_ORDER", orderId: "x" });
  });

  it("기존 셀 보존: 빈 셀만 채우기는 사람이 넣은 셀을 덮어쓰지 않고, 전체 다시 만들기는 비우고 시작", () => {
    const manual = [cell("L1", PERIOD_START, "P2", { qty: 1234, memo: "사람이 입력" }), cell("L2", "2026-11-13", null, { memo: "메모만" })];
    const o = [order("o1", "P1", 100_000, "2026-11-20")];
    const history = [hist("L1", "2026-10-22", "P1")];
    const fill = generateDraft(draftInput({ existingCells: manual, orders: o, history }));
    expect(fill.cells.find((c) => c.lineId === "L1" && c.date === PERIOD_START)).toMatchObject({ productId: "P2", qty: 1234, memo: "사람이 입력" });
    expect(fill.cells.find((c) => c.lineId === "L2" && c.date === "2026-11-13")?.memo).toBe("메모만");
    expect(fill.keptCount).toBe(1);
    expect(fill.cells.some((c) => c.origin === "auto" && c.date === "2026-11-13" && c.lineId === "L1")).toBe(true);

    const rebuild = generateDraft(draftInput({ existingCells: manual, orders: o, history, mode: "rebuild" }));
    expect(rebuild.keptCount).toBe(0);
    expect(rebuild.cells.every((c) => c.origin === "auto")).toBe(true);
    expect(rebuild.cells[0]).toMatchObject({ lineId: "L1", date: PERIOD_START, productId: "P1" });
  });

  it("순 소요량: 주문 − (현재고 − 안전재고). 재고로 다 되면 배정하지 않는다", () => {
    // P2 안전재고 50,000
    const r = generateDraft(
      draftInput({
        useNetRequirement: true,
        stockByProduct: { P2: 110_000 },
        history: [hist("L3", "2026-10-22", "P2")],
        orders: [order("o1", "P2", 40_000, "2026-11-15"), order("o2", "P2", 50_000, "2026-11-18")],
      }),
    );
    expect(r.orders[0]).toMatchObject({ stockUsed: 40_000, netRequired: 0, status: "stock" });
    expect(r.orders[1]).toMatchObject({ stockUsed: 20_000, netRequired: 30_000, planned: 30_000 });
    const gross = generateDraft(draftInput({ stockByProduct: { P2: 110_000 }, history: [hist("L3", "2026-10-22", "P2")], orders: [order("o1", "P2", 40_000, "2026-11-15")] }));
    expect(gross.orders[0].planned).toBe(40_000);
  });

  it("공장 하루 교체 횟수: 한도를 지킬 수 있으면 다른 날로 미루고, 못 지키면 배정하되 경고", () => {
    const engine = makeInput({ settings: { ...makeInput().settings, dailyChangeoverLimit: 1 } });
    const prev = { L1: "P2", L3: "P2" };
    const history = [hist("L1", "2026-10-22", "P1"), hist("L3", "2026-10-22", "P3")];
    const r = generateDraft(draftInput({ engine, prevLastProductByLine: prev, history, orders: [order("o1", "P1", 50_000, "2026-11-20"), order("o2", "P3", 20_000, "2026-11-20")] }));
    // 두 주문 모두 첫날 교체가 필요하지만 한도 1회 → 두 번째 주문은 다음 날로
    expect(r.cells.find((c) => c.productId === "P1")?.date).toBe("2026-11-12");
    expect(r.cells.find((c) => c.productId === "P3")?.date).toBe("2026-11-13");
    expect(r.exceptions.filter((e) => e.code === "CONSTRAINT")).toHaveLength(0);

    // 교체 없이 받을 수 있는 다른 호기(L2)도 막혀 있으면 한도를 넘겨 배정하고 경고한다
    const blocked = makeInput({ settings: engine.settings, downtimes: [{ lineId: "L2", startDate: "2026-11-12", endDate: "2026-11-12", reason: "점검" }] });
    const tight = generateDraft(draftInput({ engine: blocked, prevLastProductByLine: prev, history, orders: [order("o1", "P1", 50_000, "2026-11-12"), order("o2", "P3", 20_000, "2026-11-12")] }));
    expect(tight.exceptions.some((e) => e.code === "CONSTRAINT" && e.message.includes("교체 횟수"))).toBe(true);
    expect(tight.orders.every((o) => o.onTime)).toBe(true);
  });

  it("결정성: 같은 입력이면 같은 결과 (주문 순서를 섞어도)", () => {
    const orders = [order("a", "P1", 250_000, "2026-11-18"), order("b", "P2", 150_000, "2026-11-16"), order("c", "P3", 90_000, "2026-11-22"), order("d", "P1", 80_000, "2026-11-18")];
    const history = [hist("L1", "2026-10-22", "P1"), hist("L1", "2026-10-23", "P2", "BM"), hist("L3", "2026-10-22", "P3")];
    const a = generateDraft(draftInput({ orders, history }));
    const b = generateDraft(draftInput({ orders: orders.slice().reverse(), history: history.slice().reverse() }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("NFR-05 성능: 18호기 × 15일, 주문 60건이 1초 이내", () => {
    const lines: Line[] = Array.from({ length: 18 }, (_, i) => ({ ...LINES[0], id: `L${i + 1}`, code: `PET${i + 1}`, name: `PET ${i + 1}호기`, sortOrder: i + 1 }));
    const products: Product[] = Array.from({ length: 40 }, (_, i) => ({ ...PRODUCTS[0], id: `P${i + 1}`, code: `C${i + 1}`, name: `제품 ${i + 1}`, defaultDailyCapa: 30_000 + (i % 7) * 5_000 }));
    const allowedMolds = products.flatMap((p, i) => [0, 1, 2].map((k) => ({ lineId: `L${((i + k * 5) % 18) + 1}`, productId: p.id })));
    const engine = makeInput({ lines, products, allowedMolds, capacities: [] });
    const history: DraftHistoryCell[] = products.flatMap((p, i) =>
      Array.from({ length: 10 }, (_, d) => ({ lineId: `L${(i % 18) + 1}`, date: `2026-10-${String(10 + ((d + i) % 18)).padStart(2, "0")}`, productId: p.id, changeoverType: d === 0 ? ("BM" as const) : ("NONE" as const), sourceLabel: "과거" })),
    );
    const orders: DraftOrder[] = Array.from({ length: 60 }, (_, i) => ({ id: `o${i}`, productId: `P${(i % 40) + 1}`, productNameRaw: "", qty: 40_000 + (i % 9) * 15_000, dueDate: `2026-11-${String(13 + (i % 13)).padStart(2, "0")}` }));
    const t0 = performance.now();
    const r = generateDraft({ engine, existingCells: [], mode: "rebuild", orders, history, molds: [], stockByProduct: {}, useNetRequirement: false, prevLastProductByLine: {} });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(1000);
    expect(r.cells.length).toBeGreaterThan(50);
    expect(r.cells.length).toBeLessThanOrEqual(18 * 15);
  });
});

describe("초안 자동 생성 · 같은 금형을 쓰는 품번", () => {
  // P2 와 P3 가 금형 하나(M-SHARED)를 같이 쓴다
  const shared: DraftMold[] = [
    { id: "M-P1", moldNo: "A500", name: "500ml 원형", productIds: ["P1"] },
    { id: "M-SHARED", moldNo: "S-01", name: "1.5L·2L 공용", productIds: ["P2", "P3"] },
  ];

  it("같은 금형을 쓰는 품번은 연속으로 배치하고 그 사이에는 금형 교체가 없다", () => {
    const r = generateDraft(
      draftInput({
        molds: shared,
        history: [hist("L3", "2026-10-22", "P2")].map((h) => ({ ...h, moldId: "M-SHARED" })),
        orders: [order("o1", "P2", 100_000, "2026-11-20"), order("o2", "P1", 50_000, "2026-11-21"), order("o3", "P3", 60_000, "2026-11-22")],
      }),
    );
    const l3 = r.cells.filter((c) => c.lineId === "L3");
    // P2 다음에 바로 P3 가 같은 호기에 이어지고, 넘어가는 날에도 교체 표시가 없다
    expect(l3.map((c) => c.productId)).toEqual(["P2", "P2", "P3", "P3"]);
    expect(l3.every((c) => c.changeoverType === "NONE" && c.moldId === "M-SHARED")).toBe(true);
    expect(l3[2].basis).toContain("같은 금형을 쓰는 1.5L 사각 이력");
    expect(r.exceptions.filter((e) => e.code === "CHANGEOVER_ASSUMED" || e.code === "NEW_PRODUCT")).toHaveLength(1); // P1 만 신규
    // 엔진 재계산에서도 같은 금형 전환은 교체 손실이 없다
    const calc = recalc({ ...makeInput(), cells: r.cells });
    expect(calc.cells.find((c) => c.lineId === "L3" && c.date === l3[2].date)?.effectiveChangeover).toBe("NONE");
  });

  it("금형이 다르면 품번이 바뀌는 날 교체가 생긴다 (대조)", () => {
    const r = generateDraft(draftInput({ history: [hist("L3", "2026-10-22", "P2")], orders: [order("o1", "P2", 60_000, "2026-11-20"), order("o3", "P3", 40_000, "2026-11-22")], prevLastProductByLine: {} }));
    const p3 = r.cells.find((c) => c.productId === "P3")!;
    expect(p3.lineId === "L3" ? p3.changeoverType : "FULL").toBe("FULL");
  });
});
