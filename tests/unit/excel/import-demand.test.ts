/**
 * FR-05 출고일정표·제품수불일보 가져오기 테스트
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { buildFakeInventoryBuffer, buildFakeShipmentsBuffer, generateDataset } from "../../../scripts/make-fake-data";
import { parseInventoryWorkbook, parseShipmentsWorkbook, workbookToBuffer } from "../../../lib/excel";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

describe("FR-05 parseShipmentsWorkbook · 가상 출고일정표", () => {
  const ds = generateDataset();
  async function load() {
    const path = join(process.cwd(), "data", "fake", ds.files.shipments);
    return existsSync(path) ? readFileSync(path) : await buildFakeShipmentsBuffer(ds);
  }

  it("FR-05 행 수·날짜 형식·대형거래선 플래그", async () => {
    const r = await parseShipmentsWorkbook(await load());
    expect(r.sheetName).toBe("출고일정");
    expect(r.warnings).toEqual([]);
    expect(r.rows).toHaveLength(ds.shipments.length);
    expect(r.rows.every((x) => ISO.test(x.shipDate))).toBe(true);
    const productName = new Map(ds.products.map((p) => [p.id, p.name]));
    const customer = new Map(ds.customers.map((c) => [c.id, c]));
    ds.shipments.forEach((s, i) => {
      const row = r.rows[i];
      expect(row.shipDate).toBe(s.shipDate);
      expect(row.productName).toBe(productName.get(s.productId));
      expect(row.customerName).toBe(customer.get(s.customerId)!.name);
      expect(row.isMajor).toBe(customer.get(s.customerId)!.isMajor);
      expect(row.qty).toBe(s.qty);
    });
    expect(r.rows.some((x) => x.isMajor)).toBe(true);
    expect(r.rows.some((x) => !x.isMajor)).toBe(true);
  });

  it("FR-05 날짜가 문자열('11/20', '2026.11.21')이어도 읽고, 깨진 행은 경고", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("출고일정");
    ws.addRow(["출고일정표 2026년 11월"]);
    ws.addRow(["출고예정일", "거래처", "대형거래선(Y/N)", "제품명", "수량"]);
    ws.addRow(["11/20", "가나음료", "Y", "500ml 원형 A", "96,000"]);
    ws.addRow(["2026.11.21", "대한음료", "N", "500ml 원형 B", 50000]);
    ws.addRow(["???", "대한음료", "N", "500ml 원형 B", 50000]);
    ws.addRow(["2026-11-22", "대한음료", "", "", 1]);
    const r = await parseShipmentsWorkbook(await workbookToBuffer(wb));
    expect(r.rows.map((x) => [x.shipDate, x.qty, x.isMajor])).toEqual([
      ["2026-11-20", 96000, true],
      ["2026-11-21", 50000, false],
    ]);
    expect(r.warnings).toHaveLength(2);
  });
});

describe("FR-05 parseInventoryWorkbook · 가상 수불일보", () => {
  const ds = generateDataset();
  async function load() {
    const path = join(process.cwd(), "data", "fake", ds.files.inventory);
    return existsSync(path) ? readFileSync(path) : await buildFakeInventoryBuffer(ds);
  }

  it("FR-05 제품 36행, 기준일 2026-11-11, 수량 일치", async () => {
    const r = await parseInventoryWorkbook(await load());
    expect(r.sheetName).toBe("수불");
    expect(r.warnings).toEqual([]);
    expect(r.rows).toHaveLength(ds.inventory.length);
    expect(r.asOfDate).toBe("2026-11-11");
    expect(r.rows.every((x) => x.asOfDate === "2026-11-11")).toBe(true);
    const byCode = new Map(ds.products.map((p) => [p.code, p]));
    for (const row of r.rows) {
      const p = byCode.get(row.productCode)!;
      expect(p).toBeDefined();
      expect(row.productName).toBe(p.name);
      const inv = ds.inventory.find((i) => i.productId === p.id)!;
      expect(row.qty).toBe(inv.qty);
    }
  });

  it("FR-05 기준일 열이 없으면 파일명의 YYYYMMDD 로 보완", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow(["제품코드", "제품명", "양품현재고"]);
    ws.addRow(["PRD001", "300ml 원형 A", "12,000"]);
    const r = await parseInventoryWorkbook(await workbookToBuffer(wb), { filename: "제품수불일보_20261111.xlsx" });
    expect(r.rows).toEqual([{ asOfDate: "2026-11-11", productCode: "PRD001", productName: "300ml 원형 A", qty: 12000, rowNo: 2 }]);
  });
});
