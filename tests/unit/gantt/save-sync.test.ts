/**
 * 자동 저장 상태·충돌 판단 (components/gantt/save-sync.ts).
 * 혼자 쓸 때는 예전과 같아야 하고(연속 저장이 충돌이 아님), 서버 값으로 다시 맞춰질 때마다 기준(Rev id, version)이 갱신돼
 * 다음 저장이 "나 자신과의 충돌"로 잡히지 않아야 한다.
 */
import { describe, expect, it } from "vitest";
import {
  blocksConfirm,
  canAutoSave,
  canOverwrite,
  conflictMessage,
  initSaveSync,
  reduceSaveSync,
  saveBadge,
  saveRequest,
  serverDecision,
  type SaveEvent,
  type SaveSync,
  type ServerDraft,
} from "@/components/gantt/save-sync";
import type { DraftConflict } from "@/lib/plan/draft-save";

const ME = "user-me";
const OTHER = "user-other";
const server = (over: Partial<ServerDraft> = {}): ServerDraft => ({ revisionId: "R1", version: 4, status: "draft", updatedAt: null, updatedBy: null, saveToken: null, ...over });
const run = (s: SaveSync, ...events: SaveEvent[]) => events.reduce(reduceSaveSync, s);
const start = () => initSaveSync(server(), "T0");
const conflict = (over: Partial<DraftConflict> = {}): DraftConflict => ({ kind: "conflict", version: 9, updatedAt: "2026-11-24T05:05:00Z", updatedBy: OTHER, updatedByName: "김계획", revNo: null, ...over });

describe("혼자 쓸 때 (예전과 같은 흐름)", () => {
  it("수정 → 저장 중 → 저장됨, 표시 순서가 예전과 같다", () => {
    let s = start();
    expect(saveBadge(s)).toBeNull();
    s = run(s, { type: "edit" });
    expect(saveBadge(s)).toBe("dirty");
    expect(canAutoSave(s)).toBe(true);
    s = run(s, { type: "saveStart" });
    expect(saveBadge(s)).toBe("saving");
    s = run(s, { type: "saveOk", version: 6, nextToken: "T1" });
    expect(saveBadge(s)).toBe("saved");
    expect(s.dirty).toBe(false);
  });

  it("연속 저장: 두 번째 저장은 첫 저장이 돌려준 version 을 기준으로 보낸다 → 충돌 아님", () => {
    let s = run(start(), { type: "edit" });
    expect(saveRequest(s)).toEqual({ revisionId: "R1", expectedVersion: 4, token: "T0" });
    s = run(s, { type: "saveStart" }, { type: "saveOk", version: 6, nextToken: "T1" }, { type: "edit" });
    expect(saveRequest(s)).toEqual({ revisionId: "R1", expectedVersion: 6, token: "T1" });
  });

  it("저장 중에는 다음 저장을 보내지 않고, 저장 중에 고친 것은 끝난 뒤 다시 저장한다", () => {
    let s = run(start(), { type: "edit" }, { type: "saveStart" }, { type: "edit" });
    expect(canAutoSave(s)).toBe(false);
    const seq = s.editSeq;
    s = run(s, { type: "saveOk", version: 6, nextToken: "T1" });
    expect(s.dirty).toBe(true);
    expect(s.editSeq).toBe(seq + 1); // 자동 저장 타이머를 다시 건다
    expect(canAutoSave(s)).toBe(true);
    expect(saveRequest(s).expectedVersion).toBe(6);
    expect(saveBadge(s)).toBe("dirty");
  });

  it("저장 실패는 예전처럼 「저장 실패」로 남고, 다음 수정 때 다시 저장한다", () => {
    let s = run(start(), { type: "edit" }, { type: "saveStart" }, { type: "saveError", message: "네트워크" });
    expect(saveBadge(s)).toBe("error");
    expect(s.error).toBe("네트워크");
    const seq = s.editSeq;
    s = run(s, { type: "edit" });
    expect(s.editSeq).toBe(seq + 1);
    expect(canAutoSave(s)).toBe(true);
    expect(saveBadge(s)).toBe("error"); // 다음 저장이 시작될 때까지 실패 표시 유지 (예전과 같음)
  });

  it("결과를 못 받은 저장 뒤에는 같은 표식(token)으로 다시 보낸다, 성공하면 새 표식", () => {
    let s = run(start(), { type: "edit" }, { type: "saveStart" }, { type: "saveError", message: "x" }, { type: "edit" });
    expect(saveRequest(s).token).toBe("T0");
    s = run(s, { type: "saveStart" }, { type: "saveOk", version: 8, nextToken: "T9" });
    expect(s.token).toBe("T9");
  });
});

