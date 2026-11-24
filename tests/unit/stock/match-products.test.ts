import { describe, expect, it } from "vitest";
import { isSubRowName, matchScore, proposeProductLinks } from "../../../lib/stock/match-products";

const PRODUCTS = [
  { id: "kim15", name: "대상 김치 1.5kg" },
  { id: "kim12", name: "대상 김치 1.2kg" },
  { id: "r165", name: "1.65L 원형" },
  { id: "s165", name: "1.65L 사각" },
  { id: "s15", name: "1.5L 사각" },
  { id: "hdnr", name: "1.8L HD - N - RED" },
  { id: "hdny", name: "1.8L HD - N - YELLOW" },
  { id: "cj", name: "CJ 치킨스톡 300ML" },
];

describe("수불표 품목 ↔ 제품 점수", () => {
  it("단위가 빠져도 숫자가 같으면 같은 제품", () => {
    expect(matchScore("대상 김치 1.5", "대상 김치 1.5kg")).toBe(1);
    expect(matchScore("대상 김치 1.5", "대상 김치 1.2kg")).toBe(0);
  });
  it("뒤에 붙은 구분(_대경 전용)은 무시하고 앞부분으로 찾는다", () => {
    expect(matchScore("1.65L 원형_대경 전용", "1.65L 원형")).toBeGreaterThanOrEqual(0.75);
    expect(matchScore("1.65L 원형_대경 전용", "1.65L 사각")).toBeLessThan(0.5);
  });
  it("용량이 다르면 다른 제품", () => {
    expect(matchScore("1.65L 사각", "1.5L 사각")).toBe(0);
  });
  it("색 이름은 한글·영문을 같은 것으로 본다", () => {
    expect(matchScore("#_ 1.8L HD _ N 적색 (114개)", "1.8L HD - N - RED")).toBeGreaterThanOrEqual(0.75);
    expect(matchScore("#_ 1.8L HD _ N 적색 (114개)", "1.8L HD - N - YELLOW")).toBeLessThan(0.75);
  });
  it("단위가 둘 다 있고 다르면 다른 낱말", () => {
    expect(matchScore("CJ 치킨스톡 300G", "CJ 치킨스톡 300ML")).toBeLessThan(0.75);
  });
});

describe("연결 제안", () => {
  const item = (key: string, name: string, productId: string | null = null) => ({ key, name, productId });

  it("확실하면 자동 제안, 애매하면 후보 여럿, 없으면 못 찾음", () => {
    const r = proposeProductLinks([item("a", "대상 김치 1.5"), item("b", "CJ 치킨스톡 300G"), item("c", "보해 잎새 1.8L 35%")], PRODUCTS);
    expect(r.proposals.find((p) => p.key === "a")).toMatchObject({ kind: "auto", productId: "kim15" });
    expect(r.proposals.find((p) => p.key === "b")).toMatchObject({ kind: "candidates", productId: "cj" });
    expect(r.unmatched).toEqual(["보해 잎새 1.8L 35%"]);
  });

  it("이미 연결된 품목은 건드리지 않는다", () => {
    const r = proposeProductLinks([item("a", "대상 김치 1.5", "kim12")], PRODUCTS);
    expect(r.linked).toBe(1);
    expect(r.proposals).toEqual([]);
  });

  it("생산일·반품 구분 줄은 윗 품목과 같은 제품으로 제안한다", () => {
    expect(isSubRowName("10/1일 생산~")).toBe(true);
    expect(isSubRowName("반 품(10/8일)")).toBe(true);
    expect(isSubRowName("대상 김치 1.5")).toBe(false);
    const r = proposeProductLinks([item("a", "대상 김치 1.5"), item("b", "10/1일 생산~"), item("c", "반 품(10/8일)"), item("d", "보해 잎새"), item("e", "8/20일 생산~")], PRODUCTS);
    expect(r.proposals.filter((p) => p.kind === "parent").map((p) => [p.key, p.productId])).toEqual([
      ["b", "kim15"],
      ["c", "kim15"],
    ]);
    // 윗 품목을 못 찾았으면 그 아랫줄도 제안하지 않는다
    expect(r.unmatched).toEqual(["보해 잎새", "8/20일 생산~"]);
  });

  it("낱말이 전부 맞으면 비슷한 후보가 있어도 자동으로 정한다", () => {
    const r = proposeProductLinks([item("a", "HD 1.8 N -적색")], [...PRODUCTS, { id: "hdn", name: "1.8L HD - N" }]);
    expect(r.proposals[0]).toMatchObject({ kind: "auto", productId: "hdnr", score: 1 });
  });

  it("제품 이름이 너무 짧아 품목의 일부만 맞으면 자동으로 정하지 않는다", () => {
    const r = proposeProductLinks([item("a", "PE 5L 말통")], [{ id: "p5", name: "5L" }]);
    expect(r.proposals[0]?.kind).not.toBe("auto");
  });

  it("점수가 비슷한 후보가 둘이면 자동으로 정하지 않는다", () => {
    const r = proposeProductLinks([item("a", "1.8L HD N")], PRODUCTS);
    expect(r.proposals[0].kind).toBe("candidates");
    expect(r.proposals[0].candidates.map((c) => c.productId).sort()).toEqual(["hdnr", "hdny"]);
  });
});
