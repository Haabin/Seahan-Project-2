/**
 * 초안 저장(save_plan_draft, 0011) 결과 해석. 순수 함수 — 서버 액션과 화면이 함께 쓴다.
 */

export type DraftConflictKind = "conflict" | "confirmed" | "missing";

/** 저장이 거부된 이유와, 알 수 있으면 누가·언제 */
export interface DraftConflict {
  kind: DraftConflictKind;
  /** 서버의 지금 version (missing 이면 null) */
  version: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
  updatedByName: string | null;
  /** confirmed 일 때 확정된 Rev 번호 */
  revNo: number | null;
}

/** save_plan_draft 반환 행 (반환 열은 out_ 으로 시작한다) */
export interface SavePlanDraftRow {
  out_status: string;
  out_version: number | null;
  out_updated_at: string | null;
  out_updated_by: string | null;
  out_updated_by_name: string | null;
  out_rev_no: number | null;
}

export type SaveOutcome = { kind: "ok"; version: number } | { kind: "rejected"; conflict: DraftConflict };

export function interpretSaveRow(row: SavePlanDraftRow | null | undefined): SaveOutcome {
  if (!row) throw new Error("초안 저장 결과를 받지 못했습니다");
  const info = {
    version: row.out_version ?? null,
    updatedAt: row.out_updated_at ?? null,
    updatedBy: row.out_updated_by ?? null,
    updatedByName: row.out_updated_by_name ?? null,
    revNo: row.out_rev_no ?? null,
  };
  switch (row.out_status) {
    case "ok":
      if (row.out_version === null || row.out_version === undefined) throw new Error("초안 저장 결과에 버전이 없습니다");
      return { kind: "ok", version: row.out_version };
    case "conflict":
    case "confirmed":
    case "missing":
      return { kind: "rejected", conflict: { kind: row.out_status, ...info } };
    default:
      throw new Error(`알 수 없는 초안 저장 결과: ${row.out_status}`);
  }
}

export const MIGRATION_0011_MESSAGE = "DB 마이그레이션 0011 이 필요합니다 (save_plan_draft 함수가 없습니다). 관리자에게 알려 주세요.";

/** 0011 적용 전 DB 에서 함수를 부르면 나는 오류인지. 맞으면 분명한 문구를, 아니면 null */
export function migrationMissingMessage(error: { code?: string | null; message?: string | null } | null | undefined): string | null {
  if (!error) return null;
  const msg = error.message ?? "";
  if (error.code === "PGRST202") return MIGRATION_0011_MESSAGE;
  if (/save_plan_draft/.test(msg) && /(could not find|does not exist|schema cache)/i.test(msg)) return MIGRATION_0011_MESSAGE;
  return null;
}

/** 저장이 거부됐을 때 서버 액션이 돌려주는 짧은 오류 문구 (화면은 conflict 정보로 자세히 보여준다) */
export function rejectedErrorText(c: DraftConflict): string {
  if (c.kind === "confirmed") return "이 초안은 이미 확정되었습니다";
  if (c.kind === "missing") return "이 초안이 없습니다";
  return "다른 저장이 먼저 있었습니다";
}
