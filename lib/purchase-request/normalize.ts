/** 발주의뢰서 표준화: 외부 데이터는 저장 전에 반드시 사람이 검토한다. */
export type PurchaseRow = {
  productCode: string;
  productName: string;
  quantity: number | null;
  unit: string;
  requestedDate: string;
  customer: string;
  note: string;
};
export type PurchaseImport = {
  rows: PurchaseRow[];
  warnings: string[];
  unmappedColumns: string[];
};
const aliases: Record<keyof PurchaseRow, string[]> = {
  productCode: [
    "품번",
    "제품코드",
    "품목코드",
    "productcode",
    "itemcode",
    "sku",
  ],
  productName: ["품명", "제품명", "품목명", "productname", "itemname", "item"],
  quantity: ["수량", "발주수량", "요청수량", "quantity", "qty"],
  unit: ["단위", "unit"],
  requestedDate: [
    "납기",
    "납기일",
    "요청일",
    "희망납기",
    "duedate",
    "requesteddate",
  ],
  customer: ["거래처", "고객사", "업체명", "customer", "client"],
  note: ["비고", "특이사항", "메모", "note", "remarks"],
};
const normalize = (v: string) =>
  v
    .normalize("NFKC")
    .replace(/[\s_\-()]/g, "")
    .toLowerCase();
export function fieldFor(header: string) {
  return fields.find((key) => aliases[key].includes(normalize(header)));
}
const fields = Object.keys(aliases) as (keyof PurchaseRow)[];
export function normalizePurchaseRows(
  source: Record<string, unknown>[],
): PurchaseImport {
  const warnings: string[] = [];
  const columns = [...new Set(source.flatMap((row) => Object.keys(row)))];
  const mapping = new Map<keyof PurchaseRow, string>();
  for (const field of fields) {
    const matches = columns.filter((column) =>
      aliases[field].some((a) => normalize(a) === normalize(column)),
    );
    if (matches.length > 1)
      warnings.push(
        `${field}: 일치하는 열이 여러 개입니다 (${matches.join(", ")})`,
      );
    if (matches[0]) mapping.set(field, matches[0]);
  }
  const unmappedColumns = columns.filter(
    (column) => ![...mapping.values()].includes(column),
  );
  const rows = source.map((sourceRow, index) => {
    const get = (field: keyof PurchaseRow) =>
      String(sourceRow[mapping.get(field) ?? ""] ?? "").trim();
    const raw = get("quantity");
    const rawQuantity = /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(raw)
      ? raw.replace(/,/g, "")
      : "";
    const quantity =
      rawQuantity !== "" &&
      Number.isFinite(Number(rawQuantity)) &&
      Number(rawQuantity) > 0
        ? Number(rawQuantity)
        : null;
    if (quantity === null)
      warnings.push(`${index + 1}행: 수량을 확인해 주세요`);
    if (!get("productCode") && !get("productName"))
      warnings.push(`${index + 1}행: 품번 또는 품명이 없습니다`);
    return {
      productCode: get("productCode"),
      productName: get("productName"),
      quantity,
      unit: get("unit"),
      requestedDate: get("requestedDate"),
      customer: get("customer"),
      note: get("note"),
    };
  });
  return { rows, warnings, unmappedColumns };
}
/** CSV 파서: 따옴표, 쉼표, 줄바꿈을 처리한다. */
export function parsePurchaseCsv(input: string): PurchaseImport {
  const text = input.replace(/^\uFEFF/, "");
  const records: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((v) => v.trim())) records.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (quoted) throw new Error("CSV 따옴표가 닫히지 않았습니다.");
  row.push(cell);
  if (row.some((v) => v.trim())) records.push(row);
  return parseTable(records);
}
export function parseTable(records: string[][]): PurchaseImport {
  const rows: PurchaseRow[] = [];
  const warnings: string[] = [];
  let headers: string[] = [];
  let defaultCustomer = "";
  let defaultDate = "";
  for (const [index, cells] of records.entries()) {
    const keys = cells.map(fieldFor);
    if (
      keys.includes("quantity") &&
      (keys.includes("productCode") || keys.includes("productName"))
    ) {
      const mapped = keys.filter(Boolean);
      if (new Set(mapped).size !== mapped.length)
        throw new Error("중복된 CSV 열 이름 또는 중복된 표 항목이 있습니다.");
      headers = cells;
      continue;
    }
    if (!headers.length) {
      keys.forEach((key, i) => {
        if (key === "customer") defaultCustomer = cells[i + 1]?.trim() || "";
        if (key === "requestedDate") defaultDate = cells[i + 1]?.trim() || "";
      });
      continue;
    }
    if (
      !cells.some((c) => c?.trim()) ||
      /^(총계|소계|합계)$/.test(cells.find((c) => c?.trim())?.trim() || "")
    )
      continue;
    const entry = Object.fromEntries(
      headers.map((h, i) => [h, cells[i] || ""]),
    );
    const parsed = normalizePurchaseRows([entry]);
    const row = parsed.rows[0];
    row.customer ||= defaultCustomer;
    row.requestedDate ||= defaultDate;
    row.requestedDate = row.requestedDate.replace(
      /^(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})\.?$/,
      (_, y, m, d) => [y, m.padStart(2, "0"), d.padStart(2, "0")].join("-"),
    );
    if (cells.some((c, i) => c?.trim() && !fieldFor(headers[i] || "")))
      warnings.push(
        `${index + 1}행에 표준 항목에 포함되지 않은 값이 있습니다.`,
      );
    rows.push(row);
  }
  if (!rows.length)
    warnings.push("인식한 품목이 없습니다. 원본과 대조해 입력하세요.");
  return { rows, warnings, unmappedColumns: [] };
}
export function parsePurchaseJson(input: string): PurchaseImport {
  const parsed: unknown = JSON.parse(input);
  const records = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && "rows" in parsed
      ? (parsed as { rows: unknown }).rows
      : null;
  if (
    !Array.isArray(records) ||
    !records.every(
      (r) => r !== null && typeof r === "object" && !Array.isArray(r),
    )
  )
    throw new Error("JSON은 객체 배열 또는 rows 배열이어야 합니다.");
  return normalizePurchaseRows(records as Record<string, unknown>[]);
}
