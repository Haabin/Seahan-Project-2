import type { PurchaseRow } from "./normalize";

export const STANDARD_HEADERS = ["품번", "품명", "수량", "단위", "납기일", "거래처", "비고"] as const;

export function purchaseRowsToMatrix(rows: PurchaseRow[]): (string | number)[][] {
  return rows.map((r) => [
    r.productCode, r.productName, r.quantity ?? "", r.unit,
    r.requestedDate, r.customer, r.note,
  ]);
}

export function purchaseRowsToCsv(rows: PurchaseRow[]): string {
  const escape = (value: string | number) => {
    const text = String(value);
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  };
  return "\uFEFF" + [STANDARD_HEADERS, ...purchaseRowsToMatrix(rows)]
    .map((row) => row.map(escape).join(",")).join("\r\n") + "\r\n";
}

export async function purchaseRowsToXlsx(rows: PurchaseRow[]): Promise<Blob> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("표준 발주의뢰서");
  sheet.addRow([...STANDARD_HEADERS]);
  for (const row of purchaseRowsToMatrix(rows)) sheet.addRow(row);
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { vertical: "middle", horizontal: "center" };
  sheet.columns = [{width:20},{width:35},{width:15},{width:12},{width:18},{width:25},{width:40}];
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: "A1", to: "G1" };
  const bytes = await workbook.xlsx.writeBuffer();
  return new Blob([bytes as BlobPart], {type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
}
