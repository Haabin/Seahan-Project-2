/**
 * lib/engine 공용 타입.
 * 이 모듈은 프레임워크·DB에 의존하지 않는다. 브라우저와 서버, 테스트에서 동일하게 쓴다.
 * 요구사항: 5장(데이터 정의·계산식), FR-07/08/09/11/14/15/16, NFR-04(계산 근거), NFR-05(1초 이내)
 */

/** 'YYYY-MM-DD' */
export type ISODate = string;
/** 'YYYY-MM' */
export type YearMonth = string;

export type ProcessType = "PET1_1STAGE" | "PET2_INJ" | "PET2_BLOW" | "PE";
export type ChangeoverType = "NONE" | "BM" | "FULL";
export type ChangeoverKind = Exclude<ChangeoverType, "NONE">;
export type QtyUnit = "EA" | "KEA"; // 본 / 천본 (Q3)

// ---------------------------------------------------------------------------
// 기준정보 (FR-01, 5.1)
// ---------------------------------------------------------------------------
export interface Line {
  id: string;
  code: string; // 'PET1' … 'PET18', 'A1', 'P1' …
  name: string; // 'PET 1호기'
  factoryCode: string; // 'F1' | 'F2'
  processType: ProcessType;
  usesSeabulk: boolean; // 사출 공정이 있는 설비만 true
  sortOrder: number;
  isPlanTarget: boolean; // 1단계: PET1~18만 true
}

export interface Product {
  id: string;
  code: string;
  name: string; // 현행 계획표 셀의 제품명(금형명)과 매칭
  cavity: number | null;
  packUnit: number | null;
  preformWeightG: number; // 프리폼 1개 중량(g). 씨벌크 사용량 계산(FR-14)
  safetyStock: number; // Q12, 기본 0
  surplusDays: number | null; // 제품별 과잉 기준 일수. null이면 settings.surplusDays
  defaultDailyCapa: number; // 호기별 Capa가 없을 때 사용
  unit: QtyUnit;
}

export interface AllowedMold {
  lineId: string;
  productId: string;
}

export interface LineProductCapacity {
  lineId: string;
  productId: string;
  dailyCapa: number;
}

export interface ChangeoverCoefficient {
  processType: ProcessType;
  changeoverType: ChangeoverKind;
  hours: number;
  factor: number; // 교체일 가동률 계수. nextDayStart=true면 교체일 생산 0
  nextDayStart: boolean; // PET1 Full set: 익일 가동
}

export interface Settings {
  weekendFactor: number; // Q5, 기본 0.8
  dailyChangeoverLimit: number; // Q4, 공장 단위 하루 최대 교체 횟수, 기본 3
  defaultChangeoverType: ChangeoverKind; // 교체유형 미입력 시 적용, 기본 'BM'
  siloLowerBoundTon: number; // Q2, 기본 30
  siloUpperBoundTon: number; // 160 (40 + 120)
  leadTimeDays: number; // 기본 30
  receiptUnitTon: number; // 1회 입고 단위, 기본 22
  surplusDays: number; // 과잉 기준 일수, 기본 14
}

export interface PriorityWeights {
  dueSoon: number; // 납기 임박
  majorCustomer: number; // 대형 거래선
  belowSafety: number; // 안전재고 미달
}

// ---------------------------------------------------------------------------
// 계획 (FR-02, 5.2)
// ---------------------------------------------------------------------------
export interface PlanCell {
  lineId: string;
  date: ISODate;
  productId: string | null; // null = 빈 셀(계획 없음)
  qty: number | null; // null이면 예상 생산량 사용
  changeoverType: ChangeoverType;
  memo?: string | null;
}

export interface Downtime {
  lineId: string;
  startDate: ISODate; // inclusive
  endDate: ISODate; // inclusive
  reason: string;
}

// ---------------------------------------------------------------------------
// 수요·재고 (FR-05, 5.3)
// ---------------------------------------------------------------------------
export interface Shipment {
  productId: string;
  customerId: string | null;
  isMajorCustomer: boolean;
  shipDate: ISODate;
  qty: number;
}

export interface InventorySnapshot {
  productId: string;
  asOfDate: ISODate;
  qty: number;
}

// ---------------------------------------------------------------------------
// 씨벌크 원료 (FR-14~17, 5.4)
// ---------------------------------------------------------------------------
export interface SiloMeasurement {
  date: ISODate;
  siloCode: string; // 'S55' | 'S150'
  measuredTon: number;
}

export interface SiloReceipt {
  id: string;
  supplier: string;
  plannedDate: ISODate;
  qtyTon: number;
  status: "planned" | "received" | "cancelled";
}

/** 계획 대상이 아닌 사출 설비(A1, 2공장 P1~4)의 고정 사용량 (Q9) */
export interface ExternalUsage {
  label: string;
  factoryCode: string;
  weekdayTon: number;
  weekendTon: number;
}

/** 제품배치 운용안의 월별 물량. 3~6주 사용량 추정에 사용 (FR-15) */
export interface MonthlyOperationPlan {
  productId: string;
  lineId: string;
  yearMonth: YearMonth;
  qty: number;
  workingDays: number;
}

