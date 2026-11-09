/**
 * lib/excel/common.ts · 엑셀 가져오기/내보내기 공용 헬퍼 (서버 전용, ExcelJS)
 *
 * - 셀 값 추출: 문자열·숫자·Date·리치텍스트·수식 결과·하이퍼링크 모두 문자열로
 * - 날짜: Excel Date(UTC 기준) → 'YYYY-MM-DD', 한국식 헤더 '11/12(목)' → 날짜
 * - 이름 정규화: NFC, 공백 축약, 소문자 (제품명·호기명 매칭용)
 * - 천 단위 구분자가 있는 수량 문자열 파싱
 *
 * 이 모듈은 DB에 접근하지 않는다.
 */
import ExcelJS from "exceljs";
import type { ISODate } from "../engine/types";

export type ExcelInput = Buffer | ArrayBuffer | Uint8Array;

/** 기본 글꼴 (Pretendard 미설치 환경을 고려한 맑은 고딕) */
export const DEFAULT_FONT: Partial<ExcelJS.Font> = { name: "Malgun Gothic", size: 10 };
/** 주말 헤더 배경 */
export const WEEKEND_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFEDEDED" },
};
/** 가동 불가(다운타임) 셀 배경 */
export const DOWNTIME_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFBFBFBF" },
};
/** 헤더 배경 */
export const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFD9E1F2" },
};

export const KOREAN_WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

/** 가동 불가로 해석할 셀 텍스트 키워드 (제품명이 아님) */
export const DOWNTIME_KEYWORDS = ["설비 고장", "설비고장", "고장", "정전", "휴무", "점검", "비가동", "가동중지", "가동 중지", "휴일", "수리"];

// ---------------------------------------------------------------------------
// 워크북 로드
// ---------------------------------------------------------------------------
export async function loadWorkbook(input: ExcelInput): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  const buf = toNodeBuffer(input);
  // ExcelJS 타입의 Buffer 는 ArrayBuffer 확장형으로 선언돼 있어 캐스팅이 필요하다.
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

export function toNodeBuffer(input: ExcelInput): Buffer {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

export async function workbookToBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as unknown as ArrayBuffer);
}

// ---------------------------------------------------------------------------
// 셀 값
// ---------------------------------------------------------------------------
type AnyCellValue = ExcelJS.CellValue;

function isRichText(v: unknown): v is ExcelJS.CellRichTextValue {
  return typeof v === "object" && v !== null && Array.isArray((v as ExcelJS.CellRichTextValue).richText);
}
function isFormula(v: unknown): v is ExcelJS.CellFormulaValue | ExcelJS.CellSharedFormulaValue {
  return typeof v === "object" && v !== null && ("formula" in (v as object) || "sharedFormula" in (v as object));
}
function isHyperlink(v: unknown): v is ExcelJS.CellHyperlinkValue {
  return typeof v === "object" && v !== null && "hyperlink" in (v as object);
}
function isErrorValue(v: unknown): v is ExcelJS.CellErrorValue {
  return typeof v === "object" && v !== null && "error" in (v as object);
}

/** 셀의 원시 값(수식이면 결과값)을 반환 */
export function rawValue(cell: ExcelJS.Cell | AnyCellValue | undefined | null): AnyCellValue {
  if (cell === undefined || cell === null) return null;
  const v: AnyCellValue =
    typeof cell === "object" && cell !== null && "value" in (cell as object) && "address" in (cell as object)
      ? (cell as ExcelJS.Cell).value
      : (cell as AnyCellValue);
  if (isFormula(v)) return (v.result ?? null) as AnyCellValue;
  return v;
}

/** 셀 텍스트 추출. 리치텍스트/수식/하이퍼링크/Date/숫자 모두 문자열로 */
export function cellText(cell: ExcelJS.Cell | AnyCellValue | undefined | null): string {
  const v = rawValue(cell);
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v instanceof Date) return toISODateUTC(v);
  if (isRichText(v)) return v.richText.map((r) => r.text).join("").trim();
  if (isHyperlink(v)) {
    const t = v.text;
    if (typeof t === "string") return t.trim();
    if (isRichText(t)) return (t as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join("").trim();
    return String(v.hyperlink ?? "").trim();
  }
  if (isErrorValue(v)) return "";
  return String(v).trim();
}

