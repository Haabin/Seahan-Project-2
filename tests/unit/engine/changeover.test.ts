import { describe, expect, it } from "vitest";
import { recalc } from "@/lib/engine";
import {
  changeoverSiteLabel,
  coefficientFactor,
  describeCellTime,
  DEFAULT_FACTOR_ROUNDING,
  factorFromHours,
  isFactorOutOfSync,
  parseFactorRounding,
} from "@/lib/engine/changeover";
import type { ChangeoverCoefficient } from "@/lib/engine/types";
import { cell, COEFFICIENTS, makeInput } from "./fixtures";

describe("교체 시간 → 가동률 (24 − h) / 24", () => {
  it("기본 반올림은 소수 둘째 자리 내림", () => {
    expect(DEFAULT_FACTOR_ROUNDING).toBe("floor2");
  });

  it("기본(floor2)으로 현행 계수표 값을 그대로 재현: 3h 0.87, 2h 0.91, 4h 0.83, 6h 0.75", () => {
    expect(factorFromHours(3)).toBe(0.87);
    expect(factorFromHours(2)).toBe(0.91);
    expect(factorFromHours(4)).toBe(0.83);
    expect(factorFromHours(6)).toBe(0.75);
  });

  it("기존 계수표(익일가동 제외)의 저장 계수가 모두 시간 계산값과 일치", () => {
    for (const c of COEFFICIENTS) {
      expect(isFactorOutOfSync(c)).toBe(false);
    }
  });

  it("반올림 방식 설정: round2 / round3 / none", () => {
    expect(factorFromHours(3, "round2")).toBe(0.88);
    expect(factorFromHours(3, "round3")).toBe(0.875);
    expect(factorFromHours(1, "round2")).toBe(0.96);
    expect(factorFromHours(7, "round2")).toBe(0.71);
    expect(factorFromHours(9, "none")).toBe(0.625);
    expect(factorFromHours(1, "none")).toBeCloseTo(23 / 24, 10);
  });

  it("범위 밖 시간은 0~24로 자름", () => {
    expect(factorFromHours(-2)).toBe(1);
    expect(factorFromHours(0)).toBe(1);
    expect(factorFromHours(24)).toBe(0);
    expect(factorFromHours(30)).toBe(0);
    expect(factorFromHours(Number.NaN)).toBe(1);
  });

  it("설정값 파싱: 알 수 없는 값이면 기본값", () => {
    expect(parseFactorRounding("round3")).toBe("round3");
    expect(parseFactorRounding('"round2"')).toBe("round2");
    expect(parseFactorRounding("ceil")).toBe("floor2");
    expect(parseFactorRounding(null)).toBe("floor2");
    expect(parseFactorRounding(2)).toBe("floor2");
  });

  it("저장 계수가 시간과 어긋나면 감지", () => {
    const c: ChangeoverCoefficient = { processType: "PE", changeoverType: "BM", hours: 6, factor: 0.8, nextDayStart: false };
    expect(isFactorOutOfSync(c)).toBe(true);
  });
});

describe("FULLSET교체 익일가동(nextDayStart)은 시간으로 계산하지 않음", () => {
  it("익일가동 행의 계수는 시간과 무관하게 0", () => {
    expect(coefficientFactor({ hours: 0, nextDayStart: true })).toBe(0);
    expect(coefficientFactor({ hours: 3, nextDayStart: true })).toBe(0);
    expect(coefficientFactor({ hours: 24, nextDayStart: true }, "none")).toBe(0);
    expect(coefficientFactor({ hours: 3, nextDayStart: false })).toBe(0.87);
  });

  it("익일가동 행에 시간이 들어 있어도 교체일 생산 0, 다음 날 정상 생산", () => {
    const coefs = COEFFICIENTS.map((c) =>
      c.processType === "PET1_1STAGE" && c.changeoverType === "FULL"
        ? { ...c, hours: 3, factor: coefficientFactor({ hours: 3, nextDayStart: true }) }
        : c,
    );
    const input = makeInput({
      changeoverCoefficients: coefs,
      cells: [
        cell("L1", "2026-11-12", "P1"),
        cell("L1", "2026-11-13", "P2", { changeoverType: "FULL" }),
        cell("L1", "2026-11-16", "P2"),
      ],
    });
    const r = recalc(input);
    const full = r.cells.find((c) => c.lineId === "L1" && c.date === "2026-11-13");
    const next = r.cells.find((c) => c.lineId === "L1" && c.date === "2026-11-16");
    expect(full?.expectedQty).toBe(0);
    expect(next?.expectedQty).toBe(60_000);
  });
});

