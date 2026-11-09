/**
 * lib/excel/import-inventory.ts · FR-05 제품수불일보(재고 스냅샷) 가져오기
 *
 * 시트 '수불' (없으면 '제품명' + 재고 열 헤더가 있는 첫 시트)
 *   기준일 | 제품코드 | 제품명 | 양품현재고
 * 기준일 열이 없거나 비어 있으면 opts.asOfDate → 제목/파일명에서 'YYYYMMDD' 추정값을 쓴다.
 * 제품명·제품코드는 원문 그대로 돌려준다(매칭은 호출자).
 */
import type { ISODate } from "../engine/types";
import { cellDate, cellText, findColumn, findHeaderRow, headerMap, loadWorkbook, parseDateText, parseNumber, type ExcelInput } from "./common";

export interface InventoryRow {
  asOfDate: ISODate;
  productCode: string;
  productName: string;
  qty: number;
  rowNo: number;
}

export interface InventoryImportResult {
  rows: InventoryRow[];
  warnings: string[];
  sheetName: string | null;
  asOfDate: ISODate | null;
}

export async function parseInventoryWorkbook(
  buf: ExcelInput,
  opts: { sheetName?: string; asOfDate?: ISODate; filename?: string } = {},
): Promise<InventoryImportResult> {
  const warnings: string[] = [];
  const rows: InventoryRow[] = [];
  const wb = await loadWorkbook(buf);
  const ws =
    (opts.sheetName ? wb.getWorksheet(opts.sheetName) : undefined) ??
    wb.getWorksheet("수불") ??
    wb.worksheets.find((s) => findHeaderRow(s, ["제품명"]) !== null) ??
    wb.worksheets[0];
  if (!ws) return { rows, warnings: ["워크시트가 없습니다."], sheetName: null, asOfDate: null };

  const headerRow = findHeaderRow(ws, ["제품명"]);
  if (headerRow === null) return { rows, warnings: [`시트 '${ws.name}': '제품명' 헤더를 찾지 못했습니다.`], sheetName: ws.name, asOfDate: null };
  const headers = headerMap(ws, headerRow);
  const col = {
    date: findColumn(headers, ["기준일", "기준일자", "일자", "날짜", "date"]),
    code: findColumn(headers, ["제품코드", "코드", "품번"]),
    name: findColumn(headers, ["제품명", "품명"]),
    qty: findColumn(headers, ["양품현재고", "양품재고", "현재고", "재고", "수량", "qty"]),
  };
  if (col.name === null || col.qty === null) {
    return { rows, warnings: [`시트 '${ws.name}': 필수 열(제품명, 양품현재고)이 없습니다.`], sheetName: ws.name, asOfDate: null };
  }

  // 기본 기준일: 옵션 → 파일명 'YYYYMMDD' → 제목
  let fallback: ISODate | null = opts.asOfDate ?? null;
  if (!fallback && opts.filename) {
    const m = opts.filename.match(/(20\d{2})(\d{2})(\d{2})/);
    if (m) fallback = parseDateText(`${m[1]}-${m[2]}-${m[3]}`);
  }
  if (!fallback) {
    for (let r = 1; r < headerRow && !fallback; r++) {
      ws.getRow(r).eachCell({ includeEmpty: false }, (c) => {
        if (!fallback) fallback = cellDate(c) ?? parseDateText(cellText(c).replace(/[^\d]/g, "").slice(0, 8));
      });
    }
  }
  if (col.date === null && !fallback) warnings.push("'기준일' 열이 없고 기준일을 추정할 수 없어 행마다 오늘 날짜를 씁니다.");

  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const name = cellText(row.getCell(col.name)).replace(/\s+/g, " ");
    const qtyText = cellText(row.getCell(col.qty));
    if (!name && !qtyText) continue;
    if (!name) {
      warnings.push(`행 ${r}: 제품명이 비어 있어 건너뜀`);
      continue;
    }
    const qty = parseNumber(qtyText);
    if (qty === null) {
      warnings.push(`행 ${r} (${name}): 재고 '${qtyText}' 을 숫자로 읽지 못해 건너뜀`);
      continue;
    }
    let asOf: ISODate | null = col.date !== null ? cellDate(row.getCell(col.date)) : null;
    if (!asOf) asOf = fallback;
    if (!asOf) {
      const now = new Date();
      asOf = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    }
    rows.push({
      asOfDate: asOf,
      productCode: col.code !== null ? cellText(row.getCell(col.code)) : "",
      productName: name,
      qty: Math.round(qty),
      rowNo: r,
    });
  }
  const asOfDate = rows[0]?.asOfDate ?? fallback;
  return { rows, warnings, sheetName: ws.name, asOfDate };
}
