import { describe, expect, it } from "vitest";
import { recalc } from "@/lib/engine";
import {
  badgeLabels,
  changeoverSiteLabel,
  coefficientFactor,
  describeCellTime,
  DEFAULT_FACTOR_TABLE,
  describeRate,
  factorFromHours,
  floorRate2,
  fmtExplainValue,
  isFactorOutOfSync,
  noneOptionLabel,
  parseFactorTable,
  rateFromLostHours,
  SHORT_LABEL_LEGEND,
} from "@/lib/engine/changeover";
import type { ChangeoverCoefficient } from "@/lib/engine/types";
import { cell, COEFFICIENTS, makeInput } from "./fixtures";

describe("비가동 시간 → 가동률: 기준표(I65:J73) 둘째 자리 내림", () => {
  it("기준표 9개 값이 정확히 0.96 / 0.91 / 0.87 / 0.83 / 0.79 / 0.75 / 0.71 / 0.67 / 0.62", () => {
    const want = [0.96, 0.91, 0.87, 0.83, 0.79, 0.75, 0.71, 0.67, 0.62];
    want.forEach((f, i) => {
      const r = rateFromLostHours(i + 1);
      expect(r.factor).toBe(f);
      expect(r.source).toBe("table");
    });
    // 원본 값은 그대로 보관
    expect(DEFAULT_FACTOR_TABLE.map((r) => r.rate)).toEqual([0.96, 0.915, 0.875, 0.83, 0.79, 0.75, 0.71, 0.67, 0.625]);
  });

  it("공식 (24 − h)/24 값이 아니다: 1h 0.95, 7h 0.70, 8h 0.66 이 아님", () => {
    expect(factorFromHours(1)).toBe(0.96);
    expect(factorFromHours(7)).toBe(0.71);
    expect(factorFromHours(8)).toBe(0.67);
    expect(factorFromHours(1)).not.toBe(0.95);
    expect(factorFromHours(7)).not.toBe(0.7);
    expect(factorFromHours(8)).not.toBe(0.66);
  });

  it("둘째 자리 내림은 부동소수 오차가 없다 (0.83 → 0.82 가 되지 않음)", () => {
    expect(floorRate2(0.83)).toBe(0.83);
    expect(floorRate2(0.915)).toBe(0.91);
    expect(floorRate2(0.875)).toBe(0.87);
    expect(floorRate2(0.625)).toBe(0.62);
    expect(floorRate2(0.29)).toBe(0.29);
    expect(floorRate2(0.57)).toBe(0.57);
    for (let c = 0; c <= 100; c++) expect(floorRate2(c / 100)).toBe(c / 100);
  });

  it("FULL 6h → 0.75, BM 2h → 0.91", () => {
    expect(coefficientFactor({ hours: 6, nextDayStart: false })).toBe(0.75);
    expect(coefficientFactor({ hours: 2, nextDayStart: false })).toBe(0.91);
  });

  it("0h → 1.00 (손실 없음)", () => {
    expect(rateFromLostHours(0)).toEqual({ hours: 0, factor: 1, source: "none", tableRate: null });
  });

  it("10h~24h → 기준표 밖: (24 − h)/24 둘째 자리 내림 + 표시, 24h → 0", () => {
    const r10 = rateFromLostHours(10);
    expect(r10.source).toBe("outside");
    expect(r10.factor).toBe(0.58); // 14/24 = 0.5833…
    expect(describeRate(r10)).toBe("비가동 10h → 가동률 0.58 (기준표 밖 → 계산값)");
    expect(rateFromLostHours(12).factor).toBe(0.5);
    expect(rateFromLostHours(18).factor).toBe(0.25);
    expect(rateFromLostHours(23).factor).toBe(0.04);
    expect(rateFromLostHours(24)).toMatchObject({ factor: 0, source: "outside" });
    expect(describeRate(rateFromLostHours(3))).toBe("비가동 3h → 가동률 0.87 (기준표)");
  });

  it("시간은 0~24 정수로 정리", () => {
    expect(factorFromHours(-2)).toBe(1);
    expect(factorFromHours(30)).toBe(0);
    expect(factorFromHours(Number.NaN)).toBe(1);
    expect(rateFromLostHours(2.6).hours).toBe(3);
  });

  it("기존 계수표(익일가동 제외)의 저장 계수가 모두 기준표 값과 일치", () => {
    for (const c of COEFFICIENTS) {
      expect(isFactorOutOfSync(c)).toBe(false);
    }
  });

  it("저장 계수가 시간과 어긋나면 감지", () => {
    const c: ChangeoverCoefficient = { processType: "PE", changeoverType: "BM", hours: 6, factor: 0.8, nextDayStart: false };
    expect(isFactorOutOfSync(c)).toBe(true);
  });

  it("설정값 파싱: 원본 값 그대로, 형식이 틀리면 기본 기준표", () => {
    expect(parseFactorTable([{ hours: 2, rate: 0.9 }, { hours: 1, rate: 0.95 }])).toEqual([{ hours: 1, rate: 0.95 }, { hours: 2, rate: 0.9 }]);
    expect(parseFactorTable('[{"hours":3,"rate":0.875}]')).toEqual([{ hours: 3, rate: 0.875 }]);
    expect(parseFactorTable(null)).toEqual(DEFAULT_FACTOR_TABLE);
    expect(parseFactorTable([{ hours: 1.5, rate: 0.9 }])).toEqual(DEFAULT_FACTOR_TABLE);
    expect(parseFactorTable([{ hours: 1, rate: 0.9 }, { hours: 1, rate: 0.8 }])).toEqual(DEFAULT_FACTOR_TABLE);
    // 바뀐 기준표는 같은 함수로 적용된다
    expect(factorFromHours(2, parseFactorTable([{ hours: 2, rate: 0.919 }]))).toBe(0.91);
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

describe("교체 배지 표기: 좁은 칸 짧은 표기 / 넓은 칸 전체 용어 / 마우스 올리면 전체 설명", () => {
  const coefOf = (pt: string, ct: string) => COEFFICIENTS.find((c) => c.processType === pt && c.changeoverType === ct) ?? null;
  const info = (ct: "BM" | "FULL", defaulted: boolean, coefficient: { hours: number; nextDayStart: boolean } | null) =>
    describeCellTime({ effectiveChangeover: ct, defaulted, isDowntime: false, coefficient });

  it("B/M교체 3h: 짧은 'B/M 3h', 전체 'B/M교체 3h', 툴팁에 가동 21h", () => {
    const l = badgeLabels(info("BM", false, coefOf("PET1_1STAGE", "BM")));
    expect(l.short).toBe("B/M 3h");
    expect(l.full).toBe("B/M교체 3h");
    expect(l.title).toBe("B/M교체 3h · 가동 21h");
  });

  it("FULLSET교체 익일가동: 짧은 'FULL 익일', 전체 'FULLSET교체 익일가동'", () => {
    const l = badgeLabels(info("FULL", false, coefOf("PET1_1STAGE", "FULL")));
    expect(l.short).toBe("FULL 익일");
    expect(l.full).toBe("FULLSET교체 익일가동");
    expect(l.title).toBe("FULLSET교체 · 익일가동 · 가동 0h (교체일 생산 0)");
  });

  it("기본값 적용: 짧은 'B/M? 3h' (숫자로 오해할 괄호 없음), 툴팁에 기본값 적용 설명", () => {
    const l = badgeLabels(info("BM", true, coefOf("PET1_1STAGE", "BM")), "B/M교체");
    expect(l.short).toBe("B/M? 3h");
    expect(l.short).not.toMatch(/[()]/);
    expect(l.full).toBe("B/M교체(기본값) 3h");
    expect(l.title).toBe("B/M교체 3h · 가동 21h\n교체유형 미입력 → 기본값(B/M교체) 적용");
  });

  it("PET2 FULLSET교체 4h, 계수 없음, 소수 시간", () => {
    expect(badgeLabels(info("FULL", false, coefOf("PET2_INJ", "FULL"))).short).toBe("FULL 4h");
    const none = badgeLabels(info("BM", false, null));
    expect(none.short).toBe("B/M –");
    expect(none.full).toBe("B/M교체 시간 정보 없음");
    expect(badgeLabels(info("BM", false, { hours: 2.5, nextDayStart: false })).short).toBe("B/M 2.5h");
  });

  it("짧은 표기는 9자 이내 (하루짜리 칸에 들어가는 길이, 소수 시간 포함)", () => {
    const cases = [
      info("BM", false, { hours: 3, nextDayStart: false }),
      info("BM", true, { hours: 3, nextDayStart: false }),
      info("FULL", false, { hours: 0, nextDayStart: true }),
      info("FULL", false, { hours: 4, nextDayStart: false }),
      info("BM", true, { hours: 2.5, nextDayStart: false }),
    ];
    for (const c of cases) expect(badgeLabels(c).short.length).toBeLessThanOrEqual(9);
  });

  it("범례에 짧은 표기 뜻이 모두 있음", () => {
    const keys = SHORT_LABEL_LEGEND.map(([k]) => k);
    expect(keys).toEqual(expect.arrayContaining(["B/M", "FULL", "익일", "?"]));
  });
});

describe("셀 편집 패널: 계산 근거 값과 교체 유형 선택칸 표시", () => {
  it("계산 근거 소수 계수는 반올림하지 않음: 0.87 → '0.87', 0.8 → '0.8' (기존 화면은 '1')", () => {
    expect(fmtExplainValue(0.87)).toBe("0.87");
    expect(fmtExplainValue(0.8)).toBe("0.8");
    expect(fmtExplainValue(0.875)).toBe("0.875");
    expect(fmtExplainValue(100_000)).toBe("100,000");
    expect(fmtExplainValue(0)).toBe("0");
    expect(fmtExplainValue(Number.NaN)).toBe("–");
  });

  it("엔진 근거의 교체 계수(실제 적용값 0.87)가 그대로 표시됨", () => {
    const r = recalc(
      makeInput({ cells: [cell("L1", "2026-11-12", "P1"), cell("L1", "2026-11-13", "P2")] }),
    );
    const c = r.cells.find((x) => x.lineId === "L1" && x.date === "2026-11-13");
    expect(c?.changeoverDefaulted).toBe(true);
    const step = c?.explain.find((e) => e.label.startsWith("교체 계수"));
    expect(typeof step?.value).toBe("number");
    expect(fmtExplainValue(step?.value as number)).toBe("0.87");
  });

  it("교체유형 미입력 + 기본값 적용 칸: '교체 없음' 대신 '미입력 (기본값 B/M교체 적용)'", () => {
    expect(noneOptionLabel(true, "BM")).toBe("미입력 (기본값 B/M교체 적용)");
    expect(noneOptionLabel(true, "FULL")).toBe("미입력 (기본값 FULLSET교체 적용)");
  });

  it("기본값이 적용되지 않은 칸은 그대로 '교체 없음'", () => {
    expect(noneOptionLabel(false, "NONE")).toBe("교체 없음");
    expect(noneOptionLabel(false, "BM")).toBe("교체 없음");
    expect(noneOptionLabel(true, "NONE")).toBe("교체 없음");
  });
});
