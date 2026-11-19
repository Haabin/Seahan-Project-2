/**
 * 교체 계수 기본값 설정 파일(config/changeover-defaults.json) → 개발 DB 반영 계획 (순수 함수, DB 접근 없음).
 * 가동률은 파일에 두지 않고 기준표 변환(coefficientFactor)으로 계산한다.
 */
import { z } from "zod";
import { coefficientFactor, DEFAULT_FACTOR_TABLE, HOURS_PER_DAY, type FactorTableRow } from "../engine/changeover";
import type { ChangeoverCoefficient } from "../engine/types";

const entrySchema = z.object({
  processType: z.enum(["PET1_1STAGE", "PET2_INJ", "PET2_BLOW", "PE"]),
  changeoverType: z.enum(["BM", "FULL"]),
  hours: z.number().int().min(0).max(HOURS_PER_DAY),
  nextDayStart: z.boolean(),
});

const fileSchema = z.object({
  description: z.string().optional(),
  coefficients: z
    .array(entrySchema)
    .min(1)
    .refine((rows) => new Set(rows.map((r) => `${r.processType}|${r.changeoverType}`)).size === rows.length, "같은 공정·교체유형이 두 번 있습니다"),
});

export type ChangeoverDefault = z.infer<typeof entrySchema>;

export function parseChangeoverDefaults(json: unknown): ChangeoverDefault[] {
  return fileSchema.parse(json).coefficients;
}

export interface CoefficientChange {
  processType: ChangeoverCoefficient["processType"];
  changeoverType: ChangeoverCoefficient["changeoverType"];
  /** DB 현재 값 (행이 없으면 null) */
  current: Pick<ChangeoverCoefficient, "hours" | "factor" | "nextDayStart"> | null;
  /** 바꿀 값 (가동률은 기준표로 계산) */
  target: Pick<ChangeoverCoefficient, "hours" | "factor" | "nextDayStart">;
  changed: boolean;
}

/** 설정 파일 값과 DB 현재 값을 비교해 바꿀 목록을 만든다. 같으면 changed=false */
export function planCoefficientChanges(
  current: ChangeoverCoefficient[],
  defaults: ChangeoverDefault[],
  table: readonly FactorTableRow[] = DEFAULT_FACTOR_TABLE,
): CoefficientChange[] {
  return defaults.map((d) => {
    const cur = current.find((c) => c.processType === d.processType && c.changeoverType === d.changeoverType) ?? null;
    const target = { hours: d.hours, nextDayStart: d.nextDayStart, factor: coefficientFactor(d, table) };
    const changed =
      !cur || Number(cur.hours) !== target.hours || cur.nextDayStart !== target.nextDayStart || Math.abs(Number(cur.factor) - target.factor) > 1e-6;
    return {
      processType: d.processType,
      changeoverType: d.changeoverType,
      current: cur ? { hours: Number(cur.hours), factor: Number(cur.factor), nextDayStart: cur.nextDayStart } : null,
      target,
      changed,
    };
  });
}
