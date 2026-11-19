/**
 * lib/excel/import-operation-plan.ts · 현행 "제품배치 운용안" 양식(공정 시트) 파서
 *
 * import-master.ts(우리가 정한 1행 헤더 양식)와 별개로, 현업이 쓰는 원본 양식을 그대로 읽는다.
 *   - 헤더 2줄(예: '포장' / '수량'), 그 다음 행부터 데이터
 *   - 한 호기 = 여러 행 묶음. 호기 번호와 생산설비는 묶음 첫 행에만 있어 아래 행에 채워 넣는다
 *   - '소계'·'합계' 행은 건너뛴다
 *   - Capa 는 수식 계산값(캐시된 결과)을 쓰고 내림한다. 단위는 본/일(EA)로 본다
 *     (헤더 표기는 '천본/일'이지만 수식이 '초/일 ÷ 사이클 × 캐비티 × 효율' 구조라 개수 단위다)
 *   - 월별 수량·가동일수, INJ 열은 읽지 않는다
 *
 * 실제 설비 제조사·모델 규칙은 코드에 두지 않는다. 호출자가 EquipmentRules 로 넘긴다.
 * 이 모듈은 DB 에 접근하지 않는다.
 */
import type ExcelJS from "exceljs";
import { cellText, compactName, findColumn, lineLabelToCode, loadWorkbook, parseNumber, rawValue, type ExcelInput } from "./common";
import { cleanProductName, productCodeFor } from "./product-code";

export interface EquipmentRules {
  /** 모델 접두어 → 제조사. 접두어는 모델에서 뗀다. 예: { "X_": "가상기계" } */
  prefixes?: Record<string, string>;
  /** 접두어를 뗀 모델 원문 → 저장할 제조사·모델. 예: { "50Q": { maker: "가상기계2", model: "QQ-50Q" } } */
  aliases?: Record<string, { maker: string; model: string }>;
}

export interface OperationPlanOptions {
  /** 시트 이름. 없으면 '호기'·'생산설비'·'제품명' 헤더가 있는 첫 시트 */
  sheetName?: string;
  /** 숫자만 있는 호기 번호에 붙일 접두어. 기본 'PET' (1 → PET1) */
  lineCodePrefix?: string;
  equipment?: EquipmentRules;
}

export interface OperationPlanRow {
  rowNumber: number;
  lineCode: string;
  equipmentRaw: string | null;
  productNameRaw: string;
  productName: string;
  productCode: string;
  packUnit: number | null;
  cavity: number | null;
  /** 수식 계산값 원본 (내림 전) */
  dailyCapaRaw: number | null;
  /** 내림한 값. 원본이 없으면 null */
  dailyCapa: number | null;
  /** '10종'처럼 여러 품목을 한 행에 묶은 표기 */
  bundle: boolean;
}

export interface OperationPlanProduct {
  code: string;
  name: string;
  packUnit: number | null;
  cavity: number | null;
  /** 호기별 Capa 중 최솟값 (없으면 0) */
  defaultDailyCapa: number;
  lineCodes: string[];
  bundle: boolean;
}

export interface OperationPlanLineSpec {
  lineCode: string;
  equipmentRaw: string | null;
  maker: string | null;
  model: string | null;
  /** 생산설비 원문 등 */
  memo: string | null;
}

export interface OperationPlanResult {
  sheetName: string | null;
  headerRows: number[];
  /** Capa 열 헤더 원문 (단위 표기 확인용) */
  capaHeader: string | null;
  rows: OperationPlanRow[];
  products: OperationPlanProduct[];
  lineSpecs: OperationPlanLineSpec[];
  skipped: { subtotal: number; total: number; blank: number };
  warnings: string[];
}

export const BUNDLE_NOTE = "묶음 표기, 팀장님 확인 필요";
const BUNDLE_RE = /\d+\s*종/;
const REQUIRED_HEADERS = ["호기", "생산설비", "제품명"];

