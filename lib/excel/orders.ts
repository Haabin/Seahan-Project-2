/**
 * lib/excel/orders.ts · 주문내역 엑셀 (템플릿 만들기 · 읽기)
 * 열: 주문번호 | 품번 | 품명 | 수량 | 납기일 | 고객사 | 비고   (헤더 1행, 열 순서는 바뀌어도 된다)
 * 품번이 기준정보 제품 코드와 같으면 그 제품, 아니면 품명을 정규화해 비교한다. 못 찾으면 매칭 안 된 주문으로 남는다.
 */
import ExcelJS from "exceljs";
import type { ISODate } from "../engine/types";
import { cellDate, cellText, DEFAULT_FONT, findColumn, findHeaderRow, headerMap, HEADER_FILL, loadWorkbook, normalizeName, parseNumber, workbookToBuffer, type ExcelInput } from "./common";

export interface OrderExcelRow {
  orderNo: string | null;
  itemCode: string | null;
  productName: string;
  qty: number;
  dueDate: ISODate;
  customerName: string | null;
  memo: string | null;
  sourceRow: number;
}

export interface OrderImportResult {
  rows: OrderExcelRow[];
  warnings: string[];
}

export const ORDER_TEMPLATE_HEADERS = ["주문번호", "품번", "품명", "수량", "납기일", "고객사", "비고"] as const;

export async function buildOrderTemplate(examples: { itemCode: string; productName: string }[] = []): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("주문내역");
  ws.addRow([...ORDER_TEMPLATE_HEADERS]);
  ws.getRow(1).eachCell((c) => {
    c.fill = HEADER_FILL;
    c.font = { ...DEFAULT_FONT, bold: true };
  });
  examples.slice(0, 3).forEach((e, i) => ws.addRow([`예시-${i + 1}`, e.itemCode, e.productName, 50000 * (i + 1), null, "", "예시 행입니다. 지우고 쓰세요"]));
  [14, 12, 30, 12, 12, 18, 30].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  ws.getColumn(4).numFmt = "#,##0";
  ws.getColumn(5).numFmt = "yyyy-mm-dd";
  return workbookToBuffer(wb);
}

export async function parseOrdersWorkbook(input: ExcelInput, opts: { baseYear?: number } = {}): Promise<OrderImportResult> {
  const wb = await loadWorkbook(input);
  const warnings: string[] = [];
  const ws = wb.worksheets.find((w) => findHeaderRow(w, ["품명", "수량"]) !== null) ?? wb.worksheets[0];
  if (!ws) return { rows: [], warnings: ["시트가 없습니다"] };
  const headerRow = findHeaderRow(ws, ["품명", "수량"]);
  if (!headerRow) return { rows: [], warnings: ["'품명', '수량' 헤더를 찾지 못했습니다. 템플릿을 내려받아 쓰세요"] };
  const headers = headerMap(ws, headerRow);
  const col = {
    orderNo: findColumn(headers, ["주문번호", "발주번호"]),
    itemCode: findColumn(headers, ["품번", "제품코드", "코드"]),
    name: findColumn(headers, ["품명", "제품명"]),
    qty: findColumn(headers, ["수량", "주문수량"]),
    due: findColumn(headers, ["납기일", "납기", "출고예정일"]),
    customer: findColumn(headers, ["고객사", "거래처"]),
    memo: findColumn(headers, ["비고", "메모"]),
  };
  if (!col.name || !col.qty || !col.due) return { rows: [], warnings: ["'품명', '수량', '납기일' 열이 모두 있어야 합니다"] };

  const rows: OrderExcelRow[] = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const name = cellText(row.getCell(col.name)).normalize("NFC").replace(/\s+/g, " ").trim();
    const itemCode = col.itemCode ? cellText(row.getCell(col.itemCode)).trim() || null : null;
    if (!name && !itemCode) continue;
    const qty = parseNumber(cellText(row.getCell(col.qty)));
    const due = cellDate(row.getCell(col.due), opts.baseYear);
    if (qty === null || qty <= 0) {
      warnings.push(`${r}행 "${name}": 수량을 읽지 못해 건너뛰었습니다`);
      continue;
    }
    if (!due) {
      warnings.push(`${r}행 "${name}": 납기일을 읽지 못해 건너뛰었습니다`);
      continue;
    }
    rows.push({
      orderNo: col.orderNo ? cellText(row.getCell(col.orderNo)).trim() || null : null,
      itemCode,
      productName: name || itemCode || "",
      qty: Math.round(qty),
      dueDate: due,
      customerName: col.customer ? cellText(row.getCell(col.customer)).trim() || null : null,
      memo: col.memo ? cellText(row.getCell(col.memo)).trim() || null : null,
      sourceRow: r,
    });
  }
  if (!rows.length) warnings.push("읽은 주문이 없습니다");
  return { rows, warnings };
}

/** 품번(제품 코드) 우선, 없으면 품명으로 제품을 찾는다 */
export function matchOrderProduct(row: Pick<OrderExcelRow, "itemCode" | "productName">, products: { id: string; code: string; name: string }[]): string | null {
  if (row.itemCode) {
    const byCode = products.find((p) => p.code.toLowerCase() === row.itemCode!.toLowerCase());
    if (byCode) return byCode.id;
  }
  const n = normalizeName(row.productName);
  return products.find((p) => normalizeName(p.name) === n)?.id ?? null;
}
