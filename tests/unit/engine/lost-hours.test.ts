/**
 * 회의 확인 반영: PET1 FULL 6h(익일가동 끔) / BM 2h, 가동률은 기준표 둘째 자리 내림
 * 팀원 fixtures(PET1 FULL 익일가동 켬, BM 3h)는 바꾸지 않고, 이 파일에서 계수만 덮어써 검사한다.
 */
import { describe, expect, it } from "vitest";
import { recalc } from "@/lib/engine";
import { badgeLabels, coefficientFactor, describeCellTime, SHORT_LABEL_LEGEND } from "@/lib/engine/changeover";
import type { ChangeoverCoefficient, EngineInput } from "@/lib/engine/types";
import { cell, COEFFICIENTS, makeInput, PERIOD_START } from "./fixtures";

/** 회의 확인 값으로 바꾼 PET1 계수 (가동률은 기준표로 계산) */
function meetingCoefficients(): ChangeoverCoefficient[] {
  return COEFFICIENTS.map((c) => {
    if (c.processType !== "PET1_1STAGE") return c;
    const hours = c.changeoverType === "FULL" ? 6 : 2;
    return { ...c, hours, nextDayStart: false, factor: coefficientFactor({ hours, nextDayStart: false }) };
  });
}

function meetingInput(overrides: Partial<EngineInput> = {}): EngineInput {
  return makeInput({ changeoverCoefficients: meetingCoefficients(), ...overrides });
}

const first = (r: ReturnType<typeof recalc>) => r.cells.find((c) => c.lineId === "L1" && c.date === PERIOD_START)!;

describe("PET1 교체 계수: 회의 확인 값", () => {
  it("FULL 6h(익일가동 끔) → 가동률 0.75, 예상 75,000 (하루 전체 손실 아님)", () => {
    const c = first(recalc(meetingInput({ cells: [cell("L1", PERIOD_START, "P1", { changeoverType: "FULL" })] })));
    expect(c.expectedQty).toBe(75_000);
    const step = c.explain.find((e) => e.label === "교체 계수(Full set)");
    expect(step?.value).toBe(0.75);
    expect(step?.note).toContain("교체 6시간 → ×0.75");
    expect(step?.note).toContain("기준표");
  });

  it("BM 2h → 가동률 0.91, 예상 91,000", () => {
    const c = first(recalc(meetingInput({ cells: [cell("L1", PERIOD_START, "P1", { changeoverType: "BM" })] })));
    expect(c.expectedQty).toBe(91_000);
  });

  it("배지는 'FULL 6h', 익일가동이 켜진 경우에만 'FULL 익일'", () => {
    const off = describeCellTime({ effectiveChangeover: "FULL", defaulted: false, isDowntime: false, coefficient: { hours: 6, nextDayStart: false } });
    expect(badgeLabels(off).short).toBe("FULL 6h");
    expect(badgeLabels(off).full).toBe("FULLSET교체 6h");
    expect(off.availableHours).toBe(18);
    const on = describeCellTime({ effectiveChangeover: "FULL", defaulted: false, isDowntime: false, coefficient: { hours: 6, nextDayStart: true } });
    expect(badgeLabels(on).short).toBe("FULL 익일");
    expect(SHORT_LABEL_LEGEND.find(([k]) => k === "익일")?.[1]).toContain("켜진");
  });
});
