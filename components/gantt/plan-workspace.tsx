"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { addDays, buildProductionIndex, computeCell, recalc, summarizePlan } from "@/lib/engine";
import { EDITED_AUTO_PREFIX, type CellResult, type EngineInput, type PlanCell } from "@/lib/engine/types";
import type { DraftException, DraftResult } from "@/lib/engine/draft";
import type { DraftData } from "@/lib/data/draft-data";
import { DraftDialog } from "@/components/gantt/draft-dialog";
import { DraftTable } from "@/components/gantt/draft-table";
import { ExceptionGroups } from "@/components/gantt/exception-groups";
import type { RevisionHeader } from "@/lib/data/load-engine-input";
import { savePlanDraft } from "@/lib/actions/plan";
import { Badge, Button, Card, cx } from "@/components/ui";
import { CellEditor } from "@/components/gantt/cell-editor";
import { cellMapKey, closeCellEdit, openCellEdit, patchCellEdit, previewCells, type CellEditSession } from "@/components/gantt/cell-edit-session";
import { ChangeoverBadge } from "@/components/gantt/changeover-badge";
import { badgeLabels, changeoverSiteLabel, DEFAULT_FACTOR_TABLE, describeCellTime, describeRate, rateFromLostHours, SHORT_LABEL_LEGEND, type CellTimeInfo } from "@/lib/engine/changeover";
import { applyDragTo, buildAllowRules, dragIsNoop, inspectDrag, moveTargetNotAllowed, type Drag, type DragInspection } from "@/components/gantt/drag-plan";
import { DeletePlanDialog, DragConfirmDialog, OverwriteDraftDialog, DowntimeDialog, ImportDialog, RevisionDialog, UploadDemandDialog } from "@/components/gantt/dialogs";
import { buildConfirmSummary, safetyBody, safetyTitle, shortageBody, shortageTitle, violationTitle } from "@/components/gantt/plan-issues";
import { blocksConfirm, canAutoSave, canOverwrite, conflictMessage, initSaveSync, reduceSaveSync, saveBadge, saveRequest, serverDecision, type SaveEvent, type ServerDraft } from "@/components/gantt/save-sync";
import { colorIndexFor, dowKo, fmtDateTime, fmtInt, fmtMD } from "@/lib/format";

export interface PlanWorkspaceProps {
  planId: string;
  input: EngineInput;
  revisions: RevisionHeader[];
  selected: RevisionHeader;
  periods: string[];
  uploadedAt: { shipment: string | null; inventory: string | null };
  downtimeRows: { id: string; lineId: string; startDate: string; endDate: string; reason: string }[];
  canWrite: boolean;
  /** 호기 id → '제조사 · 모델' (line_specs). 없거나 빈 호기는 이름만 표시 */
  lineEquipment?: Record<string, string>;
  /** 조회 전용 화면(/view)에서는 툴바 일부를 숨긴다 */
  viewerMode?: boolean;
  /** 초안 자동 생성 입력(주문·과거 계획·금형·재고). 조회 화면에서는 없다 */
  draftData?: DraftData;
  /** 가져오기 직후 안내 */
  notice?: string | null;
  /** 초안 계획 삭제 버튼을 보일지 (admin · 확정 Rev 0개). 서버 액션이 다시 검사한다 */
  canDeletePlan?: boolean;
  /** 계획 기간 마지막 날 (삭제 확인창 표시용) */
  periodEnd?: string;
  /** 로그인 사용자 id. 충돌 알림에서 "다른 탭(창)"과 "다른 사람"을 구분한다 */
  currentUserId?: string;
}

const key = cellMapKey;
const newToken = () => crypto.randomUUID();
const serverDraftOf = (r: RevisionHeader): ServerDraft => ({
  revisionId: r.id,
  version: r.version ?? 0,
  status: r.status,
  updatedAt: r.updatedAt ?? null,
  updatedBy: r.updatedBy ?? null,
  saveToken: r.saveToken ?? null,
});

