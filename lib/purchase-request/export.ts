import type { PurchaseRow } from "./normalize";

export const STANDARD_HEADERS = [
  "품번",
  "품명",
  "수량",
  "단위",
  "납기일",
  "거래처",
  "비고",
] as const;

export function purchaseRowsToMatrix(
  rows: PurchaseRow[],
): (string | number)[][] {
  return rows.map((r) => [
    r.productCode,
    r.productName,
    r.quantity ?? "",
    r.unit,
    r.requestedDate,
    r.customer,
    r.note,
  ]);
}

export function purchaseRowsToCsv(rows: PurchaseRow[]): string {
  const escape = (value: string | number) => {
    const text =
      typeof value === "string" && /^[=+@\-\t\r]/.test(value)
        ? "'" + value
        : String(value);
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  };
  return (
    "\uFEFF" +
    [STANDARD_HEADERS, ...purchaseRowsToMatrix(rows)]
      .map((row) => row.map(escape).join(","))
      .join("\r\n") +
    "\r\n"
  );
}

export async function purchaseRowsToXlsx(
  rows: PurchaseRow[],
  number = "",
  customer = "",
): Promise<Blob> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("표준 발주의뢰서");
  sheet.addRow([...STANDARD_HEADERS]);
  for (const row of purchaseRowsToMatrix(rows)) sheet.addRow(row);
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { vertical: "middle", horizontal: "center" };
  sheet.columns = [
    { width: 20 },
    { width: 35 },
    { width: 15 },
    { width: 12 },
    { width: 18 },
    { width: 25 },
    { width: 40 },
  ];
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: "A1", to: "G1" };
  if (number) {
    const info = workbook.addWorksheet("문서 정보");
    info.addRow(["발주의뢰서 번호", number]);
    info.addRow(["거래처", customer]);
    info.columns = [{ width: 24 }, { width: 40 }];
  }
  const bytes = await workbook.xlsx.writeBuffer();
  return new Blob([bytes as BlobPart], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

export function printPurchase(
  number: string,
  customer: string,
  rows: PurchaseRow[],
) {
  const frame = window.open("", "_blank");
  if (!frame)
    throw new Error("인쇄 창을 열 수 없습니다. 팝업을 허용해 주세요.");
  const doc = frame.document;
  doc.title = number + " 발주의뢰서";
  doc.documentElement.lang = "ko";
  const style = doc.createElement("style");
  style.textContent =
    "@page{size:A4 landscape;margin:15mm}body{font:13px sans-serif;color:#132538}table{border-collapse:collapse;width:100%}td,th{border:1px solid #8998a6;padding:7px;text-align:left;white-space:pre-wrap}tr{break-inside:avoid}thead{display:table-header-group}";
  doc.head.append(style);
  const title = doc.createElement("h1");
  title.textContent = "발주의뢰서";
  const info = doc.createElement("p");
  info.textContent = number + "   " + customer;
  const table = doc.createElement("table");
  const head = table.createTHead().insertRow();
  STANDARD_HEADERS.forEach((label) => {
    const th = doc.createElement("th");
    th.textContent = label;
    head.append(th);
  });
  const body = table.createTBody();
  purchaseRowsToMatrix(rows).forEach((row) => {
    const tr = body.insertRow();
    row.forEach((value) => (tr.insertCell().textContent = String(value)));
  });
  doc.body.append(title, info, table);
  frame.focus();
  frame.print();
}