describe("충돌", () => {
  it("거부되면 충돌 상태, 자동 저장을 멈추고 더 고쳐도 다시 보내지 않는다", () => {
    let s = run(start(), { type: "edit" }, { type: "saveStart" }, { type: "saveRejected", conflict: conflict() });
    expect(saveBadge(s)).toBe("conflict");
    expect(canAutoSave(s)).toBe(false);
    s = run(s, { type: "edit" }, { type: "edit" });
    expect(canAutoSave(s)).toBe(false);
    expect(blocksConfirm(s)).toBe(true);
  });

  it("「내 것으로 덮어쓰기」는 버전 확인 없이 보내고, 성공하면 정상으로 돌아온다", () => {
    let s = run(start(), { type: "edit" }, { type: "saveStart" }, { type: "saveRejected", conflict: conflict() });
    expect(canOverwrite(s)).toBe(true);
    expect(saveRequest(s, true).expectedVersion).toBeNull();
    s = run(s, { type: "saveStart" }, { type: "saveOk", version: 11, nextToken: "T2" });
    expect(saveBadge(s)).toBe("saved");
    expect(s.conflict).toBeNull();
    expect(saveRequest(run(s, { type: "edit" })).expectedVersion).toBe(11);
  });

  it("확정됐거나 없어진 초안에는 덮어쓸 수 없다", () => {
    for (const kind of ["confirmed", "missing"] as const) {
      const s = run(start(), { type: "edit" }, { type: "saveStart" }, { type: "saveRejected", conflict: conflict({ kind }) });
      expect(canOverwrite(s)).toBe(false);
    }
  });
});

describe("서버 값으로 다시 맞춰질 때 기준 갱신 (나 자신과의 충돌 방지)", () => {
  it("내 저장의 메아리(같은 version)는 받는다, 「저장됨」 표시는 그대로", () => {
    let s = run(start(), { type: "edit" }, { type: "saveStart" }, { type: "saveOk", version: 6, nextToken: "T1" });
    expect(serverDecision(s, server({ version: 6 }))).toBe("adopt");
    s = run(s, { type: "server", server: server({ version: 6 }), nextToken: "TX" });
    expect(saveBadge(s)).toBe("saved");
    expect(s.base).toEqual({ revisionId: "R1", version: 6 });
  });

  it("저장 중에 오는 서버 값은 받지 않는다 (결과는 saveOk 가 정한다)", () => {
    const s = run(start(), { type: "edit" }, { type: "saveStart" });
    expect(serverDecision(s, server({ version: 6 }))).toBe("keep");
  });

  it("메아리인데 그 뒤로 더 고쳤으면 내 화면을 지킨다", () => {
    const s = run(start(), { type: "edit" }, { type: "saveStart" }, { type: "saveOk", version: 6, nextToken: "T1" }, { type: "edit" });
    expect(serverDecision(s, server({ version: 6 }))).toBe("keep");
  });

  it("내 저장보다 오래된 서버 값은 무시한다", () => {
    const s = run(start(), { type: "edit" }, { type: "saveStart" }, { type: "saveOk", version: 6, nextToken: "T1" });
    expect(serverDecision(s, server({ version: 4 }))).toBe("keep");
  });

  it("생산계획표 안에서 엑셀 가져오기 직후: 더 새 version 을 받고 기준도 그 version → 다음 저장이 충돌 아님", () => {
    let s = run(start(), { type: "edit" }, { type: "saveStart" }, { type: "saveOk", version: 6, nextToken: "T1" });
    const imported = server({ version: 9, updatedBy: ME });
    expect(serverDecision(s, imported)).toBe("adopt");
    s = run(s, { type: "server", server: imported, nextToken: "T2" });
    expect(saveRequest(run(s, { type: "edit" }))).toMatchObject({ revisionId: "R1", expectedVersion: 9 });
  });

  it("「최신 내용 불러오기」 직후: 고친 것이 있어도 받고, 충돌이 풀리고, 기준이 최신 version", () => {
    let s = run(start(), { type: "edit" }, { type: "saveStart" }, { type: "saveRejected", conflict: conflict() }, { type: "reloadRequested" });
    expect(serverDecision(s, server({ version: 9 }))).toBe("adopt");
    s = run(s, { type: "server", server: server({ version: 9 }), nextToken: "T3" });
    expect(s.phase).toBe("idle");
    expect(s.dirty).toBe(false);
    expect(s.conflict).toBeNull();
    expect(s.reloadRequested).toBe(false);
    expect(canAutoSave(run(s, { type: "edit" }))).toBe(true);
    expect(saveRequest(run(s, { type: "edit" }))).toEqual({ revisionId: "R1", expectedVersion: 9, token: "T3" });
  });

  it("확정 직후 새 초안으로 넘어갈 때: 다른 Rev 이므로 받고, 기준이 새 초안", () => {
    let s = run(start(), { type: "edit" }, { type: "saveStart" }, { type: "saveOk", version: 6, nextToken: "T1" });
    const newDraft = server({ revisionId: "R2", version: 1 });
    expect(serverDecision(s, newDraft)).toBe("adopt");
    s = run(s, { type: "server", server: newDraft, nextToken: "T4" });
    expect(saveRequest(run(s, { type: "edit" }))).toEqual({ revisionId: "R2", expectedVersion: 1, token: "T4" });
  });

  it("기간·Rev 를 바꿨을 때: 저장 안 된 수정이 있어도 다른 Rev 이면 받는다 (예전 동작) — 기준이 그 Rev", () => {
    let s = run(start(), { type: "edit" });
    const other = server({ revisionId: "R7", version: 3 });
    expect(serverDecision(s, other)).toBe("adopt");
    s = run(s, { type: "server", server: other, nextToken: "T5" });
    expect(s.base).toEqual({ revisionId: "R7", version: 3 });
    expect(s.dirty).toBe(false);
  });

  it("저장 안 된 수정이 있는데 남이 더 새것을 저장했으면 충돌로 알린다", () => {
    let s = run(start(), { type: "edit" });
    const theirs = server({ version: 7, updatedBy: OTHER, updatedAt: "2026-11-24T05:00:00Z" });
    expect(serverDecision(s, theirs)).toBe("conflict");
    s = run(s, { type: "server", server: theirs, nextToken: "TX" });
    expect(saveBadge(s)).toBe("conflict");
    expect(s.conflict).toMatchObject({ kind: "conflict", version: 7, updatedBy: OTHER });
    expect(canOverwrite(s)).toBe(true);
  });

  it("고친 게 없으면 남의 새 저장을 그냥 받는다 (알릴 것이 없음)", () => {
    expect(serverDecision(start(), server({ version: 7, updatedBy: OTHER }))).toBe("adopt");
  });

  it("결과를 못 받았던 내 저장(같은 save_token)이 서버에 들어가 있으면 충돌이 아니라 기준만 맞춘다", () => {
    let s = run(start(), { type: "edit" }, { type: "saveStart" }, { type: "saveError", message: "x" });
    const mine = server({ version: 6, saveToken: "T0", updatedBy: ME });
    expect(serverDecision(s, mine)).toBe("rebase");
    s = run(s, { type: "server", server: mine, nextToken: "TX" });
    expect(s.base.version).toBe(6);
    expect(s.dirty).toBe(true);
    expect(saveRequest(s).expectedVersion).toBe(6);
  });

  it("보던 초안이 확정됐는데 저장 안 된 수정이 있으면 「확정됨」 충돌", () => {
    const s = run(start(), { type: "edit" }, { type: "server", server: server({ status: "confirmed" }), nextToken: "TX" });
    expect(s.conflict?.kind).toBe("confirmed");
    expect(canOverwrite(s)).toBe(false);
  });

  it("이미 충돌 상태면 더 새 서버 값이 와도 충돌 정보를 그대로 둔다", () => {
    const s = run(start(), { type: "edit" }, { type: "saveStart" }, { type: "saveRejected", conflict: conflict({ version: 9 }) });
    expect(serverDecision(s, server({ version: 12 }))).toBe("keep");
  });
});

