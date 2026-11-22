/**
 * lib/excel/stock-ledger.ts · 제품수불표(월 단위 재고현황) 가져오기·내보내기
 *
 * 원본 레이아웃 (시트 1장, 예: '11월 제품수불표')
 *   1~2행 헤더(병합): A 공정 | B 호기 | C 품번 | D 품명/규격 | E~G 수불현황(기초재고·생산·출고) | H 현재고
 *                     | I~J PACKAGE(포장수량·unit) | K UNIT수/P | L EA/1P | M PT 수 | N~BW 1~31일(날마다 생산·출고 2열)
 *   3행~ 품목. 구간마다 소계 행('PS 계', '1211 계' …), 맨 아래 요약 표와 '합계' 행.
 *
 * 읽는 규칙 (UI 도움말에 그대로 적을 것)
 *  - 소계·요약·빈 행은 데이터로 읽지 않는다. 구간 이름은 소계 행('OO 계')에서 얻는다.
 *  - 품명은 앞뒤 공백을 지우고 연속 공백을 한 칸으로 줄인다.
 *  - 공정·호기가 빈 행은 윗 행 값을 이어받는다.
 *  - 같은 구간·공정·호기에 같은 품명이 또 나오면 합치지 않고 순번(dupIndex)으로 구분하고 경고한다.
 *  - 생산·출고 합계, 현재고, 포장수량, EA/1P, PT 수는 저장하지 않고 계산한다. 파일의 현재고와 다르면 경고한다.
 *  - 월은 시트명·파일명에서, 연도는 파일명·시트명에서 읽는다. 못 찾으면 null(사용자가 고른다).
 */
import ExcelJS from "exceljs";
import { cellText, loadWorkbook, rawValue, workbookToBuffer, DEFAULT_FONT, HEADER_FILL, type ExcelInput } from "./common";

export interface StockLedgerDay {
  /** 1~31 */
  day: number;
  produced: number;
  shipped: number;
}

export interface StockLedgerRow {
  section: string;
  process: string;
  machineLabel: string;
  itemCode: string | null;
  name: string;
  dupIndex: number;
  opening: number;
  packUnit: number | null;
  unitsPerPallet: number | null;
  /** 값이 있는 날만 */
  days: StockLedgerDay[];
  /** 원본 행 번호(가져온 경우) */
  sourceRow?: number;
}

export interface StockLedgerParseResult {
  sheetName: string | null;
  year: number | null;
  month: number | null;
  rows: StockLedgerRow[];
  sections: string[];
  warnings: string[];
}

export interface StockTotals {
  produced: number;
  shipped: number;
  /** 현재고 = 기초재고 + 생산 − 출고 */
  current: number;
  /** 포장수량 = 현재고 / unit */
  packQty: number | null;
  /** EA/1P = unit × UNIT수/P */
  eaPerPallet: number | null;
  /** PT 수 = ROUNDUP(포장수량 / UNIT수/P) */
  pallets: number | null;
}

/** 파생값 계산(엑셀 수식과 같은 식). asOfDay 를 주면 그날까지만 더한다 */
export function stockTotals(row: Pick<StockLedgerRow, "opening" | "packUnit" | "unitsPerPallet" | "days">, asOfDay = 31): StockTotals {
  let produced = 0;
  let shipped = 0;
  for (const d of row.days) {
    if (d.day > asOfDay) continue;
    produced += d.produced;
    shipped += d.shipped;
  }
  const current = row.opening + produced - shipped;
  const packQty = row.packUnit ? current / row.packUnit : null;
  const eaPerPallet = row.packUnit != null && row.unitsPerPallet != null ? row.packUnit * row.unitsPerPallet : null;
  const pallets = packQty !== null && row.unitsPerPallet ? roundUp(packQty / row.unitsPerPallet) : null;
  return { produced, shipped, current, packQty, eaPerPallet, pallets };
}

/** 엑셀 ROUNDUP(x, 0): 0에서 멀어지는 쪽으로 올림 */
function roundUp(x: number): number {
  const r = Math.round(x * 1e9) / 1e9;
  return r >= 0 ? Math.ceil(r) : Math.floor(r);
}

