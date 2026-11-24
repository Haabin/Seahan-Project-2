/**
 * save_plan_draft(0011) 결과 해석과 0011 적용 전 오류 문구 (lib/plan/draft-save.ts).
 */
import { describe, expect, it } from "vitest";
import { interpretSaveRow, migrationMissingMessage, MIGRATION_0011_MESSAGE, rejectedErrorText, type SavePlanDraftRow } from "@/lib/plan/draft-save";

const row = (over: Partial<SavePlanDraftRow>): SavePlanDraftRow => ({ out_status: "ok", out_version: 5, out_updated_at: "2026-11-24T05:00:00Z", out_updated_by: "u1", out_updated_by_name: "김계획", out_rev_no: null, ...over });

describe("interpretSaveRow", () => {
  it("ok → 새 version", () => {
    expect(interpretSaveRow(row({}))).toEqual({ kind: "ok", version: 5 });
  });

  it("conflict · confirmed · missing → 거부 + 누가·언제", () => {
    expect(interpretSaveRow(row({ out_status: "conflict", out_version: 9 }))).toEqual({
      kind: "rejected",
      conflict: { kind: "conflict", version: 9, updatedAt: "2026-11-24T05:00:00Z", updatedBy: "u1", updatedByName: "김계획", revNo: null },
    });
    expect(interpretSaveRow(row({ out_status: "confirmed", out_rev_no: 2 }))).toMatchObject({ kind: "rejected", conflict: { kind: "confirmed", revNo: 2 } });
    expect(interpretSaveRow(row({ out_status: "missing", out_version: null, out_updated_by: null, out_updated_by_name: null, out_updated_at: null }))).toMatchObject({
      kind: "rejected",
      conflict: { kind: "missing", version: null },
    });
  });

  it("결과가 없거나 모르는 상태 · ok 인데 version 없음 → 오류", () => {
    expect(() => interpretSaveRow(null)).toThrow("받지 못했습니다");
    expect(() => interpretSaveRow(row({ out_status: "weird" }))).toThrow("알 수 없는");
    expect(() => interpretSaveRow(row({ out_version: null }))).toThrow("버전이 없습니다");
  });

  it("거부 문구", () => {
    expect(rejectedErrorText({ kind: "conflict", version: 1, updatedAt: null, updatedBy: null, updatedByName: null, revNo: null })).toBe("다른 저장이 먼저 있었습니다");
  });
});

describe("migrationMissingMessage (0011 적용 전 DB)", () => {
  it("PostgREST 의 함수 없음(PGRST202) → 0011 필요", () => {
    expect(migrationMissingMessage({ code: "PGRST202", message: "Could not find the function public.save_plan_draft(p_cells, p_expected_version, p_revision_id, p_token) in the schema cache" })).toBe(MIGRATION_0011_MESSAGE);
  });

  it("Postgres 의 함수 없음 문구 → 0011 필요", () => {
    expect(migrationMissingMessage({ code: "42883", message: "function save_plan_draft(uuid, integer, uuid, jsonb) does not exist" })).toBe(MIGRATION_0011_MESSAGE);
  });

  it("다른 오류는 그대로 (null)", () => {
    expect(migrationMissingMessage({ code: "42501", message: "permission denied for table plan_cells" })).toBeNull();
    expect(migrationMissingMessage(null)).toBeNull();
  });
});
