/**
 * lib/excel/export-plan.ts · FR-12 주간 생산계획 엑셀 내보내기 (현행 계획표 양식)
 *
 * 레이아웃 (시트 '1팀 PET1')
 *   1행  제목 (기간·Rev)
 *   2행  숨김. C2.. 에 실제 Date 값 — 가져오기(FR-03)가 헤더 텍스트 대신 이 값을 우선 읽는다
 *   3행  헤더: A '호기' | B '생산가능금형' | C.. '11/12(목)' (주말 열은 연회색)
 *   4행~ 호기별 1행: A 호기명 | B 허용 금형(', ' 연결) | 날짜 셀 '제품명 (B/M)\n96,000'
 *        가동 불가일은 회색 배경, 제품이 없으면 사유 텍스트
 */
import ExcelJS from "exceljs";
import type { ChangeoverType, Downtime, ISODate, PlanCell } from "../engine/types";
import {
  DEFAULT_FONT,
  DOWNTIME_FILL,
  HEADER_FILL,
  WEEKEND_FILL,
  addDays,
  formatKoreanDateHeader,
  formatThousands,
  isWeekend,
  isoToExcelDate,
  workbookToBuffer,
} from "./common";

export const PLAN_SHEET_NAME = "1팀 PET1";
export const PLAN_HEADER_ROW = 3;
export const PLAN_DATE_ROW = 2;
export const PLAN_FIRST_DATE_COL = 3; // C

export const CHANGEOVER_MARKER: Record<ChangeoverType, string> = {
  NONE: "",
  BM: " (B/M)",
  FULL: " (Full)",
};

export interface PlanExportLine {
  id: string;
  code: string;
  name: string;
  sortOrder?: number;
}

export interface PlanExportInput {
  periodStart: ISODate;
  /** 비우면 periodStart 부터 15일 */
  dates?: ISODate[];
  lines: PlanExportLine[];
  products: { id: string; name: string }[];
  /** B열 '생산가능금형'. 없으면 B열은 빈칸 */
  allowedMolds?: { lineId: string; productId: string }[];
  cells: PlanCell[];
  downtimes?: Downtime[];
  revisionLabel?: string;
  sheetName?: string;
  title?: string;
}

/** 셀 텍스트 규칙: '제품명' + 교체 마커 + (수량이 있으면) 줄바꿈 + 천 단위 수량 */
export function formatPlanCellText(productName: string, qty: number | null, changeoverType: ChangeoverType): string {
  const head = `${productName}${CHANGEOVER_MARKER[changeoverType] ?? ""}`;
  return qty !== null && qty !== undefined ? `${head}\n${formatThousands(qty)}` : head;
}

function thinBorder(): Partial<ExcelJS.Borders> {
  const s: Partial<ExcelJS.Border> = { style: "thin", color: { argb: "FFBFBFBF" } };
  return { top: s, left: s, bottom: s, right: s };
}

export async function buildPlanWorkbook(input: PlanExportInput): Promise<Buffer> {
  const wb = buildPlanWorkbookObject(input);
  return workbookToBuffer(wb);
}

