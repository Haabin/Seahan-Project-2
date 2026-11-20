import { describe, expect, it } from "vitest";
import {
  normalizePurchaseRows,
  parsePurchaseCsv,
  parsePurchaseJson,
} from "./normalize";

describe("발주의뢰서 표준화", () => {
  it("한글 열 이름과 천 단위 수량을 표준 필드로 변환한다", () => {
    const result = normalizePurchaseRows([
      {
        품번: "P-01",
        품명: "PET",
        발주수량: "1,200",
        납기일: "2026-12-01",
        거래처: "테스트 거래처",
      },
    ]);
    expect(result.rows[0]).toMatchObject({
      productCode: "P-01",
      productName: "PET",
      quantity: 1200,
      requestedDate: "2026-12-01",
      customer: "테스트 거래처",
    });
    expect(result.warnings).toEqual([]);
  });
  it("쉼표와 줄바꿈이 포함된 CSV 셀을 유지한다", () => {
    const result = parsePurchaseCsv(
      '품번,품명,수량,비고\nP-02,"제품, 특수",2,"첫 줄\n둘째 줄"\n',
    );
    expect(result.rows[0].productName).toBe("제품, 특수");
    expect(result.rows[0].note).toBe("첫 줄\n둘째 줄");
  });
  it("수량 오류와 제품 누락을 검토 경고로 표시한다", () => {
    const result = parsePurchaseJson(JSON.stringify([{ 수량: "-5" }]));
    expect(result.rows[0].quantity).toBeNull();
    expect(result.warnings).toHaveLength(2);
  });
  it("중복 CSV 열 이름은 거부한다", () => {
    expect(() => parsePurchaseCsv("품번,품번,수량\na,b,1")).toThrow(
      "중복된 CSV 열 이름",
    );
  });
});

import { reviewErrors } from "./review";
import { importPurchase } from "./import";
import { Workbook } from "exceljs";

it("헤더 앞의 거래처와 반복 표제, 실제 날짜 셀을 여러 시트에서 읽는다", async () => {
  const book = new Workbook();
  for (const code of ["A", "B"]) {
    const sheet = book.addWorksheet(code);
    sheet.addRows([
      ["발주의뢰서"],
      ["거래처", "샘플"],
      ["품번", "품명", "수량", "납기일"],
      [code, "품목", 12, new Date("2026-11-30T00:00:00Z")],
      ["합계", "", 12],
    ]);
  }
  const file = new File(
    [(await book.xlsx.writeBuffer()) as BlobPart],
    "test.xlsx",
  );
  const result = await importPurchase(file);
  expect(result.rows.map((r) => r.productCode)).toEqual(["A", "B"]);
  expect(reviewErrors(result.rows, "")).toEqual([]);
});

it("윤년이 아닌 날짜·중복 행·잘못된 천 단위 구분을 차단한다", () => {
  const { rows } = parsePurchaseCsv(
    '품번,품명,수량,납기일,거래처\nA,B,"1,2",2026-02-29,C',
  );
  expect(rows[0].quantity).toBeNull();
  expect(reviewErrors([...rows, ...rows], "").join(" ")).toMatch(/같은 품목/);
  expect(reviewErrors(rows, "").join(" ")).toMatch(/납기일/);
});
