/**
 * lib/excel/import-plan.ts · FR-03 현행 주간 생산계획표(엑셀) 가져오기
 *
 * 매칭 규칙 (UI 도움말에 그대로 적을 것)
 *  - 호기 행: A열 라벨을 공백·'호기' 제거 후 코드와 비교. 'PET 1호기' / 'PET1' / 'PET 1' / 'pet-01' → PET1.
 *    '1호기'처럼 접두어가 없으면 'PET1' 로 시도. 어느 호기에도 안 맞는 행('사출기' 등)은 경고와 함께 건너뜀 (Q1).
 *  - 날짜 열: 헤더 바로 윗 행에 실제 Date(또는 Excel 일련번호)가 있으면 그것을 쓴다.
 *    없으면 헤더 텍스트 '11/12(목)' 를 연도(periodStart → 제목의 '2026년'/'2611' → 올해)와 합쳐 해석.
 *    월이 줄어들면(12월→1월) 연도를 올린다.
 *  - 셀 텍스트: 줄바꿈으로 나눠 첫 줄은 제품명, 이후 줄 중 숫자로 읽히는 첫 줄은 수량(천 단위 쉼표 허용).
 *    제품명 끝의 '(B/M)' '(BM)' → 교체유형 BM, '(Full)' '(F/S)' '(풀셋)' → FULL. 마커가 없으면 NONE(엔진이 기본값 적용).
 *  - 제품명은 NFC·공백 축약·소문자로 정규화해 products.name 과 비교. 못 찾으면 unmatched 에 기록하고 셀은 제외.
 *  - '설비 고장' '정전' '휴무' '점검' 등 가동 불가 텍스트 → productId null 셀 + 경고 (다운타임은 여기서 만들지 않음).
 *  - 숫자만 있는 셀은 해석 불가 숫자로 경고.
 */
import type ExcelJS from "exceljs";
import type { ChangeoverType, ISODate, PlanCell } from "../engine/types";
import {
  cellDate,
  cellText,
  compactName,
  inferYearFromTitle,
  isDowntimeText,
  lineLabelToCode,
  loadWorkbook,
  normalizeName,
  parseDateHeaders,
  parseNumber,
  rawValue,
  type ExcelInput,
} from "./common";

export interface PlanImportLine {
  id: string;
  code: string;
  name: string;
}
export interface PlanImportProduct {
  id: string;
  name: string;
}
export interface PlanImportContext {
  lines: PlanImportLine[];
  products: PlanImportProduct[];
  /** 'YYYY-MM-DD'. 헤더 텍스트 연도 추정과 결과 periodStart 기본값에 사용 */
  periodStart?: ISODate;
  /** 시트 이름. 비우면 '호기' 헤더가 있는 첫 시트 */
  sheetName?: string;
}

export interface UnmatchedCell {
  sheet: string;
  cellRef: string;
  lineCode: string;
  date: ISODate;
  text: string;
}

export interface PlanImportResult {
  periodStart: ISODate | null;
  dates: ISODate[];
  cells: PlanCell[];
  unmatched: UnmatchedCell[];
  warnings: string[];
  lineRows: { lineCode: string; allowedMoldNames: string[] }[];
  sheetName: string | null;
}

export interface ParsedCellText {
  kind: "empty" | "product" | "downtime" | "number";
  productName: string;
  changeoverType: ChangeoverType;
  qty: number | null;
  raw: string;
}

const MARKER_RE = /\s*[(\[]\s*(b\/m|bm|비엠|full|f\/s|fs|풀셋|풀세트|풀)\s*[)\]]/i;

/** 셀 텍스트 → 제품명·교체유형·수량 */
export function parsePlanCellText(raw: string): ParsedCellText {
  const text = raw.normalize("NFC").trim();
  if (!text) return { kind: "empty", productName: "", changeoverType: "NONE", qty: null, raw };
  const lines = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const first = lines[0] ?? "";

  if (isDowntimeText(first) && parseNumber(first) === null) {
    return { kind: "downtime", productName: "", changeoverType: "NONE", qty: null, raw };
  }
  if (parseNumber(first) !== null) {
    return { kind: "number", productName: "", changeoverType: "NONE", qty: parseNumber(first), raw };
  }

  let changeoverType: ChangeoverType = "NONE";
  const m = first.match(MARKER_RE);
  let name = first;
  if (m) {
    const token = m[1].toLowerCase();
    changeoverType = token === "b/m" || token === "bm" || token === "비엠" ? "BM" : "FULL";
    name = first.replace(MARKER_RE, " ");
  }
  name = name.replace(/\s+/g, " ").trim();

  let qty: number | null = null;
  for (const l of lines.slice(1)) {
    const n = parseNumber(l);
    if (n !== null) {
      qty = Math.round(n);
      break;
    }
  }
  return { kind: "product", productName: name, changeoverType, qty, raw };
}

