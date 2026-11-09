/**
 * lib/excel/import-master.ts · FR-01 제품배치 운용안 가져오기
 *
 * 시트 '운용안' (없으면 헤더가 있는 첫 시트). 헤더 행에서 열을 이름으로 찾는다:
 *   호기 | 제품코드 | 제품명 | 캐비티 | 포장단위 | 중량(g) | 일일Capa | 안전재고
 *   | 2026-11 물량 | 2026-11 가동일수 | 2026-12 물량 | … (월 열은 'YYYY-MM 물량' / 'YYYY-MM 가동일수' 패턴)
 * 호기 라벨은 'PET 1호기' → 'PET1' 로 코드화해 돌려준다.
 */
import type { YearMonth } from "../engine/types";
import { cellText, compactName, findColumn, findHeaderRow, headerMap, lineLabelToCode, loadWorkbook, parseNumber, type ExcelInput } from "./common";

export interface MasterMonthly {
  yearMonth: YearMonth;
  qty: number;
  workingDays: number;
}

export interface MasterRow {
  lineCode: string;
  productCode: string;
  productName: string;
  cavity: number | null;
  packUnit: number | null;
  weightG: number | null;
  /** 비어 있으면 0 (호기별 Capa 없음 → 제품 기본 Capa 사용) */
  dailyCapa: number;
  safetyStock: number | null;
  monthly: MasterMonthly[];
}

export interface MasterImportResult {
  rows: MasterRow[];
  warnings: string[];
  sheetName: string | null;
  months: YearMonth[];
}

const MONTH_RE = /(20\d{2})\s*[-./년]\s*(\d{1,2})\s*월?\s*(물량|수량|생산량|가동일수|가동일|일수)/;

export async function parseMasterWorkbook(buf: ExcelInput, opts: { sheetName?: string } = {}): Promise<MasterImportResult> {
  const warnings: string[] = [];
  const rows: MasterRow[] = [];
  const wb = await loadWorkbook(buf);
  const ws =
    (opts.sheetName ? wb.getWorksheet(opts.sheetName) : undefined) ??
    wb.getWorksheet("운용안") ??
    wb.worksheets.find((s) => findHeaderRow(s, ["호기", "제품명"]) !== null) ??
    wb.worksheets[0];
  if (!ws) return { rows, warnings: ["워크시트가 없습니다."], sheetName: null, months: [] };

  const headerRow = findHeaderRow(ws, ["호기", "제품명"]);
  if (headerRow === null) {
    return { rows, warnings: [`시트 '${ws.name}': '호기'·'제품명' 헤더를 찾지 못했습니다.`], sheetName: ws.name, months: [] };
  }
  const headers = headerMap(ws, headerRow);
  const col = {
    line: findColumn(headers, ["호기", "라인", "설비"]),
    code: findColumn(headers, ["제품코드", "코드", "품번"]),
    name: findColumn(headers, ["제품명", "금형명", "품명"]),
    cavity: findColumn(headers, ["캐비티", "cavity", "cv"]),
    pack: findColumn(headers, ["포장단위", "포장", "입수"]),
    weight: findColumn(headers, ["중량(g)", "중량", "프리폼중량", "무게"]),
    capa: findColumn(headers, ["일일Capa", "일일 Capa", "일Capa", "Capa", "capa", "일생산량"]),
    safety: findColumn(headers, ["안전재고", "안전"]),
  };
  if (col.line === null || col.name === null) {
    return { rows, warnings: [`시트 '${ws.name}': 필수 열(호기, 제품명)이 없습니다.`], sheetName: ws.name, months: [] };
  }
  for (const [k, v] of Object.entries(col)) {
    if (v === null && k !== "line" && k !== "name") warnings.push(`열 '${k}' 를 찾지 못해 해당 값은 비웁니다.`);
  }

  // 월별 열
  const monthCols = new Map<YearMonth, { qty?: number; days?: number }>();
  for (const [c, text] of headers) {
    const m = text.normalize("NFC").match(MONTH_RE);
    if (!m) continue;
    const ym = `${m[1]}-${m[2].padStart(2, "0")}`;
    const kind = compactName(m[3]);
    const entry = monthCols.get(ym) ?? {};
    if (kind.includes("일")) entry.days = c;
    else entry.qty = c;
    monthCols.set(ym, entry);
  }
  const months = [...monthCols.keys()].sort();

  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const lineLabel = cellText(row.getCell(col.line));
    const productName = cellText(row.getCell(col.name)).replace(/\s+/g, " ");
    if (!lineLabel && !productName) continue;
    if (!lineLabel || !productName) {
      warnings.push(`행 ${r}: 호기 또는 제품명이 비어 있어 건너뜀`);
      continue;
    }
    const monthly: MasterMonthly[] = [];
    for (const ym of months) {
      const mc = monthCols.get(ym)!;
      const qty = mc.qty !== undefined ? parseNumber(cellText(row.getCell(mc.qty))) : null;
      if (qty === null) continue;
      const days = mc.days !== undefined ? parseNumber(cellText(row.getCell(mc.days))) : null;
      monthly.push({ yearMonth: ym, qty: Math.round(qty), workingDays: days !== null ? Math.round(days) : 30 });
    }
    rows.push({
      lineCode: lineLabelToCode(lineLabel),
      productCode: col.code !== null ? cellText(row.getCell(col.code)) : "",
      productName,
      cavity: col.cavity !== null ? parseNumber(cellText(row.getCell(col.cavity))) : null,
      packUnit: col.pack !== null ? parseNumber(cellText(row.getCell(col.pack))) : null,
      weightG: col.weight !== null ? parseNumber(cellText(row.getCell(col.weight))) : null,
      dailyCapa: (col.capa !== null ? parseNumber(cellText(row.getCell(col.capa))) : null) ?? 0,
      safetyStock: col.safety !== null ? parseNumber(cellText(row.getCell(col.safety))) : null,
      monthly,
    });
  }
  return { rows, warnings, sheetName: ws.name, months };
}