export async function parseOperationPlanWorkbook(buf: ExcelInput, opts: OperationPlanOptions = {}): Promise<OperationPlanResult> {
  const empty = (sheetName: string | null, warning: string): OperationPlanResult => ({
    sheetName,
    headerRows: [],
    capaHeader: null,
    rows: [],
    products: [],
    lineSpecs: [],
    skipped: { subtotal: 0, total: 0, blank: 0 },
    warnings: [warning],
  });

  const wb = await loadWorkbook(buf);
  const ws = opts.sheetName ? wb.getWorksheet(opts.sheetName) : wb.worksheets.find((s) => findHeaderRows(s) !== null);
  if (!ws) return empty(null, opts.sheetName ? `시트 '${opts.sheetName}' 가 없습니다.` : "'호기'·'생산설비'·'제품명' 헤더가 있는 시트가 없습니다.");

  const headerRows = findHeaderRows(ws);
  if (!headerRows) return empty(ws.name, `시트 '${ws.name}': '호기'·'생산설비'·'제품명' 헤더를 찾지 못했습니다.`);
  const headers = combinedHeaders(ws, headerRows);
  const col = {
    line: findColumn(headers, ["호기"]),
    equipment: findColumn(headers, ["생산설비"]),
    name: findColumn(headers, ["제품명"]),
    pack: findColumn(headers, ["포장 수량", "포장수량", "입수"]),
    cavity: findColumn(headers, ["CAV", "캐비티"]),
    capa: findColumn(headers, ["Capa"]),
  };
  const missing = Object.entries(col)
    .filter(([, v]) => v === null)
    .map(([k]) => k);
  if (missing.length > 0) return empty(ws.name, `시트 '${ws.name}': 필수 열을 찾지 못했습니다 (${missing.join(", ")}).`);
  const c = col as Record<keyof typeof col, number>;

  const warnings: string[] = [];
  const rows: OperationPlanRow[] = [];
  const skipped = { subtotal: 0, total: 0, blank: 0 };
  const prefix = opts.lineCodePrefix ?? "PET";
  const firstDataRow = headerRows[headerRows.length - 1] + 1;
  const seenPairs = new Set<string>();

  let lineCode: string | null = null;
  let equipmentRaw: string | null = null;

  for (let r = firstDataRow; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const leading = [1, c.line, c.equipment, c.name].map((i) => compactName(cellText(row.getCell(i))));
    if (leading.some((t) => t.includes("합계"))) {
      skipped.total++;
      continue;
    }
    if (leading.some((t) => t.includes("소계"))) {
      skipped.subtotal++;
      continue;
    }

    const lineText = cellText(row.getCell(c.line));
    const eqText = cellText(row.getCell(c.equipment));
    const nameRaw = rawText(row.getCell(c.name));
    if (!nameRaw.trim()) {
      skipped.blank++;
      if (lineText || eqText) warnings.push(`행 ${r}: 제품명이 비어 있어 건너뜀`);
      continue;
    }

    if (lineText) {
      lineCode = /^\d+$/.test(lineText) ? `${prefix}${Number(lineText)}` : lineLabelToCode(lineText);
      equipmentRaw = null;
      if (!eqText) warnings.push(`행 ${r}: ${lineCode} 묶음 첫 행에 생산설비가 비어 있음`);
    }
    if (eqText) {
      if (equipmentRaw !== null && equipmentRaw !== eqText) warnings.push(`행 ${r}: ${lineCode} 안에서 생산설비가 바뀜 (${equipmentRaw} → ${eqText}), 첫 값을 씀`);
      else equipmentRaw = eqText;
    }
    if (lineCode === null) {
      warnings.push(`행 ${r}: 호기 번호보다 제품 행이 먼저 나와 건너뜀`);
      continue;
    }

    const productName = cleanProductName(nameRaw);
    const productCode = productCodeFor(productName);
    const pairKey = `${lineCode}|${productCode}`;
    if (seenPairs.has(pairKey)) {
      warnings.push(`행 ${r}: ${lineCode} 에 같은 제품이 다시 나와 건너뜀`);
      continue;
    }
    seenPairs.add(pairKey);

    const capaCell = row.getCell(c.capa);
    const capaRaw = numberOf(capaCell);
    if (capaRaw === null) warnings.push(`행 ${r}: Capa 계산값이 없음 (수식 결과가 저장되지 않았거나 빈 칸)`);

    rows.push({
      rowNumber: r,
      lineCode,
      equipmentRaw,
      productNameRaw: nameRaw,
      productName,
      productCode,
      packUnit: intOf(row.getCell(c.pack), r, "포장 수량", warnings),
      cavity: intOf(row.getCell(c.cavity), r, "CAV", warnings),
      dailyCapaRaw: capaRaw,
      dailyCapa: capaRaw === null ? null : Math.floor(capaRaw),
      bundle: BUNDLE_RE.test(productName),
    });
  }

  return {
    sheetName: ws.name,
    headerRows,
    capaHeader: headers.get(c.capa) ?? null,
    rows,
    products: aggregateProducts(rows, warnings),
    lineSpecs: buildLineSpecs(rows, opts.equipment ?? {}, warnings),
    skipped,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 헤더
// ---------------------------------------------------------------------------
/** 필수 헤더가 있는 행. 바로 아래 행도 '호기'를 포함하면 2줄 헤더로 본다 */
export function findHeaderRows(ws: ExcelJS.Worksheet, maxScan = 20): number[] | null {
  const want = REQUIRED_HEADERS.map(compactName);
  const has = (r: number, keys: string[]) => {
    const texts: string[] = [];
    ws.getRow(r).eachCell({ includeEmpty: false }, (cell) => texts.push(compactName(cellText(cell))));
    return keys.every((k) => texts.includes(k));
  };
  for (let r = 1; r <= Math.min(ws.rowCount, maxScan); r++) {
    if (!has(r, want)) continue;
    return has(r + 1, [compactName("호기")]) ? [r, r + 1] : [r];
  }
  return null;
}

/** 2줄 헤더를 '위 아래' 로 합친다. 위아래가 같으면 하나만 */
function combinedHeaders(ws: ExcelJS.Worksheet, headerRows: number[]): Map<number, string> {
  const map = new Map<number, string>();
  const maxCol = ws.columnCount;
  for (let col = 1; col <= maxCol; col++) {
    const parts: string[] = [];
    for (const r of headerRows) {
      const t = cellText(ws.getRow(r).getCell(col));
      if (t && !parts.includes(t)) parts.push(t);
    }
    if (parts.length > 0) map.set(col, parts.join(" "));
  }
  return map;
}

// ---------------------------------------------------------------------------
// 값
// ---------------------------------------------------------------------------
/** 앞뒤 공백까지 보존한 원문 텍스트 (cellText 는 trim 한다) */
function rawText(cell: ExcelJS.Cell): string {
  const v = rawValue(cell);
  if (typeof v === "string") return v;
  return cellText(cell);
}

function numberOf(cell: ExcelJS.Cell): number | null {
  const v = rawValue(cell);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  return parseNumber(cellText(cell));
}

function intOf(cell: ExcelJS.Cell, r: number, label: string, warnings: string[]): number | null {
  const n = numberOf(cell);
  if (n === null) return null;
  if (!Number.isInteger(n)) {
    warnings.push(`행 ${r}: ${label} 값이 정수가 아님 (${n}), 반올림`);
    return Math.round(n);
  }
  return n;
}

// ---------------------------------------------------------------------------
// 집계
// ---------------------------------------------------------------------------
function aggregateProducts(rows: OperationPlanRow[], warnings: string[]): OperationPlanProduct[] {
  const byCode = new Map<string, OperationPlanProduct>();
  for (const row of rows) {
    const p = byCode.get(row.productCode);
    if (!p) {
      byCode.set(row.productCode, {
        code: row.productCode,
        name: row.productName,
        packUnit: row.packUnit,
        cavity: row.cavity,
        defaultDailyCapa: row.dailyCapa ?? 0,
        lineCodes: [row.lineCode],
        bundle: row.bundle,
      });
      continue;
    }
    if (p.packUnit !== row.packUnit || p.cavity !== row.cavity) {
      warnings.push(`행 ${row.rowNumber}: 같은 제품이 호기마다 포장 수량·CAV 가 다름 (${p.lineCodes.join(",")} vs ${row.lineCode}), 첫 값을 씀`);
    }
    p.lineCodes.push(row.lineCode);
  }
  // 기본 Capa = 호기별 Capa 중 최솟값 (값이 하나도 없으면 0)
  for (const p of byCode.values()) {
    const capas = rows.filter((r) => r.productCode === p.code && r.dailyCapa !== null).map((r) => r.dailyCapa!);
    p.defaultDailyCapa = capas.length > 0 ? Math.min(...capas) : 0;
  }
  return [...byCode.values()];
}

export function resolveEquipment(raw: string | null, rules: EquipmentRules): { maker: string | null; model: string | null; matched: boolean } {
  if (!raw) return { maker: null, model: null, matched: false };
  let maker: string | null = null;
  let model = raw;
  let matched = false;
  const prefixes = Object.keys(rules.prefixes ?? {}).sort((a, b) => b.length - a.length);
  for (const pre of prefixes) {
    if (raw.startsWith(pre)) {
      maker = rules.prefixes![pre];
      model = raw.slice(pre.length).trim();
      matched = true;
      break;
    }
  }
  const alias = rules.aliases?.[model];
  if (alias) {
    maker = alias.maker;
    model = alias.model;
    matched = true;
  }
  return { maker, model, matched };
}

function buildLineSpecs(rows: OperationPlanRow[], rules: EquipmentRules, warnings: string[]): OperationPlanLineSpec[] {
  const out: OperationPlanLineSpec[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.lineCode)) continue;
    seen.add(row.lineCode);
    const eq = resolveEquipment(row.equipmentRaw, rules);
    if (row.equipmentRaw && !eq.matched) warnings.push(`${row.lineCode}: 생산설비 '${row.equipmentRaw}' 에 맞는 제조사 규칙이 없어 제조사를 비움`);
    out.push({
      lineCode: row.lineCode,
      equipmentRaw: row.equipmentRaw,
      maker: eq.maker,
      model: eq.model,
      memo: row.equipmentRaw ? `생산설비 원문: ${row.equipmentRaw}` : null,
    });
  }
  return out;
}
