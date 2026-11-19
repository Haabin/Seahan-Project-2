/**
 * 제품수불표 파서·내보내기 테스트 (가상 파일)
 */
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  buildStockLedgerWorkbook,
  inferLedgerYearMonth,
  parseStockLedgerWorkbook,
  stockTotals,
  type StockLedgerRow,
} from "../../../lib/excel/stock-ledger";
import { loadWorkbook, workbookToBuffer } from "../../../lib/excel/common";
import { buildFakeStockLedgerBuffer, generateFakeStockRows } from "../../../scripts/fake/stock-ledger";

const row = (over: Partial<StockLedgerRow>): StockLedgerRow => ({
  section: "PS",
  process: "P S",
  machineLabel: "BNP",
  itemCode: null,
  name: "PE 5L 말통",
  dupIndex: 0,
  opening: 1000,
  packUnit: 80,
  unitsPerPallet: 10,
  days: [],
  ...over,
});

const ROWS: StockLedgerRow[] = [
  row({ days: [{ day: 1, produced: 800, shipped: 160 }, { day: 3, produced: 0, shipped: 240 }] }),
  row({ name: "PE 10L 말통", itemCode: "A-100", packUnit: 64, unitsPerPallet: 1, opening: 0 }),
  row({ section: "1219", process: "1219", machineLabel: "S7", name: "가상 소주 1.8L 35%", opening: 0, packUnit: 6, unitsPerPallet: 60 }),
  row({ section: "1219", process: "1219", machineLabel: "S7", name: "가상 소주 1.8L 35%", dupIndex: 1, opening: 600, packUnit: 6, unitsPerPallet: 60, days: [{ day: 2, produced: -30, shipped: 0 }] }),
];

const strip = (rows: StockLedgerRow[]) =>
  rows.map((r) => {
    const copy = { ...r };
    delete copy.sourceRow;
    return copy;
  });

describe("제품수불표 · 계산", () => {
  it("현재고 = 기초 + 생산 − 출고, 포장수량·EA/1P·PT 수는 엑셀 수식과 같다", () => {
    const t = stockTotals(ROWS[0]);
    expect(t).toEqual({ produced: 800, shipped: 400, current: 1400, packQty: 17.5, eaPerPallet: 800, pallets: 2 });
    expect(stockTotals(ROWS[0], 1).current).toBe(1640);
    expect(stockTotals(row({ packUnit: null })).packQty).toBeNull();
  });

  it("연·월 추정: 시트명·파일명. 못 찾으면 null", () => {
    expect(inferLedgerYearMonth("11월 제품수불표", "재고현황_제품수불표 예시.xlsx")).toEqual({ year: null, month: 11 });
    expect(inferLedgerYearMonth("11월 제품수불표", "26년 11월 수불표.xlsx")).toEqual({ year: 2026, month: 11 });
    expect(inferLedgerYearMonth("Sheet1", "제품수불표_2026-11.xlsx")).toEqual({ year: 2026, month: 11 });
    expect(inferLedgerYearMonth("Sheet1", "수불표.xlsx")).toEqual({ year: null, month: null });
  });
});

