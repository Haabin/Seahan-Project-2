/**
 * 비가동(교체·정지) 시간 → 가동률 계수.
 * 가동률은 공식 (24 − h) / 24 가 아니라 현행 기준표(주간계획표 '생산1_1STAGE' I65:J73)에서 찾는다.
 *  - 기준표 원본 값은 settings.changeover_factor_table 에 그대로 저장하고, 계산에는 소수 둘째 자리 내림 값을 쓴다
 *    (0.915 → 0.91, 0.875 → 0.87, 0.625 → 0.62). 내림은 정수 연산으로 해 부동소수 오차가 없다.
 *  - 0h → 1.00 (손실 없음)
 *  - 표에 없는 시간(10h~24h 등) → (24 − h) / 24 를 둘째 자리 내림 + "기준표 밖" 주의. 24h → 0
 *  - 시간은 0~24 정수만 쓴다(기준표가 1시간 단위)
 * 교체 손실 계수 화면의 자동 계산, 가동률 다시 계산, 칸별 비가동 시간 직접 입력이 모두 rateFromLostHours() 를 쓴다.
 * 익일가동(nextDayStart) 행은 시간으로 계산하지 않고 교체일 생산 0 (계수 0) 을 유지한다.
 */
import type { ChangeoverCoefficient, ChangeoverType } from "./types";

/**
 * 화면 표시용 현장 용어. 엔진 근거 문구(production.ts CHANGEOVER_LABEL: 'B/M', 'Full set')는
 * 기존 테스트가 검사하므로 그대로 두고, 화면에서만 이 라벨을 쓴다.
 */
const SITE_LABEL: Record<ChangeoverType, string> = { NONE: "교체 없음", BM: "B/M교체", FULL: "FULLSET교체" };
export function changeoverSiteLabel(type: ChangeoverType): string {
  return SITE_LABEL[type];
}

export const HOURS_PER_DAY = 24;

/** 기준표 한 행: 비가동 시간(h) → 가동률 원본 값 */
export interface FactorTableRow {
  hours: number;
  rate: number;
}

/** 기준표 기본값 (주간계획표 I65:J73 원본). settings 에 행이 없을 때 쓴다 */
export const DEFAULT_FACTOR_TABLE: readonly FactorTableRow[] = [
  { hours: 1, rate: 0.96 },
  { hours: 2, rate: 0.915 },
  { hours: 3, rate: 0.875 },
  { hours: 4, rate: 0.83 },
  { hours: 5, rate: 0.79 },
  { hours: 6, rate: 0.75 },
  { hours: 7, rate: 0.71 },
  { hours: 8, rate: 0.67 },
  { hours: 9, rate: 0.625 },
];

/**
 * 소수 둘째 자리 내림 (오차 없음). 값을 100만 분의 1 단위 정수로 바꾼 뒤 정수 나눗셈으로 자른다.
 * 0.83 × 100 = 82.999… 처럼 부동소수 곱셈 결과를 내리는 일이 없다.
 */
export function floorRate2(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  if (rate >= 1) return 1;
  const micro = Math.round(rate * 1_000_000); // 0.83 → 830000
  return Math.floor(micro / 10_000) / 100; // 830000 / 10000 = 83 → 0.83
}

/** 시간 입력 정리: 0~24 정수. 숫자가 아니면 0 */
export function normalizeLostHours(hours: number): number {
  if (!Number.isFinite(hours)) return 0;
  return Math.min(HOURS_PER_DAY, Math.max(0, Math.round(hours)));
}

export type RateSource = "none" | "table" | "outside";

export interface LostHoursRate {
  /** 정리된 비가동 시간(0~24 정수) */
  hours: number;
  /** 계산에 쓰는 가동률 (둘째 자리 내림) */
  factor: number;
  /** none: 0h(손실 없음) · table: 기준표 · outside: 기준표 밖 → (24 − h)/24 계산값 */
  source: RateSource;
  /** 기준표 원본 값 (기준표에서 찾은 경우만) */
  tableRate: number | null;
}

/** 비가동 시간 → 가동률. 모든 화면·계산이 이 함수 하나를 쓴다 */
export function rateFromLostHours(hours: number, table: readonly FactorTableRow[] = DEFAULT_FACTOR_TABLE): LostHoursRate {
  const h = normalizeLostHours(hours);
  if (h === 0) return { hours: 0, factor: 1, source: "none", tableRate: null };
  const row = table.find((r) => r.hours === h);
  if (row) return { hours: h, factor: floorRate2(row.rate), source: "table", tableRate: row.rate };
  // 기준표 밖: (24 − h) / 24 를 정수 연산으로 둘째 자리 내림 (24h → 0)
  const factor = Math.floor(((HOURS_PER_DAY - h) * 100) / HOURS_PER_DAY) / 100;
  return { hours: h, factor, source: "outside", tableRate: null };
}

