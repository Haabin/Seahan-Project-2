/**
 * lib/excel/import-baedae.ts · 현장 「생산배대」 엑셀(과거 계획표) 가져오기
 *
 * 기존 import-plan.ts 가 가정한 형식("제품명\n수량" 셀, (B/M) 마커)과 다르다.
 * 이 파일은 셀 글자 + **도형**(네모 = 금형 교체, 가로 화살표 = 진행 기간)으로 계획을 표현한다.
 * ExcelJS 는 도형을 읽지 못하므로 xlsx 안의 XML(xl/drawings/drawingN.xml)을 JSZip 으로 직접 읽는다.
 *
 * 해석 규칙 (사용자 확정, 모든 시트 공통 · UI 도움말에 그대로 적을 것)
 *  - 날짜: 실제 날짜가 10칸 이상 이어진 행을 날짜 행으로 본다. 한 시트에 표가 여러 개면 날짜 행마다 표 하나.
 *  - 호기: A열 값이 호기 코드인 행에서 블록이 시작한다. '01'~'18' → PET1~18, 'B 1' → B1, 'E 1' → PE1, P1~P5, S1~S7, A1.
 *      · A열이 [코드 / 제조사 / 모델] 이면 코드 행이 블록 첫 행이고 제품명은 둘째 행.
 *      · A열이 [(빈칸) / 코드 / 모델] 이면 코드 행이 블록 가운데 행이고 제품명은 코드 행.
 *      · 블록 사이에 남는 행은 앞 블록에 붙인다. 도형은 블록 안 어느 행에 있든 그 블록의 호기로 본다.
 *  - 네모 = 금형 교체. 가로 폭으로 큰 네모(Full set) / 작은 네모(B/M)를 가른다.
 *      · 기준은 읽은 시트 전체의 네모 폭을 가장 큰 간격에서 둘로 나눠 정한다(시트별로 나누지 않는다).
 *      · 채우기 색은 무시(원래 색은 결과에 남긴다). 글자 'HR' 네모는 무시. 다른 글자가 든 네모는 메모 박스.
 *      · 테두리 없는 네모는 교체로 세지 않고 경고.
 *  - 가로 화살표 = 그 제품의 진행 기간. 날짜 칸 너비의 minCover(기본 50%) 이상을 덮으면 생산일.
 *      · 덮은 비율이 ambiguous(기본 30~70%) 범위면 포함하되 경고.
 *      · 제품은 같은 블록에서 화살표 시작 칸 또는 그 왼쪽 가장 가까운 제품명 칸. 제품명 칸 자체도 생산일.
 *      · 화살표도 제품명도 없는 칸은 대기(셀을 만들지 않는다). 다음 제품까지 이어 붙이지 않는다.
 *      · 세로선·mathMinus 도형은 무시하고 경고.
 *  - Rev 번호는 파일 이름에서 읽는다('(Rev. 1)' → 1). 시트 안 "[ Rev' 0 ]" 은 무시. → parseRevFromFilename 한 곳에만 둔다.
 *  - 사출 설비(P·A) 블록의 날짜 칸 숫자는 설비별 일일 원료(씨벌크) 소비량(톤)이다 (OPEN_QUESTIONS Q1 확정).
 */
import JSZip from "jszip";
import type ExcelJS from "exceljs";
import type { ChangeoverKind, ISODate } from "../engine/types";
import { cellDate, cellText, isDowntimeText, loadWorkbook, parseNumber, rawValue, toNodeBuffer, type ExcelInput } from "./common";

// ---------------------------------------------------------------------------
// 타입
// ---------------------------------------------------------------------------
export interface BaedaeOptions {
  /** 원본 파일 이름. Rev 번호를 여기서 읽는다 */
  filename?: string;
  /** 화살표가 날짜 칸을 이 비율 이상 덮으면 생산일 (settings.baedae_arrow_min_cover) */
  arrowMinCover?: number;
  /** 이 범위면 포함하되 경고 (settings.baedae_arrow_ambiguous) */
  arrowAmbiguous?: [number, number];
  /** 읽지 않을 시트 이름(부분 일치). 기본 ['음성'] */
  skipSheets?: string[];
  /** 네모가 한 종류뿐일 때 쓰는 절대 기준(EMU). 이 값 이상이면 큰 네모 */
  fallbackFullMinWidthEmu?: number;
}

export type BaedaeWarningLevel = "warn" | "info";
export interface BaedaeWarning {
  level: BaedaeWarningLevel;
  sheet: string;
  lineCode: string | null;
  date: ISODate | null;
  message: string;
}

export type BaedaeProcess = "PET1" | "PET2_BLOW" | "PET2_INJ" | "PE";

export interface BaedaeMachine {
  /** 정규화한 호기 코드: PET1…PET18, A1, B1, B2, PE1…PE4, P1…P5, S1…S7 */
  code: string;
  rawLabel: string;
  process: BaedaeProcess;
  /** A열의 나머지 글자(제조사, 모델) */
  maker: string;
  model: string;
  /** B열 생산 가능 금형 원문(행별) */
  allowedMoldText: string[];
  /** B열을 '. ' ',' '/' 로 나눈 후보 이름 */
  allowedMoldNames: string[];
  /** A·B열 메모(댓글). 근거 정보로 보관만 한다 */
  notes: string[];
  /** 블록 행 범위(1부터, 양끝 포함)와 제품명 행 */
  startRow: number;
  endRow: number;
  productRow: number;
}

export interface BaedaeCell {
  lineCode: string;
  date: ISODate;
  /** 제품명(앞뒤 공백·뒤 부가 텍스트 제거) */
  productName: string;
  /** 제품명 칸 원문. 화살표로만 이어진 칸은 시작 칸의 원문 */
  rawText: string;
  /** '본' 단위 수량. 없으면 null → 엔진이 Capa 로 계산 */
  qty: number | null;
  changeoverType: "NONE" | ChangeoverKind;
  /** 네모 원래 색 (예: 'accent2', 'FF0000') */
  changeoverColor: string | null;
  memo: string | null;
  /** 'name' = 제품명 칸, 'arrow' = 화살표가 덮은 칸 */
  source: "name" | "arrow";
  /** 화살표가 이 칸을 덮은 비율 (source='arrow') */
  cover: number | null;
  cellRef: string;
}