describe("제품수불표 · 가져오기", () => {
  it("내보내기 왕복: 내보낸 파일을 다시 읽으면 값이 같다 (소계·요약·합계 행은 제외)", async () => {
    const buf = await buildStockLedgerWorkbook({ year: 2026, month: 11, rows: ROWS });
    const r = await parseStockLedgerWorkbook(buf, { filename: "제품수불표_2026-11.xlsx" });
    expect(r.year).toBe(2026);
    expect(r.month).toBe(11);
    expect(r.sections).toEqual(["PS", "1219"]);
    expect(strip(r.rows)).toEqual(ROWS);
  });

  it("중복 품명: 합치지 않고 순번으로 구분 + 경고", async () => {
    const buf = await buildStockLedgerWorkbook({ year: 2026, month: 11, rows: ROWS });
    const r = await parseStockLedgerWorkbook(buf, { filename: "제품수불표_2026-11.xlsx" });
    const dups = r.rows.filter((x) => x.name === "가상 소주 1.8L 35%");
    expect(dups.map((d) => d.dupIndex)).toEqual([0, 1]);
    expect(dups[1].opening).toBe(600);
    expect(r.warnings.filter((w) => w.includes("같은 품명"))).toHaveLength(1);
  });

  it("품명 끝 공백 정리, 공정·호기가 빈 행은 윗 행을 이어받는다", async () => {
    const buf = await buildFakeStockLedgerBuffer(ROWS, { quirks: { trailingSpaceAt: [0], blankProcessAt: [1] } });
    const r = await parseStockLedgerWorkbook(buf, { filename: "26년 11월.xlsx" });
    expect(r.rows[0].name).toBe("PE 5L 말통");
    expect(r.rows[1]).toMatchObject({ process: "P S", machineLabel: "BNP", name: "PE 10L 말통" });
    expect(r.warnings.some((w) => w.includes("이어받았습니다"))).toBe(true);
    expect(strip(r.rows)).toEqual(ROWS);
  });

  it("수식 결과값이 없어도 직접 계산한다", async () => {
    const wb = await loadWorkbook(await buildStockLedgerWorkbook({ year: 2026, month: 11, rows: ROWS }));
    const ws = wb.worksheets[0];
    // 수식만 남기고 저장된 결과를 지운다(다른 프로그램이 저장한 파일을 흉내)
    ws.eachRow((r) =>
      r.eachCell((c) => {
        const v = c.value as ExcelJS.CellFormulaValue | null;
        if (v && typeof v === "object" && "formula" in v) c.value = { formula: v.formula } as ExcelJS.CellFormulaValue;
      }),
    );
    const r = await parseStockLedgerWorkbook(await workbookToBuffer(wb), { filename: "제품수불표_2026-11.xlsx" });
    expect(strip(r.rows)).toEqual(ROWS);
    expect(stockTotals(r.rows[0]).current).toBe(1400);
  });

  it("월 추정 실패 → null + 경고, 헤더가 없으면 빈 결과 + 경고", async () => {
    const buf = await buildFakeStockLedgerBuffer(ROWS, { sheetName: "Sheet1" });
    const r = await parseStockLedgerWorkbook(buf, { filename: "수불표.xlsx" });
    expect(r.month).toBeNull();
    expect(r.year).toBeNull();
    expect(r.warnings.some((w) => w.includes("월을 찾지 못했습니다"))).toBe(true);
    expect(r.rows).toHaveLength(4);

    const empty = new ExcelJS.Workbook();
    empty.addWorksheet("11월 제품수불표").getCell("A1").value = "아무 표";
    const bad = await parseStockLedgerWorkbook(await workbookToBuffer(empty));
    expect(bad.rows).toEqual([]);
    expect(bad.warnings[0]).toContain("헤더 행");
  });

  it("그 달에 없는 날짜(31일) 값은 읽지 않고 경고", async () => {
    const rows = [row({ days: [{ day: 31, produced: 80, shipped: 0 }] })];
    const buf = await buildStockLedgerWorkbook({ year: 2026, month: 11, rows });
    const r = await parseStockLedgerWorkbook(buf, { filename: "제품수불표_2026-11.xlsx" });
    expect(r.rows[0].days).toEqual([]);
    expect(r.warnings.some((w) => w.includes("31일"))).toBe(true);
  });
});

describe("제품수불표 · 내보내기", () => {
  it("원본과 같은 레이아웃: 헤더 2행, 파생값은 수식, 구간 소계와 맨 아래 합계", async () => {
    const wb = await loadWorkbook(await buildStockLedgerWorkbook({ year: 2026, month: 11, rows: ROWS }));
    const ws = wb.worksheets[0];
    expect(ws.name).toBe("11월 제품수불표");
    expect(ws.getCell("A1").value).toBe("공정");
    expect(ws.getCell("N1").value).toBe("1일");
    expect(ws.getCell("N2").value).toBe("생산");
    expect(ws.getCell("BW2").value).toBe("출고");
    const f = (ref: string) => (ws.getCell(ref).value as ExcelJS.CellFormulaValue).formula;
    expect(f("F3")).toBe('SUMIF($N$2:$BW$2,"생산",(N3:BW3))');
    expect(f("G3")).toBe('SUMIF($N$2:$BW$2,"출고",(N3:BW3))');
    expect(f("H3")).toBe("E3+F3-G3");
    expect(f("I3")).toBe("H3/J3");
    expect(f("L3")).toBe("J3*K3");
    expect(f("M3")).toBe("ROUNDUP(I3/K3,0)");
    expect(ws.getCell("A5").value).toBe("PS 계");
    expect(f("E5")).toBe("SUM(E3:E4)");
    expect(ws.getCell("A8").value).toBe("1219 계");
    const colA = ws.getColumn(1).values as unknown[];
    expect(colA.filter((v) => v === "합계")).toHaveLength(1);
  });

  it("가상 수불표 생성기: 기준정보 제품 이름을 그대로 쓰고 결정적이다", () => {
    const products = Array.from({ length: 12 }, (_, i) => ({ code: `PRD${i}`, name: `제품 ${i}`, packUnit: 100 }));
    const a = generateFakeStockRows(products);
    const b = generateFakeStockRows(products);
    expect(a).toEqual(b);
    expect(a).toHaveLength(14);
    expect(new Set(a.slice(0, 12).map((r) => r.name))).toEqual(new Set(products.map((p) => p.name)));
    expect(a.filter((r) => r.name === "가상 소주 1.8L 35%").map((r) => r.dupIndex)).toEqual([0, 1]);
  });
});
