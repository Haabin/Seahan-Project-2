/**
 * 가상 「생산배대」 엑셀 생성기.
 * 실제 파일과 같은 구조(호기 3행 블록, 제품명 칸 앞 공백, 네모 = 교체, 가로 화살표 = 진행 기간)로 만든다.
 * ExcelJS 는 도형을 쓰지 못하므로 셀만 ExcelJS 로 만들고, 도형은 JSZip 으로 drawing XML 을 직접 넣는다.
 * 실제 고객 자료는 들어 있지 않다(NFR-01).
 */
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { addDays, isoToExcelDate, KOREAN_WEEKDAYS, weekdayOf } from "../../lib/excel/common";
import type { ISODate } from "../../lib/engine/types";

/** 문자 폭 1 = 9px (실제 파일의 기본 글꼴 기준) */
export const FAKE_EMU_PER_CHAR = 9 * 9525;
export const FAKE_DATE_COL_CHARS = 15.5;
export const FAKE_RECT_BIG_EMU = 260_636;
export const FAKE_RECT_SMALL_EMU = 169_978;
const ROW_EMU = 238_125; // 18.75pt

export interface FakeBaedaeMachine {
  /** A열 호기 라벨: '01', 7(숫자), 'B 1', 'E 1', 'P1' … */
  label: string | number;
  maker?: string;
  model?: string;
  /** B열 3칸 */
  allowed?: string[];
  /** 'first' = [코드/제조사/모델], 'middle' = [(빈칸)/코드/모델] */
  layout?: "first" | "middle";
}

export interface FakeBaedaeText {
  machine: number;
  /** 블록 안 행(0~2). 제품명 행은 1 */
  rowOffset?: number;
  day: number;
  text: string | number;
}

export type FakeBaedaeShape =
  | {
      kind: "rect";
      machine: number;
      day: number;
      size: "big" | "small";
      /** 칸 안에서의 가로 위치(0~1), 기본 0.05 */
      frac?: number;
      fill?: string;
      text?: string;
      noBorder?: boolean;
      widthEmu?: number;
      rowOffset?: number;
    }
  | {
      kind: "arrow";
      machine: number;
      fromDay: number;
      /** 시작 칸 안 위치(0~1) */
      fromFrac: number;
      toDay: number;
      toFrac: number;
      color?: string;
      rowOffset?: number;
    }
  | { kind: "vline"; machine: number; day: number }
  | { kind: "minus"; machine: number; day: number };

export interface FakeBaedaeSheetSpec {
  name: string;
  title: string;
  startDate: ISODate;
  days?: number;
  machines: FakeBaedaeMachine[];
  texts: FakeBaedaeText[];
  shapes: FakeBaedaeShape[];
  /** 시트 안 Rev 표기(무시돼야 한다) */
  revLabel?: string;
}

const FIRST_DATE_COL = 3; // C
const FIRST_BLOCK_ROW = 4;