/** 셀이 Date 또는 Excel 날짜 일련번호이면 'YYYY-MM-DD', 아니면 문자열 날짜 파싱 시도 */
export function cellDate(cell: ExcelJS.Cell | AnyCellValue | undefined | null, baseYear?: number): ISODate | null {
  const v = rawValue(cell);
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return toISODateUTC(v);
  if (typeof v === "number") {
    // Excel 일련번호(1900 기준). 1990~2100년 범위만 날짜로 인정
    if (v > 32000 && v < 75000) return excelSerialToISODate(v);
    return null;
  }
  const text = cellText(v);
  if (!text) return null;
  return parseDateText(text, baseYear);
}

// ---------------------------------------------------------------------------
// 날짜
// ---------------------------------------------------------------------------
export function toISODateUTC(d: Date): ISODate {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${y}-${pad2(m)}-${pad2(day)}`;
}

/** 'YYYY-MM-DD' → ExcelJS 에 쓸 Date (UTC 자정). ExcelJS 는 UTC 기준으로 직렬화한다 */
export function isoToExcelDate(iso: ISODate): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function excelSerialToISODate(serial: number): ISODate {
  // Excel 1900 체계: 25569 = 1970-01-01
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  return toISODateUTC(new Date(ms));
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function addDays(iso: ISODate, n: number): ISODate {
  const d = isoToExcelDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toISODateUTC(d);
}

export function dateRange(start: ISODate, days: number): ISODate[] {
  const out: ISODate[] = [];
  for (let i = 0; i < days; i++) out.push(addDays(start, i));
  return out;
}

/** 0=일 … 6=토 */
export function weekdayOf(iso: ISODate): number {
  return isoToExcelDate(iso).getUTCDay();
}

export function isWeekend(iso: ISODate): boolean {
  const w = weekdayOf(iso);
  return w === 0 || w === 6;
}

/** '11/12(목)' 형식의 헤더 텍스트 */
export function formatKoreanDateHeader(iso: ISODate): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${m}/${d}(${KOREAN_WEEKDAYS[weekdayOf(iso)]})`;
}

/**
 * 날짜 문자열 파싱.
 *  - '2026-11-12', '2026.11.12', '2026/11/12', '20261112'
 *  - '11/12(목)', '11/12', '11.12', '11월 12일', '11월12일(목)'  → baseYear 필요(없으면 올해)
 */
export function parseDateText(text: string, baseYear?: number): ISODate | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return null;
  let m = t.match(/^(\d{4})[-./년]\s*(\d{1,2})[-./월]\s*(\d{1,2})일?/);
  if (m) return makeISO(Number(m[1]), Number(m[2]), Number(m[3]));
  m = t.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return makeISO(Number(m[1]), Number(m[2]), Number(m[3]));
  m = t.match(/^(\d{1,2})\s*[/.월]\s*(\d{1,2})\s*일?\s*(?:\([일월화수목금토]\))?/);
  if (m) {
    const y = baseYear ?? new Date().getFullYear();
    return makeISO(y, Number(m[1]), Number(m[2]));
  }
  // ISO 타임스탬프 등
  const d = new Date(t);
  if (!Number.isNaN(d.getTime()) && /^\d{4}-\d{2}-\d{2}T/.test(t)) return toISODateUTC(d);
  return null;
}

function makeISO(y: number, m: number, d: number): ISODate | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null; // 2/30 같은 날짜 거르기
  return toISODateUTC(dt);
}

/**
 * 한국식 날짜 헤더 열 해석. 연도가 없는 '11/12(목)' 는 baseYear 를 쓰되,
 * 직전 열보다 월이 작아지면(12월→1월) 연도를 1 올린다.
 */
export function parseDateHeaders(texts: string[], baseYear: number): (ISODate | null)[] {
  const out: (ISODate | null)[] = [];
  let year = baseYear;
  let prevMonth: number | null = null;
  for (const text of texts) {
    const hasYear = /\d{4}/.test(text);
    let iso = parseDateText(text, year);
    if (iso && !hasYear) {
      const month = Number(iso.slice(5, 7));
      if (prevMonth !== null && month < prevMonth) {
        year += 1;
        iso = parseDateText(text, year);
      }
      prevMonth = month;
    } else if (iso) {
      year = Number(iso.slice(0, 4));
      prevMonth = Number(iso.slice(5, 7));
    }
    out.push(iso);
  }
  return out;
}