describe("간트 셀 표시: 교체 종류 · 소요시간 · 생산 가능시간", () => {
  const coefOf = (pt: string, ct: string) => COEFFICIENTS.find((c) => c.processType === pt && c.changeoverType === ct) ?? null;

  it("현장 용어 라벨", () => {
    expect(changeoverSiteLabel("BM")).toBe("B/M교체");
    expect(changeoverSiteLabel("FULL")).toBe("FULLSET교체");
    expect(changeoverSiteLabel("NONE")).toBe("교체 없음");
  });

  it("PET1 B/M교체 3h → 생산 가능 21h", () => {
    const t = describeCellTime({ effectiveChangeover: "BM", defaulted: false, isDowntime: false, coefficient: coefOf("PET1_1STAGE", "BM") });
    expect(t.label).toBe("B/M교체");
    expect(t.lostHours).toBe(3);
    expect(t.availableHours).toBe(21);
    expect(t.text).toBe("B/M교체 3h · 가동 21h");
  });

  it("PET1 FULLSET교체 익일가동 → 생산 가능 0h, 시간 대신 '익일가동'", () => {
    const t = describeCellTime({ effectiveChangeover: "FULL", defaulted: false, isDowntime: false, coefficient: coefOf("PET1_1STAGE", "FULL") });
    expect(t.nextDayStart).toBe(true);
    expect(t.availableHours).toBe(0);
    expect(t.text).toBe("FULLSET교체 · 익일가동 · 가동 0h");
  });

  it("PET2 FULLSET교체 4h → 생산 가능 20h", () => {
    const t = describeCellTime({ effectiveChangeover: "FULL", defaulted: false, isDowntime: false, coefficient: coefOf("PET2_INJ", "FULL") });
    expect(t.text).toBe("FULLSET교체 4h · 가동 20h");
  });

  it("교체유형 미입력 → 기본값 표시", () => {
    const t = describeCellTime({ effectiveChangeover: "BM", defaulted: true, isDowntime: false, coefficient: coefOf("PET1_1STAGE", "BM") });
    expect(t.defaulted).toBe(true);
    expect(t.text).toBe("B/M교체(기본값) 3h · 가동 21h");
  });

  it("교체 없음 → 24h, 가동 불가 → 0h, 계수 없음 → 시간 정보 없음", () => {
    expect(describeCellTime({ effectiveChangeover: "NONE", defaulted: false, isDowntime: false, coefficient: null }).availableHours).toBe(24);
    const down = describeCellTime({ effectiveChangeover: "NONE", defaulted: false, isDowntime: true, coefficient: null });
    expect(down.availableHours).toBe(0);
    expect(down.label).toBe("가동 불가");
    const none = describeCellTime({ effectiveChangeover: "BM", defaulted: false, isDowntime: false, coefficient: null });
    expect(none.availableHours).toBeNull();
    expect(none.text).toBe("B/M교체 · 시간 정보 없음");
  });

  it("소수 시간도 표시: 2.5h → 가동 21.5h", () => {
    const t = describeCellTime({ effectiveChangeover: "BM", defaulted: false, isDowntime: false, coefficient: { hours: 2.5, nextDayStart: false } });
    expect(t.text).toBe("B/M교체 2.5h · 가동 21.5h");
  });
});
