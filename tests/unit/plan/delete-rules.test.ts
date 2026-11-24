/**
 * 초안 계획 삭제 판단 (lib/plan/delete-rules.ts) — 화면 버튼 표시와 서버 액션 deleteDraftPlan 이 같은 함수를 쓴다.
 */
import { describe, expect, it } from "vitest";
import { canDeleteDraftPlan, nearestPeriod } from "@/lib/plan/delete-rules";

const draft = { status: "draft" };
const confirmed = { status: "confirmed" };

describe("canDeleteDraftPlan", () => {
  it("admin + 확정 Rev 0개(초안만) → 삭제 가능", () => {
    expect(canDeleteDraftPlan({ role: "admin", revisions: [draft] })).toEqual({ ok: true });
  });

  it("admin + Rev 가 하나도 없는 계획 → 삭제 가능", () => {
    expect(canDeleteDraftPlan({ role: "admin", revisions: [] }).ok).toBe(true);
  });

  it("확정 Rev 가 1개 이상이면 admin 이어도 불가 (NFR-09)", () => {
    const one = canDeleteDraftPlan({ role: "admin", revisions: [confirmed, draft] });
    expect(one.ok).toBe(false);
    if (!one.ok) expect(one.reason).toContain("NFR-09");
    expect(canDeleteDraftPlan({ role: "admin", revisions: [confirmed, confirmed, draft] }).ok).toBe(false);
  });

  it("planner·viewer 는 초안만 있어도 불가", () => {
    for (const role of ["planner", "viewer"] as const) {
      const v = canDeleteDraftPlan({ role, revisions: [draft] });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toContain("관리자");
    }
  });
});

describe("nearestPeriod (삭제 후 이동할 기간)", () => {
  it("남은 기간 중 날짜 차이가 가장 작은 것", () => {
    expect(nearestPeriod(["2026-11-05", "2026-11-19", "2026-12-17"], "2026-11-26")).toBe("2026-11-19");
  });

  it("지운 기간 자신은 고르지 않는다", () => {
    expect(nearestPeriod(["2026-11-19", "2026-12-03"], "2026-11-19")).toBe("2026-12-03");
  });

  it("앞뒤로 같은 거리면 뒤(다가오는) 기간", () => {
    expect(nearestPeriod(["2026-11-12", "2026-11-26"], "2026-11-19")).toBe("2026-11-26");
    expect(nearestPeriod(["2026-11-26", "2026-11-12"], "2026-11-19")).toBe("2026-11-26");
  });

  it("남은 계획이 없으면 null → 빈 화면", () => {
    expect(nearestPeriod([], "2026-11-19")).toBeNull();
    expect(nearestPeriod(["2026-11-19"], "2026-11-19")).toBeNull();
  });
});