// ---------------------------------------------------------------------------
// 엔진 입력
// ---------------------------------------------------------------------------
export interface EngineInput {
  /** 계획 시작일(목요일) */
  periodStart: ISODate;
  /** 계획 일수, 기본 15 */
  periodDays: number;
  /** 사일로 예측 일수, 기본 42 (6주) */
  horizonDays: number;

  lines: Line[];
  products: Product[];
  allowedMolds: AllowedMold[];
  capacities: LineProductCapacity[];
  changeoverCoefficients: ChangeoverCoefficient[];
  settings: Settings;
  priorityWeights: PriorityWeights;

  cells: PlanCell[];
  downtimes: Downtime[];

  shipments: Shipment[];
  inventory: InventorySnapshot[];

  siloMeasurements: SiloMeasurement[];
  siloReceipts: SiloReceipt[];
  externalUsage: ExternalUsage[];
  monthlyPlans: MonthlyOperationPlan[];
}

// ---------------------------------------------------------------------------
// 엔진 출력
// ---------------------------------------------------------------------------

/** 계산 근거 한 줄 (NFR-04). 화면에서 펼쳐 보여준다 */
export interface ExplainStep {
  label: string; // '일일 Capa', '교체 계수(B/M)', '주말 계수', '가동 불가', '입력 수량 우선'
  value: number | string;
  note?: string;
}

export type ViolationCode =
  | "MOLD_NOT_ALLOWED" // FR-07 ① 허용 목록 밖 금형
  | "CHANGEOVER_LIMIT" // FR-07 ② 하루 교체 횟수 초과(공장 단위)
  | "DOWNTIME_ASSIGNED" // FR-07 ③ 가동 불가일 배치
  | "CHANGEOVER_DEFAULTED" // 주의: 제품이 바뀌었는데 교체유형 미입력 → 기본값 적용
  | "UNKNOWN_PRODUCT"; // 주의: 기준정보에 없는 제품 id

export interface Violation {
  code: ViolationCode;
  severity: "error" | "notice";
  lineId: string | null;
  date: ISODate;
  productId: string | null;
  message: string; // 한국어 설명
  detail?: Record<string, number | string | null>;
}

export interface CellResult {
  lineId: string;
  date: ISODate;
  productId: string | null;
  productName: string | null;
  plannedQty: number | null; // 입력 수량
  expectedQty: number; // 예상 생산량(입력 수량 우선)
  isDowntime: boolean;
  isWeekend: boolean;
  /** 입력값 또는 기본값이 적용된 실제 교체유형 */
  effectiveChangeover: ChangeoverType;
  changeoverDefaulted: boolean;
  explain: ExplainStep[];
  violations: ViolationCode[];
}

export type SupplyStatus = "shortage" | "warning" | "surplus" | "no_shipment" | "ok";

export interface SupplyDay {
  date: ISODate;
  opening: number;
  production: number;
  shipment: number;
  closing: number;
  status: SupplyStatus;
}

export interface PriorityBreakdown {
  dueSoon: number;
  majorCustomer: number;
  belowSafety: number;
  total: number;
}

export interface ProductSupplyRow {
  productId: string;
  productName: string;
  openingStock: number;
  safetyStock: number;
  days: SupplyDay[];
  firstShortageDate: ISODate | null;
  firstShortageQty: number | null; // 음수 재고의 절대값
  firstWarningDate: ISODate | null;
  hasMajorCustomer: boolean;
  totalShipment: number;
  status: SupplyStatus; // 기간 전체 요약 상태(가장 심각한 것)
  priority: PriorityBreakdown;
}

export type SiloStatus = "ok" | "below_lower" | "above_upper";

export interface SiloDay {
  date: ISODate;
  opening: number;
  receipt: number;
  usageF1: number; // 1공장 (계획 기반 + 외부 고정)
  usageF2: number; // 2공장 (외부 고정)
  usageTotal: number;
  closing: number;
  basis: "plan" | "estimate"; // 1~2주 계획 / 3~6주 추정
  status: SiloStatus;
  explain: ExplainStep[];
}

export interface OrderRecommendation {
  needed: boolean;
  orderBy: ISODate | null; // 발주 기한 = 최초 하한 미달일 − 리드타임
  firstBelowDate: ISODate | null;
  minProjected: number | null; // 리드타임 구간 내 최저 예상 재고
  qtyTon: number; // 입고 단위로 올림한 추천량
  avgDailyUsageWeekday: number;
  avgDailyUsageWeekend: number;
  explain: string[];
}

export interface EngineResult {
  periodDates: ISODate[];
  horizonDates: ISODate[];
  cells: CellResult[];
  violations: Violation[];
  supply: ProductSupplyRow[];
  silo: SiloDay[];
  order: OrderRecommendation;
  computedMs: number;
}

// ---------------------------------------------------------------------------
// Rev 비교 (FR-04)
// ---------------------------------------------------------------------------
export interface CellDiff {
  lineId: string;
  date: ISODate;
  kind: "added" | "removed" | "changed";
  before: PlanCell | null;
  after: PlanCell | null;
  changedFields: Array<"productId" | "qty" | "changeoverType" | "memo">;
}
