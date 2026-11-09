/**
 * scripts/make-fake-data.ts · 가상 데이터 생성기 (결정적: 같은 시드 → 같은 결과)
 *
 *   npx tsx scripts/make-fake-data.ts
 *
 * 생성물
 *   supabase/seed.sql                         재실행 가능한 시드 (npm run db:seed 가 적용)
 *   data/fake/주간생산계획_2611_Rev0.xlsx      FR-03 가져오기 테스트용 현행 계획표 (Rev 0 셀과 동일 + 테스트용 변형)
 *   data/fake/제품배치운용안_2610_Rev0.xlsx    FR-01 기준정보 가져오기
 *   data/fake/출고일정표_2611.xlsx             FR-05 출고일정
 *   data/fake/제품수불일보_20261111.xlsx       FR-05 재고 스냅샷
 *   data/fake/README.md
 *
 * 테스트는 generateDataset() 만 import 한다. 파일 쓰기는 직접 실행했을 때만 한다.
 * 실제 고객 자료는 쓰지 않는다 (NFR-01, Q7).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ExcelJS from "exceljs";
import type { ChangeoverKind, ChangeoverType, Downtime, ISODate, InventorySnapshot, PlanCell, ProcessType, SiloMeasurement, YearMonth } from "../lib/engine/types";
import { DEFAULT_FONT, HEADER_FILL, addDays, dateRange, escapeSqlString, isWeekend, isoToExcelDate, workbookToBuffer } from "../lib/excel/common";
import { PLAN_FIRST_DATE_COL, PLAN_HEADER_ROW, PLAN_SHEET_NAME, buildPlanWorkbookObject } from "../lib/excel/export-plan";

// ---------------------------------------------------------------------------
// 결정적 난수
// ---------------------------------------------------------------------------
class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  /** mulberry32 */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  shuffle<T>(arr: readonly T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  /** RFC 4122 v4 형태의 고정 UUID */
  uuid(): string {
    const b = new Uint8Array(16);
    for (let i = 0; i < 16; i++) b[i] = Math.floor(this.next() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
}

const round1000 = (n: number) => Math.round(n / 1000) * 1000;

// ---------------------------------------------------------------------------
// 데이터 모양
// ---------------------------------------------------------------------------
export interface FakeLine {
  id: string;
  code: string;
  name: string;
  factoryCode: string;
  processType: ProcessType;
  usesSeabulk: boolean;
  sortOrder: number;
  isPlanTarget: boolean;
}
export interface FakeProduct {
  id: string;
  code: string;
  name: string;
  cavity: number;
  packUnit: number;
  preformWeightG: number;
  safetyStock: number;
  surplusDays: number | null;
  defaultDailyCapa: number;
  unit: "EA";
}
export interface FakeCustomer {
  id: string;
  name: string;
  isMajor: boolean;
}
export interface FakeShipment {
  id: string;
  productId: string;
  customerId: string;
  shipDate: ISODate;
  qty: number;
}
export interface FakeUpload {
  id: string;
  kind: "plan" | "master" | "shipment" | "inventory";
  filename: string;
  rowCount: number;
}
export interface FakeDowntime extends Downtime {
  id: string;
}
export interface FakeReceipt {
  id: string;
  supplier: string;
  plannedDate: ISODate;
  qtyTon: number;
  orderDate: ISODate;
  status: "planned";
}
export interface FakeExternalUsage {
  id: string;
  factoryCode: string;
  label: string;
  weekdayTon: number;
  weekendTon: number;
}
export interface FakeMonthly {
  productId: string;
  lineId: string;
  yearMonth: YearMonth;
  qty: number;
  workingDays: number;
}
export interface FakeCoefficient {
  processType: ProcessType;
  changeoverType: ChangeoverKind;
  hours: number;
  factor: number;
  nextDayStart: boolean;
}
export interface FakeRevision {
  id: string;
  label: string;
  cells: PlanCell[];
}

export interface FakeDataset {
  periodStart: ISODate;
  periodEnd: ISODate;
  dates: ISODate[];
  lines: FakeLine[];
  products: FakeProduct[];
  allowedMolds: { lineId: string; productId: string }[];
  capacities: { lineId: string; productId: string; dailyCapa: number }[];
  customers: FakeCustomer[];
  plan: { id: string; factoryCode: string; processTab: string; periodStart: ISODate; periodEnd: ISODate };
  rev0: FakeRevision;
  draft: FakeRevision;
  downtimes: FakeDowntime[];
  uploads: FakeUpload[];
  shipments: FakeShipment[];
  inventory: InventorySnapshot[];
  inventoryAsOf: ISODate;
  siloMeasurements: SiloMeasurement[];
  siloReceipts: FakeReceipt[];
  externalUsage: FakeExternalUsage[];
  monthlyPlans: FakeMonthly[];
  changeoverCoefficients: FakeCoefficient[];
  /** 계획표 xlsx 에만 넣는 테스트용 변형 */
  planXlsx: {
    unmatchedCells: { lineCode: string; date: ISODate; text: string }[];
    injectorRow: number[];
    title: string;
  };
  files: { plan: string; master: string; shipments: string; inventory: string };
}

export const PERIOD_START: ISODate = "2026-11-12";
export const PERIOD_DAYS = 15;
export const INVENTORY_AS_OF: ISODate = "2026-11-11";
export const SEED = 20261112;

export const FAKE_FILES = {
  plan: "주간생산계획_2611_Rev0.xlsx",
  master: "제품배치운용안_2610_Rev0.xlsx",
  shipments: "출고일정표_2611.xlsx",
  inventory: "제품수불일보_20261111.xlsx",
} as const;

const CHANGEOVER_COEFFICIENTS: FakeCoefficient[] = [
  { processType: "PET1_1STAGE", changeoverType: "BM", hours: 3, factor: 0.87, nextDayStart: false },
  { processType: "PET1_1STAGE", changeoverType: "FULL", hours: 0, factor: 0, nextDayStart: true },
  { processType: "PET2_INJ", changeoverType: "BM", hours: 2, factor: 0.91, nextDayStart: false },
  { processType: "PET2_INJ", changeoverType: "FULL", hours: 4, factor: 0.83, nextDayStart: false },
  { processType: "PET2_BLOW", changeoverType: "BM", hours: 2, factor: 0.91, nextDayStart: false },
  { processType: "PET2_BLOW", changeoverType: "FULL", hours: 4, factor: 0.83, nextDayStart: false },
  { processType: "PE", changeoverType: "BM", hours: 6, factor: 0.75, nextDayStart: false },
  { processType: "PE", changeoverType: "FULL", hours: 6, factor: 0.75, nextDayStart: false },
];

// ---------------------------------------------------------------------------
// 생성
// ---------------------------------------------------------------------------
export function generateDataset(): FakeDataset {
  const rng = new Rng(SEED);
  const dates = dateRange(PERIOD_START, PERIOD_DAYS);
  const periodEnd = dates[dates.length - 1];

  // ---- lines ----
  const lines: FakeLine[] = [];
  const addLine = (code: string, name: string, factoryCode: string, processType: ProcessType, usesSeabulk: boolean, sortOrder: number, isPlanTarget: boolean) =>
    lines.push({ id: rng.uuid(), code, name, factoryCode, processType, usesSeabulk, sortOrder, isPlanTarget });
  for (let i = 1; i <= 18; i++) addLine(`PET${i}`, `PET ${i}호기`, "F1", "PET1_1STAGE", true, i, true);
  addLine("A1", "A1 사출기", "F1", "PET2_INJ", true, 19, false);
  addLine("B1", "B1 블로우", "F1", "PET2_BLOW", false, 20, false);
  addLine("B2", "B2 블로우", "F1", "PET2_BLOW", false, 21, false);
  for (let i = 1; i <= 4; i++) addLine(`PE${i}`, `PE ${i}호기`, "F1", "PE", false, 21 + i, false);
  for (let i = 1; i <= 4; i++) addLine(`P${i}`, `2공장 사출 P${i}`, "F2", "PET2_INJ", true, i, false);
  for (let i = 1; i <= 7; i++) addLine(`S${i}`, `2공장 블로우 S${i}`, "F2", "PET2_BLOW", false, 4 + i, false);
  const petLines = lines.filter((l) => l.isPlanTarget);

  // ---- products (36) ----
  const bases: { name: string; weight: number; cavities: number[]; capa: [number, number] }[] = [
    { name: "300ml 원형", weight: 13.5, cavities: [72, 96], capa: [110000, 140000] },
    { name: "330ml 원형", weight: 14.5, cavities: [72, 96], capa: [110000, 140000] },
    { name: "350ml 슬림", weight: 15.0, cavities: [64, 72, 96], capa: [100000, 135000] },
    { name: "500ml 원형", weight: 18.0, cavities: [48, 64, 72], capa: [95000, 130000] },
    { name: "500ml 사각", weight: 19.5, cavities: [48, 64], capa: [90000, 120000] },
    { name: "600ml 사각", weight: 21.0, cavities: [48, 64], capa: [85000, 115000] },
    { name: "750ml 원형", weight: 24.0, cavities: [32, 48], capa: [80000, 105000] },
    { name: "1L 원형", weight: 28.0, cavities: [32, 48], capa: [75000, 100000] },
    { name: "1.5L 원형", weight: 34.0, cavities: [24, 32], capa: [70000, 90000] },
    { name: "1.8L 원형", weight: 38.5, cavities: [24, 32], capa: [65000, 85000] },
    { name: "2L 원형", weight: 42.0, cavities: [24, 32], capa: [60000, 80000] },
    { name: "2L 사각", weight: 44.0, cavities: [24], capa: [60000, 75000] },
  ];
  const packUnits = [100, 150, 200, 250, 300, 400, 500];
  const products: FakeProduct[] = [];
  let pn = 0;
  for (const b of bases) {
    for (const suffix of ["A", "B", "C"]) {
      pn++;
      const weight = Math.round((b.weight + rng.float(-1.2, 1.2)) * 10) / 10;
      products.push({
        id: rng.uuid(),
        code: `PRD${String(pn).padStart(3, "0")}`,
        name: `${b.name} ${suffix}`,
        cavity: rng.pick(b.cavities),
        packUnit: rng.pick(packUnits),
        preformWeightG: Math.min(55, Math.max(12, weight)),
        safetyStock: 0,
        surplusDays: null,
        // 부록 11.3의 실제 씨벌크 사용량(평일 19~23톤)에 맞추기 위해 호기당 Capa를 축소한다 (18호기 × Capa × 중량 ≈ 16~17톤/일)
        defaultDailyCapa: round1000(rng.float(b.capa[0], b.capa[1]) * 0.45),
        unit: "EA",
      });
    }
  }
  // 안전재고가 있는 제품 6개
  for (const idx of [3, 9, 12, 21, 26, 33]) products[idx].safetyStock = round1000(rng.float(20000, 60000) / 5) * 5;
  products[12].surplusDays = 21;

  // ---- line_allowed_molds (호기당 3~6개, 제품은 여러 호기에 공유) ----
  const allowedByLine = new Map<string, string[]>();
  petLines.forEach((l) => allowedByLine.set(l.id, []));
  // 모든 제품이 최소 1개 호기에 배정되도록 먼저 순환 배정
  products.forEach((p, i) => allowedByLine.get(petLines[i % petLines.length].id)!.push(p.id));
  for (const l of petLines) {
    const target = rng.int(3, 6);
    const arr = allowedByLine.get(l.id)!;
    // 비슷한 크기의 제품끼리 묶이도록 기준 제품 주변에서 고른다
    const base = products.findIndex((p) => p.id === arr[0]);
    let guard = 0;
    while (arr.length < target && guard++ < 100) {
      const j = Math.min(products.length - 1, Math.max(0, base + rng.int(-7, 7)));
      const pid = products[j].id;
      if (!arr.includes(pid)) arr.push(pid);
    }
  }
  const allowedMolds: FakeDataset["allowedMolds"] = [];
  for (const l of petLines) for (const pid of allowedByLine.get(l.id)!) allowedMolds.push({ lineId: l.id, productId: pid });

  // ---- line_product_capacity (허용 조합의 약 60%) ----
  const productById = new Map(products.map((p) => [p.id, p]));
  const capacities: FakeDataset["capacities"] = [];
  for (const m of allowedMolds) {
    if (!rng.chance(0.6)) continue;
    const base = productById.get(m.productId)!.defaultDailyCapa;
    capacities.push({ lineId: m.lineId, productId: m.productId, dailyCapa: round1000(base * rng.float(0.85, 1.15)) });
  }
  const capaMap = new Map(capacities.map((c) => [`${c.lineId}|${c.productId}`, c.dailyCapa]));
  const capaFor = (lineId: string, productId: string) => capaMap.get(`${lineId}|${productId}`) ?? productById.get(productId)!.defaultDailyCapa;

  // ---- customers ----
  const customerNames = ["가나음료", "대한음료", "푸른생수", "한솔식품", "미래F&B", "동서유통", "청정워터", "새벽식품"];
  const customers: FakeCustomer[] = customerNames.map((name, i) => ({ id: rng.uuid(), name, isMajor: i < 3 }));

  // ---- plan / revisions ----
  const plan = { id: rng.uuid(), factoryCode: "F1", processTab: "1STAGE", periodStart: PERIOD_START, periodEnd };
  const rev0Id = rng.uuid();
  const draftId = rng.uuid();

  const downtimes: FakeDowntime[] = [
    { id: rng.uuid(), lineId: lineByCode(lines, "PET7").id, startDate: "2026-11-17", endDate: "2026-11-18", reason: "설비 고장" },
    { id: rng.uuid(), lineId: lineByCode(lines, "PET12").id, startDate: "2026-11-20", endDate: "2026-11-20", reason: "정전 (VCB 교체)" },
  ];

  // 교체 4건 이상인 날: 2026-11-19 (index 7)
  const BREAK_INDEX = 7;
  const forcedBreakLines = new Set(["PET2", "PET6", "PET10", "PET14"]);
  // 마지막 2일을 비워두는 호기 (xlsx 미매칭 셀 자리)
  const gapLines = new Set(["PET9", "PET16"]);

  const rev0Cells: PlanCell[] = [];
  for (const l of petLines) {
    const allowed = allowedByLine.get(l.id)!;
    const fillUntil = gapLines.has(l.code) ? PERIOD_DAYS - 2 : PERIOD_DAYS;
    let pos = 0;
    let prev: string | null = null;
    let runNo = 0;
    while (pos < fillUntil) {
      let len = rng.int(3, 8);
      if (forcedBreakLines.has(l.code) && pos < BREAK_INDEX && pos + len > BREAK_INDEX) len = BREAK_INDEX - pos;
      if (pos + len > fillUntil) len = fillUntil - pos;
      if (fillUntil - (pos + len) > 0 && fillUntil - (pos + len) < 3) len = fillUntil - pos;
      let product = rng.pick(allowed);
      let guard = 0;
      while (product === prev && allowed.length > 1 && guard++ < 20) product = rng.pick(allowed);
      let ct: ChangeoverType = "NONE";
      if (runNo > 0) {
        const r = rng.next();
        ct = r < 0.62 ? "NONE" : r < 0.9 ? "BM" : "FULL";
      }
      if (forcedBreakLines.has(l.code) && pos === BREAK_INDEX) ct = ["PET2", "PET10"].includes(l.code) ? "BM" : "NONE";
      for (let i = 0; i < len; i++) {
        const date = dates[pos + i];
        const hasQty = rng.chance(0.4);
        const capa = capaFor(l.id, product) * (isWeekend(date) ? 0.8 : 1);
        rev0Cells.push({
          lineId: l.id,
          date,
          productId: product,
          qty: hasQty ? round1000(capa * rng.float(0.92, 1.0)) : null,
          changeoverType: i === 0 ? ct : "NONE",
        });
      }
      prev = product;
      pos += len;
      runNo++;
    }
  }
  // Full 교체가 최소 2건 있도록
  for (const code of ["PET4", "PET11"]) {
    const l = lineByCode(lines, code);
    const starts = rev0Cells.filter((c, i, arr) => c.lineId === l.id && i > 0 && arr[i - 1].lineId === l.id && arr[i - 1].productId !== c.productId);
    if (starts[0]) starts[0].changeoverType = "FULL";
  }
  // 위반 ①: PET5 마지막 2일에 허용되지 않은 금형
  {
    const l = lineByCode(lines, "PET5");
    const allowed = new Set(allowedByLine.get(l.id)!);
    const notAllowed = products.find((p) => !allowed.has(p.id))!;
    for (const idx of [PERIOD_DAYS - 2, PERIOD_DAYS - 1]) {
      const c = rev0Cells.find((x) => x.lineId === l.id && x.date === dates[idx])!;
      c.productId = notAllowed.id;
      c.qty = null;
      c.changeoverType = idx === PERIOD_DAYS - 2 ? "BM" : "NONE";
    }
  }
  // 위반 ③: PET7 다운타임(11-17~18)은 비우고, PET12 다운타임(11-20)에는 셀을 남긴다
  {
    const pet7 = lineByCode(lines, "PET7").id;
    for (let i = rev0Cells.length - 1; i >= 0; i--) {
      const c = rev0Cells[i];
      if (c.lineId === pet7 && (c.date === "2026-11-17" || c.date === "2026-11-18")) rev0Cells.splice(i, 1);
    }
  }

  // ---- draft: Rev 0 에서 약 10셀 변경 ----
  const draftCells: PlanCell[] = rev0Cells.map((c) => ({ ...c }));
  const findCell = (arr: PlanCell[], code: string, idx: number) => arr.find((c) => c.lineId === lineByCode(lines, code).id && c.date === dates[idx]);
  for (const [code, idx] of [
    ["PET1", 2],
    ["PET3", 5],
    ["PET8", 10],
    ["PET15", 1],
  ] as const) {
    const c = findCell(draftCells, code, idx);
    if (c && c.productId) c.qty = round1000(capaFor(c.lineId, c.productId) * 0.85);
  }
  {
    const l = lineByCode(lines, "PET2");
    const allowed = allowedByLine.get(l.id)!;
    for (const idx of [12, 13, 14]) {
      const c = findCell(draftCells, "PET2", idx);
      if (!c) continue;
      const alt = allowed.find((p) => p !== c.productId)!;
      c.productId = alt;
      c.changeoverType = idx === 12 ? "BM" : "NONE";
    }
  }
  {
    const a = findCell(draftCells, "PET6", BREAK_INDEX);
    if (a) a.changeoverType = "FULL";
    const b = findCell(draftCells, "PET10", BREAK_INDEX);
    if (b) b.changeoverType = b.changeoverType === "BM" ? "FULL" : "BM";
  }
  {
    const pet17 = lineByCode(lines, "PET17").id;
    const i = draftCells.findIndex((c) => c.lineId === pet17 && c.date === dates[PERIOD_DAYS - 1]);
    if (i >= 0) draftCells.splice(i, 1);
  }

  // ---- uploads ----
  const uploads: FakeUpload[] = [
    { id: rng.uuid(), kind: "plan", filename: FAKE_FILES.plan, rowCount: 0 },
    { id: rng.uuid(), kind: "master", filename: FAKE_FILES.master, rowCount: 0 },
    { id: rng.uuid(), kind: "shipment", filename: FAKE_FILES.shipments, rowCount: 0 },
    { id: rng.uuid(), kind: "inventory", filename: FAKE_FILES.inventory, rowCount: 0 },
  ];

  // ---- shipments / inventory ----
  const shuffled = rng.shuffle(products);
  const noShipment = new Set(shuffled.slice(0, 6).map((p) => p.id));
  const shipped = shuffled.slice(6); // 30개
  const shortProducts = new Set(shipped.slice(0, 3).map((p) => p.id));
  const majors = customers.filter((c) => c.isMajor);
  const shipments: FakeShipment[] = [];
  const shipWindowDays = 29; // 2026-11-12 ~ 2026-12-10
  for (const p of shipped) {
    if (shortProducts.has(p.id)) {
      for (const dayIdx of [0, 2, 4, 6]) {
        shipments.push({ id: rng.uuid(), productId: p.id, customerId: rng.pick(majors).id, shipDate: addDays(PERIOD_START, dayIdx), qty: round1000(rng.float(75000, 90000)) });
      }
      continue;
    }
    const n = rng.int(2, 6);
    for (let i = 0; i < n; i++) {
      const customer = rng.chance(0.35) ? rng.pick(majors) : rng.pick(customers);
      shipments.push({ id: rng.uuid(), productId: p.id, customerId: customer.id, shipDate: addDays(PERIOD_START, rng.int(0, shipWindowDays - 1)), qty: round1000(rng.float(10000, 90000)) });
    }
  }
  shipments.sort((a, b) => (a.shipDate < b.shipDate ? -1 : a.shipDate > b.shipDate ? 1 : a.productId.localeCompare(b.productId)));
  const inventory: InventorySnapshot[] = products.map((p) => ({
    productId: p.id,
    asOfDate: INVENTORY_AS_OF,
    qty: shortProducts.has(p.id) ? round1000(rng.float(3000, 9000)) : round1000(rng.float(0, 140000)),
  }));
  uploads[2].rowCount = shipments.length;
  uploads[3].rowCount = inventory.length;
  uploads[0].rowCount = rev0Cells.length;
  uploads[1].rowCount = allowedMolds.length;
  void noShipment;

  // ---- silo ----
  const siloMeasurements: SiloMeasurement[] = [
    { date: PERIOD_START, siloCode: "S55", measuredTon: 28.5 },
    { date: PERIOD_START, siloCode: "S150", measuredTon: 61.0 },
  ];
  // 실제 운용(일 19~23톤 사용, 1회 입고 22~23톤)에 맞춰 매일 1차 입고. 12/11 이후는 미발주 → 그 뒤 하한 미달 → 발주 추천 시나리오
  const receiptDates: string[] = [];
  for (let d = PERIOD_START; d <= "2026-12-11"; d = addDays(d, 1)) receiptDates.push(d);
  const siloReceipts: FakeReceipt[] = receiptDates.map((d) => ({
    id: rng.uuid(),
    supplier: "롯데케미칼",
    plannedDate: d,
    qtyTon: 22.5,
    orderDate: addDays(d, -30),
    status: "planned",
  }));
  const externalUsage: FakeExternalUsage[] = [
    { id: rng.uuid(), factoryCode: "F1", label: "A1 사출기", weekdayTon: 1.5, weekendTon: 1.2 },
    { id: rng.uuid(), factoryCode: "F2", label: "2공장 사출 P1~4", weekdayTon: 4.0, weekendTon: 3.0 },
  ];

  // ---- monthly operation plan ----
  const months: [YearMonth, number][] = [
    ["2026-11", 30],
    ["2026-12", 31],
    ["2027-01", 31],
  ];
  const monthlyPlans: FakeMonthly[] = [];
  for (const l of petLines) {
    const allowed = allowedByLine.get(l.id)!;
    const n = Math.min(allowed.length, rng.int(2, 3));
    const chosen = rng.shuffle(allowed).slice(0, n);
    for (const [ym, days] of months) {
      for (const pid of chosen) {
        monthlyPlans.push({ productId: pid, lineId: l.id, yearMonth: ym, qty: round1000((capaFor(l.id, pid) * days) / n), workingDays: days });
      }
    }
  }

  // ---- 계획표 xlsx 테스트 변형 ----
  const injectorRow = dates.map(() => rng.pick([2.4, 2.8, 3.2, 4, 4.4]));
  const planXlsx = {
    unmatchedCells: [
      { lineCode: "PET9", date: dates[PERIOD_DAYS - 2], text: "750ml 타원형\n60,000" },
      { lineCode: "PET16", date: dates[PERIOD_DAYS - 1], text: "1.2L 원형 D" },
    ],
    injectorRow,
    title: `주간 생산계획 2611 (${PERIOD_START} ~ ${periodEnd}) · Rev 0 · 1팀 PET1`,
  };

  return {
    periodStart: PERIOD_START,
    periodEnd,
    dates,
    lines,
    products,
    allowedMolds,
    capacities,
    customers,
    plan,
    rev0: { id: rev0Id, label: "Rev 0", cells: rev0Cells },
    draft: { id: draftId, label: "초안", cells: draftCells },
    downtimes,
    uploads,
    shipments,
    inventory,
    inventoryAsOf: INVENTORY_AS_OF,
    siloMeasurements,
    siloReceipts,
    externalUsage,
    monthlyPlans,
    changeoverCoefficients: CHANGEOVER_COEFFICIENTS,
    planXlsx,
    files: { ...FAKE_FILES },
  };
}

export function lineByCode(lines: FakeLine[], code: string): FakeLine {
  const l = lines.find((x) => x.code === code);
  if (!l) throw new Error(`line ${code} not found`);
  return l;
}

// ---------------------------------------------------------------------------
// seed.sql
// ---------------------------------------------------------------------------
const q = (s: string) => `'${escapeSqlString(s)}'`;
const num = (n: number | null | undefined) => (n === null || n === undefined ? "null" : String(n));
const bool = (b: boolean) => (b ? "true" : "false");

export function buildSeedSql(ds: FakeDataset): string {
  const out: string[] = [];
  const lineCode = new Map(ds.lines.map((l) => [l.id, l.code]));
  const productCode = new Map(ds.products.map((p) => [p.id, p.code]));
  const customerName = new Map(ds.customers.map((c) => [c.id, c.name]));
  const factory = (code: string) => `(select id from factories where code = ${q(code)})`;
  const line = (id: string) => `(select id from lines where code = ${q(lineCode.get(id)!)})`;

  out.push(`-- =====================================================================`);
  out.push(`-- supabase/seed.sql · 가상 데이터 (scripts/make-fake-data.ts 가 생성, 직접 편집 금지)`);
  out.push(`-- 재실행 가능: 기준정보는 on conflict do update, 운용 데이터는 삭제 후 삽입.`);
  out.push(`-- 실행: npm run db:seed (scripts/db.ts 가 트랜잭션으로 감싼다)`);
  out.push(`-- 시드 ${SEED} · 기간 ${ds.periodStart} ~ ${ds.periodEnd} · 생성 시각은 기록하지 않음(결정적 출력)`);
  out.push(`-- =====================================================================`);
  out.push("");

  // lines
  out.push(`-- ---------- lines (${ds.lines.length}) ----------`);
  out.push(`insert into lines (id, factory_id, code, name, process_type, uses_seabulk, sort_order, is_plan_target) values`);
  out.push(
    ds.lines
      .map((l) => `  (${q(l.id)}, ${factory(l.factoryCode)}, ${q(l.code)}, ${q(l.name)}, ${q(l.processType)}, ${bool(l.usesSeabulk)}, ${l.sortOrder}, ${bool(l.isPlanTarget)})`)
      .join(",\n"),
  );
  out.push(`on conflict (code) do update set factory_id = excluded.factory_id, name = excluded.name, process_type = excluded.process_type,`);
  out.push(`  uses_seabulk = excluded.uses_seabulk, sort_order = excluded.sort_order, is_plan_target = excluded.is_plan_target, updated_at = now();`);
  out.push("");

  // products
  out.push(`-- ---------- products (${ds.products.length}) ----------`);
  out.push(`insert into products (id, code, name, cavity, pack_unit, preform_weight_g, safety_stock, surplus_days, default_daily_capa, unit) values`);
  out.push(
    ds.products
      .map(
        (p) =>
          `  (${q(p.id)}, ${q(p.code)}, ${q(p.name)}, ${p.cavity}, ${p.packUnit}, ${p.preformWeightG}, ${p.safetyStock}, ${num(p.surplusDays)}, ${p.defaultDailyCapa}, ${q(p.unit)})`,
      )
      .join(",\n"),
  );
  out.push(`on conflict (code) do update set name = excluded.name, cavity = excluded.cavity, pack_unit = excluded.pack_unit,`);
  out.push(`  preform_weight_g = excluded.preform_weight_g, safety_stock = excluded.safety_stock, surplus_days = excluded.surplus_days,`);
  out.push(`  default_daily_capa = excluded.default_daily_capa, unit = excluded.unit, updated_at = now();`);
  out.push("");

  // allowed molds
  out.push(`-- ---------- line_allowed_molds (${ds.allowedMolds.length}) ----------`);
  out.push(`delete from line_allowed_molds where line_id in (select id from lines where is_plan_target);`);
  out.push(`insert into line_allowed_molds (line_id, product_id)`);
  out.push(`select l.id, p.id from (values`);
  out.push(ds.allowedMolds.map((m) => `  (${q(lineCode.get(m.lineId)!)}, ${q(productCode.get(m.productId)!)})`).join(",\n"));
  out.push(`) as v(line_code, product_code)`);
  out.push(`join lines l on l.code = v.line_code join products p on p.code = v.product_code`);
  out.push(`on conflict do nothing;`);
  out.push("");

  // capacity
  out.push(`-- ---------- line_product_capacity (${ds.capacities.length}) ----------`);
  out.push(`delete from line_product_capacity where line_id in (select id from lines where is_plan_target);`);
  out.push(`insert into line_product_capacity (line_id, product_id, daily_capa)`);
  out.push(`select l.id, p.id, v.capa::numeric from (values`);
  out.push(ds.capacities.map((c) => `  (${q(lineCode.get(c.lineId)!)}, ${q(productCode.get(c.productId)!)}, ${c.dailyCapa})`).join(",\n"));
  out.push(`) as v(line_code, product_code, capa)`);
  out.push(`join lines l on l.code = v.line_code join products p on p.code = v.product_code`);
  out.push(`on conflict (line_id, product_id) do update set daily_capa = excluded.daily_capa;`);
  out.push("");

  // customers
  out.push(`-- ---------- customers (${ds.customers.length}) ----------`);
  out.push(`insert into customers (id, name, is_major) values`);
  out.push(ds.customers.map((c) => `  (${q(c.id)}, ${q(c.name)}, ${bool(c.isMajor)})`).join(",\n"));
  out.push(`on conflict (name) do update set is_major = excluded.is_major;`);
  out.push("");

  // plan / revisions / cells
  out.push(`-- ---------- plans / plan_revisions / plan_cells ----------`);
  out.push(`-- 확정 Rev 불변 트리거(NFR-09) 때문에 재실행 시 기존 계획을 지우려면 삭제 구간에서만 트리거를 끈다.`);
  out.push(`alter table plan_cells disable trigger plan_cells_immutable;`);
  out.push(`alter table plan_revisions disable trigger plan_revisions_immutable;`);
  out.push(
    `delete from plans where id = ${q(ds.plan.id)} or (factory_id = ${factory(ds.plan.factoryCode)} and process_tab = ${q(ds.plan.processTab)} and period_start = ${q(ds.plan.periodStart)});`,
  );
  out.push(`alter table plan_revisions enable trigger plan_revisions_immutable;`);
  out.push(`alter table plan_cells enable trigger plan_cells_immutable;`);
  out.push("");
  out.push(`insert into plans (id, factory_id, process_tab, period_start, period_end) values`);
  out.push(`  (${q(ds.plan.id)}, ${factory(ds.plan.factoryCode)}, ${q(ds.plan.processTab)}, ${q(ds.plan.periodStart)}, ${q(ds.plan.periodEnd)});`);
  out.push("");
  out.push(`-- Rev 0: 초안으로 넣고 셀을 채운 뒤 확정으로 바꾼다 (plan_cells 트리거는 확정 Rev 에 대한 삽입을 막기 때문)`);
  out.push(`insert into plan_revisions (id, plan_id, rev_no, status) values (${q(ds.rev0.id)}, ${q(ds.plan.id)}, null, 'draft');`);
  out.push(cellsInsertSql(ds.rev0.id, ds.rev0.cells, lineCode, productCode));
  out.push(`update plan_revisions set status = 'confirmed', rev_no = 0, confirmed_at = now() where id = ${q(ds.rev0.id)};`);
  out.push("");
  out.push(`-- 초안 (Rev 0 기반, 약 10셀 차이 → Rev 비교 화면용)`);
  out.push(
    `insert into plan_revisions (id, plan_id, rev_no, status, parent_revision_id) values (${q(ds.draft.id)}, ${q(ds.plan.id)}, null, 'draft', ${q(ds.rev0.id)});`,
  );
  out.push(cellsInsertSql(ds.draft.id, ds.draft.cells, lineCode, productCode));
  out.push("");

  // downtimes
  out.push(`-- ---------- downtimes (${ds.downtimes.length}) ----------`);
  out.push(`delete from downtimes;`);
  out.push(`insert into downtimes (id, line_id, start_date, end_date, reason) values`);
  out.push(ds.downtimes.map((d) => `  (${q(d.id)}, ${line(d.lineId)}, ${q(d.startDate)}, ${q(d.endDate)}, ${q(d.reason)})`).join(",\n"));
  out.push(`on conflict (id) do update set line_id = excluded.line_id, start_date = excluded.start_date, end_date = excluded.end_date, reason = excluded.reason;`);
  out.push("");

  // uploads
  out.push(`-- ---------- uploads (${ds.uploads.length}) ----------`);
  out.push(`delete from uploads;`);
  out.push(`insert into uploads (id, kind, filename, uploaded_at, row_count) values`);
  out.push(ds.uploads.map((u) => `  (${q(u.id)}, ${q(u.kind)}, ${q(u.filename)}, now(), ${u.rowCount})`).join(",\n"));
  out.push(`on conflict (id) do update set kind = excluded.kind, filename = excluded.filename, uploaded_at = now(), row_count = excluded.row_count;`);
  out.push("");

  // shipments
  const shipUpload = ds.uploads.find((u) => u.kind === "shipment")!;
  out.push(`-- ---------- shipments (${ds.shipments.length}) · 출고일정표는 업로드마다 전체 교체(Q13)이므로 삭제 후 삽입 ----------`);
  out.push(`delete from shipments;`);
  out.push(`insert into shipments (id, product_id, customer_id, ship_date, qty, upload_id)`);
  out.push(`select v.id::uuid, p.id, c.id, v.ship_date::date, v.qty::numeric, ${q(shipUpload.id)}::uuid from (values`);
  out.push(
    ds.shipments
      .map((s) => `  (${q(s.id)}, ${q(productCode.get(s.productId)!)}, ${q(customerName.get(s.customerId)!)}, ${q(s.shipDate)}, ${s.qty})`)
      .join(",\n"),
  );
  out.push(`) as v(id, product_code, customer_name, ship_date, qty)`);
  out.push(`join products p on p.code = v.product_code left join customers c on c.name = v.customer_name;`);
  out.push("");

  // inventory
  const invUpload = ds.uploads.find((u) => u.kind === "inventory")!;
  out.push(`-- ---------- inventory_snapshots (${ds.inventory.length}) ----------`);
  out.push(`insert into inventory_snapshots (product_id, as_of_date, qty, upload_id)`);
  out.push(`select p.id, v.as_of::date, v.qty::numeric, ${q(invUpload.id)}::uuid from (values`);
  out.push(ds.inventory.map((i) => `  (${q(productCode.get(i.productId)!)}, ${q(i.asOfDate)}, ${i.qty})`).join(",\n"));
  out.push(`) as v(product_code, as_of, qty)`);
  out.push(`join products p on p.code = v.product_code`);
  out.push(`on conflict (product_id, as_of_date) do update set qty = excluded.qty, upload_id = excluded.upload_id;`);
  out.push("");

  // silo
  out.push(`-- ---------- silo_stock_measurements ----------`);
  out.push(`delete from silo_stock_measurements;`);
  out.push(`insert into silo_stock_measurements (date, silo_id, measured_ton) values`);
  out.push(ds.siloMeasurements.map((m) => `  (${q(m.date)}, (select id from silos where code = ${q(m.siloCode)}), ${m.measuredTon})`).join(",\n"));
  out.push(`on conflict (date, silo_id) do update set measured_ton = excluded.measured_ton, updated_at = now();`);
  out.push("");
  out.push(`-- ---------- silo_receipts (${ds.siloReceipts.length}) ----------`);
  out.push(`delete from silo_receipts;`);
  out.push(`insert into silo_receipts (id, supplier, planned_date, qty_ton, order_date, status) values`);
  out.push(ds.siloReceipts.map((r) => `  (${q(r.id)}, ${q(r.supplier)}, ${q(r.plannedDate)}, ${r.qtyTon}, ${q(r.orderDate)}, ${q(r.status)})`).join(",\n"));
  out.push(`on conflict (id) do update set supplier = excluded.supplier, planned_date = excluded.planned_date, qty_ton = excluded.qty_ton, order_date = excluded.order_date, status = excluded.status;`);
  out.push("");
  out.push(`-- ---------- silo_external_usage (Q9) ----------`);
  out.push(`delete from silo_external_usage;`);
  out.push(`insert into silo_external_usage (id, factory_id, label, weekday_ton, weekend_ton) values`);
  out.push(ds.externalUsage.map((u) => `  (${q(u.id)}, ${factory(u.factoryCode)}, ${q(u.label)}, ${u.weekdayTon}, ${u.weekendTon})`).join(",\n"));
  out.push(`on conflict (id) do update set factory_id = excluded.factory_id, label = excluded.label, weekday_ton = excluded.weekday_ton, weekend_ton = excluded.weekend_ton, updated_at = now();`);
  out.push("");

  // monthly
  out.push(`-- ---------- monthly_operation_plan (${ds.monthlyPlans.length}) ----------`);
  out.push(`delete from monthly_operation_plan where line_id in (select id from lines where is_plan_target);`);
  out.push(`insert into monthly_operation_plan (product_id, line_id, year_month, qty, working_days)`);
  out.push(`select p.id, l.id, v.ym, v.qty::numeric, v.days::int from (values`);
  out.push(
    ds.monthlyPlans
      .map((m) => `  (${q(productCode.get(m.productId)!)}, ${q(lineCode.get(m.lineId)!)}, ${q(m.yearMonth)}, ${m.qty}, ${m.workingDays})`)
      .join(",\n"),
  );
  out.push(`) as v(product_code, line_code, ym, qty, days)`);
  out.push(`join products p on p.code = v.product_code join lines l on l.code = v.line_code`);
  out.push(`on conflict (product_id, line_id, year_month) do update set qty = excluded.qty, working_days = excluded.working_days;`);
  out.push("");
  out.push(`-- 끝`);
  return out.join("\n") + "\n";
}

function cellsInsertSql(revisionId: string, cells: PlanCell[], lineCode: Map<string, string>, productCode: Map<string, string>): string {
  if (cells.length === 0) return `-- (셀 없음)`;
  const rows = cells.map((c, i) => {
    const vals = [q(lineCode.get(c.lineId)!), q(c.date), c.productId ? q(productCode.get(c.productId)!) : "null", num(c.qty), q(c.changeoverType)];
    if (i === 0) {
      // 첫 행에 타입을 명시해 values 의 열 타입을 고정한다
      vals[0] += "::text";
      vals[1] += "::date";
      vals[2] += "::text";
      vals[3] += "::numeric";
      vals[4] += "::changeover_type";
    }
    return `  (${vals.join(", ")})`;
  });
  return [
    `insert into plan_cells (revision_id, line_id, date, product_id, qty, changeover_type)`,
    `select ${q(revisionId)}::uuid, l.id, v.d, p.id, v.qty, v.ct from (values`,
    rows.join(",\n"),
    `) as v(line_code, d, product_code, qty, ct)`,
    `join lines l on l.code = v.line_code left join products p on p.code = v.product_code;`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Excel 파일
// ---------------------------------------------------------------------------
function styleHeaderRow(row: ExcelJS.Row) {
  row.eachCell((c) => {
    c.font = { ...DEFAULT_FONT, bold: true };
    c.fill = HEADER_FILL;
    c.alignment = { vertical: "middle", horizontal: "center" };
  });
}
function styleBody(ws: ExcelJS.Worksheet, fromRow: number) {
  for (let r = fromRow; r <= ws.rowCount; r++) ws.getRow(r).eachCell((c) => (c.font = DEFAULT_FONT));
}

/** 현행 계획표 양식의 가상 파일: 내보내기 결과 + 테스트용 변형('사출기' 행, 미매칭 제품명 2셀, 교체손실계수 시트) */
export async function buildFakePlanWorkbook(ds: FakeDataset): Promise<ExcelJS.Workbook> {
  const petLines = ds.lines.filter((l) => l.isPlanTarget);
  const wb = buildPlanWorkbookObject({
    periodStart: ds.periodStart,
    dates: ds.dates,
    lines: petLines,
    products: ds.products,
    allowedMolds: ds.allowedMolds,
    cells: ds.rev0.cells,
    downtimes: ds.downtimes,
    revisionLabel: ds.rev0.label,
    title: ds.planXlsx.title,
  });
  const ws = wb.getWorksheet(PLAN_SHEET_NAME)!;

  // 미매칭 제품명 2셀 (Rev 0 에서 비어 있는 자리)
  for (const u of ds.planXlsx.unmatchedCells) {
    const rowIdx = petLines.findIndex((l) => l.code === u.lineCode);
    const colIdx = ds.dates.indexOf(u.date);
    const cell = ws.getCell(PLAN_HEADER_ROW + 1 + rowIdx, PLAN_FIRST_DATE_COL + colIdx);
    cell.value = u.text;
  }

  // '사출기' 행 (Q1: 의미 미확정 숫자 → 가져오기는 경고 후 무시)
  const injRow = ws.getRow(PLAN_HEADER_ROW + 1 + petLines.length);
  injRow.getCell(1).value = "사출기";
  injRow.getCell(1).font = { ...DEFAULT_FONT, bold: true };
  injRow.getCell(1).alignment = { vertical: "middle", horizontal: "center" };
  injRow.getCell(2).value = "(씨벌크 사용량? 의미 확인 필요)";
  injRow.getCell(2).font = { ...DEFAULT_FONT, italic: true, color: { argb: "FF808080" } };
  ds.planXlsx.injectorRow.forEach((n, i) => {
    const c = injRow.getCell(PLAN_FIRST_DATE_COL + i);
    c.value = n;
    c.font = DEFAULT_FONT;
    c.alignment = { vertical: "middle", horizontal: "center" };
  });
  injRow.height = 20;

  // 교체손실계수 시트
  const cs = wb.addWorksheet("교체손실계수");
  cs.addRow(["공정유형", "교체유형", "소요시간(h)", "가동률 계수", "익일 가동"]);
  styleHeaderRow(cs.getRow(1));
  for (const c of ds.changeoverCoefficients) {
    cs.addRow([c.processType, c.changeoverType === "BM" ? "B/M" : "Full", c.hours, c.factor, c.nextDayStart ? "Y" : "N"]);
  }
  styleBody(cs, 2);
  cs.columns.forEach((col) => (col.width = 16));
  return wb;
}

export async function buildFakeMasterWorkbook(ds: FakeDataset): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("운용안", { views: [{ state: "frozen", ySplit: 1 }] });
  const months: YearMonth[] = [...new Set(ds.monthlyPlans.map((m) => m.yearMonth))].sort();
  const header = ["호기", "제품코드", "제품명", "캐비티", "포장단위", "중량(g)", "일일Capa", "안전재고"];
  for (const ym of months) header.push(`${ym} 물량`, `${ym} 가동일수`);
  ws.addRow(header);
  styleHeaderRow(ws.getRow(1));

  const lineById = new Map(ds.lines.map((l) => [l.id, l]));
  const productById = new Map(ds.products.map((p) => [p.id, p]));
  const capa = new Map(ds.capacities.map((c) => [`${c.lineId}|${c.productId}`, c.dailyCapa]));
  const monthly = new Map(ds.monthlyPlans.map((m) => [`${m.lineId}|${m.productId}|${m.yearMonth}`, m]));
  const petLines = ds.lines.filter((l) => l.isPlanTarget);
  for (const l of petLines) {
    for (const m of ds.allowedMolds.filter((x) => x.lineId === l.id)) {
      const p = productById.get(m.productId)!;
      const row: (string | number | null)[] = [
        lineById.get(l.id)!.name,
        p.code,
        p.name,
        p.cavity,
        p.packUnit,
        p.preformWeightG,
        capa.get(`${l.id}|${p.id}`) ?? p.defaultDailyCapa,
        p.safetyStock,
      ];
      for (const ym of months) {
        const mp = monthly.get(`${l.id}|${p.id}|${ym}`);
        row.push(mp ? mp.qty : null, mp ? mp.workingDays : null);
      }
      ws.addRow(row);
    }
  }
  styleBody(ws, 2);
  ws.getColumn(1).width = 12;
  ws.getColumn(2).width = 10;
  ws.getColumn(3).width = 18;
  for (let c = 4; c <= header.length; c++) {
    ws.getColumn(c).width = 13;
    ws.getColumn(c).numFmt = c >= 7 ? "#,##0" : "0.#";
  }
  return wb;
}

export async function buildFakeShipmentsWorkbook(ds: FakeDataset): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("출고일정", { views: [{ state: "frozen", ySplit: 2 }] });
  ws.addRow([`출고일정표 2026-11 (${ds.periodStart} 기준)`]);
  ws.getCell(1, 1).font = { ...DEFAULT_FONT, size: 13, bold: true };
  ws.addRow(["출고예정일", "거래처", "대형거래선(Y/N)", "제품명", "수량"]);
  styleHeaderRow(ws.getRow(2));
  const productById = new Map(ds.products.map((p) => [p.id, p]));
  const customerById = new Map(ds.customers.map((c) => [c.id, c]));
  for (const s of ds.shipments) {
    const c = customerById.get(s.customerId)!;
    const row = ws.addRow([isoToExcelDate(s.shipDate), c.name, c.isMajor ? "Y" : "N", productById.get(s.productId)!.name, s.qty]);
    row.getCell(1).numFmt = "yyyy-mm-dd";
    row.getCell(5).numFmt = "#,##0";
  }
  styleBody(ws, 3);
  [14, 14, 14, 20, 12].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  return wb;
}

export async function buildFakeInventoryWorkbook(ds: FakeDataset): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("수불", { views: [{ state: "frozen", ySplit: 2 }] });
  ws.addRow([`제품수불일보 (기준일 ${ds.inventoryAsOf})`]);
  ws.getCell(1, 1).font = { ...DEFAULT_FONT, size: 13, bold: true };
  ws.addRow(["기준일", "제품코드", "제품명", "양품현재고"]);
  styleHeaderRow(ws.getRow(2));
  const productById = new Map(ds.products.map((p) => [p.id, p]));
  for (const i of ds.inventory) {
    const p = productById.get(i.productId)!;
    const row = ws.addRow([isoToExcelDate(i.asOfDate), p.code, p.name, i.qty]);
    row.getCell(1).numFmt = "yyyy-mm-dd";
    row.getCell(4).numFmt = "#,##0";
  }
  styleBody(ws, 3);
  [14, 12, 20, 14].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  return wb;
}

export async function buildFakePlanBuffer(ds: FakeDataset): Promise<Buffer> {
  return workbookToBuffer(await buildFakePlanWorkbook(ds));
}
export async function buildFakeMasterBuffer(ds: FakeDataset): Promise<Buffer> {
  return workbookToBuffer(await buildFakeMasterWorkbook(ds));
}
export async function buildFakeShipmentsBuffer(ds: FakeDataset): Promise<Buffer> {
  return workbookToBuffer(await buildFakeShipmentsWorkbook(ds));
}
export async function buildFakeInventoryBuffer(ds: FakeDataset): Promise<Buffer> {
  return workbookToBuffer(await buildFakeInventoryWorkbook(ds));
}

// ---------------------------------------------------------------------------
// README
// ---------------------------------------------------------------------------
function buildReadme(ds: FakeDataset): string {
  const petLines = ds.lines.filter((l) => l.isPlanTarget).length;
  const diff = countDiff(ds.rev0.cells, ds.draft.cells);
  return `# data/fake · 가상 데이터

\`npx tsx scripts/make-fake-data.ts\` 가 만든다. 시드가 고정돼 있어 다시 실행해도 같은 내용·같은 UUID가 나온다.
실제 고객 자료는 들어 있지 않다(NFR-01, Q7). \`*.xlsx\` 는 .gitignore 대상이므로 clone 뒤에는 위 명령으로 다시 만든다.

| 파일 | 용도 | 내용 |
|---|---|---|
| \`../../supabase/seed.sql\` | \`npm run db:seed\` | 호기 ${ds.lines.length}(계획 대상 PET ${petLines}), 제품 ${ds.products.length}, 허용 금형 ${ds.allowedMolds.length}, 호기별 Capa ${ds.capacities.length}, 거래처 ${ds.customers.length}, 계획 1건(${ds.periodStart}~${ds.periodEnd}) · Rev 0 ${ds.rev0.cells.length}셀 + 초안 ${ds.draft.cells.length}셀(차이 ${diff}셀), 다운타임 ${ds.downtimes.length}, 출고 ${ds.shipments.length}, 재고 ${ds.inventory.length}, 사일로 실측 2, 입고 예정 3, 외부 사용량 2, 월 운용안 ${ds.monthlyPlans.length} |
| \`${ds.files.plan}\` | FR-03 가져오기 테스트 | 시트 '1팀 PET1': 1행 제목, 2행(숨김) 실제 날짜, 3행 헤더 \`호기 | 생산가능금형 | 11/12(목) …\`, 4행~ PET 1~18호기. 셀은 \`제품명 (B/M)\\n96,000\` 형식. Rev 0 셀과 동일하되 **테스트용 변형**: '사출기' 행(일별 숫자, Q1 → 경고 후 무시), 기준정보에 없는 제품명 2셀(${ds.planXlsx.unmatchedCells.map((u) => `${u.lineCode} ${u.date} '${u.text.split("\n")[0]}'`).join(", ")}), 다운타임 셀 회색(PET7 11-17~18 은 '설비 고장' 텍스트, PET12 11-20 은 제품이 배치된 채 회색 → 위반 ③ 재현). 두 번째 시트 '교체손실계수' |
| \`${ds.files.master}\` | FR-01 기준정보 가져오기 | 시트 '운용안': 호기 × 허용 제품 1행 (${ds.allowedMolds.length}행). 캐비티·포장단위·중량·일일Capa·안전재고 + 2026-11/12, 2027-01 물량·가동일수 |
| \`${ds.files.shipments}\` | FR-05 출고일정 | 시트 '출고일정' (헤더 2행): 출고예정일(Excel 날짜) · 거래처 · 대형거래선(Y/N) · 제품명 · 수량. ${ds.shipments.length}행, 2026-11-12~12-10. 3개 제품은 재고 대비 출고가 크게 많아 **부족**, 6개 제품은 출고 없음 |
| \`${ds.files.inventory}\` | FR-05 재고 스냅샷 | 시트 '수불' (헤더 2행): 기준일 ${ds.inventoryAsOf} · 제품코드 · 제품명 · 양품현재고. ${ds.inventory.length}행 |

## 계획 데이터에 일부러 넣은 상황 (경고·위반 화면 확인용)

- PET5 마지막 2일: 허용 목록에 없는 금형 → FR-07 ① MOLD_NOT_ALLOWED
- 2026-11-19: PET2·PET6·PET10·PET14 가 같은 날 제품 교체 → 공장 단위 교체 4건으로 FR-07 ② CHANGEOVER_LIMIT(기본 3회) 초과
- PET12 2026-11-20: 다운타임('정전 (VCB 교체)')인데 셀이 있음 → FR-07 ③ DOWNTIME_ASSIGNED
- PET7 2026-11-17~18: 다운타임('설비 고장'), 셀 비움
- 교체유형이 비어 있는 제품 전환이 다수 → 기본 교체유형(BM) 적용 주의(CHANGEOVER_DEFAULTED)
- 수량이 입력된 셀은 약 40%, 나머지는 예상 생산량 사용
- 사일로 실측 ${ds.periodStart}: S55 28.5t, S150 61.0t · 입고 예정 22.5t × 일요일 제외 매일 (11-12 ~ 12-11, 롯데케미칼), 이후 미발주

## 엑셀 해석 규칙 (lib/excel)

- 호기 행: 'PET 1호기' / 'PET1' / 'PET 1' / '1호기' → PET1. 모르는 행은 경고 후 건너뜀
- 날짜 열: 헤더 윗 행의 실제 날짜 우선, 없으면 '11/12(목)' + 연도(기간 시작일 → 제목 → 올해)
- 셀: 첫 줄 제품명, '(B/M)'→BM, '(Full)'/'(풀셋)'→FULL, 다음 줄 숫자 → 수량. '설비 고장'·'정전'·'휴무'·'점검' → 빈 셀 + 경고
- 제품명 비교: NFC · 공백 축약 · 대소문자 무시
`;
}

export function countDiff(a: PlanCell[], b: PlanCell[]): number {
  const key = (c: PlanCell) => `${c.lineId}|${c.date}`;
  const sig = (c: PlanCell) => `${c.productId}|${c.qty}|${c.changeoverType}`;
  const ma = new Map(a.map((c) => [key(c), sig(c)]));
  const mb = new Map(b.map((c) => [key(c), sig(c)]));
  let n = 0;
  for (const [k, v] of ma) if (mb.get(k) !== v) n++;
  for (const k of mb.keys()) if (!ma.has(k)) n++;
  return n;
}

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------
export async function writeAll(root: string): Promise<FakeDataset> {
  const ds = generateDataset();
  const fakeDir = join(root, "data", "fake");
  const supaDir = join(root, "supabase");
  mkdirSync(fakeDir, { recursive: true });
  mkdirSync(supaDir, { recursive: true });

  writeFileSync(join(supaDir, "seed.sql"), buildSeedSql(ds), "utf8");
  writeFileSync(join(fakeDir, ds.files.plan), await buildFakePlanBuffer(ds));
  writeFileSync(join(fakeDir, ds.files.master), await buildFakeMasterBuffer(ds));
  writeFileSync(join(fakeDir, ds.files.shipments), await buildFakeShipmentsBuffer(ds));
  writeFileSync(join(fakeDir, ds.files.inventory), await buildFakeInventoryBuffer(ds));
  writeFileSync(join(fakeDir, "README.md"), buildReadme(ds), "utf8");
  return ds;
}

const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return pathToFileURL(resolve(argv1)).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  writeAll(root)
    .then((ds) => {
      const petLines = ds.lines.filter((l) => l.isPlanTarget).length;
      console.log(`seed.sql · lines ${ds.lines.length} (PET ${petLines}) · products ${ds.products.length} · allowed ${ds.allowedMolds.length} · capa ${ds.capacities.length}`);
      console.log(`plan ${ds.periodStart}~${ds.periodEnd} · Rev0 cells ${ds.rev0.cells.length} · draft cells ${ds.draft.cells.length} · diff ${countDiff(ds.rev0.cells, ds.draft.cells)}`);
      console.log(`shipments ${ds.shipments.length} · inventory ${ds.inventory.length} · monthly ${ds.monthlyPlans.length}`);
      console.log(`xlsx → data/fake/{${Object.values(ds.files).join(", ")}}`);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
