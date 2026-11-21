import products from "./products.json";

/** 발주의뢰서 표준화: 외부 데이터는 저장 전에 반드시 사람이 검토한다. */
export type PurchaseRow = {
  productCode: string;
  productName: string;
  quantity: number | null;
  unit: string;
  requestedDate: string;
  customer: string;
  note: string;
  destination?: string;
  condition?: string;
  boxes?: number | null;
  originalQuantity?: string;
  originalUnit?: string;
  originalName?: string;
  conversion?: string;
  customerCode?: string;
  reviewReason?: string;
};
export type PurchaseImport = {
  rows: PurchaseRow[];
  warnings: string[];
  orderNumber?: string;
  unmappedColumns: string[];
};
const aliases: Record<keyof PurchaseRow, string[]> = {
  productCode: [
    "자재코드", "코드", "품번",
    "제품코드",
    "품목코드",
    "productcode",
    "itemcode",
    "sku",
  ],
  productName: ["자재명", "품목", "품명", "제품명", "품목명", "productname", "itemname", "item"],
  quantity: ["발주수", "주문수량", "발주량", "출고수량", "수량", "발주수량", "요청수량", "quantity", "qty"],
  unit: ["단위", "unit"],
  requestedDate: [
    "입고요청일", "납품예정일", "납품요청일", "납기",
    "납기일",
    "요청일",
    "희망납기",
    "duedate",
    "requesteddate",
  ],
  customer: ["거래처", "고객사", "업체명", "customer", "client"],
  destination: ["착지", "납품처", "납품장소", "도착지", "플랜트명"],
  originalName: ["품명원문"], conversion: ["환산근거"], condition: ["납품조건"], boxes: ["박스수량"], originalUnit: ["원문단위"], originalQuantity: ["원문수량"], customerCode: ["거래처품번"], reviewReason: ["검토사유"],
  note: ["특기사항", "비고", "특이사항", "메모", "note", "remarks"],
};
const normalize = (v: string) =>
  v
    .normalize("NFKC")
    .replace(/[\s_\-()]/g, "")
    .toLowerCase();
export function fieldFor(header: string) {
  return fields.find((key) => aliases[key]!.includes(normalize(header.replace(/^(수량|발주수량)\([^)]+\)$/, "$1"))));
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
      fieldFor(column) === field,
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
  const headers = [...mapping.values()];
  const grid = source.map(row => headers.map(key => String(row[key] ?? "").trim()));
  const result = parseTable(grid, "", new Date(), headers);
  for (const [index, row] of result.rows.entries()) {
    if (row.quantity === null) warnings.push(`${index + 1}행: 수량을 확인해 주세요`);
    if (!row.originalName && !row.productCode && !row.customerCode)
      warnings.push(`${index + 1}행: 품번 또는 품명이 없습니다`);
  }
  return { ...result, warnings: [...warnings, ...result.warnings], unmappedColumns };
}
/** CSV 파서: 따옴표, 쉼표, 줄바꿈을 처리한다. */
export function parsePurchaseCsv(input: string, filename = "", reference = new Date()): PurchaseImport {
  const text = input.replace(/^\uFEFF/, "");
  const records: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  for (let i = 0;i < text.length;i++) {
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
  return parseTable(records, filename, reference);
}
function readDate(raw: string, reference: Date) {
  const text = raw.trim().replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
  const match = text.match(/^(?:(\d{4})\s*[-./년]\s*)?(\d{1,2})\s*[-./월]\s*(\d{1,2})(?:일|\.)?\s*(.*)$/);
  if (!match) return { date: text, condition: "", warning: "" };
  const [, year, month, day, suffix] = match;
  const md = month.padStart(2, "0") + "-" + day.padStart(2, "0");
  const today = reference.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
  const date = (year || String(Number(today.slice(0, 4)) + Number(md < today.slice(5)))) + "-" + md;
  const weekday = suffix.match(/\(([일월화수목금토])\)/)?.[1];
  const actual = new Date(date + "T00:00:00Z");
  const warning = weekday && weekday !== "일월화수목금토"[actual.getUTCDay()] ? "요일 불일치" : "";
  return { date, warning, condition: suffix.replace(/\([^)]*\)/g, "").trim().replace(/아침착/g, "아침 착") };
}