function colWidthEmu(chars: number): number {
  return Math.round(chars * FAKE_EMU_PER_CHAR);
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function colorXml(color: string): string {
  return /^[0-9A-Fa-f]{6}$/.test(color) ? `<a:srgbClr val="${color.toUpperCase()}"/>` : `<a:schemeClr val="${color}"/>`;
}

function drawingXml(spec: FakeBaedaeSheetSpec): string {
  const dateW = colWidthEmu(FAKE_DATE_COL_CHARS);
  const blockRow0 = (machine: number) => FIRST_BLOCK_ROW - 1 + machine * 3; // 0부터
  const col0 = (day: number) => FIRST_DATE_COL - 1 + day;
  let id = 2;
  const parts: string[] = [];

  for (const s of spec.shapes) {
    if (s.kind === "rect") {
      const width = s.widthEmu ?? (s.text ? Math.round(dateW * 1.1) : s.size === "big" ? FAKE_RECT_BIG_EMU : FAKE_RECT_SMALL_EMU);
      const off = Math.round(dateW * (s.frac ?? 0.05));
      const row = blockRow0(s.machine) + (s.rowOffset ?? 1);
      const fill = s.fill ?? "accent2";
      const ln = s.noBorder
        ? `<a:ln><a:noFill/></a:ln>`
        : `<a:ln w="12700"><a:solidFill><a:srgbClr val="C00000"/></a:solidFill></a:ln>`;
      const body = s.text
        ? `<xdr:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ko-KR" sz="900"/><a:t>${xmlEscape(s.text)}</a:t></a:r></a:p></xdr:txBody>`
        : `<xdr:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="ko-KR"/></a:p></xdr:txBody>`;
      parts.push(
        `<xdr:oneCellAnchor><xdr:from><xdr:col>${col0(s.day)}</xdr:col><xdr:colOff>${off}</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>20000</xdr:rowOff></xdr:from>` +
          `<xdr:ext cx="${width}" cy="200000"/>` +
          `<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="${id}" name="Rectangle ${id}"/><xdr:cNvSpPr/></xdr:nvSpPr>` +
          `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="200000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
          `<a:solidFill>${colorXml(fill)}</a:solidFill>${ln}</xdr:spPr>${body}</xdr:sp><xdr:clientData/></xdr:oneCellAnchor>`,
      );
      id++;
    } else if (s.kind === "arrow") {
      const row = blockRow0(s.machine) + (s.rowOffset ?? 2);
      const fromOff = Math.round(dateW * s.fromFrac);
      const toOff = Math.round(dateW * s.toFrac);
      const cx = (s.toDay - s.fromDay) * dateW + toOff - fromOff;
      parts.push(
        `<xdr:twoCellAnchor><xdr:from><xdr:col>${col0(s.fromDay)}</xdr:col><xdr:colOff>${fromOff}</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>110000</xdr:rowOff></xdr:from>` +
          `<xdr:to><xdr:col>${col0(s.toDay)}</xdr:col><xdr:colOff>${toOff}</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>110000</xdr:rowOff></xdr:to>` +
          `<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="${id}" name="Line ${id}"/><xdr:cNvSpPr/></xdr:nvSpPr>` +
          `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="0"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:noFill/>` +
          `<a:ln w="28575"><a:solidFill>${colorXml(s.color ?? "002060")}</a:solidFill><a:headEnd type="none"/><a:tailEnd type="stealth" w="med" len="lg"/></a:ln></xdr:spPr>` +
          `<xdr:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="ko-KR"/></a:p></xdr:txBody></xdr:sp><xdr:clientData/></xdr:twoCellAnchor>`,
      );
      id++;
    } else if (s.kind === "vline") {
      const row = blockRow0(s.machine);
      const off = Math.round(dateW * 0.5);
      parts.push(
        `<xdr:twoCellAnchor><xdr:from><xdr:col>${col0(s.day)}</xdr:col><xdr:colOff>${off}</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>10000</xdr:rowOff></xdr:from>` +
          `<xdr:to><xdr:col>${col0(s.day)}</xdr:col><xdr:colOff>${off}</xdr:colOff><xdr:row>${row + 1}</xdr:row><xdr:rowOff>200000</xdr:rowOff></xdr:to>` +
          `<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="${id}" name="Line ${id}"/><xdr:cNvSpPr/></xdr:nvSpPr>` +
          `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="${ROW_EMU + 190000}"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:noFill/>` +
          `<a:ln w="28575"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:headEnd type="none"/><a:tailEnd type="none"/></a:ln></xdr:spPr>` +
          `<xdr:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="ko-KR"/></a:p></xdr:txBody></xdr:sp><xdr:clientData/></xdr:twoCellAnchor>`,
      );
      id++;
    } else {
      const row = blockRow0(s.machine) + 1;
      parts.push(
        `<xdr:oneCellAnchor><xdr:from><xdr:col>${col0(s.day)}</xdr:col><xdr:colOff>${Math.round(dateW * 0.3)}</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>30000</xdr:rowOff></xdr:from>` +
          `<xdr:ext cx="381358" cy="161017"/>` +
          `<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="${id}" name="Minus ${id}"/><xdr:cNvSpPr/></xdr:nvSpPr>` +
          `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="381358" cy="161017"/></a:xfrm><a:prstGeom prst="mathMinus"><a:avLst/></a:prstGeom>` +
          `<a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></xdr:spPr>` +
          `<xdr:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="ko-KR"/></a:p></xdr:txBody></xdr:sp><xdr:clientData/></xdr:oneCellAnchor>`,
      );
      id++;
    }
  }

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    parts.join("") +
    `</xdr:wsDr>`
  );
}

function fillSheet(ws: ExcelJS.Worksheet, spec: FakeBaedaeSheetSpec) {
  const days = spec.days ?? 15;
  ws.getColumn(1).width = 9;
  ws.getColumn(2).width = 23;
  for (let d = 0; d < days; d++) ws.getColumn(FIRST_DATE_COL + d).width = FAKE_DATE_COL_CHARS;
  ws.getColumn(FIRST_DATE_COL + days).width = 2;

  ws.getCell(1, 1).value = spec.title;
  ws.getCell(1, FIRST_DATE_COL).value = "가상 1주간";
  ws.getCell(1, FIRST_DATE_COL + 8).value = spec.revLabel ?? "[ Rev' 0 ]";
  ws.getCell(2, 1).value = "설비";
  ws.getCell(2, 2).value = "제품명";
  for (let d = 0; d < days; d++) {
    const iso = addDays(spec.startDate, d);
    ws.getCell(2, FIRST_DATE_COL + d).value = `${KOREAN_WEEKDAYS[weekdayOf(iso)]}요일`;
    const c = ws.getCell(3, FIRST_DATE_COL + d);
    c.value = isoToExcelDate(iso);
    c.numFmt = "m/d";
  }
  ws.views = [{ state: "frozen", xSplit: 2, ySplit: 3 }];

  spec.machines.forEach((m, i) => {
    const r0 = FIRST_BLOCK_ROW + i * 3;
    const layout = m.layout ?? "first";
    if (layout === "first") {
      ws.getCell(r0, 1).value = m.label;
      ws.getCell(r0 + 1, 1).value = m.maker ?? "AOKI";
      ws.getCell(r0 + 2, 1).value = m.model ?? "500LL-75";
    } else {
      ws.getCell(r0 + 1, 1).value = m.label;
      ws.getCell(r0 + 2, 1).value = m.model ?? "(WJ-380)";
    }
    (m.allowed ?? []).slice(0, 3).forEach((t, k) => {
      ws.getCell(r0 + k, 2).value = t;
    });
  });

  for (const t of spec.texts) {
    const r = FIRST_BLOCK_ROW + t.machine * 3 + (t.rowOffset ?? 1);
    ws.getCell(r, FIRST_DATE_COL + t.day).value = t.text;
  }

  // 표 아래 메모와 교체 손실 범례(실제 파일 59행 이후를 흉내)
  const memoRow = FIRST_BLOCK_ROW + spec.machines.length * 3 + 2;
  ws.getCell(memoRow, 1).value = "※ 가상 데이터입니다. 실제 계획이 아닙니다.";
  const legend: [string, string][] = [
    ["B/M교체", "2HR (0.915)"],
    ["FULLSET교체", "6HR (0.75)"],
  ];
  legend.forEach(([k, v], i) => {
    ws.getCell(memoRow + 6 + i, 5).value = k;
    ws.getCell(memoRow + 6 + i, 6).value = v;
  });
}

/** 가상 생산배대 xlsx 버퍼 */
export async function buildFakeBaedaeBuffer(sheets: FakeBaedaeSheetSpec[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const spec of sheets) fillSheet(wb.addWorksheet(spec.name), spec);
  const base = Buffer.from(await wb.xlsx.writeBuffer());

  const zip = await JSZip.loadAsync(base);
  let contentTypes = await zip.file("[Content_Types].xml")!.async("string");
  for (let i = 0; i < sheets.length; i++) {
    const n = i + 1;
    const sheetPath = `xl/worksheets/sheet${n}.xml`;
    const sheetFile = zip.file(sheetPath);
    if (!sheetFile) throw new Error(`${sheetPath} 가 없습니다`);
    let sheetXml = await sheetFile.async("string");
    if (!sheets[i].shapes.length) continue;

    zip.file(`xl/drawings/drawing${n}.xml`, drawingXml(sheets[i]));
    const relsPath = `xl/worksheets/_rels/sheet${n}.xml.rels`;
    const rel = `<Relationship Id="rIdDrw${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${n}.xml"/>`;
    const existing = zip.file(relsPath);
    if (existing) {
      zip.file(relsPath, (await existing.async("string")).replace("</Relationships>", `${rel}</Relationships>`));
    } else {
      zip.file(
        relsPath,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel}</Relationships>`,
      );
    }
    if (!/xmlns:r=/.test(sheetXml)) {
      sheetXml = sheetXml.replace("<worksheet ", `<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" `);
    }
    sheetXml = sheetXml.replace("</worksheet>", `<drawing r:id="rIdDrw${n}"/></worksheet>`);
    zip.file(sheetPath, sheetXml);
    contentTypes = contentTypes.replace(
      "</Types>",
      `<Override PartName="/xl/drawings/drawing${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`,
    );
  }
  zip.file("[Content_Types].xml", contentTypes);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

// ---------------------------------------------------------------------------
// 계획(호기 × 날짜 → 제품)을 생산배대 모양으로 바꾸기
// ---------------------------------------------------------------------------
export interface FakeBaedaePlanCell {
  /** 0부터 세는 호기 순번 */
  machine: number;
  day: number;
  productName: string;
  changeover: "NONE" | "BM" | "FULL";
  qty?: number | null;
}

/**
 * 같은 제품이 이어진 구간을 [제품명 칸 + 화살표]로, 교체를 네모로 바꾼다.
 * 제품명 앞에는 네모 자리만큼 공백을 넣는다(실제 파일과 같은 습관).
 */
export function planToBaedaeShapes(cells: FakeBaedaePlanCell[], days = 15): { texts: FakeBaedaeText[]; shapes: FakeBaedaeShape[] } {
  const texts: FakeBaedaeText[] = [];
  const shapes: FakeBaedaeShape[] = [];
  const byMachine = new Map<number, FakeBaedaePlanCell[]>();
  for (const c of cells) {
    const arr = byMachine.get(c.machine);
    if (arr) arr.push(c);
    else byMachine.set(c.machine, [c]);
  }
  for (const [machine, list] of byMachine) {
    const byDay = new Map(list.map((c) => [c.day, c] as const));
    let d = 0;
    while (d < days) {
      const c = byDay.get(d);
      if (!c) {
        d++;
        continue;
      }
      let end = d;
      while (end + 1 < days) {
        const n = byDay.get(end + 1);
        if (!n || n.productName !== c.productName || n.changeover !== "NONE") break;
        end++;
      }
      const hasRect = c.changeover !== "NONE";
      const qtyText = c.qty != null ? ` ${c.qty.toLocaleString("en-US")}본` : "";
      texts.push({ machine, day: d, rowOffset: 1, text: `${hasRect ? "       " : ""}${c.productName}${qtyText}` });
      if (hasRect) shapes.push({ kind: "rect", machine, day: d, size: c.changeover === "FULL" ? "big" : "small" });
      if (end > d) shapes.push({ kind: "arrow", machine, fromDay: d + 1, fromFrac: 0.02, toDay: end, toFrac: 0.97 });
      d = end + 1;
    }
  }
  return { texts, shapes };
}
