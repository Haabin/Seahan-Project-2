/**
 * FR-12 주간 생산계획 엑셀 내보내기 테스트 · 내보낸 파일을 FR-03 파서로 다시 읽으면 같은 셀 집합이어야 한다.
 */
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { generateDataset } from "../../../scripts/make-fake-data";
import { buildPlanWorkbook, formatPlanCellText, parsePlanWorkbook } from "../../../lib/excel";
import { PLAN_DATE_ROW, PLAN_FIRST_DATE_COL, PLAN_HEADER_ROW, PLAN_SHEET_NAME } from "../../../lib/excel/export-plan";

const cellKey = (c: { lineId: string; date: string; productId: string | null; qty: number | null; changeoverType: string }) =>
  `${c.lineId}|${c.date}|${c.productId}|${c.qty}|${c.changeoverType}`;

describe("FR-12 buildPlanWorkbook", () => {
  const ds = generateDataset();
  const petLines = ds.lines.filter((l) => l.isPlanTarget);

  async function build() {
    return buildPlanWorkbook({
      periodStart: ds.periodStart,
      dates: ds.dates,
      lines: petLines,
      products: ds.products,
      allowedMolds: ds.allowedMolds,
      cells: ds.rev0.cells,
      downtimes: ds.downtimes,
      revisionLabel: "Rev 0",
    });
  }

  it("FR-12 → FR-03 왕복: (호기, 날짜, 제품, 수량, 교체유형) 집합이 보존된다", async () => {
    const buf = await build();
    expect(Buffer.isBuffer(buf)).toBe(true);
    const r = await parsePlanWorkbook(buf, { lines: ds.lines, products: ds.products, periodStart: ds.periodStart });
    expect(r.unmatched).toHaveLength(0);
    expect(r.dates).toEqual(ds.dates);
    const got = new Set(r.cells.filter((c) => c.productId !== null).map(cellKey));
    const want = new Set(ds.rev0.cells.map(cellKey));
    expect(got).toEqual(want);
    // 다운타임 사유 텍스트 셀 2개 (PET7 11-17, 11-18)
    expect(r.cells.filter((c) => c.productId === null)).toHaveLength(2);
  });

  it("FR-12 레이아웃: 시트명·틀 고정·숨김 날짜 행·주말 회색 헤더·B열 금형", async () => {
    const buf = await build();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet(PLAN_SHEET_NAME)!;
    expect(ws).toBeDefined();
    expect(ws.views[0]).toMatchObject({ state: "frozen", xSplit: 2, ySplit: PLAN_HEADER_ROW });
    expect(ws.getRow(PLAN_DATE_ROW).hidden).toBe(true);
    expect(ws.getCell(PLAN_DATE_ROW, PLAN_FIRST_DATE_COL).value).toBeInstanceOf(Date);
    expect(ws.getCell(PLAN_HEADER_ROW, 1).value).toBe("호기");
    expect(ws.getCell(PLAN_HEADER_ROW, 2).value).toBe("생산가능금형");
    expect(ws.getCell(PLAN_HEADER_ROW, PLAN_FIRST_DATE_COL).value).toBe("11/12(목)");
    // 11/14(토) = 3번째 날짜 열
    const sat = ws.getCell(PLAN_HEADER_ROW, PLAN_FIRST_DATE_COL + 2);
    expect(sat.value).toBe("11/14(토)");
    expect((sat.fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFEDEDED");
    const thu = ws.getCell(PLAN_HEADER_ROW, PLAN_FIRST_DATE_COL);
    expect((thu.fill as ExcelJS.FillPattern).fgColor?.argb).not.toBe("FFEDEDED");
    // 호기 행
    expect(ws.getCell(PLAN_HEADER_ROW + 1, 1).value).toBe("PET 1호기");
    expect(ws.getCell(PLAN_HEADER_ROW + 18, 1).value).toBe("PET 18호기");
    expect(String(ws.getCell(PLAN_HEADER_ROW + 1, 2).value)).toContain(", ");
    // 글꼴
    expect(ws.getCell(PLAN_HEADER_ROW + 1, PLAN_FIRST_DATE_COL).font?.name).toBe("Malgun Gothic");
    // 다운타임 셀 회색 + 사유
    const pet7Row = PLAN_HEADER_ROW + 7;
    const dtCell = ws.getCell(pet7Row, PLAN_FIRST_DATE_COL + ds.dates.indexOf("2026-11-17"));
    expect(dtCell.value).toBe("설비 고장");
    expect((dtCell.fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFBFBFBF");
    // 다운타임인데 셀이 있는 PET12 11-20 은 제품 텍스트 + 회색
    const pet12Row = PLAN_HEADER_ROW + 12;
    const v = ws.getCell(pet12Row, PLAN_FIRST_DATE_COL + ds.dates.indexOf("2026-11-20"));
    expect(String(v.value)).not.toContain("정전");
    expect((v.fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFBFBFBF");
    // 열 너비
    expect(ws.getColumn(2).width).toBeGreaterThanOrEqual(30);
  });

  it("FR-12 셀 텍스트 규칙: '제품명 (B/M)\\n96,000'", () => {
    expect(formatPlanCellText("500ml 원형 A", 96000, "BM")).toBe("500ml 원형 A (B/M)\n96,000");
    expect(formatPlanCellText("500ml 원형 A", null, "FULL")).toBe("500ml 원형 A (Full)");
    expect(formatPlanCellText("500ml 원형 A", 1200000, "NONE")).toBe("500ml 원형 A\n1,200,000");
  });
});
