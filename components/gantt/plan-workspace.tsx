"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { addDays, buildProductionIndex, computeCell, recalc, summarizePlan } from "@/lib/engine";
import type { CellResult, EngineInput, PlanCell, Violation } from "@/lib/engine/types";
import type { RevisionHeader } from "@/lib/data/load-engine-input";
import { savePlanDraft } from "@/lib/actions/plan";
import { Badge, Button, Card, cx } from "@/components/ui";
import { CellEditor } from "@/components/gantt/cell-editor";
import { cellMapKey, closeCellEdit, openCellEdit, patchCellEdit, previewCells, type CellEditSession } from "@/components/gantt/cell-edit-session";
import { ChangeoverBadge } from "@/components/gantt/changeover-badge";
import { badgeLabels, changeoverSiteLabel, DEFAULT_FACTOR_TABLE, describeCellTime, describeRate, rateFromLostHours, SHORT_LABEL_LEGEND, type CellTimeInfo } from "@/lib/engine/changeover";
import { DowntimeDialog, ImportDialog, RevisionDialog, UploadDemandDialog } from "@/components/gantt/dialogs";
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
}

const key = cellMapKey;

type Drag =
  | { kind: "move"; lineId: string; startIdx: number; endIdx: number; productId: string; grabIdx: number; hoverIdx: number; hoverLineId: string }
  | { kind: "resize"; lineId: string; startIdx: number; endIdx: number; productId: string; hoverIdx: number };