export interface BaedaeChangeover {
  lineCode: string;
  date: ISODate;
  type: ChangeoverKind;
  widthEmu: number;
  color: string | null;
  /** 그날 생산 셀이 있어 교체가 반영됐는지 */
  applied: boolean;
}

export interface BaedaeArrow {
  lineCode: string;
  /** 화살표가 걸친 날짜와 덮은 비율 */
  spans: { date: ISODate; cover: number; counted: boolean }[];
  productName: string | null;
  color: string | null;
}

export interface BaedaeResinUsage {
  lineCode: string;
  date: ISODate;
  ton: number;
}

export interface BaedaeSheetStats {
  rectFull: number;
  rectBm: number;
  textBoxes: number;
  hrBoxes: number;
  borderless: number;
  arrows: number;
  ignoredLines: number;
  ignoredOther: number;
}

export interface BaedaeSheet {
  sheetName: string;
  /** 표 제목들 (예: '생산 1팀 - PET 1') */
  titles: string[];
  dates: ISODate[];
  machines: BaedaeMachine[];
  cells: BaedaeCell[];
  changeovers: BaedaeChangeover[];
  arrows: BaedaeArrow[];
  resinUsage: BaedaeResinUsage[];
  /** '원료소비량' 행의 날짜별 합계(검산용) */
  resinTotals: { date: ISODate; ton: number }[];
  stats: BaedaeSheetStats;
  warnings: BaedaeWarning[];
}

export interface BaedaeParseResult {
  /** 파일 이름에서 읽은 Rev 번호. 없으면 null → 업로드 화면에서 입력받는다 */
  revNo: number | null;
  periodStart: ISODate | null;
  periodEnd: ISODate | null;
  sheets: BaedaeSheet[];
  skippedSheets: string[];
  /** 큰/작은 네모를 가른 기준 폭(EMU). 이 값 이상이면 Full */
  rectThresholdEmu: number | null;
  /** 기준을 어떻게 정했는지: 'gap' = 가장 큰 간격, 'fallback' = 한 종류뿐이라 절대 기준 */
  rectThresholdBasis: "gap" | "fallback" | "none";
  rectWidths: { widthEmu: number; count: number }[];
  warnings: BaedaeWarning[];
}

const DEFAULTS = {
  arrowMinCover: 0.5,
  arrowAmbiguous: [0.3, 0.7] as [number, number],
  skipSheets: ["음성"],
  // 실측: 큰 네모 약 260,000 / 작은 네모 약 170,000~183,000 EMU
  fallbackFullMinWidthEmu: 220_000,
};

// ---------------------------------------------------------------------------
// 작은 도구
// ---------------------------------------------------------------------------
/** Rev 번호 출처. 규칙이 바뀌면 여기만 고친다 (현재: 파일 이름의 'Rev. 1' / 'Rev1' / 'rev_2') */
export function parseRevFromFilename(filename: string | null | undefined): number | null {
  if (!filename) return null;
  const m = filename.normalize("NFC").match(/rev\s*[.'’_\-]?\s*(\d{1,3})/i);
  return m ? Number(m[1]) : null;
}

/** A열 라벨 → 호기 코드. 호기가 아니면 null */
export function baedaeMachineCode(label: string): { code: string; process: BaedaeProcess } | null {
  const t = label.normalize("NFC").trim().toUpperCase();
  if (/^\d{1,2}$/.test(t)) {
    const n = Number(t);
    if (n >= 1 && n <= 30) return { code: `PET${n}`, process: "PET1" };
    return null;
  }
  const m = t.match(/^([ABEPS])\s*(\d{1,2})$/);
  if (!m) return null;
  const n = Number(m[2]);
  switch (m[1]) {
    case "A":
      return { code: `A${n}`, process: "PET2_INJ" };
    case "P":
      return { code: `P${n}`, process: "PET2_INJ" };
    case "B":
      return { code: `B${n}`, process: "PET2_BLOW" };
    case "S":
      return { code: `S${n}`, process: "PET2_BLOW" };
    default:
      return { code: `PE${n}`, process: "PE" };
  }
}

/** B열 '생산 가능 금형' 글자를 후보 이름으로 나눈다. 숫자 사이 점('8. 10. 12')과 소수점('1.8L')을 구분한다 */
export function splitAllowedMolds(text: string): string[] {
  const t = text.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!t) return [];
  return t
    .split(/\s*[,/]\s*|\.\s+|\s{2,}/)
    .map((s) => s.replace(/^[.\s]+|[.\s]+$/g, "").trim())
    .filter((s) => s.length > 0);
}

export interface ParsedBaedaeText {
  kind: "empty" | "product" | "note";
  productName: string;
  qty: number | null;
  extra: string | null;
}

/**
 * 제품명 칸 글자 → 제품명 · 수량(본) · 부가 텍스트.
 *  '      1.8L HD - N  노랑 264 + 골드 60 + 적색 480 →' → 제품 '1.8L HD - N', 부가 '노랑 264 + 골드 60 + 적색 480'
 *  '진로 3.6L 전주공장용 라벨 50,400본'                  → 제품 '진로 3.6L 전주공장용 라벨', 수량 50400
 *  '8L 사각  210박스 소진'                               → 제품 '8L 사각', 부가 '210박스 소진' (박스는 수량으로 쓰지 않는다)
 */
export function parseBaedaeCellText(raw: string): ParsedBaedaeText {
  let t = raw.normalize("NFC").replace(/[\r\n]+/g, "  ");
  t = t.replace(/[→⇒▶➔]+\s*$/u, "").replace(/\s+$/u, "").replace(/^\s+/u, "");
  if (!t || /^[.\-_·,]+$/.test(t)) return { kind: "empty", productName: "", qty: null, extra: null };
  if (isDowntimeText(t)) return { kind: "note", productName: "", qty: null, extra: t };

  // 수량·기간·조건만 적힌 칸("250박스", "2일", "20% 4,992본", "노랑 192 + 골드 48 + 적색 408")은 제품이 아니라 메모
  if (/^\d[\d,.]*\s*(박스|일|%|본|만|HR|시간)/i.test(t) || /^[가-힣A-Za-z]{1,4}\s*\d[\d,]*\s*\+/.test(t)) {
    return { kind: "note", productName: "", qty: null, extra: t.replace(/\s+/g, " ") };
  }

  const extras: string[] = [];
  let qty: number | null = null;

  // '50,400본' → 수량
  const bon = t.match(/(\d[\d,]*)\s*본(?![가-힣])/);
  if (bon) {
    qty = parseNumber(bon[1]);
    t = (t.slice(0, bon.index) + " " + t.slice((bon.index ?? 0) + bon[0].length)).replace(/\s+$/u, "");
  }
  // '210박스 소진' → 끝까지 부가 텍스트
  const box = t.match(/\s(\d[\d,]*)\s*박스.*$/);
  if (box) {
    extras.push(box[0].trim());
    t = t.slice(0, box.index);
  }
  // 두 칸 이상 띄운 뒤의 글자는 부가 텍스트
  const parts = t.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    extras.unshift(...parts.slice(1));
    t = parts[0];
  }
  const name = t.replace(/\s+/g, " ").trim();
  if (!name) return { kind: "note", productName: "", qty, extra: extras.join(" · ") || null };
  return { kind: "product", productName: name, qty, extra: extras.length ? extras.join(" · ") : null };
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

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

// ---------------------------------------------------------------------------
// 도형 읽기 (xl/drawings/drawingN.xml)
// ---------------------------------------------------------------------------
export interface RawShape {
  geom: string;
  fromCol: number;
  fromColOff: number;
  fromRow: number;
  fromRowOff: number;
  toCol: number;
  toColOff: number;
  toRow: number;
  toRowOff: number;
  /** xfrm ext (없으면 0) */
  cx: number;
  cy: number;
  text: string;
  hasBorder: boolean;
  fillColor: string | null;
  lineColor: string | null;
  hasArrowHead: boolean;
  /** oneCellAnchor: 끝 위치가 없고 시작 위치 + 크기(cx, cy)만 있다 */
  oneCell: boolean;
}

function parseAnchorPos(block: string, tag: "from" | "to"): [number, number, number, number] | null {
  const m = block.match(new RegExp(`<xdr:${tag}>([\\s\\S]*?)</xdr:${tag}>`));
  if (!m) return null;
  const num = (k: string) => {
    const r = m[1].match(new RegExp(`<xdr:${k}>\\s*(-?\\d+)\\s*</xdr:${k}>`));
    return r ? Number(r[1]) : 0;
  };
  return [num("col"), num("colOff"), num("row"), num("rowOff")];
}

function firstColor(xml: string): string | null {
  const m = xml.match(/<a:(srgbClr|schemeClr|sysClr|prstClr)\s+val="([^"]+)"/);
  return m ? m[2] : null;
}