export function PlanWorkspace(p: PlanWorkspaceProps) {
  const router = useRouter();
  const editable = p.canWrite && p.selected.status === "draft" && !p.viewerMode;

  const [cells, setCells] = useState<Map<string, PlanCell>>(() => new Map(p.input.cells.map((c) => [key(c.lineId, c.date), c])));
  // 자동 저장 상태와 기준(초안 Rev id, version). 상태 전이는 save-sync.ts (순수 함수)
  const [sync, setSync] = useState(() => initSaveSync(serverDraftOf(p.selected), newToken()));
  const dispatchSync = (e: SaveEvent) => setSync((prev) => reduceSaveSync(prev, e));
  // 덮어쓰기·기간 밖·허용 금형 확인을 기다리는 드래그. 확인하면 그때 적용한다
  const [pendingDrag, setPendingDrag] = useState<{ drag: Drag; inspection: DragInspection } | null>(null);
  // 서버에서 새 Rev/셀이 내려오면 로컬 상태를 그 값으로 맞춘다 (렌더 중 상태 조정 패턴)
  const [syncedSource, setSyncedSource] = useState(p.input.cells);
  if (syncedSource !== p.input.cells) {
    setSyncedSource(p.input.cells);
    // 서버 값을 받을지 정한다: 기간·Rev 이동·불러오기·혼자 쓸 때는 받고(기준도 함께 갱신),
    // 저장 중이거나 저장 뒤 더 고친 내용이 있으면 내 화면을 지키고, 남이 먼저 바꿨으면 충돌로 알린다
    const server = serverDraftOf(p.selected);
    if (serverDecision(sync, server) === "adopt") setCells(new Map(p.input.cells.map((c) => [key(c.lineId, c.date), c])));
    setSync(reduceSaveSync(sync, { type: "server", server, nextToken: newToken() }));
    // 셀이 서버 값으로 바뀌었을 수 있으니, 이전 셀로 검사한 확인 대기는 버린다
    setPendingDrag(null);
  }
  const [overwriteOpen, setOverwriteOpen] = useState(false);
  const badge = saveBadge(sync);
  // 편집창: 바꾸는 값은 session.draft 에만 담고 "완료" 때 계획표에 반영한다 (X·Esc·바깥 클릭은 취소)
  const [editing, setEditing] = useState<{ lineId: string; date: string; anchor: DOMRect; session: CellEditSession } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dialog, setDialog] = useState<"revision" | "downtime" | "import" | "demand" | "draft" | "delete" | null>(null);
  const [draftResult, setDraftResult] = useState<DraftResult | null>(null);
  const [sideTab, setSideTab] = useState<"warnings" | "draft">("warnings");
  const [view, setView] = useState<"gantt" | "table">("gantt");
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const movedRef = useRef(false);
  // 재계산 시간은 서버/클라이언트가 다르므로 하이드레이션 후에만 표시한다
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  const input = useMemo<EngineInput>(() => ({ ...p.input, cells: [...cells.values()] }), [p.input, cells]);
  const result = useMemo(() => recalc(input), [input]);

  const lines = useMemo(() => p.input.lines.filter((l) => l.isPlanTarget).sort((a, b) => a.sortOrder - b.sortOrder), [p.input.lines]);
  const products = p.input.products;
  const productById = useMemo(() => new Map(products.map((x) => [x.id, x])), [products]);
  const lineById = useMemo(() => new Map(lines.map((l) => [l.id, l])), [lines]);
  const allowedByLine = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const a of p.input.allowedMolds) m.set(a.lineId, [...(m.get(a.lineId) ?? []), a.productId]);
    return m;
  }, [p.input.allowedMolds]);
  const resultByKey = useMemo(() => new Map(result.cells.map((c) => [key(c.lineId, c.date), c])), [result.cells]);
  // 교체 종류·소요시간·생산 가능시간 표시용 (엔진 계산값은 바꾸지 않음)
  const coefByKey = useMemo(() => new Map(p.input.changeoverCoefficients.map((c) => [`${c.processType}|${c.changeoverType}`, c])), [p.input.changeoverCoefficients]);
  const defaultChangeoverLabel = changeoverSiteLabel(p.input.settings.defaultChangeoverType);
  const timeInfoOf = (r: CellResult | undefined, lineId: string): CellTimeInfo | null => {
    if (!r) return null;
    const line = lineById.get(lineId);
    const coef = line && r.effectiveChangeover !== "NONE" ? coefByKey.get(`${line.processType}|${r.effectiveChangeover}`) ?? null : null;
    return describeCellTime({
      effectiveChangeover: r.effectiveChangeover,
      defaulted: r.changeoverDefaulted,
      isDowntime: r.isDowntime,
      coefficient: coef,
      overrideHours: r.lostHoursSource === "override" ? r.lostHours ?? 0 : null,
    });
  };
  const dates = result.periodDates;
  // 합계 행·열: 셀에 보이는 수량과 같은 값(입력 우선, 없으면 예상), 교체 횟수는 하루 한도 검사와 같은 규칙
  const summary = useMemo(() => summarizePlan(result.cells, lines.map((l) => l.id), dates), [result.cells, lines, dates]);
  const changeoverLimit = p.input.settings.dailyChangeoverLimit;

  // ---- 자동 저장 (초안만) ----
  // 저장은 한 번에 하나만. 화면이 본 version 과 같을 때만 저장되고, 다르면 충돌로 멈춘다
  const latest = useRef({ sync, cells });
  useEffect(() => {
    latest.current = { sync, cells };
  });
  async function runSave(force: boolean) {
    const { sync: s, cells: snapshot } = latest.current;
    if (s.phase === "saving") return;
    if (!force && !canAutoSave(s)) return;
    const req = saveRequest(s, force);
    dispatchSync({ type: "saveStart" });
    let r: Awaited<ReturnType<typeof savePlanDraft>>;
    try {
      r = await savePlanDraft(p.planId, [...snapshot.values()], req);
    } catch {
      // 응답을 못 받았다: 저장됐는지 모른다. 같은 표식으로 다시 보내면 DB 가 알아본다
      dispatchSync({ type: "saveError", message: "네트워크 오류로 저장 결과를 확인하지 못했습니다" });
      return;
    }
    if (r.ok) dispatchSync({ type: "saveOk", version: r.data.version, nextToken: newToken() });
    else if (r.conflict) dispatchSync({ type: "saveRejected", conflict: r.conflict });
    else dispatchSync({ type: "saveError", message: r.error });
  }
  const runSaveRef = useRef(runSave);
  useEffect(() => {
    runSaveRef.current = runSave;
  });
  const autoSaveWanted = editable && canAutoSave(sync);
  useEffect(() => {
    if (!autoSaveWanted) return;
    const t = setTimeout(() => void runSaveRef.current(false), 1200);
    return () => clearTimeout(t);
  }, [sync.editSeq, autoSaveWanted]);

  function markEdited() {
    dispatchSync({ type: "edit" });
  }

  /** 「최신 내용 불러오기」: 내 수정을 버리고 서버의 최신 초안을 다시 읽는다 */
  function reloadLatest() {
    dispatchSync({ type: "reloadRequested" });
    const kind = sync.conflict?.kind;
    // 확정됐거나 없어진 초안이면 그 기간의 새 초안(없으면 남은 계획)으로 간다
    if (kind === "confirmed") router.replace(`/plan?period=${p.input.periodStart}`);
    else if (kind === "missing") router.replace("/plan");
    router.refresh();
  }

  function update(mutate: (m: Map<string, PlanCell>) => void) {
    if (!editable) return;
    setCells((prev) => {
      const m = new Map(prev);
      mutate(m);
      return m;
    });
    markEdited();
  }

  function patchCell(lineId: string, date: string, patch: Partial<PlanCell>) {
    update((m) => {
      const k = key(lineId, date);
      const cur = m.get(k) ?? { lineId, date, productId: null, qty: null, changeoverType: "NONE" as const, memo: null };
      const next = { ...cur, ...patch };
      // 사람이 고친 셀로 표시한다. 자동 생성 셀이었으면 근거 앞에 표시를 남겨 나중에 수정 비율을 센다
      if (cur.origin === "auto") next.basis = `${EDITED_AUTO_PREFIX} · ${cur.basis ?? ""}`.slice(0, 300);
      next.origin = "manual";
      // 제품을 바꾸면 금형은 다시 골라야 한다(그 제품의 금형이 하나뿐이면 자동으로 넣는다)
      if (patch.productId !== undefined && patch.productId !== cur.productId && patch.moldId === undefined) {
        const options = (p.draftData?.molds ?? []).filter((x) => patch.productId && x.productIds.includes(patch.productId));
        next.moldId = options.length === 1 ? options[0].id : null;
      }
      if (next.productId === null) {
        next.qty = null;
        next.changeoverType = "NONE";
        next.lostHoursOverride = null;
        next.moldId = null;
      }
      if (next.productId === null && !next.memo) m.delete(k);
      else m.set(k, next);
    });
  }

  // ---- 연속 구간(run) 계산: 같은 호기에서 같은 제품이 이어지는 날짜 범위 ----
  function runAt(lineId: string, idx: number): { startIdx: number; endIdx: number; productId: string } | null {
    const c = cells.get(key(lineId, dates[idx]));
    if (!c?.productId) return null;
    let s = idx;
    let e = idx;
    while (s > 0 && cells.get(key(lineId, dates[s - 1]))?.productId === c.productId) s--;
    while (e < dates.length - 1 && cells.get(key(lineId, dates[e + 1]))?.productId === c.productId) e++;
    return { startIdx: s, endIdx: e, productId: c.productId };
  }

  // ---- 드래그 ----
  function onCellPointerDown(e: React.PointerEvent, lineId: string, idx: number, resizeHandle: boolean) {
    if (!editable || e.button !== 0) return;
    const run = runAt(lineId, idx);
    if (!run) return;
    movedRef.current = false;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    if (resizeHandle) setDrag({ kind: "resize", lineId, ...run, hoverIdx: idx });
    else setDrag({ kind: "move", lineId, ...run, grabIdx: idx, hoverIdx: idx, hoverLineId: lineId });
    e.preventDefault();
  }

  // 허용 금형 판정: 엔진 MOLD_NOT_ALLOWED 와 같은 기준
  const allowRules = useMemo(() => buildAllowRules(p.input.allowedMolds, products.map((x) => x.id)), [p.input.allowedMolds, products]);

  const applyDrag = (d: Drag) => {
    if (dragIsNoop(d)) return;
    update((m) => applyDragTo(m, d, dates));
  };

  /** 놓았을 때: 덮어쓰기·기간 밖·허용 금형 문제가 없으면 바로 적용, 있으면 확인창 */
  const dropDrag = (d: Drag) => {
    const inspection = inspectDrag(cells, d, dates, allowRules);
    if (inspection.needsConfirm) setPendingDrag({ drag: d, inspection });
    else applyDrag(d);
  };

  const dropDragRef = useRef(dropDrag);
  useEffect(() => {
    dropDragRef.current = dropDrag;
  });

  useEffect(() => {
    if (!drag) return;
    function onMove(e: PointerEvent) {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-line][data-idx]");
      if (!el) return;
      const lineId = el.dataset.line!;
      const idx = Number(el.dataset.idx);
      setDrag((d) => {
        if (!d) return d;
        if (d.kind === "resize") {
          if (idx !== d.hoverIdx) movedRef.current = true;
          return { ...d, hoverIdx: Math.max(d.startIdx, idx) };
        }
        if (idx !== d.hoverIdx || lineId !== d.hoverLineId) movedRef.current = true;
        return { ...d, hoverIdx: idx, hoverLineId: lineId };
      });
    }
    function onUp() {
      if (movedRef.current) dropDragRef.current(drag!);
      setDrag(null);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag]);

  // ---- 경고 목록 ----
  const errors = result.violations.filter((v) => v.severity === "error");
  const notices = result.violations.filter((v) => v.severity === "notice");
  const shortages = result.supply.filter((s) => s.status === "shortage");
  const safetyWarnings = result.supply.filter((s) => s.status === "warning");
  const warningsCount = errors.length + shortages.length;

  /** 목록에서 고른 칸으로 이동해 잠깐 강조한다. 품번별 표를 보고 있으면 그 칸이 든 줄로, 일정표면 그 칸으로 */
  function focusCell(lineId: string | null, date: string) {
    const target = lineId ? key(lineId, date) : null;
    const scrollGantt = () => {
      const el = gridRef.current?.querySelector<HTMLElement>(lineId ? `[data-key="${CSS.escape(target!)}"]` : `[data-date-col="${date}"]`);
      el?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
    };
    setFocusKey(target);
    setTimeout(() => setFocusKey(null), 2400);
    if (view === "table") {
      // 표에서 그 칸이 든 줄을 찾는다. 없으면(날짜 단위 경고 등) 일정표로 바꿔서 보여준다
      const row = target ? tableRef.current?.querySelector<HTMLElement>(`tr[data-run-cells~="${target}"]`) : null;
      if (row) {
        row.scrollIntoView({ block: "center", behavior: "smooth" });
        return;
      }
      setView("gantt");
      setTimeout(scrollGantt, 80);
      return;
    }
    scrollGantt();
  }

  // ---- 초안 자동 생성 ----
  function applyDraft(r: DraftResult) {
    setCells(new Map(r.cells.map((c) => [key(c.lineId, c.date), c])));
    markEdited();
    setDraftResult(r);
    setSideTab("draft");
    setView("table");
    setDialog(null);
  }
  const draftExceptionKeys = useMemo(() => {
    const m = new Map<string, DraftException["code"]>();
    for (const e of draftResult?.exceptions ?? []) if (e.lineId && e.date) m.set(key(e.lineId, e.date), e.code);
    return m;
  }, [draftResult]);
  const autoCount = useMemo(() => [...cells.values()].filter((c) => c.productId && c.origin === "auto").length, [cells]);
  const editedCount = useMemo(() => [...cells.values()].filter((c) => c.productId && c.origin === "manual" && c.basis?.startsWith(EDITED_AUTO_PREFIX)).length, [cells]);
  const moldById = useMemo(() => new Map((p.draftData?.molds ?? []).map((x) => [x.id, x] as const)), [p.draftData]);

  const confirmedCount = p.revisions.filter((r) => r.status === "confirmed").length;
  const nextRevNo = confirmedCount === 0 ? 0 : Math.max(...p.revisions.filter((r) => r.revNo !== null).map((r) => r.revNo!)) + 1;
  const draft = p.revisions.find((r) => r.status === "draft");
  const revLabel = (r: RevisionHeader) => (r.status === "draft" ? "초안 (편집 중)" : `Rev ${r.revNo}${r.reasonCategory ? ` · ${r.reasonCategory}` : ""}`);
  const downtimeSet = useMemo(() => new Set(result.cells.filter((c) => c.isDowntime).map((c) => key(c.lineId, c.date))), [result.cells]);

  // 편집창 표시값: draft 와, draft 를 끼워 그 칸만 다시 계산한 결과 (계획표·합계·경고는 그대로)
  const editingCell = editing ? editing.session.draft : null;
  const editingResult = useMemo(() => {
    if (!editing) return undefined;
    const line = lineById.get(editing.lineId);
    if (!line) return undefined;
    const previewInput: EngineInput = { ...input, cells: previewCells(cells, editing.session) };
    return computeCell(previewInput, buildProductionIndex(previewInput), line, editing.date, addDays(editing.date, -1));
  }, [editing, input, cells, lineById]);

  // 편집창: 비가동 시간 → 가동률 변환 근거, 비워 둘 때 쓰는 기준 시간 표기
  const factorTable = p.input.settings.factorTable ?? DEFAULT_FACTOR_TABLE;
  const editingCoef =
    editing && editingResult && editingResult.effectiveChangeover !== "NONE"
      ? coefByKey.get(`${lineById.get(editing.lineId)?.processType}|${editingResult.effectiveChangeover}`) ?? null
      : null;
  const editingRateNote = !editingResult?.productId
    ? null
    : editingResult.lostHours != null
      ? describeRate(rateFromLostHours(editingResult.lostHours, factorTable))
      : editingCoef?.nextDayStart
        ? "익일가동 → 교체일 생산 0"
        : describeRate(rateFromLostHours(0, factorTable));
  const editingStandardLabel = !editingResult?.productId
    ? null
    : editingResult.effectiveChangeover === "NONE"
      ? "0h (교체 없음)"
      : editingCoef
        ? editingCoef.nextDayStart
          ? "익일가동"
          : `${editingCoef.hours}h`
        : null;

  function finishEdit() {
    if (!editing) return;
    if (editable) {
      const r = closeCellEdit(cells, editing.session, "done");
      if (r.changed) {
        setCells(new Map(r.cells));
        markEdited();
      }
    }
    setEditing(null);
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 툴바 */}
      <Card className="flex flex-wrap items-center gap-2 px-3 py-2">
        <div className="flex items-center gap-1">
          <TabButton active>1-Stage</TabButton>
          <TabButton disabled title="2단계 범위">
            2-Stage · PE
          </TabButton>
          <TabButton disabled title="2단계 범위">
            2공장
          </TabButton>
        </div>
        <span className="mx-1 h-5 w-px bg-border" />
        <div className="flex items-center gap-1" role="group" aria-label="보기 방식">
          <button data-testid="view-gantt" onClick={() => setView("gantt")} className={cx("h-7 rounded-[var(--radius-sm)] px-2.5 text-xs font-medium", view === "gantt" ? "bg-brand-tint text-brand-deep" : "text-text-muted hover:bg-bg-sub")}>
            일정표
          </button>
          <button data-testid="view-table" onClick={() => setView("table")} className={cx("h-7 rounded-[var(--radius-sm)] px-2.5 text-xs font-medium", view === "table" ? "bg-brand-tint text-brand-deep" : "text-text-muted hover:bg-bg-sub")}>
            품번별 표
          </button>
        </div>
        <span className="mx-1 h-5 w-px bg-border" />
        <label className="flex items-center gap-1.5 text-xs text-text-muted">
          기간
          <select
            className="h-7 rounded-[var(--radius-sm)] border border-border bg-white px-2 text-xs text-text"
            value={p.input.periodStart}
            onChange={(e) => router.push(`${p.viewerMode ? "/view" : "/plan"}?period=${e.target.value}`)}
          >
            {p.periods.map((d) => (
              <option key={d} value={d}>
                {d} (목) ~ 15일
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-text-muted">
          Rev
          <select
            className="h-7 rounded-[var(--radius-sm)] border border-border bg-white px-2 text-xs text-text"
            value={p.selected.id}
            onChange={(e) => router.push(`${p.viewerMode ? "/view" : "/plan"}?period=${p.input.periodStart}&rev=${e.target.value}`)}
          >
            {p.revisions
              .filter((r) => p.canWrite || r.status === "confirmed")
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {revLabel(r)}
                </option>
              ))}
          </select>
        </label>
        {p.canDeletePlan && !p.viewerMode ? (
          // 위험 동작: 「확정」(오른쪽 끝)과 떨어진 왼쪽 기간·Rev 옆에 빨간 테두리로 둔다
          <button
            type="button"
            data-testid="delete-plan-open"
            onClick={() => setDialog("delete")}
            disabled={blocksConfirm(sync)}
            title={blocksConfirm(sync) ? "저장이 끝난 뒤 삭제할 수 있습니다" : "확정된 Rev가 없는 이 계획을 통째로 지웁니다 (관리자)"}
            className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-sm)] border border-danger/50 bg-white px-2.5 text-xs font-medium text-danger hover:bg-danger-bg disabled:cursor-not-allowed disabled:opacity-50"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
            </svg>
            초안 계획 삭제
          </button>
        ) : null}
        <span className="text-xs text-text-muted">
          수요·재고 기준 <span className="tnum text-text">{fmtDateTime(p.uploadedAt.shipment)}</span> / <span className="tnum text-text">{fmtDateTime(p.uploadedAt.inventory)}</span>
        </span>
        <div className="ml-auto flex items-center gap-2">
          {editable ? (
            <span data-testid="save-state" role="status" aria-live="polite">
              {badge === "conflict" ? (
                <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-danger/40 bg-danger-bg px-3 text-[13px] font-semibold text-danger" data-testid="save-conflict-badge">
                  <span className="h-2 w-2 rounded-full bg-danger" />
                  충돌 · 저장 멈춤
                </span>
              ) : badge === "saving" ? (
                <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-bg-sub px-3 text-[13px] font-semibold text-text-muted">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-text-muted" />
                  저장 중…
                </span>
              ) : badge === "error" ? (
                <span className="inline-flex h-7 items-center rounded-full border border-danger/40 bg-danger-bg px-3 text-[13px] font-semibold text-danger">저장 실패: {sync.error}</span>
              ) : badge === "dirty" ? (
                <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-warn/50 bg-warn-bg px-3 text-[13px] font-semibold text-[#9a6b00]">
                  <span className="h-2 w-2 rounded-full bg-warn" />
                  수정됨 · 곧 저장
                </span>
              ) : badge === "saved" ? (
                <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-ok/40 bg-ok-bg px-3 text-[13px] font-semibold text-ok">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="m5 12 5 5 9-10" />
                  </svg>
                  저장됨
                </span>
              ) : null}
            </span>
          ) : (
            <Badge tone={p.selected.status === "confirmed" ? "info" : "neutral"}>{p.selected.status === "confirmed" ? "확정본 · 읽기 전용" : "읽기 전용"}</Badge>
          )}
          {p.canWrite && !p.viewerMode ? (
            <>
              <Button size="sm" onClick={() => setDialog("demand")}>
                수요·재고
              </Button>
              <Button size="sm" onClick={() => setDialog("downtime")}>
                가동 불가 등록
              </Button>
              <Button size="sm" onClick={() => setDialog("import")}>
                엑셀 가져오기
              </Button>
              {p.draftData ? (
                <Button size="sm" variant="primary" data-testid="draft-open" onClick={() => setDialog("draft")} disabled={!editable} title={editable ? "주문을 과거 계획에 맞춰 초안으로 채웁니다" : "초안에서만 쓸 수 있습니다"}>
                  초안 자동 생성
                </Button>
              ) : null}
            </>
          ) : null}
          <a href={`/api/export/plan?revisionId=${p.selected.id}`} className="inline-flex h-7 items-center rounded-[var(--radius-sm)] border border-brand/40 bg-white px-2.5 text-xs font-medium text-brand hover:bg-brand-tint">
            엑셀 내보내기
          </a>
          {editable ? (
            <Button size="sm" data-testid="save-revision" onClick={() => setDialog("revision")}>
              {nextRevNo === 0 ? "확정 (Rev 0)" : `변경 저장 (Rev ${nextRevNo})`}
            </Button>
          ) : p.canWrite && !p.viewerMode && draft ? (
            <Button size="sm" variant="primary" onClick={() => router.push(`/plan?period=${p.input.periodStart}&rev=${draft.id}`)}>
              초안으로 이동
            </Button>
          ) : null}
        </div>
      </Card>

      {sync.phase === "conflict" && sync.conflict ? (
        <div role="alert" data-testid="save-conflict" className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border border-danger/40 bg-danger-bg px-3 py-2 text-xs">
          <span className="font-semibold text-danger">{conflictMessage(sync.conflict, p.currentUserId ?? null, fmtDateTime)}</span>
          <span className="text-text-muted">내 수정은 아직 저장되지 않았고, 자동 저장을 멈췄습니다.</span>
          <span className="ml-auto flex gap-2">
            <Button size="sm" variant="primary" data-testid="conflict-reload" onClick={reloadLatest}>
              최신 내용 불러오기
            </Button>
            {canOverwrite(sync) && editable ? (
              <Button size="sm" variant="danger" data-testid="conflict-overwrite" onClick={() => setOverwriteOpen(true)}>
                내 것으로 덮어쓰기
              </Button>
            ) : null}
          </span>
        </div>
      ) : null}
      {p.notice ? <p role="status" className="rounded-[var(--radius-sm)] border border-ok/30 bg-ok-bg px-3 py-2 text-xs text-ok">{p.notice}</p> : null}
      <div className="grid grid-cols-[1fr_320px] gap-3">
        {/* 생산계획표 그리드 */}
        {view === "table" ? (
          <Card className="overflow-hidden">
            <div ref={tableRef}>
            <DraftTable
              cells={[...cells.values()]}
              results={resultByKey}
              lines={lines}
              products={products}
              molds={p.draftData?.molds ?? []}
              dates={dates}
              editable={editable}
              exceptionKeys={draftExceptionKeys}
              focusKey={focusKey}
              onPatch={(lineId, date, patch) => patchCell(lineId, date, patch)}
              onOpen={(lineId, date) => {
                setView("gantt");
                // 일정표가 그려진 뒤 그 셀로 이동해 편집기를 연다
                setTimeout(() => {
                  focusCell(lineId, date);
                  const el = gridRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key(lineId, date))}"]`);
                  if (el) setEditing({ lineId, date, anchor: el.getBoundingClientRect(), session: openCellEdit(cells, lineId, date) });
                }, 60);
              }}
            />
            </div>
          </Card>
        ) : null}
        <Card className={cx("overflow-hidden", view === "table" ? "hidden" : "")}>
          <div ref={gridRef} className="overflow-auto" data-testid="gantt-grid" style={{ maxHeight: "calc(100vh - 190px)" }}>
            <table className="w-full border-separate border-spacing-0 text-xs" style={{ minWidth: 1100 }}>
              <thead className="sticky top-0 z-20 bg-white">
                <tr>
                  <th className="sticky left-0 z-30 w-[88px] border-b border-r border-border bg-white px-2 py-1.5 text-left font-semibold text-text-muted">호기</th>
                  {dates.map((d) => {
                    const dow = dowKo(d);
                    const weekend = dow === "토" || dow === "일";
                    return (
                      <th key={d} data-date-col={d} className={cx("border-b border-r border-border px-1 py-1.5 text-center font-medium", weekend ? "bg-bg-sub text-text-muted" : "text-text")}>
                        <div className="tnum">{fmtMD(d)}</div>
                        <div className={cx("text-[10px]", dow === "토" ? "text-accent" : dow === "일" ? "text-danger" : "text-text-faint")}>{dow}</div>
                      </th>
                    );
                  })}
                  <th className="sticky right-0 z-30 w-[76px] border-b border-l border-border bg-white px-2 py-1.5 text-right font-semibold text-text-muted">합계</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id} className="group">
                    <th className="sticky left-0 z-10 max-w-[88px] border-b border-r border-border bg-white px-2 py-0 text-left font-medium text-text group-hover:bg-bg-muted">
                      {line.name}
                      {/* 엑셀 계획표의 설비 3행(번호 / 제조사 / 모델)처럼 이름 아래 작게. 칸 높이는 셀(h-14)이 정하므로 바뀌지 않는다 */}
                      {p.lineEquipment?.[line.id] ? (
                        <div className="truncate text-[10px] font-normal leading-tight text-text-muted" title={p.lineEquipment[line.id]} data-testid="line-equipment">
                          {p.lineEquipment[line.id]}
                        </div>
                      ) : null}
                    </th>
                    {dates.map((d, idx) => {
                      const k = key(line.id, d);
                      const c = cells.get(k);
                      const r = resultByKey.get(k);
                      const product = c?.productId ? productById.get(c.productId) : undefined;
                      const isDown = downtimeSet.has(k);
                      const run = c?.productId ? runAt(line.id, idx) : null;
                      const isStart = run?.startIdx === idx;
                      const isEnd = run?.endIdx === idx;
                      const hasError = r?.violations.some((v) => v !== "CHANGEOVER_DEFAULTED" && v !== "UNKNOWN_PRODUCT" && v !== "OUTSIDE_FACTOR_TABLE");
                      const outsideTable = !!r?.violations.includes("OUTSIDE_FACTOR_TABLE");
                      const defaulted = r?.changeoverDefaulted;
                      const changeover = r && r.effectiveChangeover !== "NONE" && c?.productId;
                      // 교체 없는 칸에 비가동 시간을 직접 넣은 경우도 배지를 보인다
                      const overrideOnly = !changeover && !!c?.productId && r?.lostHoursSource === "override" && (r.lostHours ?? 0) > 0;
                      const timeInfo = changeover || overrideOnly ? timeInfoOf(r, line.id) : null;
                      const colorIdx = c?.productId ? colorIndexFor(c.productId) : 0;
                      const isAuto = c?.origin === "auto";
                      const isEdited = c?.origin === "manual" && !!c.basis?.startsWith(EDITED_AUTO_PREFIX);
                      const draftExc = draftExceptionKeys.get(k);
                      const mold = c?.moldId ? moldById.get(c.moldId) : undefined;
                      const dragging = drag && drag.lineId === line.id && idx >= drag.startIdx && idx <= drag.endIdx;
                      const dropPreview =
                        drag?.kind === "move" && drag.hoverLineId === line.id && idx - (drag.hoverIdx - drag.grabIdx) >= drag.startIdx && idx - (drag.hoverIdx - drag.grabIdx) <= drag.endIdx;
                      const resizePreview = drag?.kind === "resize" && drag.lineId === line.id && idx > drag.endIdx && idx <= drag.hoverIdx;
                      // 허용되지 않는 호기 위로 옮기는 중이면 미리보기를 빨강으로
                      const dropBlocked = dropPreview && !!drag && moveTargetNotAllowed(drag, allowRules);
                      const dow = dowKo(d);
                      const weekend = dow === "토" || dow === "일";
                      return (
                        <td
                          key={d}
                          data-key={k}
                          data-line={line.id}
                          data-idx={idx}
                          data-testid={editable && c?.productId ? "gantt-cell" : undefined}
                          className={cx(
                            "relative h-14 border-b border-r border-border p-0 align-middle",
                            weekend && !isDown ? "bg-bg-sub/60" : "",
                            isDown ? "hatched" : "",
                            focusKey === k ? "ring-2 ring-inset ring-accent" : "",
                            dropBlocked ? "bg-danger-bg" : dropPreview || resizePreview ? "bg-info-bg" : "",
                            editable ? "cursor-pointer" : "",
                          )}
                          onClick={(e) => {
                            if (movedRef.current) {
                              movedRef.current = false;
                              return;
                            }
                            if (!editable && !c?.productId) return;
                            setEditing({ lineId: line.id, date: d, anchor: (e.currentTarget as HTMLElement).getBoundingClientRect(), session: openCellEdit(cells, line.id, d) });
                          }}
                        >
                          {isDown && !c?.productId ? (
                            <div className="truncate px-1.5 text-[10px] text-text-muted">{p.input.downtimes.find((x) => x.lineId === line.id && x.startDate <= d && x.endDate >= d)?.reason ?? "가동 불가"}</div>
                          ) : null}
                          {c?.productId ? (
                            <div
                              onPointerDown={(e) => onCellPointerDown(e, line.id, idx, false)}
                              className={cx(
                                "absolute inset-y-1.5 flex items-center overflow-hidden border-y text-[11px] leading-tight",
                                isStart ? "left-1 rounded-l-[6px] border-l" : "left-0",
                                isEnd ? "right-1 rounded-r-[6px] border-r" : "right-0",
                                hasError ? "border-danger border-2 bg-danger-bg" : "",
                                outsideTable && !hasError ? "ring-1 ring-inset ring-warn" : "",
                                !hasError && draftExc ? "outline outline-2 -outline-offset-2 outline-warn" : "",
                                isAuto && !hasError ? "border-dashed" : "",
                                dragging ? "opacity-50" : "",
                                editable ? "cursor-grab active:cursor-grabbing" : "",
                              )}
                              style={
                                hasError
                                  ? undefined
                                  : { background: isAuto ? `color-mix(in srgb, var(--bar-${colorIdx}) 45%, white)` : `var(--bar-${colorIdx})`, borderColor: `var(--bar-${colorIdx}-border)` }
                              }
                              data-origin={c.origin ?? "manual"}
                              title={[
                                product?.name ?? "?",
                                c.qty !== null ? `계획 수량 ${fmtInt(c.qty)} (직접 넣은 값)` : r ? `예상 ${fmtInt(r.expectedQty)}` : "",
                                timeInfo ? timeInfo.text : "",
                                mold ? `금형 ${mold.moldNo}` : p.draftData ? "금형 미정" : "",
                                isAuto ? "자동 생성" : isEdited ? "자동 생성 후 사람이 수정" : "",
                                c.basis && !isEdited ? c.basis : "",
                                defaulted ? "교체유형 미입력(기본값 적용)" : "",
                                outsideTable ? "비가동 시간 기준표 밖(계산값)" : "",
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            >
                              {isEdited ? <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-accent" title="자동 생성 후 사람이 수정" /> : null}
                              {changeover ? (
                                <span
                                  className={cx("absolute left-0 top-0 h-full w-1", defaulted ? "bg-warn" : r?.effectiveChangeover === "FULL" ? "bg-brand-darkest" : "bg-brand-deep")}
                                  title={timeInfo ? badgeLabels(timeInfo, defaultChangeoverLabel).title : undefined}
                                />
                              ) : null}
                              <div className={cx("min-w-0 flex-1 px-1.5", changeover ? "pl-2.5" : "")}>
                                {isStart || idx === 0 ? (
                                  <>
                                    <div className="truncate font-medium text-text">{product?.name ?? "알 수 없는 제품"}</div>
                                    <div className="tnum truncate text-[10px] text-text-muted">
                                      {c.qty !== null ? fmtInt(c.qty) : r ? `${fmtInt(r.expectedQty)}/일` : ""}
                                    </div>
                                  </>
                                ) : (
                                  <div className="tnum truncate text-[10px] text-text-muted">{c.qty !== null ? fmtInt(c.qty) : r ? fmtInt(r.expectedQty) : ""}</div>
                                )}
                                {timeInfo ? <ChangeoverBadge info={timeInfo} defaultLabel={defaultChangeoverLabel} className="mt-0.5" /> : null}
                              </div>
                              {isEnd && editable ? (
                                <div
                                  onPointerDown={(e) => {
                                    e.stopPropagation();
                                    onCellPointerDown(e, line.id, idx, true);
                                  }}
                                  className="absolute right-0 top-0 h-full w-2 cursor-ew-resize hover:bg-brand/20"
                                  title="끌어서 연장"
                                />
                              ) : null}
                            </div>
                          ) : null}
                        </td>
                      );
                    })}
                    <td className="tnum sticky right-0 z-10 border-b border-l border-border bg-white px-2 text-right text-[11px] font-medium text-text group-hover:bg-bg-muted" data-testid="line-total">
                      {fmtInt(summary.byLine.get(line.id) ?? 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="sticky bottom-0 z-20 bg-white">
                <tr>
                  <th className="sticky left-0 z-30 border-t border-r border-border bg-bg-sub px-2 py-1 text-left text-[11px] font-semibold text-text-muted">일 합계</th>
                  {dates.map((d) => (
                    <td key={d} className="tnum border-r border-t border-border bg-bg-sub px-1 py-1 text-right text-[11px] text-text" data-testid="day-total">
                      {fmtInt(summary.byDate.get(d) ?? 0)}
                    </td>
                  ))}
                  <td className="tnum sticky right-0 z-30 border-l border-t border-border bg-bg-sub px-2 py-1 text-right text-[11px] font-semibold text-text">{fmtInt(summary.total)}</td>
                </tr>
                <tr>
                  <th className="sticky left-0 z-30 border-r border-t border-border bg-bg-sub px-2 py-1 text-left text-[11px] font-semibold text-text-muted" title={`하루 교체 한도 ${changeoverLimit}회`}>
                    교체 횟수
                  </th>
                  {dates.map((d) => {
                    const n = summary.changeoversByDate.get(d) ?? 0;
                    const over = n > changeoverLimit;
                    return (
                      <td
                        key={d}
                        className={cx("tnum border-r border-t border-border px-1 py-1 text-center text-[11px]", over ? "bg-danger-bg font-semibold text-danger" : "bg-bg-sub text-text")}
                        title={over ? `하루 교체 한도 ${changeoverLimit}회 초과` : `하루 교체 한도 ${changeoverLimit}회`}
                        data-testid="day-changeovers"
                      >
                        {n > 0 ? `${n}/${changeoverLimit}` : "–"}
                      </td>
                    );
                  })}
                  <td className="tnum sticky right-0 z-30 border-l border-t border-border bg-bg-sub px-2 py-1 text-right text-[11px] text-text-muted">
                    {[...summary.changeoversByDate.values()].reduce((a, b) => a + b, 0)}회
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-1.5 text-[11px] text-text-muted">
            <Legend swatch="rounded-sm border border-accent bg-[var(--bar-1)]" label="생산 계획" />
            <Legend swatch="bg-brand-deep w-1" label="B/M교체" />
            <Legend swatch="bg-brand-darkest w-1" label="FULLSET교체" />
            <Legend swatch="bg-warn w-1" label="교체유형 미입력(기본값)" />
            <span className="text-text-faint" data-testid="changeover-legend">
              교체 칸 짧은 표기: {SHORT_LABEL_LEGEND.map(([k, v]) => `${k} = ${v}`).join(", ")} · 칸이 넓으면 전체 용어와 가동(생산 가능)시간, 마우스를 올리면 전체 설명
            </span>
            <Legend swatch="rounded-sm border border-dashed border-accent bg-white" label={`자동 생성 ${autoCount}`} />
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" /> 사람이 수정 {editedCount}
            </span>
            <Legend swatch="outline outline-2 -outline-offset-1 outline-warn" label="확인 필요" />
            <Legend swatch="hatched border border-border" label="가동 불가" />
            <Legend swatch="border-2 border-danger bg-danger-bg" label="제약 위반" />
            <span className="ml-auto tnum" suppressHydrationWarning>
              {mounted ? `재계산 ${result.computedMs.toFixed(0)}ms · ` : ""}셀 {cells.size}
            </span>
          </div>
        </Card>

        {/* 경고 목록 */}
        <Card className="flex flex-col overflow-hidden" style={{ maxHeight: "calc(100vh - 150px)" }}>
          {draftResult ? (
            <div className="flex border-b border-border text-xs">
              <button className={cx("flex-1 px-3 py-2 font-medium", sideTab === "draft" ? "border-b-2 border-brand text-brand-deep" : "text-text-muted")} onClick={() => setSideTab("draft")} data-testid="draft-tab">
                확인 필요 {draftResult.exceptions.length}
              </button>
              <button className={cx("flex-1 px-3 py-2 font-medium", sideTab === "warnings" ? "border-b-2 border-brand text-brand-deep" : "text-text-muted")} onClick={() => setSideTab("warnings")}>
                경고 {warningsCount}
              </button>
            </div>
          ) : null}
          {draftResult && sideTab === "draft" ? (
            <div className="flex-1 space-y-2 overflow-auto p-2 text-xs" data-testid="draft-result">
              <p className="rounded-[var(--radius-sm)] bg-info-bg px-2 py-1.5 text-text">
                초안 셀 {draftResult.createdCount}개를 만들었습니다{draftResult.keptCount ? ` (기존 ${draftResult.keptCount}개 유지)` : ""}. 확인한 뒤 「확정 / 변경 저장」을 눌러야 확정됩니다.
              </p>
              <ExceptionGroups exceptions={draftResult.exceptions} onPick={(e) => (e.lineId && e.date ? focusCell(e.lineId, e.date) : e.code === "UNMATCHED_ORDER" ? router.push("/orders") : undefined)} />
              <h3 className="px-1 pt-1 font-semibold text-brand-deep">주문별 결과</h3>
              {draftResult.orders.map((o) => (
                <button
                  key={o.orderId}
                  className="block w-full rounded-[var(--radius-sm)] border border-border px-2 py-1.5 text-left hover:bg-bg-muted"
                  onClick={() => (o.assignments[0] ? focusCell(o.assignments[0].lineId, o.assignments[0].date) : undefined)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium text-text">{o.productName}</span>
                    <Badge tone={o.status === "ok" || o.status === "stock" ? "ok" : o.status === "late" ? "warn" : "danger"}>
                      {o.status === "ok" ? "납기 충족" : o.status === "stock" ? "재고로 충족" : o.status === "late" ? "납기 지연" : o.status === "short" ? "수량 부족" : "매칭 안 됨"}
                    </Badge>
                  </div>
                  <div className="tnum mt-0.5 text-text-muted">
                    납기 {fmtMD(o.dueDate)} · 주문 {fmtInt(o.required)}
                    {o.stockUsed ? ` · 재고 ${fmtInt(o.stockUsed)}` : ""} · 계획 {fmtInt(o.planned)}
                    {o.shortage ? ` · 납기 내 부족 ${fmtInt(o.shortage)}` : ""}
                  </div>
                  {o.assignments.length ? (
                    <div className="tnum mt-0.5 truncate text-[11px] text-text-faint">
                      {Array.from(new Set(o.assignments.map((a) => lineById.get(a.lineId)?.name ?? ""))).join(", ")} · {fmtMD(o.assignments[0].date)}~{fmtMD(o.assignments[o.assignments.length - 1].date)} ({o.assignments.length}일)
                    </div>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
          <div className={cx("flex items-center justify-between border-b border-border px-3 py-2", draftResult ? "hidden" : "")}>
            <h2 className="text-sm font-semibold text-brand-deep">
              경고 <span className="tnum" data-testid="warning-count">{warningsCount}</span>건
            </h2>
            <span className="text-[11px] text-text-muted">주의 {notices.length}</span>
          </div>
          <div className={cx("flex-1 space-y-1.5 overflow-auto p-2", draftResult && sideTab === "draft" ? "hidden" : "")}>
            {errors.map((v, i) => (
              <WarningItem key={`e${i}`} tone="danger" title={violationTitle(v)} body={v.message} onClick={() => focusCell(v.lineId, v.date)} />
            ))}
            {shortages.map((s) => (
              <WarningItem
                key={s.productId}
                tone="danger"
                title={shortageTitle(s)}
                body={shortageBody(s)}
                onClick={() => {
                  const first = result.cells.find((c) => c.productId === s.productId);
                  if (first) focusCell(first.lineId, first.date);
                  else router.push("/supply");
                }}
              />
            ))}
            {safetyWarnings.map((s) => (
              <WarningItem key={`w${s.productId}`} tone="warn" title={safetyTitle(s)} body={safetyBody(s)} onClick={() => router.push("/supply")} />
            ))}
            {notices.map((v, i) => (
              <WarningItem key={`n${i}`} tone="warn" title={violationTitle(v)} body={v.message} onClick={() => focusCell(v.lineId, v.date)} />
            ))}
            {warningsCount === 0 && notices.length === 0 ? <p className="px-2 py-6 text-center text-xs text-text-muted">경고가 없습니다.</p> : null}
          </div>
        </Card>
      </div>

      {editing ? (
        <CellEditor
          anchor={editing.anchor}
          lineName={lineById.get(editing.lineId)?.name ?? ""}
          date={editing.date}
          cell={editingCell}
          result={editingResult}
          timeInfo={editingCell?.productId ? timeInfoOf(editingResult, editing.lineId) : null}
          rateNote={editingRateNote}
          standardHoursLabel={editingStandardLabel}
          allowedProducts={(allowedByLine.get(editing.lineId) ?? []).map((id) => productById.get(id)!).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, "ko"))}
          allProducts={products}
          molds={p.draftData?.molds}
          readOnly={!editable}
          onChange={(patch) =>
            setEditing((cur) => {
              if (!cur) return cur;
              let next = patch;
              // 제품을 바꾸면 금형은 다시 골라야 한다(그 제품의 금형이 하나뿐이면 자동으로 넣는다)
              if (patch.productId !== undefined && patch.productId !== cur.session.draft.productId && patch.moldId === undefined) {
                const options = (p.draftData?.molds ?? []).filter((x) => patch.productId && x.productIds.includes(patch.productId));
                next = { ...patch, moldId: options.length === 1 ? options[0].id : null };
              }
              return { ...cur, session: patchCellEdit(cur.session, next) };
            })
          }
          onClear={() => {
            patchCell(editing.lineId, editing.date, { productId: null, memo: null });
            setEditing(null);
          }}
          clearDisabled={!editing.session.original?.productId && !editing.session.original?.memo}
          onDone={finishEdit}
          onCancel={() => setEditing(null)}
        />
      ) : null}

      {dialog === "revision" ? (
        <RevisionDialog
          planId={p.planId}
          nextRevNo={nextRevNo}
          dirty={blocksConfirm(sync)}
          // 경고 패널과 같은 계산 결과(errors·shortages·safetyWarnings·notices·draftResult)를 그대로 넘긴다
          summary={buildConfirmSummary({ errors, shortages, safetyWarnings, notices, draftExceptions: draftResult ? draftResult.exceptions : null })}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "delete" && p.canDeletePlan ? (
        <DeletePlanDialog
          planId={p.planId}
          periodStart={p.input.periodStart}
          periodEnd={p.periodEnd ?? addDays(p.input.periodStart, 14)}
          cellCount={cells.size}
          otherRevisionCount={p.revisions.filter((r) => r.id !== p.selected.id).length}
          dirty={blocksConfirm(sync)}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {overwriteOpen && sync.conflict ? (
        <OverwriteDraftDialog
          message={conflictMessage(sync.conflict, p.currentUserId ?? null, fmtDateTime)}
          onConfirm={() => {
            setOverwriteOpen(false);
            void runSaveRef.current(true);
          }}
          onCancel={() => setOverwriteOpen(false)}
        />
      ) : null}
      {pendingDrag ? (
        <DragConfirmDialog
          inspection={pendingDrag.inspection}
          lineName={(id) => lineById.get(id)?.name ?? p.input.lines.find((l) => l.id === id)?.name ?? id}
          productName={(id) => (id ? productById.get(id)?.name ?? "알 수 없는 제품" : null)}
          onConfirm={() => {
            applyDrag(pendingDrag.drag);
            setPendingDrag(null);
          }}
          onCancel={() => setPendingDrag(null)}
        />
      ) : null}
      {dialog === "downtime" ? <DowntimeDialog lines={lines} downtimes={p.downtimeRows} periodStart={p.input.periodStart} onClose={() => setDialog(null)} /> : null}
      {dialog === "import" ? <ImportDialog periodStart={p.input.periodStart} products={products.map((x) => ({ id: x.id, name: x.name }))} onClose={() => setDialog(null)} /> : null}
      {dialog === "draft" && p.draftData ? <DraftDialog
          input={input}
          cells={[...cells.values()]}
          data={p.draftData}
          onApply={applyDraft}
          onClearAuto={() => {
            const removed = [...cells.values()].filter((c) => c.origin === "auto").length;
            setCells((prev) => new Map([...prev].filter(([, c]) => c.origin !== "auto")));
            markEdited();
            setDraftResult(null);
            setSideTab("warnings");
            return removed;
          }}
          onClose={() => setDialog(null)}
        /> : null}
      {dialog === "demand" ? <UploadDemandDialog onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

function WarningItem({ tone, title, body, onClick }: { tone: "danger" | "warn"; title: string; body: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "block w-full rounded-[var(--radius-sm)] border-l-4 px-3 py-2 text-left text-xs transition-colors",
        tone === "danger" ? "border-danger bg-danger-bg hover:brightness-[0.98]" : "border-warn bg-warn-bg hover:brightness-[0.98]",
      )}
    >
      <div className="font-medium text-text">{title}</div>
      <div className="mt-0.5 text-text-muted">{body}</div>
    </button>
  );
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cx("inline-block h-3 w-4", swatch)} />
      {label}
    </span>
  );
}

function TabButton({ active, disabled, children, title }: { active?: boolean; disabled?: boolean; children: React.ReactNode; title?: string }) {
  return (
    <button
      disabled={disabled}
      title={title}
      className={cx(
        "h-7 rounded-[var(--radius-sm)] px-3 text-xs font-medium",
        active ? "bg-brand text-white" : "border border-border bg-white text-text-muted",
        disabled ? "cursor-not-allowed opacity-50" : "",
      )}
    >
      {children}
    </button>
  );
}

export type { CellResult };
