/**
 * FR-03 현행 주간 생산계획표 가져오기 테스트
 * 가상 파일 data/fake/주간생산계획_2611_Rev0.xlsx 를 읽는다 (없으면 생성기로 메모리에서 만든다).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { buildFakePlanBuffer, buildFakePlanWorkbook, generateDataset, type FakeDataset } from "../../../scripts/make-fake-data";
import { lineLabelToCode, parseDateHeaders, parsePlanCellText, parsePlanWorkbook, workbookToBuffer, type PlanImportResult } from "../../../lib/excel";
import { PLAN_DATE_ROW, PLAN_SHEET_NAME } from "../../../lib/excel/export-plan";

const cellKey = (c: { lineId: string; date: string; productId: string | null; qty: number | null; changeoverType: string }) =>
  `${c.lineId}|${c.date}|${c.productId}|${c.qty}|${c.changeoverType}`;

describe("FR-03 parsePlanWorkbook · 가상 계획표", () => {
  let ds: FakeDataset;
  let result: PlanImportResult;

  beforeAll(async () => {
    ds = generateDataset();
    const path = join(process.cwd(), "data", "fake", ds.files.plan);
    const buf = existsSync(path) ? readFileSync(path) : await buildFakePlanBuffer(ds);
    result = await parsePlanWorkbook(buf, {
      lines: ds.lines.map((l) => ({ id: l.id, code: l.code, name: l.name })),
      products: ds.products.map((p) => ({ id: p.id, name: p.name })),
      periodStart: ds.periodStart,
    });
  });

  it("FR-03 시트·날짜 15개를 읽는다", () => {
    expect(result.sheetName).toBe(PLAN_SHEET_NAME);
    expect(result.periodStart).toBe("2026-11-12");
    expect(result.dates).toHaveLength(15);
    expect(result.dates[0]).toBe("2026-11-12");
    expect(result.dates[14]).toBe("2026-11-26");
  });

  it("FR-03 제품 셀을 200개 이상 읽고 Rev 0 셀과 정확히 일치한다", () => {
    const productCells = result.cells.filter((c) => c.productId !== null);
    expect(productCells.length).toBeGreaterThanOrEqual(200);
    expect(productCells.length).toBe(ds.rev0.cells.length);
    const got = new Set(productCells.map(cellKey));
    const want = new Set(ds.rev0.cells.map(cellKey));
    expect(got).toEqual(want);
  });

  it("FR-03 기준정보에 없는 제품명은 unmatched 에 정확히 2건", () => {
    expect(result.unmatched).toHaveLength(2);
    const texts = result.unmatched.map((u) => u.text.split("\n")[0]).sort();
    expect(texts).toEqual(["1.2L 원형 D", "750ml 타원형"]);
    for (const u of result.unmatched) {
      expect(u.sheet).toBe(PLAN_SHEET_NAME);
      expect(u.cellRef).toMatch(/^[A-Z]+\d+$/);
      expect(["PET9", "PET16"]).toContain(u.lineCode);
    }
  });

  it("FR-03 Q1 '사출기' 행은 경고와 함께 건너뛴다", () => {
    const w = result.warnings.find((x) => x.includes("사출기"));
    expect(w).toBeDefined();
    expect(w).toContain("해석 불가 숫자");
    expect(result.lineRows.some((r) => r.lineCode.includes("사출기"))).toBe(false);
    expect(result.lineRows).toHaveLength(18);
  });

  it("FR-03 교체 마커 (B/M)·(Full) 를 교체유형으로 읽는다", () => {
    const bm = result.cells.filter((c) => c.changeoverType === "BM").length;
    const full = result.cells.filter((c) => c.changeoverType === "FULL").length;
    expect(bm).toBeGreaterThan(0);
    expect(full).toBeGreaterThanOrEqual(2);
    expect(bm).toBe(ds.rev0.cells.filter((c) => c.changeoverType === "BM").length);
    expect(full).toBe(ds.rev0.cells.filter((c) => c.changeoverType === "FULL").length);
  });

  it("FR-03 가동 불가 텍스트 셀은 빈 셀 + 경고 (다운타임은 만들지 않음)", () => {
    const pet7 = ds.lines.find((l) => l.code === "PET7")!;
    const dt = result.cells.filter((c) => c.productId === null);
    expect(dt.map((c) => `${c.lineId}|${c.date}`).sort()).toEqual([`${pet7.id}|2026-11-17`, `${pet7.id}|2026-11-18`]);
    expect(dt.every((c) => c.memo === "설비 고장")).toBe(true);
    expect(result.warnings.filter((w) => w.includes("가동 불가")).length).toBe(2);
  });

  it("FR-03 B열 생산가능금형 목록을 읽는다", () => {
    const pet1 = ds.lines.find((l) => l.code === "PET1")!;
    const names = ds.allowedMolds.filter((m) => m.lineId === pet1.id).map((m) => ds.products.find((p) => p.id === m.productId)!.name);
    const row = result.lineRows.find((r) => r.lineCode === "PET1")!;
    expect(row.allowedMoldNames.sort()).toEqual(names.sort());
  });

  it("FR-03 2행 실제 날짜가 없으면 '11/12(목)' 헤더 텍스트로 날짜를 복원한다", async () => {
    const wb = await buildFakePlanWorkbook(ds);
    const ws = wb.getWorksheet(PLAN_SHEET_NAME)!;
    ws.getRow(PLAN_DATE_ROW).eachCell((c) => (c.value = null));
    const buf = await workbookToBuffer(wb);
    const r = await parsePlanWorkbook(buf, {
      lines: ds.lines,
      products: ds.products,
      // periodStart 없이 → 제목의 '2026-11-12' 에서 연도 추정
    });
    expect(r.dates).toEqual(ds.dates);
    expect(r.cells.filter((c) => c.productId).length).toBe(ds.rev0.cells.length);
  });

  it("FR-03 호기 라벨 변형(PET1 / PET 1 / 1호기)도 같은 호기로 매칭", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("1팀 PET1");
    ws.getCell("A1").value = "주간 생산계획 2026년 11월";
    ws.getCell("A3").value = "호기";
    ws.getCell("B3").value = "생산가능금형";
    ws.getCell("C3").value = "11/12(목)";
    ws.getCell("D3").value = "11/13(금)";
    const p = ds.products[0];
    ws.getCell("A4").value = "PET1";
    ws.getCell("C4").value = `${p.name}\n96,000`;
    ws.getCell("A5").value = "PET 2";
    ws.getCell("C5").value = { richText: [{ text: p.name }, { text: " (B/M)" }] };
    ws.getCell("A6").value = "3호기";
    ws.getCell("D6").value = `${p.name} (풀셋)`;
    const buf = await workbookToBuffer(wb);
    const r = await parsePlanWorkbook(buf, { lines: ds.lines, products: ds.products });
    const byCode = (code: string) => ds.lines.find((l) => l.code === code)!.id;
    expect(r.dates).toEqual(["2026-11-12", "2026-11-13"]);
    expect(r.cells).toEqual([
      { lineId: byCode("PET1"), date: "2026-11-12", productId: p.id, qty: 96000, changeoverType: "NONE" },
      { lineId: byCode("PET2"), date: "2026-11-12", productId: p.id, qty: null, changeoverType: "BM" },
      { lineId: byCode("PET3"), date: "2026-11-13", productId: p.id, qty: null, changeoverType: "FULL" },
    ]);
    expect(r.unmatched).toHaveLength(0);
  });
});

describe("FR-03 셀 텍스트·헤더 해석 단위 규칙", () => {
  it("parsePlanCellText: 제품명 / 마커 / 수량", () => {
    expect(parsePlanCellText("500ml 원형 A (B/M)\n96,000")).toMatchObject({ kind: "product", productName: "500ml 원형 A", changeoverType: "BM", qty: 96000 });
    expect(parsePlanCellText("1L 원형 B (Full)")).toMatchObject({ kind: "product", productName: "1L 원형 B", changeoverType: "FULL", qty: null });
    expect(parsePlanCellText("1L 원형 B(풀셋)\n80000본")).toMatchObject({ productName: "1L 원형 B", changeoverType: "FULL", qty: 80000 });
    expect(parsePlanCellText("  2L   사각 C  ")).toMatchObject({ kind: "product", productName: "2L 사각 C", changeoverType: "NONE" });
    expect(parsePlanCellText("설비 고장")).toMatchObject({ kind: "downtime" });
    expect(parsePlanCellText("정전 (VCB 교체)")).toMatchObject({ kind: "downtime" });
    expect(parsePlanCellText("2.8")).toMatchObject({ kind: "number", qty: 2.8 });
    expect(parsePlanCellText("")).toMatchObject({ kind: "empty" });
  });

  it("lineLabelToCode: 'PET 1호기' / 'PET1' / 'PET 1' / 'pet-01' → PET1", () => {
    for (const s of ["PET 1호기", "PET1", "PET 1", "pet-01", "Pet1호기"]) expect(lineLabelToCode(s)).toBe("PET1");
    expect(lineLabelToCode("PET 12호기")).toBe("PET12");
    expect(lineLabelToCode("A1 사출기")).toBe("A1사출기");
  });

  it("parseDateHeaders: 연도 경계(12월→1월)에서 연도를 올린다", () => {
    expect(parseDateHeaders(["12/30(수)", "12/31(목)", "1/1(금)", "2027-01-02"], 2026)).toEqual(["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
  });
});