function buildLineIndex(lines: PlanImportLine[]): Map<string, PlanImportLine> {
  const idx = new Map<string, PlanImportLine>();
  for (const l of lines) {
    const keys = new Set<string>([
      lineLabelToCode(l.code),
      lineLabelToCode(l.name),
      compactName(l.code),
      compactName(l.name),
      compactName(l.name).replace(/호기$/, ""),
    ]);
    for (const k of keys) if (k && !idx.has(k)) idx.set(k, l);
  }
  return idx;
}

function matchLine(label: string, idx: Map<string, PlanImportLine>): PlanImportLine | null {
  const code = lineLabelToCode(label);
  const compact = compactName(label);
  const cands = [code, compact, compact.replace(/호기$/, "")];
  for (const c of cands) {
    const hit = idx.get(c);
    if (hit) return hit;
  }
  // '1호기' → PET1
  const digits = compact.replace(/호기$/, "");
  if (/^\d+$/.test(digits)) {
    const hit = idx.get(`PET${Number(digits)}`);
    if (hit) return hit;
  }
  return null;
}

function pickSheet(wb: ExcelJS.Workbook, sheetName?: string): ExcelJS.Worksheet | null {
  if (sheetName) {
    const ws = wb.getWorksheet(sheetName);
    if (ws) return ws;
  }
  for (const ws of wb.worksheets) {
    if (findLineHeaderRow(ws) !== null) return ws;
  }
  return wb.worksheets[0] ?? null;
}

const LINE_HEADER_WORDS = ["호기", "라인", "설비", "line"];

function findLineHeaderRow(ws: ExcelJS.Worksheet): { row: number; lineCol: number } | null {
  const limit = Math.min(ws.rowCount, 20);
  for (let r = 1; r <= limit; r++) {
    const row = ws.getRow(r);
    let found: number | null = null;
    let nonEmpty = 0;
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      nonEmpty++;
      const t = compactName(cellText(cell));
      if (found === null && LINE_HEADER_WORDS.includes(t)) found = col;
    });
    if (found !== null && nonEmpty >= 3) return { row: r, lineCol: found };
  }
  return null;
}