/** drawing XML → 도형 목록. 그룹·그림은 건너뛴다 */
export function parseDrawingXml(xml: string): RawShape[] {
  const shapes: RawShape[] = [];
  const re = /<xdr:(twoCellAnchor|oneCellAnchor)\b[^>]*>([\s\S]*?)<\/xdr:\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const a = m[2];
    const oneCell = m[1] === "oneCellAnchor";
    if (!/<xdr:(sp|cxnSp)\b/.test(a)) continue;
    const from = parseAnchorPos(a, "from");
    const to = oneCell ? from : parseAnchorPos(a, "to");
    if (!from || !to) continue;
    const geom = a.match(/<a:prstGeom\s+prst="([^"]+)"/)?.[1] ?? "custom";
    const ext = a.match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/) ?? a.match(/<xdr:ext\s+cx="(\d+)"\s+cy="(\d+)"/);
    const spPr = a.match(/<xdr:spPr\b[\s\S]*?<\/xdr:spPr>/)?.[0] ?? "";
    const ln = spPr.match(/<a:ln\b[^>]*\/>|<a:ln\b[\s\S]*?<\/a:ln>/)?.[0] ?? "";
    const spPrNoLn = ln ? spPr.replace(ln, "") : spPr;
    const style = a.match(/<xdr:style>[\s\S]*?<\/xdr:style>/)?.[0] ?? "";

    let hasBorder: boolean;
    if (ln) hasBorder = !/<a:noFill\s*\/>/.test(ln);
    else hasBorder = /<a:lnRef\s+idx="[1-9]/.test(style);

    let fillColor: string | null = null;
    if (/<a:noFill\s*\/>/.test(spPrNoLn)) fillColor = null;
    else {
      const solid = spPrNoLn.match(/<a:solidFill>[\s\S]*?<\/a:solidFill>/)?.[0];
      if (solid) fillColor = firstColor(solid);
      else fillColor = firstColor(style.match(/<a:fillRef[\s\S]*?<\/a:fillRef>/)?.[0] ?? "");
    }
    const lineColor = ln ? firstColor(ln) : firstColor(style.match(/<a:lnRef[\s\S]*?<\/a:lnRef>/)?.[0] ?? "");
    const hasArrowHead = /<a:(headEnd|tailEnd)\s+[^>]*type="(?!none)[a-zA-Z]+"/.test(ln);
    const text = xmlUnescape(
      (a.match(/<a:t>([^<]*)<\/a:t>/g) ?? []).map((s) => s.replace(/<[^>]+>/g, "")).join(""),
    ).trim();

    shapes.push({
      geom,
      fromCol: from[0],
      fromColOff: from[1],
      fromRow: from[2],
      fromRowOff: from[3],
      toCol: to[0],
      toColOff: to[1],
      toRow: to[2],
      toRowOff: to[3],
      cx: ext ? Number(ext[1]) : 0,
      cy: ext ? Number(ext[2]) : 0,
      text,
      hasBorder,
      fillColor,
      lineColor,
      hasArrowHead,
      oneCell,
    });
  }
  return shapes;
}

interface SheetPackage {
  name: string;
  /** 열 너비(문자 단위), index 0 = A열 */
  colWidthChars: (col0: number) => number;
  shapes: RawShape[];
}

