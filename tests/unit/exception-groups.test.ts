import { describe, expect, it } from "vitest";
import { groupExceptions } from "../../components/gantt/exception-groups";
import type { DraftException } from "../../lib/engine/draft";

const e = (code: DraftException["code"], message: string): DraftException => ({ code, message, lineId: "L1", date: "2026-11-19", orderId: null, productId: null });

describe("확인 필요 목록 묶기", () => {
  it("종류별로 묶고 급한 순서(부족 → 충돌 → 매칭 안 됨 → …)로 놓는다", () => {
    const g = groupExceptions([e("NEW_PRODUCT", "a"), e("SHORTAGE", "b"), e("CHANGEOVER_ASSUMED", "c"), e("SHORTAGE", "d"), e("MOLD_CONFLICT", "x")]);
    expect(g.map((x) => [x.code, x.total])).toEqual([
      ["SHORTAGE", 2],
      ["MOLD_CONFLICT", 1],
      ["CHANGEOVER_ASSUMED", 1],
      ["NEW_PRODUCT", 1],
    ]);
  });
  it("글이 똑같은 항목은 하나로 합치고 건수를 센다", () => {
    const g = groupExceptions([e("NEW_PRODUCT", "같은 안내"), e("NEW_PRODUCT", "같은 안내"), e("NEW_PRODUCT", "다른 안내")]);
    expect(g[0].total).toBe(3);
    expect(g[0].items.map((x) => [x.message, x.count])).toEqual([
      ["같은 안내", 2],
      ["다른 안내", 1],
    ]);
  });
  it("항목이 없으면 빈 목록", () => {
    expect(groupExceptions([])).toEqual([]);
  });
});
