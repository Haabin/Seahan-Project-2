/**
 * 회의 확인 반영: PET1 FULL 6h(익일가동 끔) / BM 2h, 가동률은 기준표 둘째 자리 내림
 * 팀원 fixtures(PET1 FULL 익일가동 켬, BM 3h)는 바꾸지 않고, 이 파일에서 계수만 덮어써 검사한다.
 */
import { describe, expect, it } from "vitest";
import { diffCells, recalc } from "@/lib/engine";
import { badgeLabels, coefficientFactor, describeCellTime, SHORT_LABEL_LEGEND } from "@/lib/engine/changeover";
import type { ChangeoverCoefficient, EngineInput } from "@/lib/engine/types";
import { cell, COEFFICIENTS, makeInput, PERIOD_START, SAT } from "./fixtures";

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

const D2 = "2026-11-13";
const at = (r: ReturnType<typeof recalc>, date: string) => r.cells.find((c) => c.lineId === "L1" && c.date === date)!;

describe("비가동 시간 직접 입력 (plan_cells.lost_hours_override)", () => {
  it("직접 입력 3h 가 교체 기준 시간(BM 2h)보다 우선: 가동률 0.87, 예상 87,000", () => {
    const c = first(recalc(meetingInput({ cells: [cell("L1", PERIOD_START, "P1", { changeoverType: "BM" })].map((x) => ({ ...x, lostHoursOverride: 3 })) })));
    expect(c.expectedQty).toBe(87_000);
    expect(c.lostHours).toBe(3);
    expect(c.lostHoursSource).toBe("override");
    expect(c.standardLostHours).toBe(2);
    expect(c.effectiveChangeover).toBe("BM");
    const step = c.explain.find((e) => e.label === "비가동 시간(직접 입력)");
    expect(step?.value).toBe(0.87);
    expect(step?.note).toContain("비가동 3h → 가동률 0.87 (기준표)");
    expect(step?.note).toContain("기준 2h 대신");
    expect(c.explain.some((e) => e.label.startsWith("교체 계수"))).toBe(false); // 더하지 않고 대체
  });

  it("비워 두면 교체 기준 시간(BM 2h → 0.91)", () => {
    const c = first(recalc(meetingInput({ cells: [cell("L1", PERIOD_START, "P1", { changeoverType: "BM" })] })));
    expect(c.expectedQty).toBe(91_000);
    expect(c.lostHours).toBe(2);
    expect(c.lostHoursSource).toBe("standard");
  });

  it("교체 없는 칸에도 입력: 점검 3h → 87,000, 배지 '비가동 3h'", () => {
    const r = recalc(meetingInput({ cells: [cell("L1", PERIOD_START, "P1"), { ...cell("L1", D2, "P1"), lostHoursOverride: 3 }] }));
    const c = at(r, D2);
    expect(c.effectiveChangeover).toBe("NONE");
    expect(c.expectedQty).toBe(87_000);
    const info = describeCellTime({ effectiveChangeover: "NONE", defaulted: false, isDowntime: false, coefficient: null, overrideHours: 3 });
    expect(badgeLabels(info).short).toBe("비가동 3h");
    expect(info.availableHours).toBe(21);
    expect(badgeLabels(info).title).toContain("직접 입력: 3h");
  });

  it("배지 글자는 기준 시간 칸과 같고, 마우스를 올렸을 때만 '직접 입력: 3h (기준 2h)'", () => {
    const std = describeCellTime({ effectiveChangeover: "BM", defaulted: false, isDowntime: false, coefficient: { hours: 3, nextDayStart: false } });
    const ovr = describeCellTime({ effectiveChangeover: "BM", defaulted: false, isDowntime: false, coefficient: { hours: 2, nextDayStart: false }, overrideHours: 3 });
    expect(badgeLabels(ovr).short).toBe(badgeLabels(std).short); // 'B/M 3h'
    expect(badgeLabels(ovr).full).toBe(badgeLabels(std).full);
    expect(badgeLabels(ovr).short).toBe("B/M 3h");
    expect(badgeLabels(ovr).title).toContain("직접 입력: 3h (기준 2h)");
    expect(badgeLabels(std).title).not.toContain("직접 입력");
  });

  it("직접 입력은 익일가동보다도 우선 (팀원 fixtures 의 FULL 익일가동 + 입력 6h → 75,000)", () => {
    const c = first(recalc(makeInput({ cells: [{ ...cell("L1", PERIOD_START, "P1", { changeoverType: "FULL" }), lostHoursOverride: 6 }] })));
    expect(c.expectedQty).toBe(75_000);
    expect(c.explain.find((e) => e.label === "비가동 시간(직접 입력)")?.note).toContain("기준 익일가동 대신");
  });

  it("0h → 1.00 (교체 칸이어도 손실 없음), 24h → 0", () => {
    const zero = first(recalc(meetingInput({ cells: [{ ...cell("L1", PERIOD_START, "P1", { changeoverType: "FULL" }), lostHoursOverride: 0 }] })));
    expect(zero.expectedQty).toBe(100_000);
    const full = first(recalc(meetingInput({ cells: [{ ...cell("L1", PERIOD_START, "P1"), lostHoursOverride: 24 }] })));
    expect(full.expectedQty).toBe(0);
  });

  it("10h → 기준표 밖 (24 − 10)/24 = 0.58 + '기준표 밖' 주의, 확정을 막는 오류는 아님", () => {
    const r = recalc(meetingInput({ cells: [{ ...cell("L1", PERIOD_START, "P1"), lostHoursOverride: 10 }] }));
    const c = first(r);
    expect(c.expectedQty).toBe(58_000);
    expect(c.outsideFactorTable).toBe(true);
    expect(c.violations).toContain("OUTSIDE_FACTOR_TABLE");
    const v = r.violations.find((x) => x.code === "OUTSIDE_FACTOR_TABLE");
    expect(v?.severity).toBe("notice");
    expect(v?.message).toContain("기준표 밖");
    expect(c.explain.find((e) => e.label === "비가동 시간(직접 입력)")?.note).toContain("기준표 밖 → 계산값");
  });

  it("주말 계수·입력 수량 우선 등 기존 규칙은 그대로", () => {
    const sat = recalc(meetingInput({ cells: [{ ...cell("L1", SAT, "P1"), lostHoursOverride: 3 }] }));
    expect(at(sat, SAT).expectedQty).toBe(69_600); // 100,000 × 0.87 × 0.8
    const qty = first(recalc(meetingInput({ cells: [{ ...cell("L1", PERIOD_START, "P1", { qty: 50_000 }), lostHoursOverride: 3 }] })));
    expect(qty.expectedQty).toBe(50_000);
  });

  it("Rev 비교에서 비가동 시간 변경을 잡는다", () => {
    const before = [cell("L1", PERIOD_START, "P1")];
    const after = [{ ...cell("L1", PERIOD_START, "P1"), lostHoursOverride: 3 }];
    expect(diffCells(before, after)[0]?.changedFields).toEqual(["lostHoursOverride"]);
  });
});
