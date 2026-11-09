import { describe, expect, it } from "vitest";
import {
  addDays,
  dateRange,
  dayOfWeekKo,
  diffDays,
  isWeekend,
  thisWeekThursday,
  yearMonthOf,
} from "@/lib/engine/calendar";

describe("calendar", () => {
  it("addDays 월·연 경계를 넘긴다", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-11-12", -30)).toBe("2026-10-13");
  });

  it("isWeekend 토·일만 true", () => {
    expect(isWeekend("2026-11-12")).toBe(false); // 목
    expect(isWeekend("2026-11-14")).toBe(true); // 토
    expect(isWeekend("2026-11-15")).toBe(true); // 일
    expect(isWeekend("2026-11-16")).toBe(false); // 월
  });

  it("dateRange / diffDays / yearMonthOf", () => {
    const r = dateRange("2026-11-12", 15);
    expect(r).toHaveLength(15);
    expect(r[0]).toBe("2026-11-12");
    expect(r[14]).toBe("2026-11-26");
    expect(diffDays("2026-11-12", "2026-11-26")).toBe(14);
    expect(diffDays("2026-11-26", "2026-11-12")).toBe(-14);
    expect(yearMonthOf("2026-12-03")).toBe("2026-12");
  });

  it("dayOfWeekKo", () => {
    expect(dayOfWeekKo("2026-11-12")).toBe("목");
    expect(dayOfWeekKo("2026-11-15")).toBe("일");
    expect(dayOfWeekKo("2026-11-16")).toBe("월");
  });

  it("thisWeekThursday 월~일 주 기준", () => {
    expect(thisWeekThursday("2026-11-09")).toBe("2026-11-12"); // 월
    expect(thisWeekThursday("2026-11-12")).toBe("2026-11-12"); // 목
    expect(thisWeekThursday("2026-11-15")).toBe("2026-11-12"); // 일 → 같은 주
    expect(thisWeekThursday("2026-11-16")).toBe("2026-11-19"); // 다음 주 월
  });
});