/** xlsx 패키지에서 시트별 열 너비와 도형을 읽는다 */
async function readSheetPackages(buf: Buffer): Promise<Map<string, SheetPackage>> {
  const zip = await JSZip.loadAsync(buf);
  const read = async (path: string) => {
    const f = zip.file(path);
    return f ? f.async("string") : null;
  };
  const out = new Map<string, SheetPackage>();
  const wbXml = await read("xl/workbook.xml");
  const wbRels = await read("xl/_rels/workbook.xml.rels");
  if (!wbXml || !wbRels) return out;

  const relTarget = new Map<string, string>();
  for (const m of wbRels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/\bId="([^"]+)"/)?.[1];
    const target = m[0].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) relTarget.set(id, target);
  }
  const resolve = (baseDir: string, target: string) => {
    if (target.startsWith("/")) return target.slice(1);
    const parts = (baseDir + "/" + target).split("/");
    const stack: string[] = [];
    for (const p of parts) {
      if (p === "..") stack.pop();
      else if (p && p !== ".") stack.push(p);
    }
    return stack.join("/");
  };

  for (const m of wbXml.matchAll(/<sheet\b[^>]*>/g)) {
    const name = xmlUnescape(m[0].match(/\bname="([^"]*)"/)?.[1] ?? "");
    const rid = m[0].match(/\br:id="([^"]+)"/)?.[1];
    const target = rid ? relTarget.get(rid) : undefined;
    if (!target) continue;
    const sheetPath = resolve("xl", target);
    const sheetXml = await read(sheetPath);
    if (!sheetXml) continue;

    const defW = Number(sheetXml.match(/<sheetFormatPr\b[^>]*\bdefaultColWidth="([\d.]+)"/)?.[1] ?? 8.43);
    const ranges: { min: number; max: number; width: number }[] = [];
    for (const c of sheetXml.matchAll(/<col\b[^>]*>/g)) {
      const min = Number(c[0].match(/\bmin="(\d+)"/)?.[1]);
      const max = Number(c[0].match(/\bmax="(\d+)"/)?.[1]);
      const width = Number(c[0].match(/\bwidth="([\d.]+)"/)?.[1]);
      const hidden = /\bhidden="1"/.test(c[0]);
      if (Number.isFinite(min) && Number.isFinite(max) && Number.isFinite(width)) ranges.push({ min, max, width: hidden ? 0 : width });
    }
    const colWidthChars = (col0: number) => {
      const c1 = col0 + 1;
      for (const r of ranges) if (c1 >= r.min && c1 <= r.max) return r.width;
      return defW;
    };

    let shapes: RawShape[] = [];
    const dir = sheetPath.slice(0, sheetPath.lastIndexOf("/"));
    const file = sheetPath.slice(sheetPath.lastIndexOf("/") + 1);
    const rels = await read(`${dir}/_rels/${file}.rels`);
    if (rels) {
      for (const r of rels.matchAll(/<Relationship\b[^>]*>/g)) {
        if (!/relationships\/drawing"/.test(r[0])) continue;
        const t = r[0].match(/\bTarget="([^"]+)"/)?.[1];
        if (!t) continue;
        const dxml = await read(resolve(dir, t));
        if (dxml) shapes = shapes.concat(parseDrawingXml(dxml));
      }
    }
    out.set(name, { name, colWidthChars, shapes });
  }
  return out;
}

/**
 * 열 너비(문자 단위) → EMU 환산 계수.
 * 글꼴에 따라 달라지므로, 여러 칸에 걸친 도형의 실제 폭(cx)과 앵커 위치로 역산한다.
 * 역산할 도형이 없으면 일반적인 값(문자당 7px)으로 둔다.
 */