/** 가동률 숫자만 필요할 때 */
export function factorFromHours(hours: number, table: readonly FactorTableRow[] = DEFAULT_FACTOR_TABLE): number {
  return rateFromLostHours(hours, table).factor;
}

/** 근거 문구: '비가동 3h → 가동률 0.87 (기준표)' / '비가동 10h → 가동률 0.58 (기준표 밖 → 계산값)' */
export function describeRate(r: LostHoursRate): string {
  const src = r.source === "table" ? "기준표" : r.source === "outside" ? "기준표 밖 → 계산값" : "손실 없음";
  return `비가동 ${r.hours}h → 가동률 ${r.factor.toFixed(2)} (${src})`;
}

/** 설정값(jsonb) → 기준표. 형식이 틀리면 기본 기준표 */
export function parseFactorTable(value: unknown): FactorTableRow[] {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [...DEFAULT_FACTOR_TABLE];
    }
  }
  if (!Array.isArray(v)) return [...DEFAULT_FACTOR_TABLE];
  const rows: FactorTableRow[] = [];
  for (const item of v) {
    const hours = Number((item as FactorTableRow)?.hours);
    const rate = Number((item as FactorTableRow)?.rate);
    if (!Number.isInteger(hours) || hours < 1 || hours > HOURS_PER_DAY || !Number.isFinite(rate) || rate < 0 || rate > 1) return [...DEFAULT_FACTOR_TABLE];
    if (rows.some((r) => r.hours === hours)) return [...DEFAULT_FACTOR_TABLE];
    rows.push({ hours, rate });
  }
  return rows.length ? rows.sort((a, b) => a.hours - b.hours) : [...DEFAULT_FACTOR_TABLE];
}

/** 계수표 한 행의 가동률. 익일가동이면 시간과 무관하게 0 (교체일 생산 0) */
export function coefficientFactor(
  c: Pick<ChangeoverCoefficient, "hours" | "nextDayStart">,
  /** 문자열은 예전 반올림 방식 인자(0004 이전 호출 호환) → 무시하고 기본 기준표 */
  table: readonly FactorTableRow[] | string = DEFAULT_FACTOR_TABLE,
): number {
  if (c.nextDayStart) return 0;
  return factorFromHours(c.hours, typeof table === "string" ? DEFAULT_FACTOR_TABLE : table);
}

/** 저장된 계수가 현재 기준표로 계산한 값과 어긋나는지 */
export function isFactorOutOfSync(c: ChangeoverCoefficient, table: readonly FactorTableRow[] = DEFAULT_FACTOR_TABLE): boolean {
  return Math.abs(c.factor - coefficientFactor(c, table)) > 1e-6;
}

// ---------------------------------------------------------------------------
// 간트 셀 표시: 교체 종류 · 소요시간 · 생산 가능시간 (화면 전용, 엔진 계산값은 바꾸지 않음)
// ---------------------------------------------------------------------------
export interface CellTimeInfo {
  /** 교체 종류 (NONE 이면 교체 없음) */
  changeover: ChangeoverType;
  /** 화면 라벨: 'B/M교체' / 'FULLSET교체' / '교체 없음' / '가동 불가' */
  label: string;
  /** 교체·정지로 생산하지 못하는 시간(h). 계수 정보가 없으면 null */
  lostHours: number | null;
  /** 생산 가능시간 = 24 − 손실 시간(h). 계수 정보가 없으면 null */
  availableHours: number | null;
  nextDayStart: boolean;
  /** 교체유형 미입력 → 기본값 적용 */
  defaulted: boolean;
  isDowntime: boolean;
  /** 셀에 그대로 쓰는 한 줄 요약. 예: 'B/M교체 3h · 가동 21h' */
  text: string;
}

function fmtHours(h: number): string {
  return `${Number.isInteger(h) ? h : Math.round(h * 10) / 10}h`;
}