/** 제목 텍스트에서 연도 추정: '2026년', '2026-11', '2611' (YYMM) */
export function inferYearFromTitle(title: string): number | null {
  let m = title.match(/(20\d{2})\s*[-./년]/);
  if (m) return Number(m[1]);
  m = title.match(/(?:^|[^\d])(2\d)(0[1-9]|1[0-2])(?:[^\d]|$)/); // '2611' → 2026
  if (m) return 2000 + Number(m[1]);
  return null;
}

// ---------------------------------------------------------------------------
// 이름·숫자
// ---------------------------------------------------------------------------
/** 매칭용 정규화: NFC, 앞뒤 공백 제거, 연속 공백 1칸, 소문자 */
export function normalizeName(s: string): string {
  return s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** 공백·구두점을 모두 제거한 강한 정규화(호기명 비교용) */
export function compactName(s: string): string {
  return s.normalize("NFC").toLowerCase().replace(/[\s\-_./()\[\]]/g, "");
}

/**
 * 호기 라벨 → 코드. 'PET 1호기' / 'PET1' / 'PET 1' / 'pet-01' → 'PET1'.
 * 숫자만 있거나('1호기') 모르는 형태면 공백 제거 후 대문자로 돌려준다.
 */
export function lineLabelToCode(label: string): string {
  const c = compactName(label).replace(/호기$/, "");
  const m = c.match(/^([a-z]+)0*(\d+)$/);
  if (m) return `${m[1].toUpperCase()}${Number(m[2])}`;
  return c.toUpperCase();
}

/** '96,000' / '96000본' / '96,000 EA' / '1.5' → number. 빈 값·'-' → null */
export function parseNumber(text: string | number | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  if (typeof text === "number") return Number.isFinite(text) ? text : null;
  const t = text.replace(/[,\s]/g, "").replace(/(본|ea|kea|개|톤|t|g|일)$/i, "").trim();
  if (!t || t === "-") return null;
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** 'Y' / 'N' / '예' / '아니오' / 'O' / 'X' / true / 1 → boolean */
export function parseYesNo(text: string | number | boolean | null | undefined): boolean {
  if (text === null || text === undefined) return false;
  if (typeof text === "boolean") return text;
  if (typeof text === "number") return text !== 0;
  const t = text.trim().toLowerCase();
  return ["y", "yes", "o", "true", "1", "예", "대형", "✓", "v"].includes(t);
}

export function formatThousands(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// 워크시트 탐색
// ---------------------------------------------------------------------------
/** 요구 텍스트를 모두 포함하는 첫 헤더 행 번호 (없으면 null) */
export function findHeaderRow(ws: ExcelJS.Worksheet, required: string[], maxScan = 20): number | null {
  const want = required.map(compactName);
  const limit = Math.min(ws.rowCount, maxScan);
  for (let r = 1; r <= limit; r++) {
    const row = ws.getRow(r);
    const texts: string[] = [];
    row.eachCell({ includeEmpty: false }, (cell) => texts.push(compactName(cellText(cell))));
    if (want.every((w) => texts.some((t) => t.includes(w)))) return r;
  }
  return null;
}

/** 헤더 행의 열 → 정규화된 헤더 텍스트 맵 */
export function headerMap(ws: ExcelJS.Worksheet, headerRow: number): Map<number, string> {
  const map = new Map<number, string>();
  ws.getRow(headerRow).eachCell({ includeEmpty: false }, (cell, col) => {
    const t = cellText(cell);
    if (t) map.set(col, t);
  });
  return map;
}

/** 헤더 맵에서 후보 이름 중 하나를 포함하는 첫 열 번호 */
export function findColumn(headers: Map<number, string>, candidates: string[]): number | null {
  const wants = candidates.map(compactName);
  for (const [col, text] of headers) {
    const c = compactName(text);
    if (wants.some((w) => c === w)) return col;
  }
  for (const [col, text] of headers) {
    const c = compactName(text);
    if (wants.some((w) => c.includes(w))) return col;
  }
  return null;
}

export function isDowntimeText(text: string): boolean {
  const c = compactName(text);
  if (!c) return false;
  return DOWNTIME_KEYWORDS.some((k) => c.includes(compactName(k)));
}

export function escapeSqlString(s: string): string {
  return s.replace(/'/g, "''");
}
