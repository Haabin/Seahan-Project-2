/**
 * unwrapInOrder (lib/data/settle.ts): 함께 시작한 조회의 결과를 순서대로 풀고, 실패는 목록 앞쪽 것을 던진다.
 */
import { describe, expect, it } from "vitest";
import { unwrapInOrder } from "@/lib/data/settle";

const ok = <T,>(v: T, ms = 0) => new Promise<T>((r) => setTimeout(() => r(v), ms));
const bad = (msg: string, ms = 0) => new Promise<never>((_, j) => setTimeout(() => j(new Error(msg)), ms));

describe("unwrapInOrder", () => {
  it("모두 성공하면 넣은 순서대로 값을 돌려준다", async () => {
    const [a, b, c] = unwrapInOrder(await Promise.allSettled([ok(1, 20), ok("x", 0), ok(null, 5)]));
    expect([a, b, c]).toEqual([1, "x", null]);
  });

  it("여럿 실패하면 먼저 끝난 것이 아니라 목록에서 앞에 있는 실패를 던진다", async () => {
    const settled = await Promise.allSettled([ok(1), bad("기준정보 조회 실패: A", 30), bad("B", 0)]);
    expect(() => unwrapInOrder(settled)).toThrow("기준정보 조회 실패: A");
  });

  it("빈 목록은 빈 결과", () => {
    expect(unwrapInOrder([])).toEqual([]);
  });
});