export function describeCellTime(args: {
  effectiveChangeover: ChangeoverType;
  defaulted: boolean;
  isDowntime: boolean;
  coefficient: Pick<ChangeoverCoefficient, "hours" | "nextDayStart"> | null;
}): CellTimeInfo {
  const { effectiveChangeover, defaulted, isDowntime, coefficient } = args;
  if (isDowntime) {
    return {
      changeover: effectiveChangeover,
      label: "가동 불가",
      lostHours: HOURS_PER_DAY,
      availableHours: 0,
      nextDayStart: false,
      defaulted: false,
      isDowntime: true,
      text: "가동 불가 · 가동 0h",
    };
  }
  if (effectiveChangeover === "NONE") {
    return {
      changeover: "NONE",
      label: SITE_LABEL.NONE,
      lostHours: 0,
      availableHours: HOURS_PER_DAY,
      nextDayStart: false,
      defaulted: false,
      isDowntime: false,
      text: `가동 ${fmtHours(HOURS_PER_DAY)}`,
    };
  }
  const label = SITE_LABEL[effectiveChangeover];
  const suffix = defaulted ? "(기본값)" : "";
  if (!coefficient) {
    return {
      changeover: effectiveChangeover,
      label,
      lostHours: null,
      availableHours: null,
      nextDayStart: false,
      defaulted,
      isDowntime: false,
      text: `${label}${suffix} · 시간 정보 없음`,
    };
  }
  if (coefficient.nextDayStart) {
    return {
      changeover: effectiveChangeover,
      label,
      lostHours: HOURS_PER_DAY,
      availableHours: 0,
      nextDayStart: true,
      defaulted,
      isDowntime: false,
      text: `${label}${suffix} · 익일가동 · 가동 0h`,
    };
  }
  const lost = Math.min(HOURS_PER_DAY, Math.max(0, coefficient.hours));
  const available = HOURS_PER_DAY - lost;
  return {
    changeover: effectiveChangeover,
    label,
    lostHours: lost,
    availableHours: available,
    nextDayStart: false,
    defaulted,
    isDowntime: false,
    text: `${label}${suffix} ${fmtHours(lost)} · 가동 ${fmtHours(available)}`,
  };
}

// ---------------------------------------------------------------------------
// 교체 배지 표기: 좁은 칸은 짧은 표기, 넓은 칸은 전체 용어, 마우스를 올리면 전체 설명
// ---------------------------------------------------------------------------
const SHORT_LABEL: Record<ChangeoverType, string> = { NONE: "", BM: "B/M", FULL: "FULL" };

/** 범례에 그대로 쓰는 짧은 표기 설명 */
export const SHORT_LABEL_LEGEND: readonly (readonly [string, string])[] = [
  ["B/M", "B/M교체"],
  ["FULL", "FULLSET교체"],
  ["익일", "익일가동 (교체일 생산 0)"],
  ["?", "교체유형 미입력 · 기본값 적용"],
  ["3h", "교체 소요시간"],
];

export interface BadgeLabels {
  /** 좁은 칸: 'B/M 3h', 'FULL 익일', 'B/M? 3h', 시간 정보 없음 'B/M –' */
  short: string;
  /** 넓은 칸: 'B/M교체 3h', 'FULLSET교체 익일가동', 'B/M교체(기본값) 3h' */
  full: string;
  /** 마우스를 올렸을 때: 전체 용어 + 생산 가능시간 + 기본값 적용 설명 */
  title: string;
}

export function badgeLabels(info: CellTimeInfo, defaultLabel?: string): BadgeLabels {
  if (info.isDowntime) return { short: "정지", full: "가동 불가", title: "가동 불가 · 가동 0h" };
  if (info.changeover === "NONE") return { short: "", full: "", title: info.text };
  const q = info.defaulted ? "?" : "";
  const shortHours = info.nextDayStart ? "익일" : info.lostHours != null ? fmtHours(info.lostHours) : "–";
  const fullHours = info.nextDayStart ? "익일가동" : info.lostHours != null ? fmtHours(info.lostHours) : "시간 정보 없음";
  const avail = info.availableHours != null ? ` · 가동 ${fmtHours(info.availableHours)}` : "";
  const titleMain = info.nextDayStart
    ? `${info.label} · 익일가동${avail} (교체일 생산 0)`
    : `${info.label} ${fullHours}${avail}`;
  const titleDefault = info.defaulted ? `\n교체유형 미입력 → 기본값(${defaultLabel ?? info.label}) 적용` : "";
  return {
    short: `${SHORT_LABEL[info.changeover]}${q} ${shortHours}`,
    full: `${info.label}${info.defaulted ? "(기본값)" : ""} ${fullHours}`,
    title: titleMain + titleDefault,
  };
}

// ---------------------------------------------------------------------------
// 셀 편집 패널 표시
// ---------------------------------------------------------------------------
/**
 * 계산 근거 값 표시. 정수(Capa·수량)는 천 단위 쉼표, 소수(교체 계수 0.87·주말 계수 0.8)는 그대로.
 * 기존 화면은 모든 숫자를 정수로 반올림해 0.87 이 '1' 로 보였다.
 */
export function fmtExplainValue(v: number): string {
  if (!Number.isFinite(v)) return "–";
  if (Number.isInteger(v)) return v.toLocaleString("ko-KR");
  return v.toLocaleString("ko-KR", { maximumFractionDigits: 3 });
}

/**
 * 교체 유형 선택칸의 '교체 없음(NONE)' 항목 라벨.
 * 제품이 바뀌었는데 교체유형이 비어 있어 기본값이 적용된 칸이면 '미입력 (기본값 B/M교체 적용)'.
 * 저장 값은 그대로 NONE.
 */
export function noneOptionLabel(defaulted: boolean, effective: ChangeoverType): string {
  if (defaulted && effective !== "NONE") return `미입력 (기본값 ${SITE_LABEL[effective]} 적용)`;
  return SITE_LABEL.NONE;
}
