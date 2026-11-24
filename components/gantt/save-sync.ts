import type { DraftConflict } from "@/lib/plan/draft-save";

/**
 * 생산계획표 자동 저장 상태와 충돌 판단. 순수 함수.
 *
 * - 저장은 한 번에 하나만 보낸다. 성공하면 응답의 version 이 다음 저장의 기준이 된다 → 내 연속 저장은 충돌이 아니다.
 * - 저장 중에 또 고치면 끝난 뒤 다시 저장한다(editSeq 를 올려 자동 저장 타이머를 다시 건다).
 * - 충돌이면 자동 저장을 멈춘다. 사용자가 「최신 내용 불러오기」나 「내 것으로 덮어쓰기」를 고른다.
 * - 저장 결과를 못 받았으면(네트워크 오류) 같은 save_token 으로 다시 보낸다. DB 가 "내 직전 저장"을 알아본다.
 * - 화면이 서버 값으로 다시 맞춰질 때(serverDecision) 기준(Rev id, version)도 함께 바꾼다.
 */

export interface SaveBase {
  revisionId: string;
  version: number;
}

/** 서버가 내려준 지금 화면의 Rev */
export interface ServerDraft {
  revisionId: string;
  version: number;
  status: "draft" | "confirmed";
  updatedAt: string | null;
  updatedBy: string | null;
  /** 이 Rev 를 마지막으로 save_plan_draft 로 저장한 표식 (다른 경로로 바뀌면 null) */
  saveToken: string | null;
}

export type SavePhase = "idle" | "saving" | "saved" | "error" | "conflict";

export interface SaveSync {
  phase: SavePhase;
  /** 아직 저장되지 않은 수정이 있다 */
  dirty: boolean;
  /** 자동 저장 타이머를 다시 걸 때마다 오른다 (수정 · 저장 중 수정 뒤 저장 완료) */
  editSeq: number;
  editedDuringSave: boolean;
  base: SaveBase;
  /** 이번 저장 표식. 성공하면 새것으로, 결과를 모르면 그대로 다시 쓴다 */
  token: string;
  error: string | null;
  conflict: DraftConflict | null;
  /** 「최신 내용 불러오기」를 눌렀다 → 다음 서버 값은 무조건 받는다 */
  reloadRequested: boolean;
}

export type SaveEvent =
  | { type: "edit" }
  | { type: "saveStart" }
  | { type: "saveOk"; version: number; nextToken: string }
  | { type: "saveRejected"; conflict: DraftConflict }
  | { type: "saveError"; message: string }
  | { type: "reloadRequested" }
  | { type: "server"; server: ServerDraft; nextToken: string };

export function initSaveSync(server: ServerDraft, token: string): SaveSync {
  return {
    phase: "idle",
    dirty: false,
    editSeq: 0,
    editedDuringSave: false,
    base: { revisionId: server.revisionId, version: server.version },
    token,
    error: null,
    conflict: null,
    reloadRequested: false,
  };
}

/** 자동 저장을 보내도 되는가 (충돌·저장 중에는 보내지 않는다) */
export function canAutoSave(s: SaveSync): boolean {
  return s.dirty && s.phase !== "saving" && s.phase !== "conflict";
}

/** 「내 것으로 덮어쓰기」를 할 수 있는가 (확정됐거나 없어진 초안에는 덮어쓸 수 없다) */
export function canOverwrite(s: SaveSync): boolean {
  return s.phase === "conflict" && s.conflict?.kind === "conflict";
}

/** 서버로 보낼 기준. force(덮어쓰기)면 버전을 확인하지 않는다 */
export function saveRequest(s: SaveSync, force = false): { revisionId: string; expectedVersion: number | null; token: string } {
  return { revisionId: s.base.revisionId, expectedVersion: force ? null : s.base.version, token: s.token };
}

/** 확정·계획 삭제를 막아야 하는 상태 (저장 안 된 수정 · 저장 중 · 충돌) */
export function blocksConfirm(s: SaveSync): boolean {
  return s.dirty || s.phase === "saving" || s.phase === "conflict";
}

/**
 * 서버 값이 새로 내려왔을 때:
 *  adopt    = 화면 셀을 서버 값으로 바꾸고 기준도 서버 값으로
 *  keep     = 내 화면 셀을 그대로 둔다 (저장 중이거나, 내 저장의 메아리인데 그 뒤로 더 고쳤거나, 오래된 값)
 *  rebase   = 서버가 더 새것인데 그게 결과를 못 받은 내 저장(같은 save_token) → 내 화면은 두고 기준 version 만 맞춘다
 *  conflict = 내가 저장하지 않은 수정이 있는데 서버가 더 새것 → 충돌로 알린다
 */