export function normalizeStockName(s: string): string {
  return s.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** 품목 식별 키: 품번이 있으면 품번 우선, 없으면 구간+공정+호기+품명+순번 */
export function stockItemKey(r: Pick<StockLedgerRow, "section" | "process" | "machineLabel" | "name" | "dupIndex">): string {
  return [r.section, r.process, r.machineLabel, r.name, r.dupIndex].join("\u0001");
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 시트명·파일명에서 연·월 추정. 규칙이 바뀌면 여기만 고친다 */
export function inferLedgerYearMonth(sheetName: string | null, filename: string | null): { year: number | null; month: number | null } {
  const texts = [sheetName ?? "", filename ?? ""].map((t) => t.normalize("NFC"));
  let month: number | null = null;
  let year: number | null = null;
  for (const t of texts) {
    if (month === null) {
      const m = t.match(/(\d{1,2})\s*월/);
      if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) month = Number(m[1]);
    }
    if (year === null) {
      const y4 = t.match(/(20\d{2})\s*년?/);
      const y2 = t.match(/(?:^|[^\d])(\d{2})\s*년/);
      if (y4) year = Number(y4[1]);
      else if (y2) year = 2000 + Number(y2[1]);
    }
  }
  for (const t of texts) {
    const ym = t.match(/(20\d{2})[-_. ]?(0[1-9]|1[0-2])(?!\d)/);
    if (ym) {
      if (year === null) year = Number(ym[1]);
      if (month === null) month = Number(ym[2]);
    }
  }
  return { year, month };
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = v.replace(/,/g, "").trim();
    if (t !== "" && /^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  }
  return null;
}

// 고정 열 (1부터)
const COL = { process: 1, machine: 2, code: 3, name: 4, opening: 5, produced: 6, shipped: 7, current: 8, packQty: 9, unit: 10, unitsPerPallet: 11, eaPerPallet: 12, pallets: 13, firstDay: 14 };

// ---------------------------------------------------------------------------
// 가져오기
// ---------------------------------------------------------------------------
export async function parseStockLedgerWorkbook(
  input: ExcelInput,
  opts: { filename?: string; sheetName?: string } = {},
): Promise<StockLedgerParseResult> {
  const wb = await loadWorkbook(input);
  const warnings: string[] = [];
  const ws =
    (opts.sheetName ? wb.getWorksheet(opts.sheetName) : undefined) ??
    wb.worksheets.find((w) => /수불/.test(w.name)) ??
    wb.worksheets[0];
  if (!ws) return { sheetName: null, year: null, month: null, rows: [], sections: [], warnings: ["시트가 없습니다"] };

  // 헤더 행: A '공정', D '품명'
  let headerRow = 0;
  for (let r = 1; r <= Math.min(ws.rowCount, 15); r++) {
    if (/공정/.test(cellText(ws.getRow(r).getCell(COL.process))) && /품명/.test(cellText(ws.getRow(r).getCell(COL.name)))) {
      headerRow = r;
      break;
    }
  }
  if (!headerRow) {
    return { sheetName: ws.name, year: null, month: null, rows: [], sections: [], warnings: ["'공정 … 품명/규격' 헤더 행을 찾지 못했습니다. 제품수불표 양식이 맞는지 확인하세요"] };
  }

  // 일자 열: 헤더의 'N일' → 생산 열, 그 다음 열이 출고
  const dayCols = new Map<number, number>();
  const hdr = ws.getRow(headerRow);
  for (let c = COL.firstDay; c <= Math.max(ws.columnCount, COL.firstDay + 62); c++) {
    const m = cellText(hdr.getCell(c)).trim().match(/^(\d{1,2})\s*일$/);
    // 병합된 헤더는 둘째 칸도 같은 글자로 읽히므로 처음 나온 열만 쓴다
    if (m && !dayCols.has(Number(m[1]))) dayCols.set(Number(m[1]), c);
  }
  if (!dayCols.size) {
    for (let d = 1; d <= 31; d++) dayCols.set(d, COL.firstDay + (d - 1) * 2);
    warnings.push("일자 헤더('1일'…)를 찾지 못해 N열부터 2열씩으로 읽었습니다");
  }

  const { year, month } = inferLedgerYearMonth(ws.name, opts.filename ?? null);
  if (month === null) warnings.push("시트명·파일명에서 월을 찾지 못했습니다. 화면에서 고르세요");
  if (year === null) warnings.push("시트명·파일명에서 연도를 찾지 못했습니다. 화면에서 고르세요");
  const maxDay = year !== null && month !== null ? daysInMonth(year, month) : 31;

  const rows: StockLedgerRow[] = [];
  const sections: string[] = [];
  let sectionStart = 0; // rows 배열에서 현재 구간이 시작하는 위치
  let lastProcess = "";
  let lastMachine = "";
  const dupCount = new Map<string, number>();

  for (let r = headerRow + 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const a = cellText(row.getCell(COL.process)).normalize("NFC").trim();
    const name = normalizeStockName(cellText(row.getCell(COL.name)));

    // 요약 표(헤더가 한 번 더 나옴)·합계 → 끝
    if (/^공정$/.test(a) || /^합\s*계$/.test(a)) break;
    // 소계 행
    const sub = a.match(/^(.*?)\s*계$/);
    if (sub && !name) {
      const section = sub[1].replace(/\s+/g, " ").trim();
      for (let i = sectionStart; i < rows.length; i++) rows[i].section = section;
      sections.push(section);
      sectionStart = rows.length;
      lastProcess = "";
      lastMachine = "";
      continue;
    }
    if (!name) continue;

    let process = a.replace(/\s+/g, " ");
    let machine = cellText(row.getCell(COL.machine)).normalize("NFC").replace(/\s+/g, " ").trim();
    if (!process && !machine) {
      process = lastProcess;
      machine = lastMachine;
      warnings.push(`${r}행 "${name}": 공정·호기가 비어 있어 윗 행(${process || "-"} / ${machine || "-"})을 이어받았습니다`);
    } else {
      if (!process) process = lastProcess;
      lastProcess = process;
      lastMachine = machine;
    }

    const opening = num(rawValue(row.getCell(COL.opening)));
    if (opening === null && cellText(row.getCell(COL.opening)).trim() !== "") {
      warnings.push(`${r}행 "${name}": 기초재고를 숫자로 읽지 못해 0으로 두었습니다`);
    }

    const days: StockLedgerDay[] = [];
    const negatives: string[] = [];
    for (const [day, c] of dayCols) {
      const p = num(rawValue(row.getCell(c))) ?? 0;
      const s = num(rawValue(row.getCell(c + 1))) ?? 0;
      if (p === 0 && s === 0) continue;
      if (day > maxDay) {
        warnings.push(`${r}행 "${name}": ${day}일 칸에 값이 있지만 그 달은 ${maxDay}일까지라 읽지 않았습니다`);
        continue;
      }
      if (p < 0) negatives.push(`${day}일 생산 ${p.toLocaleString("ko-KR")}`);
      if (s < 0) negatives.push(`${day}일 출고 ${s.toLocaleString("ko-KR")}`);
      days.push({ day, produced: p, shipped: s });
    }
    days.sort((x, y) => x.day - y.day);
    if ((opening ?? 0) < 0) negatives.unshift(`기초재고 ${(opening as number).toLocaleString("ko-KR")}`);
    if (negatives.length) warnings.push(`${r}행 "${name}": 음수가 있습니다 (${negatives.join(", ")}). 보정(반품·수량 정정)이 아니라면 파일을 고쳐 다시 올리세요`);

    const item: StockLedgerRow = {
      section: "",
      process,
      machineLabel: machine,
      itemCode: cellText(row.getCell(COL.code)).trim() || null,
      name,
      dupIndex: 0,
      opening: opening ?? 0,
      packUnit: num(rawValue(row.getCell(COL.unit))),
      unitsPerPallet: num(rawValue(row.getCell(COL.unitsPerPallet))),
      days,
      sourceRow: r,
    };
    // 현재고 검산: 저장된 결과값이 있으면 비교, 없으면 계산값을 그대로 쓴다
    const stored = num(rawValue(row.getCell(COL.current)));
    const calc = stockTotals(item).current;
    if (stored !== null && Math.abs(stored - calc) > 0.5) {
      warnings.push(`${r}행 "${name}": 파일의 현재고 ${stored.toLocaleString("ko-KR")} 와 계산값 ${calc.toLocaleString("ko-KR")} 이 다릅니다. 계산값을 씁니다`);
    }
    rows.push(item);
  }

  // 같은 구간·공정·호기의 같은 품명 → 순번
  for (const item of rows) {
    const k = [item.section, item.process, item.machineLabel, item.name].join("\u0001");
    const n = dupCount.get(k) ?? 0;
    item.dupIndex = n;
    dupCount.set(k, n + 1);
    if (n > 0) {
      warnings.push(`${item.sourceRow}행 "${item.name}": 같은 구간에 같은 품명이 또 있습니다(${n + 1}번째). 합치지 않고 따로 읽었습니다`);
    }
  }
  if (!rows.length) warnings.push("읽은 품목이 없습니다");
  return { sheetName: ws.name, year, month, rows, sections, warnings };
}

// ---------------------------------------------------------------------------
// 내보내기 (원본과 같은 레이아웃, 파생값은 엑셀 수식)
// ---------------------------------------------------------------------------
export interface StockLedgerExportInput {
  year: number;
  month: number;
  rows: StockLedgerRow[];
}

function colLetter(col1: number): string {
  let n = col1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function stockLedgerSheetName(month: number): string {
  return `${month}월 제품수불표`;
}

export function stockLedgerFileName(year: number, month: number): string {
  return `제품수불표_${year}-${String(month).padStart(2, "0")}.xlsx`;
}

export function buildStockLedgerWorkbookObject(input: StockLedgerExportInput): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(stockLedgerSheetName(input.month));
  const LAST_DAY_COL = COL.firstDay + 31 * 2 - 1; // BW
  const firstDayL = colLetter(COL.firstDay);
  const lastDayL = colLetter(LAST_DAY_COL);
  const border: Partial<ExcelJS.Borders> = {
    top: { style: "thin", color: { argb: "FFBFBFBF" } },
    left: { style: "thin", color: { argb: "FFBFBFBF" } },
    bottom: { style: "thin", color: { argb: "FFBFBFBF" } },
    right: { style: "thin", color: { argb: "FFBFBFBF" } },
  };

  // ---- 헤더 2행 ----
  const h1 = ["공정", "호기", "품번", "품명/규격", "수불현황", null, null, "현재고", "PACKAGE", null, "UNIT수/P", "EA/1P", "PT 수"];
  const h2 = [null, null, null, null, "기초재고", "생산", "출고", null, "포장수량", "unit", null, null, null];
  h1.forEach((v, i) => (ws.getCell(1, i + 1).value = v));
  h2.forEach((v, i) => (ws.getCell(2, i + 1).value = v));
  for (let d = 1; d <= 31; d++) {
    const c = COL.firstDay + (d - 1) * 2;
    ws.getCell(1, c).value = `${d}일`;
    ws.mergeCells(1, c, 1, c + 1);
    ws.getCell(2, c).value = "생산";
    ws.getCell(2, c + 1).value = "출고";
  }
  for (const c of [1, 2, 3, 4, 8, 11, 12, 13]) ws.mergeCells(1, c, 2, c);
  ws.mergeCells(1, 5, 1, 7);
  ws.mergeCells(1, 9, 1, 10);
  for (const r of [1, 2]) {
    ws.getRow(r).eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = HEADER_FILL;
      cell.font = { ...DEFAULT_FONT, bold: true };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = border;
    });
  }
  ws.getColumn(1).width = 8;
  ws.getColumn(2).width = 8;
  ws.getColumn(3).width = 12;
  ws.getColumn(4).width = 34;
  for (let c = 5; c <= 13; c++) ws.getColumn(c).width = 11;
  for (let c = COL.firstDay; c <= LAST_DAY_COL; c++) ws.getColumn(c).width = 9;
  ws.views = [{ state: "frozen", xSplit: 4, ySplit: 2 }];

  // ---- 구간별 품목 + 소계 ----
  const sectionOrder: string[] = [];
  const bySection = new Map<string, StockLedgerRow[]>();
  for (const row of input.rows) {
    if (!bySection.has(row.section)) {
      bySection.set(row.section, []);
      sectionOrder.push(row.section);
    }
    bySection.get(row.section)!.push(row);
  }

  const sumCols = [COL.opening, COL.produced, COL.shipped, COL.current];
  const subtotalRows: { section: string; row: number; totals: number[]; dayTotals: number[] }[] = [];
  let r = 3;
  for (const section of sectionOrder) {
    const items = bySection.get(section)!;
    const first = r;
    const totals = [0, 0, 0, 0];
    const dayTotals = new Array<number>(62).fill(0);
    for (const item of items) {
      const t = stockTotals(item);
      const row = ws.getRow(r);
      row.getCell(COL.process).value = item.process || null;
      row.getCell(COL.machine).value = item.machineLabel || null;
      row.getCell(COL.code).value = item.itemCode;
      row.getCell(COL.name).value = item.name;
      row.getCell(COL.opening).value = item.opening;
      row.getCell(COL.produced).value = { formula: `SUMIF($${firstDayL}$2:$${lastDayL}$2,"생산",(${firstDayL}${r}:${lastDayL}${r}))`, result: t.produced };
      row.getCell(COL.shipped).value = { formula: `SUMIF($${firstDayL}$2:$${lastDayL}$2,"출고",(${firstDayL}${r}:${lastDayL}${r}))`, result: t.shipped };
      row.getCell(COL.current).value = { formula: `E${r}+F${r}-G${r}`, result: t.current };
      if (item.packUnit != null) row.getCell(COL.unit).value = item.packUnit;
      if (item.unitsPerPallet != null) row.getCell(COL.unitsPerPallet).value = item.unitsPerPallet;
      if (item.packUnit) row.getCell(COL.packQty).value = { formula: `H${r}/J${r}`, result: t.packQty ?? 0 };
      if (item.packUnit != null && item.unitsPerPallet != null) row.getCell(COL.eaPerPallet).value = { formula: `J${r}*K${r}`, result: t.eaPerPallet ?? 0 };
      if (item.packUnit && item.unitsPerPallet) row.getCell(COL.pallets).value = { formula: `ROUNDUP(I${r}/K${r},0)`, result: t.pallets ?? 0 };
      for (const d of item.days) {
        const c = COL.firstDay + (d.day - 1) * 2;
        if (d.produced !== 0) row.getCell(c).value = d.produced;
        if (d.shipped !== 0) row.getCell(c + 1).value = d.shipped;
        dayTotals[(d.day - 1) * 2] += d.produced;
        dayTotals[(d.day - 1) * 2 + 1] += d.shipped;
      }
      totals[0] += item.opening;
      totals[1] += t.produced;
      totals[2] += t.shipped;
      totals[3] += t.current;
      for (let c = 1; c <= LAST_DAY_COL; c++) {
        const cell = row.getCell(c);
        cell.font = DEFAULT_FONT;
        cell.border = border;
        if (c >= COL.opening) cell.numFmt = c === COL.packQty ? "#,##0.0" : "#,##0";
      }
      r++;
    }
    // 소계 행
    const last = r - 1;
    const srow = ws.getRow(r);
    srow.getCell(1).value = `${section} 계`;
    sumCols.forEach((c, i) => {
      const L = colLetter(c);
      srow.getCell(c).value = { formula: `SUM(${L}${first}:${L}${last})`, result: totals[i] };
    });
    for (let c = COL.firstDay; c <= LAST_DAY_COL; c++) {
      const L = colLetter(c);
      srow.getCell(c).value = { formula: `SUM(${L}${first}:${L}${last})`, result: dayTotals[c - COL.firstDay] };
    }
    for (let c = 1; c <= LAST_DAY_COL; c++) {
      const cell = srow.getCell(c);
      cell.font = { ...DEFAULT_FONT, bold: true };
      cell.fill = HEADER_FILL;
      cell.border = border;
      if (c >= COL.opening) cell.numFmt = "#,##0";
    }
    subtotalRows.push({ section, row: r, totals, dayTotals });
    r++;
  }

  // ---- 맨 아래 요약 표 + 합계 ----
  r += 2;
  const sh1 = ["공정", "호기", null, "품명/규격", "수불현황", null, null, "현재고"];
  const sh2 = [null, null, null, null, "기초재고", "생산", "출고", null];
  sh1.forEach((v, i) => (ws.getCell(r, i + 1).value = v));
  sh2.forEach((v, i) => (ws.getCell(r + 1, i + 1).value = v));
  for (const rr of [r, r + 1]) {
    for (let c = 1; c <= 8; c++) {
      const cell = ws.getCell(rr, c);
      cell.fill = HEADER_FILL;
      cell.font = { ...DEFAULT_FONT, bold: true };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = border;
    }
  }
  r += 2;
  const firstSummary = r;
  for (const s of subtotalRows) {
    ws.getCell(r, 1).value = { formula: `A${s.row}`, result: `${s.section} 계` };
    sumCols.forEach((c, i) => {
      const L = colLetter(c);
      ws.getCell(r, c).value = { formula: `${L}${s.row}`, result: s.totals[i] };
    });
    r++;
  }
  ws.getCell(r, 1).value = "합계";
  sumCols.forEach((c, i) => {
    const L = colLetter(c);
    const total = subtotalRows.reduce((a, s) => a + s.totals[i], 0);
    ws.getCell(r, c).value = subtotalRows.length ? { formula: `SUM(${L}${firstSummary}:${L}${r - 1})`, result: total } : 0;
  });
  for (let rr = firstSummary; rr <= r; rr++) {
    for (let c = 1; c <= 8; c++) {
      const cell = ws.getCell(rr, c);
      cell.font = { ...DEFAULT_FONT, bold: rr === r };
      cell.border = border;
      if (c >= COL.opening) cell.numFmt = "#,##0";
    }
  }
  return wb;
}

export async function buildStockLedgerWorkbook(input: StockLedgerExportInput): Promise<Buffer> {
  return workbookToBuffer(buildStockLedgerWorkbookObject(input));
}
