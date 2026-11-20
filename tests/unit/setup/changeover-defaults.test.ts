import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseChangeoverDefaults, planCoefficientChanges } from "@/lib/setup/changeover-defaults";
import type { ChangeoverCoefficient } from "@/lib/engine/types";

const defaults = parseChangeoverDefaults(JSON.parse(readFileSync(join(process.cwd(), "config", "changeover-defaults.json"), "utf8")));

/** 0001_init.sql 기본값 (예전 버전으로 세팅한 DB) */
const OLD: ChangeoverCoefficient[] = [
  { processType: "PET1_1STAGE", changeoverType: "BM", hours: 3, factor: 0.87, nextDayStart: false },
  { processType: "PET1_1STAGE", changeoverType: "FULL", hours: 0, factor: 0, nextDayStart: true },
  { processType: "PE", changeoverType: "BM", hours: 6, factor: 0.75, nextDayStart: false },
];

describe("config/changeover-defaults.json", () => {
  it("PET1 BM 2h, FULL 6h + 익일가동 끔만 있다 (PET2·PE 없음, 가동률 없음)", () => {
    expect(defaults).toEqual([
      { processType: "PET1_1STAGE", changeoverType: "BM", hours: 2, nextDayStart: false },
      { processType: "PET1_1STAGE", changeoverType: "FULL", hours: 6, nextDayStart: false },
    ]);
  });

  it("기준표 변환으로 BM 0.91, FULL 0.75", () => {
    const plan = planCoefficientChanges(OLD, defaults);
    expect(plan.map((c) => c.target)).toEqual([
      { hours: 2, nextDayStart: false, factor: 0.91 },
      { hours: 6, nextDayStart: false, factor: 0.75 },
    ]);
    expect(plan.every((c) => c.changed)).toBe(true);
    expect(plan[1].current).toEqual({ hours: 0, factor: 0, nextDayStart: true });
  });

  it("이미 같은 값이면 바꿀 것 없음(건너뜀)", () => {
    const same: ChangeoverCoefficient[] = [
      { processType: "PET1_1STAGE", changeoverType: "BM", hours: 2, factor: 0.91, nextDayStart: false },
      { processType: "PET1_1STAGE", changeoverType: "FULL", hours: 6, factor: 0.75, nextDayStart: false },
    ];
    expect(planCoefficientChanges(same, defaults).some((c) => c.changed)).toBe(false);
  });

  it("시간·익일가동이 같아도 저장 가동률이 다르면 바꾼다", () => {
    const stale: ChangeoverCoefficient[] = [
      { processType: "PET1_1STAGE", changeoverType: "BM", hours: 2, factor: 0.92, nextDayStart: false },
      { processType: "PET1_1STAGE", changeoverType: "FULL", hours: 6, factor: 0.75, nextDayStart: false },
    ];
    expect(planCoefficientChanges(stale, defaults).map((c) => c.changed)).toEqual([true, false]);
  });

  it("형식이 틀린 설정 파일은 거부 (소수 시간, 중복)", () => {
    expect(() => parseChangeoverDefaults({ coefficients: [{ processType: "PET1_1STAGE", changeoverType: "BM", hours: 2.5, nextDayStart: false }] })).toThrow();
    const dup = { processType: "PET1_1STAGE", changeoverType: "BM", hours: 2, nextDayStart: false };
    expect(() => parseChangeoverDefaults({ coefficients: [dup, dup] })).toThrow();
  });
});
