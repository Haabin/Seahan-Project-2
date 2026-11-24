/**
 * 확정 확인창 요약 (components/gantt/plan-issues.ts) — 경고 패널이 계산한 목록을 그대로 받아 센다.
 */
import { describe, expect, it } from "vitest";
import { buildConfirmSummary, violationTitle } from "@/components/gantt/plan-issues";
import type { ProductSupplyRow, Violation } from "@/lib/engine/types";
import type { DraftException } from "@/lib/engine/draft";

const v = (code: Violation["code"], severity: Violation["severity"], message: string): Violation => ({ code, severity, lineId: "L1", date: "2026-11-19", productId: null, message });
const supply = (name: string, extra: Partial<ProductSupplyRow>): ProductSupplyRow =>
  ({ productId: name, productName: name, openingStock: 0, safetyStock: 50_000, days: [], firstShortageDate: null, firstShortageQty: null, firstWarningDate: null, status: "ok", ...extra }) as ProductSupplyRow;
const ex = (code: DraftException["code"], message: string): DraftException => ({ code, message, lineId: null, date: null, orderId: null, productId: null });

const empty = { errors: [], shortages: [], safetyWarnings: [], notices: [], draftExceptions: null };

describe("buildConfirmSummary", () => {
  it("문제 0건 · 자동 생성 미실행 → 모든 개수 0, 확인 필요는 null", () => {
    const s = buildConfirmSummary(empty);
    expect(s.counts).toEqual({ errors: 0, shortages: 0, safety: 0, notices: 0, draft: null });
    expect(s.total).toBe(0);
    expect(s.warningsTotal).toBe(0);
    expect(s.items).toEqual([]);
    expect(s.hiddenCount).toBe(0);
  });

  it("자동 생성을 실행했고 확인 필요 0건 → draft 0 (null 과 구분)", () => {
    expect(buildConfirmSummary({ ...empty, draftExceptions: [] }).counts.draft).toBe(0);
  });

  it("종류별 개수 · 경고 합계(오류+부족)는 패널 「경고 N건」과 같은 규칙", () => {
    const s = buildConfirmSummary({
      errors: [v("MOLD_NOT_ALLOWED", "error", "PET 3호기 11/19: 허용되지 않은 금형(500ml 원형)"), v("CHANGEOVER_LIMIT", "error", "11/20 교체 4회")],
      shortages: [supply("A", { status: "shortage", firstShortageDate: "2026-11-21", firstShortageQty: 12_000 })],
      safetyWarnings: [supply("B", { status: "warning", firstWarningDate: "2026-11-22" }), supply("C", { status: "warning", firstWarningDate: null })],
      notices: [v("CHANGEOVER_DEFAULTED", "notice", "기본값 적용")],
      draftExceptions: [ex("NEW_PRODUCT", "신규"), ex("SHORTAGE", "부족함")],
    });
    expect(s.counts).toEqual({ errors: 2, shortages: 1, safety: 2, notices: 1, draft: 2 });
    expect(s.warningsTotal).toBe(3);
    expect(s.total).toBe(8);
  });

  it("문구는 경고 패널과 같다 (순서: 오류 → 부족 → 안전재고 → 주의 → 확인 필요, 확인 필요는 급한 종류 먼저)", () => {
    const s = buildConfirmSummary({
      errors: [v("MOLD_NOT_ALLOWED", "error", "m1")],
      shortages: [supply("A", { status: "shortage", firstShortageDate: "2026-11-21", firstShortageQty: 12_000 })],
      safetyWarnings: [supply("B", { status: "warning", firstWarningDate: "2026-11-22" })],
      notices: [v("OUTSIDE_FACTOR_TABLE", "notice", "n1")],
      draftExceptions: [ex("NEW_PRODUCT", "신규"), ex("SHORTAGE", "부족함")],
    });
    expect(s.items.map((i) => [i.kind, i.title, i.body])).toEqual([
      ["error", "허용되지 않은 금형", "m1"],
      ["shortage", "부족 · A", "11/21부터 −12,000본"],
      ["safety", "안전재고 미달 · B", "11/22 · 안전재고 50,000"],
      ["notice", "비가동 시간 기준표 밖", "n1"],
      ["draft", "확인 필요 · 납기 내 수량 부족", "부족함"],
      ["draft", "확인 필요 · 신규 제품 · 임시 배정", "신규"],
    ]);
  });

  it("목록이 길면 앞에서 limit 개만 보이고 나머지는 「외 N건」", () => {
    const errors = Array.from({ length: 11 }, (_, i) => v("CHANGEOVER_LIMIT", "error", `e${i}`));
    const s = buildConfirmSummary({ ...empty, errors }, 8);
    expect(s.items).toHaveLength(8);
    expect(s.items[7].body).toBe("e7");
    expect(s.hiddenCount).toBe(3);
    expect(s.counts.errors).toBe(11);
  });

  it("목록이 limit 이하면 자르지 않는다", () => {
    const s = buildConfirmSummary({ ...empty, errors: [v("CHANGEOVER_LIMIT", "error", "e")] }, 8);
    expect(s.items).toHaveLength(1);
    expect(s.hiddenCount).toBe(0);
  });
});

describe("violationTitle — 패널에서 옮긴 문구가 그대로인지", () => {
  it.each([
    ["MOLD_NOT_ALLOWED", "허용되지 않은 금형"],
    ["CHANGEOVER_LIMIT", "교체 횟수 초과"],
    ["DOWNTIME_ASSIGNED", "가동 불가일 배치"],
    ["CHANGEOVER_DEFAULTED", "교체유형 미입력 · 기본값 적용"],
    ["UNKNOWN_PRODUCT", "기준정보에 없는 제품"],
    ["OUTSIDE_FACTOR_TABLE", "비가동 시간 기준표 밖"],
  ] as const)("%s → %s", (code, title) => {
    expect(violationTitle(v(code, "error", ""))).toBe(title);
  });
});