export function PlanWorkspace(p: PlanWorkspaceProps) {
  const router = useRouter();
  const editable = p.canWrite && p.selected.status === "draft" && !p.viewerMode;

  const [cells, setCells] = useState<Map<string, PlanCell>>(() => new Map(p.input.cells.map((c) => [key(c.lineId, c.date), c])));
  const [dirty, setDirty] = useState(false);
  // 서버에서 새 Rev/셀이 내려오면 로컬 상태를 그 값으로 맞춘다 (렌더 중 상태 조정 패턴)
  const [syncedSource, setSyncedSource] = useState(p.input.cells);
  if (syncedSource !== p.input.cells) {
    setSyncedSource(p.input.cells);
    setCells(new Map(p.input.cells.map((c) => [key(c.lineId, c.date), c])));
    setDirty(false);
  }
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  // 편집창: 바꾸는 값은 session.draft 에만 담고 "완료" 때 계획표에 반영한다 (X·Esc·바깥 클릭은 취소)
  const [editing, setEditing] = useState<{ lineId: string; date: string; anchor: DOMRect; session: CellEditSession } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dialog, setDialog] = useState<"revision" | "downtime" | "import" | "demand" | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
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
  const idxOf = useMemo(() => new Map(dates.map((d, i) => [d, i])), [dates]);

  // ---- 자동 저장 (초안만) ----
  useEffect(() => {
    if (!editable || !dirty) return;
    const t = setTimeout(async () => {
      setSaveState("saving");
      const r = await savePlanDraft(p.planId, [...cells.values()]);
      if (r.ok) {
        setSaveState("saved");
        setSaveError(null);
        setDirty(false);
      } else {
        setSaveState("error");
        setSaveError(r.error);
      }
    }, 1200);
    return () => clearTimeout(t);
  }, [cells, dirty, editable, p.planId]);

  function update(mutate: (m: Map<string, PlanCell>) => void) {
    if (!editable) return;
    setCells((prev) => {
      const m = new Map(prev);
      mutate(m);
      return m;
    });
    setDirty(true);
  }

  function patchCell(lineId: string, date: string, patch: Partial<PlanCell>) {
    update((m) => {
      const k = key(lineId, date);
      const cur = m.get(k) ?? { lineId, date, productId: null, qty: null, changeoverType: "NONE" as const, memo: null };
      const next = { ...cur, ...patch };
      if (next.productId === null) {
        next.qty = null;
        next.changeoverType = "NONE";
        next.lostHoursOverride = null;
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

  const applyDrag = (d: Drag) => {
    if (d.kind === "resize") {
      const newEnd = d.hoverIdx;
      update((m) => {
        if (newEnd > d.endIdx) {
          const template = m.get(key(d.lineId, dates[d.endIdx]));
          for (let i = d.endIdx + 1; i <= newEnd; i++) {
            m.set(key(d.lineId, dates[i]), { lineId: d.lineId, date: dates[i], productId: d.productId, qty: null, changeoverType: "NONE", memo: template?.memo ?? null });
          }
        } else if (newEnd < d.endIdx) {
          for (let i = newEnd + 1; i <= d.endIdx; i++) m.delete(key(d.lineId, dates[i]));
        }
      });
      return;
    }
    const delta = d.hoverIdx - d.grabIdx;
    const targetLine = d.hoverLineId;
    if (delta === 0 && targetLine === d.lineId) return;
    update((m) => {
      const moving: PlanCell[] = [];
      for (let i = d.startIdx; i <= d.endIdx; i++) {
        const c = m.get(key(d.lineId, dates[i]));
        if (c) moving.push(c);
        m.delete(key(d.lineId, dates[i]));
      }
      for (const c of moving) {
        const ni = idxOf.get(c.date)! + delta;
        if (ni < 0 || ni >= dates.length) continue;
        m.set(key(targetLine, dates[ni]), { ...c, lineId: targetLine, date: dates[ni] });
      }
    });
  };

  const applyDragRef = useRef(applyDrag);
  useEffect(() => {
    applyDragRef.current = applyDrag;
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
      if (movedRef.current) applyDragRef.current(drag!);
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
  const warningsCount = errors.length + shortages.length;

  function focusCell(lineId: string | null, date: string) {
    const target = lineId ? key(lineId, date) : null;
    setFocusKey(target);
    const el = gridRef.current?.querySelector<HTMLElement>(lineId ? `[data-key="${CSS.escape(target!)}"]` : `[data-date-col="${date}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
    setTimeout(() => setFocusKey(null), 1600);
  }

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
        setDirty(true);
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
        <span className="text-xs text-text-muted">
          수요·재고 기준 <span className="tnum text-text">{fmtDateTime(p.uploadedAt.shipment)}</span> / <span className="tnum text-text">{fmtDateTime(p.uploadedAt.inventory)}</span>
        </span>
        <div className="ml-auto flex items-center gap-2">
          {editable ? (
            <span className="text-[11px] text-text-faint" data-testid="save-state">
              {saveState === "saving" ? "저장 중…" : saveState === "error" ? <span className="text-danger">저장 실패: {saveError}</span> : dirty ? "수정됨" : saveState === "saved" ? "저장됨" : ""}
            </span>
          ) : (
            <Badge tone={p.selected.status === "confirmed" ? "info" : "neutral"}>{p.selected.status === "confirmed" ? "확정본 · 읽기 전용" : "읽기 전용"}</Badge>
          )}
          {p.canWrite && !p.viewerMode ? (
            <>
              <Button size="sm" onClick={() => setDialog("demand")}>
                수요·재고 업로드
              </Button>
              <Button size="sm" onClick={() => setDialog("downtime")}>
                가동 불가 등록
              </Button>
              <Button size="sm" onClick={() => setDialog("import")} disabled={!editable}>
                엑셀 가져오기
              </Button>
            </>
          ) : null}
          <a href={`/api/export/plan?revisionId=${p.selected.id}`} className="inline-flex h-7 items-center rounded-[var(--radius-sm)] border border-brand/40 bg-white px-2.5 text-xs font-medium text-brand hover:bg-brand-tint">
            엑셀 내보내기
          </a>
          {editable ? (
            <Button size="sm" variant="primary" data-testid="save-revision" onClick={() => setDialog("revision")}>
              {nextRevNo === 0 ? "확정 (Rev 0)" : `변경 저장 (Rev ${nextRevNo})`}
            </Button>
          ) : p.canWrite && !p.viewerMode && draft ? (
            <Button size="sm" variant="primary" onClick={() => router.push(`/plan?period=${p.input.periodStart}&rev=${draft.id}`)}>
              초안으로 이동
            </Button>
          ) : null}
        </div>
      </Card>

      <div className="grid grid-cols-[1fr_320px] gap-3">
        {/* 생산계획표 그리드 */}
        <Card className="overflow-hidden">
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
                      const dragging = drag && drag.lineId === line.id && idx >= drag.startIdx && idx <= drag.endIdx;
                      const dropPreview =
                        drag?.kind === "move" && drag.hoverLineId === line.id && idx - (drag.hoverIdx - drag.grabIdx) >= drag.startIdx && idx - (drag.hoverIdx - drag.grabIdx) <= drag.endIdx;
                      const resizePreview = drag?.kind === "resize" && drag.lineId === line.id && idx > drag.endIdx && idx <= drag.hoverIdx;
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
                            dropPreview || resizePreview ? "bg-info-bg" : "",
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
                                dragging ? "opacity-50" : "",
                                editable ? "cursor-grab active:cursor-grabbing" : "",
                              )}
                              style={
                                hasError
                                  ? undefined
                                  : { background: `var(--bar-${colorIdx})`, borderColor: `var(--bar-${colorIdx}-border)` }
                              }
                              title={`${product?.name ?? "?"}${r ? ` · 예상 ${fmtInt(r.expectedQty)}` : ""}${timeInfo ? ` · ${timeInfo.text}` : ""}${defaulted ? " · 교체유형 미입력(기본값 적용)" : ""}${outsideTable ? " · 비가동 시간 기준표 밖(계산값)" : ""}`}
                            >
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
                                      {c.qty !== null ? `${fmtInt(c.qty)} (입력)` : r ? `${fmtInt(r.expectedQty)}/일` : ""}
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
            <Legend swatch="hatched border border-border" label="가동 불가" />
            <Legend swatch="border-2 border-danger bg-danger-bg" label="제약 위반" />
            <span className="ml-auto tnum" suppressHydrationWarning>
              {mounted ? `재계산 ${result.computedMs.toFixed(0)}ms · ` : ""}셀 {cells.size}
            </span>
          </div>
        </Card>

        {/* 경고 목록 */}
        <Card className="flex flex-col overflow-hidden" style={{ maxHeight: "calc(100vh - 150px)" }}>
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <h2 className="text-sm font-semibold text-brand-deep">
              경고 <span className="tnum" data-testid="warning-count">{warningsCount}</span>건
            </h2>
            <span className="text-[11px] text-text-muted">주의 {notices.length}</span>
          </div>
          <div className="flex-1 space-y-1.5 overflow-auto p-2">
            {errors.map((v, i) => (
              <WarningItem key={`e${i}`} tone="danger" title={violationTitle(v)} body={v.message} onClick={() => focusCell(v.lineId, v.date)} />
            ))}
            {shortages.map((s) => (
              <WarningItem
                key={s.productId}
                tone="danger"
                title={`부족 · ${s.productName}`}
                body={`${s.firstShortageDate ? fmtMD(s.firstShortageDate) : ""}부터 −${fmtInt(s.firstShortageQty)}본`}
                onClick={() => {
                  const first = result.cells.find((c) => c.productId === s.productId);
                  if (first) focusCell(first.lineId, first.date);
                  else router.push("/supply");
                }}
              />
            ))}
            {result.supply
              .filter((s) => s.status === "warning")
              .map((s) => (
                <WarningItem key={`w${s.productId}`} tone="warn" title={`안전재고 미달 · ${s.productName}`} body={`${s.firstWarningDate ? fmtMD(s.firstWarningDate) : ""} · 안전재고 ${fmtInt(s.safetyStock)}`} onClick={() => router.push("/supply")} />
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
          readOnly={!editable}
          onChange={(patch) => setEditing((cur) => (cur ? { ...cur, session: patchCellEdit(cur.session, patch) } : cur))}
          onClear={() => {
            patchCell(editing.lineId, editing.date, { productId: null, memo: null });
            setEditing(null);
          }}
          clearDisabled={!editing.session.original?.productId && !editing.session.original?.memo}
          onDone={finishEdit}
          onCancel={() => setEditing(null)}
        />
      ) : null}

      {dialog === "revision" ? <RevisionDialog planId={p.planId} nextRevNo={nextRevNo} dirty={dirty || saveState === "saving"} onClose={() => setDialog(null)} /> : null}
      {dialog === "downtime" ? <DowntimeDialog lines={lines} downtimes={p.downtimeRows} periodStart={p.input.periodStart} onClose={() => setDialog(null)} /> : null}
      {dialog === "import" ? <ImportDialog periodStart={p.input.periodStart} onClose={() => setDialog(null)} /> : null}
      {dialog === "demand" ? <UploadDemandDialog onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

function violationTitle(v: Violation) {
  switch (v.code) {
    case "MOLD_NOT_ALLOWED":
      return "허용되지 않은 금형";
    case "CHANGEOVER_LIMIT":
      return "교체 횟수 초과";
    case "DOWNTIME_ASSIGNED":
      return "가동 불가일 배치";
    case "CHANGEOVER_DEFAULTED":
      return "교체유형 미입력 · 기본값 적용";
    case "UNKNOWN_PRODUCT":
      return "기준정보에 없는 제품";
    case "OUTSIDE_FACTOR_TABLE":
      return "비가동 시간 기준표 밖";
  }
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
