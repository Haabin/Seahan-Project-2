/**
 * 초안 자동 생성의 과거 계획 고르기 (lib/data/draft-sources.ts).
 * 예전 조회 plans.eq(process_tab,'1STAGE').gte(period_start, from).lt(period_start, periodStart).order(period_start)
 * + "계획마다 rev_no 가 있는 확정본 중 가장 큰 것" 과 같은 결과를 /plan 이 이미 읽은 계획 목록에서 골라야 한다.
 */
import { describe, expect, it } from "vitest";
import { historyFrom, pickHistorySources, plansInHistoryWindow, type HistoryPlanInput } from "@/lib/data/draft-sources";

const PERIOD = "2026-11-19"; // 목요일
const conf = (id: string, revNo: number | null) => ({ id, revNo, status: "confirmed" });
const draft = (id: string) => ({ id, revNo: null, status: "draft" });
const plan = (periodStart: string, revisions: HistoryPlanInput["revisions"]): HistoryPlanInput => ({ periodStart, revisions });

/** 예전 DB 조회 조건을 그대로 옮긴 기준 구현 (비교용) */
function oldQuery(plans: HistoryPlanInput[], periodStart: string, weeks: number) {
  const from = historyFrom(periodStart, weeks);
  return plans.filter((p) => p.periodStart >= from && p.periodStart < periodStart).sort((a, b) => a.periodStart.localeCompare(b.periodStart));
}

describe("historyFrom", () => {
  it("8주 → 56일 전", () => {
    expect(historyFrom(PERIOD, 8)).toBe("2026-09-24");
  });
});

describe("plansInHistoryWindow", () => {
  it("8주 경계: from 당일은 포함, 하루 전은 제외, 이번 기간 시작일은 제외", () => {
    const plans = [plan("2026-09-23", []), plan("2026-09-24", []), plan("2026-11-12", []), plan(PERIOD, []), plan("2026-11-26", [])];
    expect(plansInHistoryWindow(plans, PERIOD, 8).map((p) => p.periodStart)).toEqual(["2026-09-24", "2026-11-12"]);
  });

  it("/plan 의 계획 목록(시작일 내림차순)을 받아 오름차순으로 돌려준다 — 예전 조회와 같은 결과", () => {
    const desc = ["2026-11-26", PERIOD, "2026-11-12", "2026-11-05", "2026-10-29", "2026-09-17"].map((d) => plan(d, [conf(`r${d}`, 0)]));
    const got = plansInHistoryWindow(desc, PERIOD, 8);
    expect(got.map((p) => p.periodStart)).toEqual(["2026-10-29", "2026-11-05", "2026-11-12"]);
    expect(got).toEqual(oldQuery(desc, PERIOD, 8));
  });

  it("같은 시작일이 여러 개면 받은 순서를 그대로 둔다 (정렬이 안정적)", () => {
    const a = plan("2026-11-12", [conf("a", 0)]);
    const b = plan("2026-11-12", [conf("b", 0)]);
    expect(plansInHistoryWindow([a, b], PERIOD, 8)).toEqual([a, b]);
    expect(plansInHistoryWindow([b, a], PERIOD, 8)).toEqual([b, a]);
  });

  it("주 수 설정을 따른다 (1주 → 직전 계획 하나)", () => {
    const plans = [plan("2026-11-12", []), plan("2026-11-05", [])];
    expect(plansInHistoryWindow(plans, PERIOD, 1).map((p) => p.periodStart)).toEqual(["2026-11-12"]);
  });

  it("계획이 없으면 빈 목록", () => {
    expect(plansInHistoryWindow([], PERIOD, 8)).toEqual([]);
  });
});

describe("pickHistorySources", () => {
  it("확정 계획 0개(초안만) → 빈 목록", () => {
    expect(pickHistorySources([plan("2026-11-12", [draft("d1")]), plan("2026-11-05", [])])).toEqual([]);
  });

  it("계획마다 rev_no 가 가장 큰 확정본, 표시 이름은 「11/12 주 Rev 2」", () => {
    const got = pickHistorySources([plan("2026-11-12", [conf("r0", 0), conf("r2", 2), conf("r1", 1), draft("d")])]);
    expect(got).toEqual([{ revId: "r2", periodStart: "2026-11-12", label: "11/12 주 Rev 2" }]);
  });

  it("rev_no 가 없는 확정본과 초안은 고르지 않는다", () => {
    expect(pickHistorySources([plan("2026-11-12", [conf("x", null), draft("d")])])).toEqual([]);
  });

  it("Rev 0 도 고른다 (0 을 없음으로 보지 않는다)", () => {
    expect(pickHistorySources([plan("2026-11-05", [conf("z", 0)])])[0]).toMatchObject({ revId: "z", label: "11/5 주 Rev 0" });
  });

  it("받은 계획 순서를 그대로 둔다 (확정본 없는 계획은 건너뜀)", () => {
    const got = pickHistorySources([plan("2026-10-29", [conf("a", 0)]), plan("2026-11-05", [draft("d")]), plan("2026-11-12", [conf("b", 1)])]);
    expect(got.map((s) => s.revId)).toEqual(["a", "b"]);
  });
});