export async function parsePlanWorkbook(buf: ExcelInput, ctx: PlanImportContext): Promise<PlanImportResult> {
  const warnings: string[] = [];
  const unmatched: UnmatchedCell[] = [];
  const cells: PlanCell[] = [];
  const lineRows: { lineCode: string; allowedMoldNames: string[] }[] = [];

  const wb = await loadWorkbook(buf);
  const ws = pickSheet(wb, ctx.sheetName);
  if (!ws) {
    return { periodStart: ctx.periodStart ?? null, dates: [], cells, unmatched, warnings: ["워크시트가 없습니다."], lineRows, sheetName: null };
  }
  const header = findLineHeaderRow(ws);
  if (!header) {
    return {
      periodStart: ctx.periodStart ?? null,
      dates: [],
      cells,
      unmatched,
      warnings: [`시트 '${ws.name}': '호기' 헤더 행을 찾지 못했습니다.`],
      lineRows,
      sheetName: ws.name,
    };
  }
  const { row: headerRow, lineCol } = header;

  // 연도 추정: periodStart → 제목 → 올해
  let baseYear: number | null = ctx.periodStart ? Number(ctx.periodStart.slice(0, 4)) : null;
  if (!baseYear) {
    for (let r = 1; r < headerRow && !baseYear; r++) {
      ws.getRow(r).eachCell({ includeEmpty: false }, (cell) => {
        if (!baseYear) baseYear = inferYearFromTitle(cellText(cell));
      });
    }
  }
  if (!baseYear) {
    baseYear = new Date().getFullYear();
    warnings.push(`연도를 알 수 없어 올해(${baseYear})로 가정했습니다.`);
  }

  // 열 해석
  const headerCells: { col: number; text: string }[] = [];
  ws.getRow(headerRow).eachCell({ includeEmpty: false }, (cell, col) => headerCells.push({ col, text: cellText(cell) }));
  let moldCol: number | null = null;
  const dateCandidates: { col: number; text: string }[] = [];
  for (const h of headerCells) {
    if (h.col === lineCol) continue;
    const c = compactName(h.text);
    if (moldCol === null && (c.includes("금형") || c.includes("생산가능") || c.includes("제품"))) {
      moldCol = h.col;
      continue;
    }
    dateCandidates.push(h);
  }
  const fromText = parseDateHeaders(
    dateCandidates.map((d) => d.text),
    baseYear,
  );
  const dateCols: { col: number; date: ISODate }[] = [];
  dateCandidates.forEach((d, i) => {
    let iso: ISODate | null = null;
    if (headerRow > 1) {
      const above = ws.getCell(headerRow - 1, d.col);
      const rv = rawValue(above);
      if (rv instanceof Date || typeof rv === "number") iso = cellDate(above, baseYear ?? undefined);
    }
    if (!iso) iso = fromText[i];
    if (iso) dateCols.push({ col: d.col, date: iso });
    else if (d.text) warnings.push(`열 ${d.col} 헤더 '${d.text}' 를 날짜로 해석하지 못해 건너뜀`);
  });
  const dates = dateCols.map((d) => d.date);
  if (dates.length === 0) warnings.push(`시트 '${ws.name}': 날짜 열을 찾지 못했습니다.`);

  // 제품 인덱스
  const productIdx = new Map<string, PlanImportProduct>();
  for (const p of ctx.products) productIdx.set(normalizeName(p.name), p);
  const lineIdx = buildLineIndex(ctx.lines);
  const seenLines = new Set<string>();

  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const label = cellText(row.getCell(lineCol));
    if (!label) continue;
    const line = matchLine(label, lineIdx);
    if (!line) {
      const nums: string[] = [];
      for (const dc of dateCols) {
        const t = cellText(row.getCell(dc.col));
        if (t) nums.push(t);
      }
      const tail = nums.length ? ` (해석 불가 숫자: ${nums.slice(0, 6).join(", ")}${nums.length > 6 ? " …" : ""})` : "";
      warnings.push(`행 ${r} '${label}': 호기를 찾을 수 없어 건너뜀${tail}`);
      continue;
    }
    if (seenLines.has(line.id)) {
      warnings.push(`행 ${r} '${label}': 호기 ${line.code} 가 중복돼 두 번째 행은 무시`);
      continue;
    }
    seenLines.add(line.id);

    const moldText = moldCol !== null ? cellText(row.getCell(moldCol)) : "";
    lineRows.push({
      lineCode: line.code,
      allowedMoldNames: moldText
        .split(/[,\n/;]/)
        .map((s) => s.replace(/\s+/g, " ").trim())
        .filter(Boolean),
    });

    for (const dc of dateCols) {
      const cell = row.getCell(dc.col);
      const text = cellText(cell);
      if (!text) continue;
      const parsed = parsePlanCellText(text);
      if (parsed.kind === "empty") continue;
      if (parsed.kind === "downtime") {
        cells.push({ lineId: line.id, date: dc.date, productId: null, qty: null, changeoverType: "NONE", memo: parsed.raw.trim() });
        warnings.push(`${line.code} ${dc.date}: 가동 불가 텍스트 '${parsed.raw.trim()}' → 빈 셀로 처리 (가동 불가일은 별도 등록 필요)`);
        continue;
      }
      if (parsed.kind === "number") {
        warnings.push(`${line.code} ${dc.date} (${cell.address}): 제품명 없이 숫자 '${parsed.raw.trim()}' 만 있어 무시`);
        continue;
      }
      const product = productIdx.get(normalizeName(parsed.productName));
      if (!product) {
        unmatched.push({ sheet: ws.name, cellRef: cell.address, lineCode: line.code, date: dc.date, text: parsed.raw.trim() });
        continue;
      }
      cells.push({
        lineId: line.id,
        date: dc.date,
        productId: product.id,
        qty: parsed.qty,
        changeoverType: parsed.changeoverType,
      });
    }
  }

  return {
    periodStart: ctx.periodStart ?? dates[0] ?? null,
    dates,
    cells,
    unmatched,
    warnings,
    lineRows,
    sheetName: ws.name,
  };
}