describe("확정·삭제 막기, 표시", () => {
  it("저장 안 된 수정 · 저장 중 · 충돌이면 확정을 막는다", () => {
    expect(blocksConfirm(start())).toBe(false);
    expect(blocksConfirm(run(start(), { type: "edit" }))).toBe(true);
    expect(blocksConfirm(run(start(), { type: "edit" }, { type: "saveStart" }))).toBe(true);
    expect(blocksConfirm(run(start(), { type: "edit" }, { type: "saveStart" }, { type: "saveOk", version: 5, nextToken: "T1" }))).toBe(false);
  });

  it("충돌 문구: 다른 사람(이름·시각) / 다른 탭 / 확정됨 / 없어짐", () => {
    const t = (iso: string) => `T(${iso.slice(11, 16)})`;
    expect(conflictMessage(conflict(), ME, t)).toBe("다른 사람이 먼저 저장했습니다 (김계획 · T(05:05))");
    expect(conflictMessage(conflict({ updatedBy: ME, updatedByName: "나" }), ME, t)).toBe("다른 탭(창)에서 먼저 저장했습니다 (T(05:05))");
    expect(conflictMessage(conflict({ updatedByName: null, updatedAt: null, updatedBy: null }), ME, t)).toBe("다른 사람이 먼저 저장했습니다");
    expect(conflictMessage(conflict({ kind: "confirmed", revNo: 2 }), ME, t)).toContain("Rev 2으로 확정되었습니다");
    expect(conflictMessage(conflict({ kind: "missing" }), ME, t)).toContain("초안이 없어졌습니다");
  });
});