export function boxCount(code: string, quantity: number | null, unit: string) {
  const product = products.find(p => p.code === code);
  if (!product || quantity === null || !["EA", "개", "본", ""].includes(unit.toUpperCase())) return null;
  const count = quantity / product.box;
  return Number.isInteger(count) ? count : null;
}

export function parseTable(records: string[][], filename = "", reference = new Date(), objectHeaders?: string[]): PurchaseImport {
  const rows: PurchaseRow[] = [];
  const warnings: string[] = [];
  const meta: Record<string, string> = Object.create(null);
  let headers: string[] = objectHeaders ?? [];
  let dates: number[] = [];
  let plant = "";
  const customerNames = ["대경페트산업", "씨제이제일제당", "대상주식회사", "하이트진로", "보해양조", "충북소주", "매일유업"];
  const seen = new Set<string>();
  for (const cells of records) {
    const keys = cells.map(fieldFor);
    const dateCols = cells.flatMap((c, i) => /^\d{4}[./-]\d{1,2}[./-]\d{1,2}$/.test(c) ? [i] : []);
    if (!objectHeaders && (keys.includes("quantity") || dateCols.length > 0) && (keys.includes("productName") || keys.includes("productCode"))) {
      const mapped = keys.filter(Boolean);
      if (new Set(mapped).size !== mapped.length) throw new Error("중복된 CSV 열 이름 또는 중복된 표 항목이 있습니다.");
      headers = cells; dates = dateCols; plant = ""; continue;
    }
    if (!objectHeaders && !headers.length) {
      for (let i = 0;i < cells.length;i++) {
        const raw = cells[i]?.trim();
        if (!raw) continue;
        const parts = raw.match(/^([^:：]+)[:：]\s*(.*)$/);
        const key = (parts?.[1] || raw).replace(/\s/g, "");
        const value = parts?.[2] || cells.slice(i + 1).find(c => c?.trim()) || "";
        if (value) meta[key] = value.trim();
      }
      continue;
    }
    const first = cells.find(c => c?.trim())?.trim() || "";
    if (!objectHeaders && (!first || /^(합계|총합계|소계|계|TOTAL)$|^(※|담당\s*[:：])/.test(first))) continue;
    const get = (key: keyof PurchaseRow) => (cells[headers.findIndex(h => fieldFor(h) === key)] || "").trim();
    const name = get("productName"), code = get("productCode");
    if (!objectHeaders && !name && !code) continue;
    const sender = meta["거래처"] || meta["발주처"] || "";
    const customer = get("customer") || customerNames.find(n => sender.replace(/\s/g, "").includes(n) || (!sender && filename.includes(n === "대상주식회사" ? "대상" : n))) || sender;
    if (dates.length && get("destination")) plant = get("destination");
    const factory = sender.replace(/\s/g, "").replace(customer, "").replace(/\(주\)|주식회사/g, "").match(/^[가-힣0-9]+공장$/)?.[0];
    const destination = get("destination") || plant || meta["도착지"] || factory || customer;
    const dateRef = /^\d{4}-\d{2}-\d{2}$/.test(meta["발주일"] || "") ? new Date(meta["발주일"] + "T00:00:00Z") : reference;
    for (const col of dates.length ? dates : [-1]) {
      const raw = col >= 0 ? cells[col]?.trim() : get("quantity");
      if (col >= 0 && !raw) continue;
      const reasons: string[] = [];
      let product = products.find(p => p.code === code);
      const canonical = (v: string) => v.toUpperCase().replace(/\s+/g, "");
      if (!product && (!code || /^\d+$/.test(code)) && name) product = products.find(p => canonical(p.name) === canonical(name));
      if (!product && (!code || /^\d+$/.test(code)) && name) {
        const tokens = (v: string) => (v.toUpperCase().match(/[A-Z]+|\d+(?:\.\d+)?|[가-힣]+/g) || []).sort().join("|");
        const parts = tokens(name).split("|");
        const exact = products.filter(p => tokens(p.name) === tokens(name));
        const candidates = exact.length ? exact : products.filter(p => {
          const master = tokens(p.name).split("|");
          return parts.length >= 2 && (parts.every(t => master.includes(t)) ||
            (/^\d+$/.test(code) && master.every(t => parts.includes(t))));
        });
        const lengths = candidates.map(p => tokens(p.name).split("|").length);
        const closest = candidates.filter((_, i) => lengths[i] === Math.min(...lengths));
        if (closest.length === 1) product = closest[0];
        if (product) reasons.push("품명 표기 확인");
      }
      const customerCode = /^\d+$/.test(code) ? code : "";
      if (customerCode) reasons.push("거래처 품번 확인");
      if (!product && (!code || customerCode)) reasons.push("품번 확인");
      const parts = (raw || "").match(/^(-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?)\s*(P|PLT|파렛트|BOX|박스|C\/T|EA|본|개|천본|KEA)?$/i);
      let unit = (parts?.[2] || get("unit") || headers.find(h => fieldFor(h) === "quantity")?.match(/\(([^)]+)\)/)?.[1] || "EA").toUpperCase();
      const originalUnit = unit;
      if (!/^(EA|본|개|P|PLT|파렛트|박스|BOX|C\/T|천본|KEA)$/.test(unit)) reasons.push("단위 확인");
      let quantity = parts ? Number(parts[1].replace(/,/g, "")) : null;
      const factor = /^(P|PLT|파렛트)$/.test(unit) ? product?.pallet : /^(박스|BOX|C\/T)$/.test(unit) ? product?.box : /^(천본|KEA)$/.test(unit) ? 1000 : 1;
      if (quantity === null || !factor || quantity <= 0) { quantity = null; reasons.push("수량 확인"); }
      else {
        quantity *= factor;
        // Correct floating-point noise from decimal thousands without rounding fractional EA.
        const nearest = Math.round(quantity);
        if (Math.abs(quantity - nearest) <= Number.EPSILON * Math.abs(quantity)) quantity = nearest;
        if (/^(EA|본|개|P|PLT|파렛트|박스|BOX|C\/T|천본|KEA)$/.test(unit)) unit = "EA";
        if (!Number.isSafeInteger(quantity)) reasons.push("단위 환산 확인");
      }
      const date = readDate((col >= 0 ? headers[col] : get("requestedDate")) || meta["납기일"] || meta["납기"] || "", dateRef);
      if (date.warning) reasons.push(date.warning);
      if (!date.date) reasons.push("납기 확인");
      else if (date.date < reference.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" })) reasons.push("지난 납기 확인");
      const price = cells[headers.findIndex(h => h === "단가")];
      const orderNumber = meta["발주번호"] || meta["주문번호"];
      const note = [orderNumber && "발주번호 " + orderNumber, price && /^단가\s*기재/.test(meta["특이사항"] || "") ? "" : meta["특이사항"], price && "단가 " + Number(price.replace(/,/g, "")).toLocaleString("ko-KR"), get("note")].filter(Boolean).join(" / ");
      const productCode = product?.code || (customerCode ? "" : code);
      const key = JSON.stringify([destination, customer, productCode || name, date.date]);
      if (seen.has(key)) reasons.push("중복 여부 확인");
      seen.add(key);
      const boxes = boxCount(productCode, quantity, unit);
      if (product && quantity !== null && boxes === null) reasons.push("박스수량 확인");
      rows.push({ productCode, productName: product?.name || name, quantity, unit, customer, destination, boxes, requestedDate: date.date, condition: date.condition || get("condition"), note, originalName: name, originalQuantity: raw || "", originalUnit, conversion: factor && factor !== 1 ? "1" + originalUnit + "=" + factor + "EA" : "", customerCode, reviewReason: reasons.join(" / ") });
    }
  }
  if (!rows.length) warnings.push("인식한 품목이 없습니다. 원본과 대조해 입력하세요.");
  return { rows, warnings, unmappedColumns: [], orderNumber: meta["발주번호"] || meta["주문번호"] };
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