export function serverDecision(s: SaveSync, server: ServerDraft): "adopt" | "keep" | "rebase" | "conflict" {
  if (s.reloadRequested) return "adopt";
  if (server.revisionId !== s.base.revisionId) return "adopt"; // 기간·Rev 이동, 확정 직후 새 초안
  if (s.phase === "saving") return "keep"; // 저장 응답과 함께 오는 서버 값 — 결과는 saveOk 가 정한다
  if (server.status === "confirmed") return s.dirty ? "conflict" : "adopt";
  if (server.version < s.base.version) return "keep"; // 내 저장보다 오래된 값
  if (server.version === s.base.version) return s.dirty ? "keep" : "adopt";
  if (s.phase === "conflict") return "keep";
  if (!s.dirty) return "adopt";
  return server.saveToken !== null && server.saveToken === s.token ? "rebase" : "conflict";
}

export function reduceSaveSync(s: SaveSync, e: SaveEvent): SaveSync {
  switch (e.type) {
    case "edit":
      return { ...s, dirty: true, editSeq: s.editSeq + 1, editedDuringSave: s.phase === "saving" ? true : s.editedDuringSave };
    case "saveStart":
      return { ...s, phase: "saving", editedDuringSave: false };
    case "saveOk": {
      const again = s.editedDuringSave;
      return {
        ...s,
        phase: "saved",
        base: { ...s.base, version: e.version },
        dirty: again,
        editSeq: again ? s.editSeq + 1 : s.editSeq,
        editedDuringSave: false,
        token: e.nextToken,
        error: null,
        conflict: null,
      };
    }
    case "saveRejected":
      return { ...s, phase: "conflict", dirty: true, editedDuringSave: false, conflict: e.conflict };
    case "saveError":
      // 결과를 모르므로 token 은 그대로 둔다 → 다음 저장이 DB 에 들어간 직전 저장을 알아볼 수 있다
      return { ...s, phase: "error", error: e.message, editedDuringSave: false };
    case "reloadRequested":
      return { ...s, reloadRequested: true };
    case "server": {
      const d = serverDecision(s, e.server);
      if (d === "keep") return s;
      if (d === "rebase") return { ...s, base: { ...s.base, version: e.server.version } };
      if (d === "conflict") {
        return {
          ...s,
          phase: "conflict",
          conflict: {
            kind: e.server.status === "confirmed" ? "confirmed" : "conflict",
            version: e.server.version,
            updatedAt: e.server.updatedAt,
            updatedBy: e.server.updatedBy,
            updatedByName: null,
            revNo: null,
          },
        };
      }
      return {
        ...s,
        // 저장 표시는 그대로 둔다(저장 직후 「저장됨」이 유지되던 지금 모양). 충돌만 풀린다
        phase: s.phase === "conflict" ? "idle" : s.phase,
        dirty: false,
        editedDuringSave: false,
        base: { revisionId: e.server.revisionId, version: e.server.version },
        token: e.server.revisionId === s.base.revisionId && !s.reloadRequested ? s.token : e.nextToken,
        conflict: null,
        reloadRequested: false,
      };
    }
  }
}

/** 저장 상태 표시: 충돌 > 저장 중 > 저장 실패 > 수정됨 > 저장됨 (충돌 외 순서는 예전과 같다) */
export function saveBadge(s: SaveSync): "conflict" | "saving" | "error" | "dirty" | "saved" | null {
  if (s.phase === "conflict") return "conflict";
  if (s.phase === "saving") return "saving";
  if (s.phase === "error") return "error";
  if (s.dirty) return "dirty";
  if (s.phase === "saved") return "saved";
  return null;
}

/** 충돌 알림 문구 */
export function conflictMessage(c: DraftConflict, myUserId: string | null, fmtTime: (iso: string) => string): string {
  if (c.kind === "confirmed") return `이 초안은 이미 ${c.revNo !== null ? `Rev ${c.revNo}으로 ` : ""}확정되었습니다. 최신 내용을 불러와 새 초안에서 이어서 고치세요.`;
  if (c.kind === "missing") return "이 초안이 없어졌습니다 (계획이 삭제되었을 수 있습니다). 최신 내용을 불러오세요.";
  const who = c.updatedBy && myUserId && c.updatedBy === myUserId ? "다른 탭(창)에서 먼저 저장했습니다" : "다른 사람이 먼저 저장했습니다";
  const detail = [c.updatedBy && c.updatedBy === myUserId ? null : c.updatedByName, c.updatedAt ? fmtTime(c.updatedAt) : null].filter(Boolean).join(" · ");
  return detail ? `${who} (${detail})` : who;
}