function calibrateEmuPerChar(pkg: SheetPackage): number {
  const samples: number[] = [];
  for (const s of pkg.shapes) {
    if (s.oneCell || s.cx <= 0 || s.toCol <= s.fromCol) continue;
    let chars = 0;
    for (let c = s.fromCol; c < s.toCol; c++) chars += pkg.colWidthChars(c);
    if (chars <= 0) continue;
    const k = (s.cx - s.toColOff + s.fromColOff) / chars;
    if (k > 20_000 && k < 200_000) samples.push(k);
  }
  if (!samples.length) return 7 * 9525 * 1.05;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

// ---------------------------------------------------------------------------
// 시트 해석
// ---------------------------------------------------------------------------
interface DateTable {
  dateRow: number;
  /** 1부터 세는 열 번호 → 날짜 */
  dateByCol: Map<number, ISODate>;
  firstCol: number;
  lastCol: number;
  title: string;
  /** 이 표에 속하는 마지막 행 */
  endRow: number;
}

function findDateTables(ws: ExcelJS.Worksheet): DateTable[] {
  const tables: DateTable[] = [];
  const maxRow = Math.min(ws.rowCount, 400);
  for (let r = 1; r <= maxRow; r++) {
    const row = ws.getRow(r);
    const dateByCol = new Map<number, ISODate>();
    let run: [number, ISODate][] = [];
    let best: [number, ISODate][] = [];
    for (let c = 2; c <= 40; c++) {
      const v = rawValue(row.getCell(c));
      let iso: ISODate | null = null;
      if (v instanceof Date) iso = cellDate(v);
      else if (typeof v === "number" && v > 40000 && v < 60000 && Number.isInteger(v)) iso = cellDate(v);
      const prev = run.length ? run[run.length - 1][1] : null;
      if (iso && (!prev || iso > prev)) run.push([c, iso]);
      else {
        if (run.length > best.length) best = run;
        run = iso ? [[c, iso]] : [];
      }
    }
    if (run.length > best.length) best = run;
    if (best.length < 10) continue;
    for (const [c, d] of best) dateByCol.set(c, d);
    // 제목: 날짜 행 위 3행 안에서 A열 글자
    let title = "";
    for (let t = r - 1; t >= Math.max(1, r - 3); t--) {
      const s = cellText(ws.getRow(t).getCell(1)).trim();
      if (s && !/^(LINE|설비)$/i.test(s)) {
        title = s;
        break;
      }
    }
    tables.push({ dateRow: r, dateByCol, firstCol: best[0][0], lastCol: best[best.length - 1][0], title, endRow: maxRow });
  }
  // 표의 끝: 다음 표 제목 행 바로 앞
  for (let i = 0; i < tables.length - 1; i++) {
    tables[i].endRow = Math.max(tables[i].dateRow, tables[i + 1].dateRow - 3);
  }
  return tables;
}

function noteText(cell: ExcelJS.Cell): string {
  const n = cell.note as unknown;
  if (!n) return "";
  if (typeof n === "string") return n.trim();
  const texts = (n as { texts?: { text?: string }[] }).texts;
  if (Array.isArray(texts)) return texts.map((t) => t.text ?? "").join("").trim();
  return "";
}

function findMachines(ws: ExcelJS.Worksheet, table: DateTable, hasNextTable: boolean, warnings: BaedaeWarning[]): BaedaeMachine[] {
  const aText = (r: number) => cellText(ws.getRow(r).getCell(1)).trim();
  const bText = (r: number) => cellText(ws.getRow(r).getCell(2)).trim();
  const isTotalRow = (r: number) => /원료\s*소비량/.test(bText(r)) || /원료\s*소비량/.test(aText(r));

  // 코드 행 찾기. 코드 행이 20행 넘게 안 나오면 표가 끝난 것으로 본다
  const codeRows: { row: number; code: string; process: BaedaeProcess; raw: string }[] = [];
  let lastHit = table.dateRow;
  for (let r = table.dateRow + 1; r <= table.endRow; r++) {
    if (r - lastHit > 20) break;
    if (isTotalRow(r)) continue;
    const raw = aText(r);
    const mc = raw ? baedaeMachineCode(raw) : null;
    if (mc) {
      codeRows.push({ row: r, ...mc, raw });
      lastHit = r;
    }
  }

  const machines: BaedaeMachine[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < codeRows.length; i++) {
    const cr = codeRows[i];
    const nextCodeRow = codeRows[i + 1]?.row ?? null;
    const prevEnd = machines.length ? machines[machines.length - 1].endRow : table.dateRow;
    const a1 = nextCodeRow === cr.row + 1 || isTotalRow(cr.row + 1) ? "" : aText(cr.row + 1);
    const a2 = nextCodeRow !== null && nextCodeRow <= cr.row + 2 ? "" : isTotalRow(cr.row + 2) ? "" : aText(cr.row + 2);
    // [코드/제조사/모델] 이면 코드가 첫 행, 아니면 가운데 행
    const codeFirst = a1 !== "" && a2 !== "" && !baedaeMachineCode(a2);
    let startRow: number;
    let stdEnd: number;
    let productRow: number;
    if (codeFirst) {
      startRow = cr.row;
      stdEnd = cr.row + 2;
      productRow = cr.row + 1;
    } else {
      startRow = Math.max(prevEnd + 1, cr.row - 1);
      stdEnd = a1 !== "" ? cr.row + 1 : cr.row;
      productRow = cr.row;
    }
    // 같은 코드가 다시 나오면 본표가 끝나고 다른 표(프리폼 재고표 등)가 시작된 것으로 본다
    if (seen.has(cr.code)) {
      warnings.push({ level: "info", sheet: ws.name, lineCode: null, date: null, message: `${cr.row}행부터는 호기 코드가 다시 나와 다른 표로 보고 읽지 않았습니다` });
      break;
    }
    seen.add(cr.code);
    machines.push({
      code: cr.code,
      rawLabel: cr.raw,
      process: cr.process,
      maker: codeFirst ? a1 : "",
      model: codeFirst ? a2 : a1,
      allowedMoldText: [],
      allowedMoldNames: [],
      notes: [],
      startRow,
      endRow: stdEnd,
      productRow,
    });
  }

  // 블록 사이에 남는 행은 앞 블록에 붙인다. 마지막 블록은 뒤에 다른 표가 있을 때만 그 표 앞까지 늘린다.
  for (let i = 0; i < machines.length; i++) {
    const m = machines[i];
    const next = machines[i + 1];
    if (next) {
      // 합계 행('원료소비량')은 어느 블록에도 넣지 않는다
      let end = next.startRow - 1;
      while (end > m.endRow && isTotalRow(end)) end--;
      m.endRow = Math.max(m.endRow, end);
    } else if (hasNextTable) {
      m.endRow = Math.max(m.endRow, table.endRow);
    }
    for (let r = m.startRow; r <= m.endRow; r++) {
      if (isTotalRow(r)) continue;
      const b = bText(r);
      if (b) m.allowedMoldText.push(b);
      for (const col of [1, 2]) {
        const n = noteText(ws.getRow(r).getCell(col));
        if (n) m.notes.push(n);
      }
    }
    m.allowedMoldNames = Array.from(new Set(m.allowedMoldText.flatMap(splitAllowedMolds)));
  }
  return machines;
}

interface Geometry {
  /** 열(0부터)의 왼쪽 x(EMU) */
  colLeft: (col0: number) => number;
  colWidth: (col0: number) => number;
  /** x(EMU) → 열(0부터) */
  colAt: (x: number) => number;
}

function buildGeometry(pkg: SheetPackage, maxCol0: number): Geometry {
  const k = calibrateEmuPerChar(pkg);
  const widths: number[] = [];
  const lefts: number[] = [0];
  for (let c = 0; c <= maxCol0 + 2; c++) {
    widths.push(Math.max(0, Math.round(pkg.colWidthChars(c) * k)));
    lefts.push(lefts[c] + widths[c]);
  }
  return {
    colLeft: (c) => lefts[Math.min(Math.max(c, 0), lefts.length - 1)],
    colWidth: (c) => widths[Math.min(Math.max(c, 0), widths.length - 1)] ?? 0,
    colAt: (x) => {
      for (let c = 0; c < widths.length; c++) if (x < lefts[c + 1]) return c;
      return widths.length - 1;
    },
  };
}

function shapeX(g: Geometry, col0: number, off: number): number {
  const w = g.colWidth(col0);
  return g.colLeft(col0) + Math.min(Math.max(off, 0), w > 0 ? w : off);
}

function parseSheet(
  ws: ExcelJS.Worksheet,
  pkg: SheetPackage | undefined,
  opts: Required<Pick<BaedaeOptions, "arrowMinCover" | "arrowAmbiguous">>,
): { sheet: BaedaeSheet; rects: { shape: RawShape; machine: BaedaeMachine; date: ISODate; width: number }[] } | null {
  const warnings: BaedaeWarning[] = [];
  const warn = (level: BaedaeWarningLevel, lineCode: string | null, date: ISODate | null, message: string) =>
    warnings.push({ level, sheet: ws.name, lineCode, date, message });

  const tables = findDateTables(ws);
  if (!tables.length) return null;

  const stats: BaedaeSheetStats = { rectFull: 0, rectBm: 0, textBoxes: 0, hrBoxes: 0, borderless: 0, arrows: 0, ignoredLines: 0, ignoredOther: 0 };
  const sheet: BaedaeSheet = {
    sheetName: ws.name,
    titles: tables.map((t) => t.title).filter(Boolean),
    dates: Array.from(tables[0].dateByCol.values()),
    machines: [],
    cells: [],
    changeovers: [],
    arrows: [],
    resinUsage: [],
    resinTotals: [],
    stats,
    warnings,
  };

  const maxCol0 = Math.max(...tables.map((t) => t.lastCol)) + 2;
  const geom = pkg ? buildGeometry(pkg, maxCol0) : null;
  const shapes = pkg?.shapes ?? [];
  const usedShape = new Set<RawShape>();
  // 글자 든 네모는 날짜 칸 밖(S열 메모 영역 등)에 있어도 개수에 넣는다
  for (const s of shapes) {
    if (!/rect/i.test(s.geom) || !s.text) continue;
    if (isHrText(s.text)) stats.hrBoxes++;
    else stats.textBoxes++;
  }
  const rects: { shape: RawShape; machine: BaedaeMachine; date: ISODate; width: number }[] = [];
  const cellMap = new Map<string, BaedaeCell>();
  const key = (code: string, date: ISODate) => `${code}|${date}`;

  tables.forEach((table, ti) => {
    const machines = findMachines(ws, table, ti < tables.length - 1, warnings);
    sheet.machines.push(...machines);
    const cols = Array.from(table.dateByCol.keys());
    const machineAtRow = (row1: number) => machines.find((m) => row1 >= m.startRow && row1 <= m.endRow) ?? null;

    // ---- 원료소비량 합계 행 ----
    for (let r = table.dateRow + 1; r <= Math.min(table.endRow, ws.rowCount); r++) {
      const b = cellText(ws.getRow(r).getCell(2));
      if (!/원료\s*소비량/.test(b)) continue;
      for (const c of cols) {
        const v = rawValue(ws.getRow(r).getCell(c));
        if (typeof v === "number") sheet.resinTotals.push({ date: table.dateByCol.get(c) as ISODate, ton: v });
      }
    }

    // ---- 셀 글자 ----
    interface NameCell { col: number; date: ISODate; parsed: ParsedBaedaeText; raw: string }
    const nameCellsByMachine = new Map<string, NameCell[]>();
    const memoByKey = new Map<string, string[]>();
    const addMemo = (code: string, date: ISODate, text: string) => {
      const k = key(code, date);
      const arr = memoByKey.get(k);
      if (arr) arr.push(text);
      else memoByKey.set(k, [text]);
    };

    for (const m of machines) {
      const names: NameCell[] = [];
      nameCellsByMachine.set(m.code, names);
      for (let r = m.startRow; r <= m.endRow; r++) {
        const row = ws.getRow(r);
        for (const c of cols) {
          const date = table.dateByCol.get(c) as ISODate;
          const v = rawValue(row.getCell(c));
          if (v === null || v === undefined || v === "") continue;
          if (typeof v === "number") {
            if (m.process === "PET2_INJ") sheet.resinUsage.push({ lineCode: m.code, date, ton: v });
            else warn("info", m.code, date, `${colLetter(c)}${r} 숫자 ${v}: 사출 설비가 아니라 원료 소비량으로 읽지 않았습니다`);
            continue;
          }
          const raw = cellText(row.getCell(c));
          if (!raw.trim()) continue;
          if (r === m.productRow) {
            const parsed = parseBaedaeCellText(raw);
            if (parsed.kind === "product") names.push({ col: c, date, parsed, raw });
            else if (parsed.kind === "note" && parsed.extra) {
              addMemo(m.code, date, parsed.extra);
              warn("info", m.code, date, `${colLetter(c)}${r} "${parsed.extra}": 제품이 아닌 글자로 보고 메모로 넣었습니다`);
            }
          } else {
            addMemo(m.code, date, raw.replace(/\s+/g, " ").trim());
          }
        }
      }
      names.sort((a, b) => a.col - b.col);

      // 제품명 칸 → 셀
      for (const n of names) {
        cellMap.set(key(m.code, n.date), {
          lineCode: m.code,
          date: n.date,
          productName: n.parsed.productName,
          rawText: n.raw,
          qty: n.parsed.qty,
          changeoverType: "NONE",
          changeoverColor: null,
          memo: n.parsed.extra,
          source: "name",
          cover: null,
          cellRef: `${colLetter(n.col)}${m.productRow}`,
        });
      }
    }

    // ---- 도형 ----
    if (geom) {
      const first0 = table.firstCol - 1;
      const last0 = table.lastCol - 1;
      const inDateArea = (col0: number) => col0 >= first0 && col0 <= last0;

      for (const s of shapes) {
        if (usedShape.has(s)) continue;
        const m = machineAtRow(s.fromRow + 1) ?? machineAtRow(s.toRow + 1);
        if (!m) continue;
        const x1 = shapeX(geom, s.fromCol, s.fromColOff);
        const x2 = s.oneCell ? x1 + s.cx : shapeX(geom, s.toCol, s.toColOff);
        const left = Math.min(x1, x2);
        const right = Math.max(x1, x2);
        const centerCol = geom.colAt((left + right) / 2);
        if (!inDateArea(centerCol) && !(inDateArea(geom.colAt(left)) || inDateArea(geom.colAt(right)))) continue;
        usedShape.add(s);

        const isRect = /rect/i.test(s.geom);
        const isLine = s.geom === "line" || /connector/i.test(s.geom);

        if (isRect) {
          const date = table.dateByCol.get(centerCol + 1) ?? null;
          if (s.text) {
            if (isHrText(s.text)) continue;
            // 메모 박스: 덮고 있는 칸의 메모
            const c0 = Math.max(first0, geom.colAt(left));
            const c1 = Math.min(last0, geom.colAt(right - 1));
            let attached = false;
            for (let c = c0; c <= c1; c++) {
              const d = table.dateByCol.get(c + 1);
              if (!d) continue;
              const cover = (Math.min(right, geom.colLeft(c) + geom.colWidth(c)) - Math.max(left, geom.colLeft(c))) / (geom.colWidth(c) || 1);
              if (cover >= 0.25 || c0 === c1) {
                addMemo(m.code, d, `[박스] ${s.text}`);
                attached = true;
              }
            }
            if (!attached && date) addMemo(m.code, date, `[박스] ${s.text}`);
            continue;
          }
          if (!s.hasBorder) {
            stats.borderless++;
            warn("warn", m.code, date, `테두리 없는 네모가 있습니다. 교체로 세지 않았습니다`);
            continue;
          }
          if (!date) continue;
          rects.push({ shape: s, machine: m, date, width: s.cx > 0 ? s.cx : right - left });
          continue;
        }

        if (isLine) {
          const dy = Math.abs(s.toRow - s.fromRow) * 240_000 + Math.abs(s.toRowOff - s.fromRowOff);
          const dx = right - left;
          const horizontal = s.toRow === s.fromRow ? dx > Math.abs(s.toRowOff - s.fromRowOff) * 2 : dx > dy * 2;
          if (!horizontal) {
            stats.ignoredLines++;
            warn("info", m.code, table.dateByCol.get(centerCol + 1) ?? null, `세로선 도형은 무시했습니다`);
            continue;
          }
          stats.arrows++;
          const spans: BaedaeArrow["spans"] = [];
          const [lo, hi] = opts.arrowAmbiguous;
          for (let c = Math.max(first0, geom.colAt(left)); c <= Math.min(last0, geom.colAt(Math.max(left, right - 1))); c++) {
            const d = table.dateByCol.get(c + 1);
            const w = geom.colWidth(c);
            if (!d || w <= 0) continue;
            const cover = Math.max(0, Math.min(right, geom.colLeft(c) + w) - Math.max(left, geom.colLeft(c))) / w;
            const ambiguous = cover >= lo && cover <= hi;
            const counted = cover >= opts.arrowMinCover || ambiguous;
            spans.push({ date: d, cover: Math.round(cover * 100) / 100, counted });
          }
          // 제품: 화살표 시작 칸 또는 그 왼쪽 가장 가까운 제품명 칸
          const startCol1 = geom.colAt(left) + 1;
          const names = nameCellsByMachine.get(m.code) ?? [];
          let owner: NameCell | null = null;
          for (const n of names) if (n.col <= startCol1) owner = n;
          sheet.arrows.push({ lineCode: m.code, spans, productName: owner?.parsed.productName ?? null, color: s.lineColor });
          if (!owner) {
            warn("warn", m.code, spans[0]?.date ?? null, `화살표가 제품명 없이 시작합니다. 이 화살표는 읽지 않았습니다`);
            continue;
          }
          for (const sp of spans) {
            if (!sp.counted) continue;
            const k = key(m.code, sp.date);
            const existing = cellMap.get(k);
            if (existing && existing.source === "name") {
              if (existing.productName !== owner.parsed.productName && existing.date !== owner.date) {
                // 화살표 구간 안에 다른 제품명: 그 칸은 새 제품으로 둔다
                warn(
                  sp.cover >= 0.95 ? "warn" : "info",
                  m.code,
                  sp.date,
                  `한 칸에 두 제품이 겹칩니다: "${owner.parsed.productName}" 화살표(${Math.round(sp.cover * 100)}%)와 "${existing.productName}". 이 날은 "${existing.productName}"로 읽었습니다`,
                );
              }
              continue;
            }
            if (existing && existing.source === "arrow") {
              if (existing.productName !== owner.parsed.productName) {
                warn("warn", m.code, sp.date, `한 칸에 화살표 두 개가 겹칩니다: "${existing.productName}" / "${owner.parsed.productName}". 덮은 비율이 큰 쪽으로 읽었습니다`);
                if ((existing.cover ?? 0) >= sp.cover) continue;
              } else {
                existing.cover = Math.max(existing.cover ?? 0, sp.cover);
                continue;
              }
            }
            const [alo, ahi] = opts.arrowAmbiguous;
            if (sp.cover >= alo && sp.cover <= ahi) {
              warn("warn", m.code, sp.date, `화살표가 이 칸의 ${Math.round(sp.cover * 100)}%만 덮습니다. 생산일에 포함했으니 확인하세요 ("${owner.parsed.productName}")`);
            }
            cellMap.set(k, {
              lineCode: m.code,
              date: sp.date,
              productName: owner.parsed.productName,
              rawText: owner.raw,
              qty: null,
              changeoverType: "NONE",
              changeoverColor: null,
              memo: null,
              source: "arrow",
              cover: sp.cover,
              cellRef: `${colLetter(geom.colAt(geom.colLeft(0)) + 1)}${m.productRow}`,
            });
          }
          continue;
        }

        stats.ignoredOther++;
        warn("info", m.code, table.dateByCol.get(centerCol + 1) ?? null, `${s.geom} 도형은 무시했습니다`);
      }
    }

    // ---- 메모 붙이기 (생산 셀이 있는 날만. 대기 칸의 메모는 정보로 남긴다) ----
    for (const [k, texts] of memoByKey) {
      const c = cellMap.get(k);
      const text = Array.from(new Set(texts)).join(" / ");
      if (c) c.memo = c.memo ? `${c.memo} / ${text}` : text;
      else {
        const [code, date] = k.split("|");
        warn("info", code, date, `생산이 없는 칸의 메모: ${text}`);
      }
    }
  });

  // arrow 셀의 cellRef 를 실제 칸으로 바로잡는다
  const colOfDate = new Map<string, number>();
  for (const t of tables) for (const [c, d] of t.dateByCol) if (!colOfDate.has(d)) colOfDate.set(d, c);
  const machineByCode = new Map(sheet.machines.map((m) => [m.code, m] as const));
  for (const c of cellMap.values()) {
    const col = colOfDate.get(c.date);
    const m = machineByCode.get(c.lineCode);
    if (col && m) c.cellRef = `${colLetter(col)}${m.productRow}`;
  }

  sheet.cells = Array.from(cellMap.values()).sort((a, b) => {
    const ia = sheet.machines.findIndex((m) => m.code === a.lineCode);
    const ib = sheet.machines.findIndex((m) => m.code === b.lineCode);
    return ia - ib || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  });
  if (!pkg) warn("warn", null, null, "이 시트의 도형 정보를 찾지 못했습니다. 제품명 칸만 읽었습니다");
  return { sheet, rects };
}

function isHrText(text: string): boolean {
  return /^H\s*\/?\s*R$/i.test(text.trim());
}

/** 네모 폭을 가장 큰 간격에서 둘로 나눈다 */
export function splitRectWidths(
  widths: number[],
  fallbackFullMinWidthEmu: number = DEFAULTS.fallbackFullMinWidthEmu,
): { threshold: number | null; basis: BaedaeParseResult["rectThresholdBasis"] } {
  const uniq = Array.from(new Set(widths)).sort((a, b) => a - b);
  if (!uniq.length) return { threshold: null, basis: "none" };
  let bestGap = 0;
  let bestAt = -1;
  for (let i = 0; i < uniq.length - 1; i++) {
    const gap = uniq[i + 1] - uniq[i];
    if (gap > bestGap) {
      bestGap = gap;
      bestAt = i;
    }
  }
  // 간격이 작은 쪽 폭의 20% 미만이면 한 종류로 본다
  if (bestAt < 0 || bestGap < uniq[bestAt] * 0.2) return { threshold: fallbackFullMinWidthEmu, basis: "fallback" };
  return { threshold: Math.round((uniq[bestAt] + uniq[bestAt + 1]) / 2), basis: "gap" };
}

/** 생산배대 형식인지 빠르게 판별: 날짜가 10칸 이상 이어진 행이 있고 도형이 있는 시트가 있으면 true */
export async function isBaedaeWorkbook(input: ExcelInput): Promise<boolean> {
  try {
    const zip = await JSZip.loadAsync(toNodeBuffer(input));
    const drawings = Object.keys(zip.files).filter((p) => /^xl\/drawings\/drawing\d+\.xml$/.test(p));
    for (const p of drawings) {
      const xml = await zip.file(p)!.async("string");
      if (/prst="line"/.test(xml) && /prst="rect"/.test(xml)) return true;
      if ((xml.match(/<xdr:twoCellAnchor\b/g) ?? []).length >= 5 && /<a:(headEnd|tailEnd)\b/.test(xml)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function parseBaedaeWorkbook(input: ExcelInput, options: BaedaeOptions = {}): Promise<BaedaeParseResult> {
  const opts = {
    arrowMinCover: options.arrowMinCover ?? DEFAULTS.arrowMinCover,
    arrowAmbiguous: options.arrowAmbiguous ?? DEFAULTS.arrowAmbiguous,
    skipSheets: options.skipSheets ?? DEFAULTS.skipSheets,
    fallbackFullMinWidthEmu: options.fallbackFullMinWidthEmu ?? DEFAULTS.fallbackFullMinWidthEmu,
  };
  const buf = toNodeBuffer(input);
  const [wb, packages] = await Promise.all([loadWorkbook(buf), readSheetPackages(buf)]);

  const result: BaedaeParseResult = {
    revNo: parseRevFromFilename(options.filename),
    periodStart: null,
    periodEnd: null,
    sheets: [],
    skippedSheets: [],
    rectThresholdEmu: null,
    rectThresholdBasis: "none",
    rectWidths: [],
    warnings: [],
  };

  const allRects: { sheet: BaedaeSheet; shape: RawShape; machine: BaedaeMachine; date: ISODate; width: number }[] = [];
  for (const ws of wb.worksheets) {
    if (opts.skipSheets.some((s) => ws.name.includes(s))) {
      result.skippedSheets.push(ws.name);
      continue;
    }
    const parsed = parseSheet(ws, packages.get(ws.name), opts);
    if (!parsed) {
      result.skippedSheets.push(ws.name);
      continue;
    }
    result.sheets.push(parsed.sheet);
    for (const r of parsed.rects) allRects.push({ sheet: parsed.sheet, ...r });
  }

  // 네모 크기: 읽은 시트 전체 기준
  const widthCount = new Map<number, number>();
  for (const r of allRects) widthCount.set(r.width, (widthCount.get(r.width) ?? 0) + 1);
  result.rectWidths = Array.from(widthCount, ([widthEmu, count]) => ({ widthEmu, count })).sort((a, b) => a.widthEmu - b.widthEmu);
  const split = splitRectWidths(allRects.map((r) => r.width), opts.fallbackFullMinWidthEmu);
  result.rectThresholdEmu = split.threshold;
  result.rectThresholdBasis = split.basis;
  if (split.basis === "fallback") {
    result.warnings.push({
      level: "warn",
      sheet: "",
      lineCode: null,
      date: null,
      message: `네모 크기가 한 종류뿐이라 절대 기준(${opts.fallbackFullMinWidthEmu.toLocaleString("ko-KR")} EMU)으로 큰/작은 네모를 갈랐습니다`,
    });
  }

  for (const r of allRects) {
    const type: ChangeoverKind = split.threshold !== null && r.width >= split.threshold ? "FULL" : "BM";
    if (type === "FULL") r.sheet.stats.rectFull++;
    else r.sheet.stats.rectBm++;
    const cell = r.sheet.cells.find((c) => c.lineCode === r.machine.code && c.date === r.date);
    const co: BaedaeChangeover = { lineCode: r.machine.code, date: r.date, type, widthEmu: r.width, color: r.shape.fillColor, applied: !!cell };
    r.sheet.changeovers.push(co);
    if (!cell) {
      r.sheet.warnings.push({ level: "warn", sheet: r.sheet.sheetName, lineCode: r.machine.code, date: r.date, message: `교체 네모(${type === "FULL" ? "Full set" : "B/M"})가 있는데 그날 생산 칸이 없습니다` });
      continue;
    }
    if (cell.changeoverType !== "NONE") {
      r.sheet.warnings.push({ level: "info", sheet: r.sheet.sheetName, lineCode: r.machine.code, date: r.date, message: `한 칸에 교체 네모가 두 개입니다. 큰 쪽으로 읽었습니다` });
      if (cell.changeoverType === "FULL") continue;
    }
    cell.changeoverType = type;
    cell.changeoverColor = r.shape.fillColor;
  }

  // 원료 소비량 검산
  for (const s of result.sheets) {
    for (const t of s.resinTotals) {
      const sum = s.resinUsage.filter((u) => u.date === t.date).reduce((a, u) => a + u.ton, 0);
      if (Math.abs(sum - t.ton) > 0.051) {
        s.warnings.push({ level: "info", sheet: s.sheetName, lineCode: null, date: t.date, message: `원료소비량 합계 ${t.ton} 와 설비별 숫자 합 ${Math.round(sum * 100) / 100} 이 다릅니다` });
      }
    }
  }

  const allDates = result.sheets.flatMap((s) => s.dates).sort();
  result.periodStart = result.sheets[0]?.dates[0] ?? null;
  result.periodEnd = allDates.length ? allDates[allDates.length - 1] : null;
  if (result.revNo === null) {
    result.warnings.push({ level: "warn", sheet: "", lineCode: null, date: null, message: "파일 이름에서 Rev 번호를 찾지 못했습니다. 업로드 화면에서 입력하세요" });
  }
  return result;
}
