import { describe, expect, it } from "vitest";
import { normalizePurchaseRows, parsePurchaseCsv, parsePurchaseJson } from "./normalize";

describe("발주의뢰서 표준화", () => {
  it("한글 열 이름과 천 단위 수량을 표준 필드로 변환한다", () => {
    const result = normalizePurchaseRows([{ 품번: "P-01", 품명: "PET", 발주수량: "1,200", 납기일: "2026-12-01", 거래처: "테스트 거래처" }]);
    expect(result.rows[0]).toMatchObject({ productCode: "P-01", productName: "PET", quantity: 1200, requestedDate: "2026-12-01", customer: "테스트 거래처" });
    expect(result.warnings).toEqual([]);
  });
  it("쉼표와 줄바꿈이 포함된 CSV 셀을 유지한다", () => {
    const result = parsePurchaseCsv('품번,품명,수량,비고\nP-02,"제품, 특수",2,"첫 줄\n둘째 줄"\n');
    expect(result.rows[0].productName).toBe("제품, 특수");
    expect(result.rows[0].note).toBe("첫 줄\n둘째 줄");
  });
  it("수량 오류와 제품 누락을 검토 경고로 표시한다", () => {
    const result = parsePurchaseJson(JSON.stringify([{ 수량: "-5" }]));
    expect(result.rows[0].quantity).toBeNull();
    expect(result.warnings).toHaveLength(2);
  });
  it("중복 CSV 열 이름은 거부한다", () => {
    expect(() => parsePurchaseCsv("품번,품번,수량\na,b,1")).toThrow("중복된 CSV 열 이름");
  });
});
