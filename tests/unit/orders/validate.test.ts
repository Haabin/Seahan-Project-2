import { describe, expect, it } from "vitest";
import { checkDueDate, duplicateOrderNoKeys, formatDueDate, orderNoKey, todayKst } from "../../../lib/orders/validate";

const TODAY = "2026-11-22";

describe("주문 납기일 검사", () => {
  it("연도를 잘못 넣은 먼 과거(2020-01-01)는 받지 않는다", () => {
    const r = checkDueDate("2020-01-01", TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("연도를 확인하세요");
  });
  it("30일 안에 지난 납기는 받되 '납기 지남'", () => {
    expect(checkDueDate("2026-11-21", TODAY)).toEqual({ ok: true, overdue: true });
    expect(checkDueDate("2026-10-23", TODAY)).toEqual({ ok: true, overdue: true });
    expect(checkDueDate("2026-10-22", TODAY).ok).toBe(false);
  });
  it("오늘과 앞날은 정상, 2년 넘게 먼 날짜는 받지 않는다", () => {
    expect(checkDueDate("2026-11-22", TODAY)).toEqual({ ok: true, overdue: false });
    expect(checkDueDate("2027-03-01", TODAY)).toEqual({ ok: true, overdue: false });
    expect(checkDueDate("2030-01-01", TODAY).ok).toBe(false);
  });
  it("형식이 틀리면 받지 않는다", () => {
    expect(checkDueDate("11/25", TODAY).ok).toBe(false);
    expect(checkDueDate("2026-13-40", TODAY).ok).toBe(false);
  });
});

describe("주문번호 중복", () => {
  it("공백·대소문자를 무시하고 같은 번호로 본다", () => {
    expect(orderNoKey(" TEST-A1 ")).toBe("test-a1");
    expect(orderNoKey("")).toBeNull();
    expect(orderNoKey(null)).toBeNull();
  });
  it("두 번 넘게 쓰인 주문번호를 찾는다. 번호 없는 주문은 중복이 아니다", () => {
    const dup = duplicateOrderNoKeys([{ orderNo: "TEST-A1" }, { orderNo: "test-a1 " }, { orderNo: "SO-1" }, { orderNo: null }, { orderNo: null }]);
    expect(Array.from(dup)).toEqual(["test-a1"]);
  });
});

describe("납기일 표시", () => {
  it("올해는 월/일, 다른 해는 연도를 붙인다", () => {
    expect(formatDueDate("2026-11-25", TODAY)).toBe("11/25 수");
    expect(formatDueDate("2020-01-01", TODAY)).toBe("2020-01-01 수");
    expect(formatDueDate("2027-01-04", TODAY)).toBe("2027-01-04 월");
  });
  it("오늘은 한국 시간 기준", () => {
    expect(todayKst(Date.UTC(2026, 10, 21, 15, 30))).toBe("2026-11-22");
  });
});
