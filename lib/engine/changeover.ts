/**
 * 교체 손실 시간 → 가동률 계수.
 * 현행 교체 기준표: 가동률 = (24 − 교체시간) / 24 를 반올림 방식(설정 changeover_factor_rounding)으로 맞춘다.
 *  - 기본 'floor2'(소수 둘째 자리 내림): 3h → 0.87, 2h → 0.91, 4h → 0.83, 6h → 0.75 (기준표 교체 칸 값과 같음)
 *  - 익일가동(nextDayStart) 행은 시간으로 계산하지 않고 교체일 생산 0 (계수 0) 을 유지한다.
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

export const FACTOR_ROUNDING_MODES = ["floor2", "round2", "round3", "none"] as const;
export type FactorRounding = (typeof FACTOR_ROUNDING_MODES)[number];
export const DEFAULT_FACTOR_ROUNDING: FactorRounding = "floor2";

export const FACTOR_ROUNDING_LABEL: Record<FactorRounding, string> = {
  floor2: "소수 둘째 자리 내림 (기준표 방식)",
  round2: "소수 둘째 자리 반올림",
  round3: "소수 셋째 자리 반올림",
  none: "반올림 없음",
};

export const HOURS_PER_DAY = 24;

/** 설정값(jsonb) → 반올림 방식. 알 수 없는 값이면 기본값 */
export function parseFactorRounding(value: unknown): FactorRounding {
  const v = typeof value === "string" ? value.replace(/"/g, "").trim() : "";
  return (FACTOR_ROUNDING_MODES as readonly string[]).includes(v) ? (v as FactorRounding) : DEFAULT_FACTOR_ROUNDING;
}

// 부동소수 오차(예: 0.29 * 100 = 28.999…) 보정
const EPS = 1e-9;

/** 교체 손실 시간(h) → 가동률 계수 (0~1) */
export function factorFromHours(hours: number, rounding: FactorRounding = DEFAULT_FACTOR_ROUNDING): number {
  const h = Math.min(HOURS_PER_DAY, Math.max(0, Number.isFinite(hours) ? hours : 0));
  const raw = (HOURS_PER_DAY - h) / HOURS_PER_DAY;
  switch (rounding) {
    case "floor2":
      return Math.floor(raw * 100 + EPS) / 100;
    case "round2":
      return Math.round(raw * 100 + EPS) / 100;
    case "round3":
      return Math.round(raw * 1000 + EPS) / 1000;
    case "none":
      return raw;
  }
}

/** 계수표 한 행의 가동률. 익일가동이면 시간과 무관하게 0 (교체일 생산 0) */
export function coefficientFactor(
  c: Pick<ChangeoverCoefficient, "hours" | "nextDayStart">,
  rounding: FactorRounding = DEFAULT_FACTOR_ROUNDING,
): number {
  if (c.nextDayStart) return 0;
  return factorFromHours(c.hours, rounding);
}

/** 저장된 계수가 현재 규칙으로 계산한 값과 어긋나는지 */
export function isFactorOutOfSync(c: ChangeoverCoefficient, rounding: FactorRounding = DEFAULT_FACTOR_ROUNDING): boolean {
  return Math.abs(c.factor - coefficientFactor(c, rounding)) > 1e-6;
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
