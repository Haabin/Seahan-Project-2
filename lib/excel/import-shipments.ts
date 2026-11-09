/**
 * lib/excel/import-shipments.ts · FR-05 출고일정표 가져오기
 *
 * 시트 '출고일정' (없으면 '제품명'·'수량' 헤더가 있는 첫 시트)
 *   출고예정일 (Excel 날짜 또는 'YYYY-MM-DD' / '11/12') | 거래처 | 대형거래선(Y/N) | 제품명 | 수량
 * 제품명은 원문 그대로 돌려준다. 제품 id 매칭은 호출자가 한다.
 */
import type { ISODate } from "../engine/types";
import { cellDate, cellText, findColumn, findHeaderRow, headerMap, inferYearFromTitle, loadWorkbook, parseNumber, parseYesNo, type ExcelInput } from "./common";

export interface ShipmentRow {
  shipDate: ISODate;
  customerName: string;
  isMajor: boolean;
  productName: string;
  qty: number;
  rowNo: number;
}

export interface ShipmentImportResult {
  rows: ShipmentRow[];
  warnings: string[];
  sheetName: string | null;
}

export async function parseShipmentsWorkbook(buf: ExcelInput, opts: { sheetName?: string; baseYear?: number } = {}): Promise<ShipmentImportResult> {
  const warnings: string[] = [];
  const rows: ShipmentRow[] = [];
  const wb = await loadWorkbook(buf);
  const ws =
    (opts.sheetName ? wb.getWorksheet(opts.sheetName) : undefined) ??
    wb.getWorksheet("출고일정") ??
    wb.worksheets.find((s) => findHeaderRow(s, ["제품명", "수량"]) !== null) ??
    wb.worksheets[0];
  if (!ws) return { rows, warnings: ["워크시트가 없습니다."], sheetName: null };

  const headerRow = findHeaderRow(ws, ["제품명", "수량"]);
  if (headerRow === null) return { rows, warnings: [`시트 '${ws.name}': '제품명'·'수량' 헤더를 찾지 못했습니다.`], sheetName: ws.name };
  const headers = headerMap(ws, headerRow);
  const col = {
    date: findColumn(headers, ["출고예정일", "출고일", "납기일", "납기", "일자", "날짜", "date"]),
    customer: findColumn(headers, ["거래처", "고객", "customer"]),
    major: findColumn(headers, ["대형거래선", "대형", "주요거래처", "major"]),
    name: findColumn(headers, ["제품명", "품명", "금형명"]),
    qty: findColumn(headers, ["수량", "출고량", "qty"]),
  };
  if (col.date === null || col.name === null || col.qty === null) {
    return { rows, warnings: [`시트 '${ws.name}': 필수 열(출고예정일, 제품명, 수량)이 없습니다.`], sheetName: ws.name };
  }
  if (col.customer === null) warnings.push("'거래처' 열이 없어 거래처는 비웁니다.");
  if (col.major === null) warnings.push("'대형거래선' 열이 없어 모두 N 으로 둡니다.");

  let baseYear = opts.baseYear ?? null;
  if (!baseYear) {
    for (let r = 1; r < headerRow && !baseYear; r++) {
      ws.getRow(r).eachCell({ includeEmpty: false }, (c) => {
        if (!baseYear) baseYear = inferYearFromTitle(cellText(c));
      });
    }
  }

  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const name = cellText(row.getCell(col.name)).replace(/\s+/g, " ");
    const dateText = cellText(row.getCell(col.date));
    const qtyText = cellText(row.getCell(col.qty));
    if (!name && !dateText && !qtyText) continue;
    const shipDate = cellDate(row.getCell(col.date), baseYear ?? undefined);
    const qty = parseNumber(qtyText);
    if (!shipDate) {
      warnings.push(`행 ${r}: 출고예정일 '${dateText}' 을 날짜로 읽지 못해 건너뜀`);
      continue;
    }
    if (!name) {
      warnings.push(`행 ${r}: 제품명이 비어 있어 건너뜀`);
      continue;
    }
    if (qty === null) {
      warnings.push(`행 ${r} (${name}): 수량 '${qtyText}' 을 숫자로 읽지 못해 건너뜀`);
      continue;
    }
    rows.push({
      shipDate,
      customerName: col.customer !== null ? cellText(row.getCell(col.customer)) : "",
      isMajor: col.major !== null ? parseYesNo(cellText(row.getCell(col.major))) : false,
      productName: name,
      qty: Math.round(qty),
      rowNo: r,
    });
  }
  return { rows, warnings, sheetName: ws.name };
}