/** 테스트·가상 데이터 생성 등에서 워크북 객체를 직접 다룰 때 */
export function buildPlanWorkbookObject(input: PlanExportInput): ExcelJS.Workbook {
  const dates = input.dates && input.dates.length > 0 ? input.dates : Array.from({ length: 15 }, (_, i) => addDays(input.periodStart, i));
  const periodEnd = dates[dates.length - 1];
  const sheetName = input.sheetName ?? PLAN_SHEET_NAME;
  const revisionLabel = input.revisionLabel ?? "";

  const productName = new Map(input.products.map((p) => [p.id, p.name]));
  const lines = [...input.lines].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const cellMap = new Map<string, PlanCell>();
  for (const c of input.cells) cellMap.set(`${c.lineId}|${c.date}`, c);
  const moldsByLine = new Map<string, string[]>();
  for (const m of input.allowedMolds ?? []) {
    const name = productName.get(m.productId);
    if (!name) continue;
    const arr = moldsByLine.get(m.lineId) ?? [];
    arr.push(name);
    moldsByLine.set(m.lineId, arr);
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = "주간 생산계획 수립 지원 툴";
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName, {
    views: [{ state: "frozen", xSplit: 2, ySplit: PLAN_HEADER_ROW }],
  });

  const lastCol = PLAN_FIRST_DATE_COL + dates.length - 1;

  // 1행 제목
  const title = input.title ?? `주간 생산계획 ${input.periodStart} ~ ${periodEnd}${revisionLabel ? ` · ${revisionLabel}` : ""}`;
  ws.mergeCells(1, 1, 1, lastCol);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = title;
  titleCell.font = { ...DEFAULT_FONT, size: 14, bold: true };
  titleCell.alignment = { vertical: "middle", horizontal: "left" };
  ws.getRow(1).height = 24;

  // 2행 실제 날짜 (숨김)
  const dateRow = ws.getRow(PLAN_DATE_ROW);
  dateRow.getCell(1).value = "(날짜)";
  dates.forEach((d, i) => {
    const c = dateRow.getCell(PLAN_FIRST_DATE_COL + i);
    c.value = isoToExcelDate(d);
    c.numFmt = "yyyy-mm-dd";
    c.font = { ...DEFAULT_FONT, color: { argb: "FF808080" } };
  });
  dateRow.hidden = true;

  // 3행 헤더
  const header = ws.getRow(PLAN_HEADER_ROW);
  header.getCell(1).value = "호기";
  header.getCell(2).value = "생산가능금형";
  dates.forEach((d, i) => {
    header.getCell(PLAN_FIRST_DATE_COL + i).value = formatKoreanDateHeader(d);
  });
  for (let col = 1; col <= lastCol; col++) {
    const c = header.getCell(col);
    c.font = { ...DEFAULT_FONT, bold: true };
    c.alignment = { vertical: "middle", horizontal: "center" };
    c.border = thinBorder();
    const iso = col >= PLAN_FIRST_DATE_COL ? dates[col - PLAN_FIRST_DATE_COL] : null;
    c.fill = iso && isWeekend(iso) ? WEEKEND_FILL : HEADER_FILL;
  }
  header.height = 20;

  // 열 너비
  ws.getColumn(1).width = 12;
  ws.getColumn(2).width = 40;
  for (let col = PLAN_FIRST_DATE_COL; col <= lastCol; col++) ws.getColumn(col).width = 15;

  // 호기 행
  lines.forEach((line, idx) => {
    const r = PLAN_HEADER_ROW + 1 + idx;
    const row = ws.getRow(r);
    row.height = 32;
    const a = row.getCell(1);
    a.value = line.name;
    a.font = { ...DEFAULT_FONT, bold: true };
    a.alignment = { vertical: "middle", horizontal: "center" };
    a.border = thinBorder();
    const b = row.getCell(2);
    b.value = (moldsByLine.get(line.id) ?? []).join(", ");
    b.font = DEFAULT_FONT;
    b.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
    b.border = thinBorder();

    dates.forEach((d, i) => {
      const c = row.getCell(PLAN_FIRST_DATE_COL + i);
      const cell = cellMap.get(`${line.id}|${d}`);
      const dt = (input.downtimes ?? []).find((x) => x.lineId === line.id && x.startDate <= d && x.endDate >= d);
      let text = "";
      if (cell && cell.productId) {
        const name = productName.get(cell.productId) ?? `(알 수 없는 제품 ${cell.productId})`;
        text = formatPlanCellText(name, cell.qty, cell.changeoverType);
      } else if (dt) {
        text = dt.reason || "가동 불가";
      }
      c.value = text || null;
      c.font = DEFAULT_FONT;
      c.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      c.border = thinBorder();
      if (dt) c.fill = DOWNTIME_FILL;
      else if (isWeekend(d)) c.fill = WEEKEND_FILL;
    });
  });

  return wb;
}
