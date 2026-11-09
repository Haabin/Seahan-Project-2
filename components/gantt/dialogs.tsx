"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button, inputClass } from "@/components/ui";
import { confirmRevision, deleteDowntime, upsertDowntime } from "@/lib/actions/plan";
import type { Downtime, Line } from "@/lib/engine/types";
import { fmtMD } from "@/lib/format";

export function Modal({ title, children, onClose, testId, extra }: { title: string; children: ReactNode; onClose: () => void; testId?: string; extra?: Record<string, string> }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-brand-darkest/30" onMouseDown={onClose}>
      <div
        data-testid={testId}
        {...extra}
        className="w-[520px] max-w-[92vw] rounded-[var(--radius-md)] border border-border bg-white p-5 shadow-[0_16px_40px_rgba(0,16,78,0.18)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-brand-deep">{title}</h3>
          <button className="text-text-muted hover:text-text" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const REASONS = ["설비", "품질", "인원", "출고계획", "급발주", "기타"] as const;

export function RevisionDialog({ planId, nextRevNo, dirty, onClose }: { planId: string; nextRevNo: number; dirty: boolean; onClose: () => void }) {
  const router = useRouter();
  const [category, setCategory] = useState<(typeof REASONS)[number] | "">("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isFirst = nextRevNo === 0;
  const valid = isFirst || (category !== "" && text.trim().length > 0);

  async function submit() {
    setBusy(true);
    setError(null);
    const r = await confirmRevision({ planId, reasonCategory: category || null, reasonText: text || null });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    onClose();
    router.replace(`/plan?rev=${r.data.newDraftId}`);
    router.refresh();
  }

  return (
    <Modal title={isFirst ? "계획 확정 (Rev 0)" : `변경 저장 (Rev ${nextRevNo})`} onClose={onClose} testId="revision-dialog" extra={{ "data-first-confirm": String(isFirst) }}>
      {dirty ? <p className="mb-2 rounded-[var(--radius-sm)] bg-warn-bg px-3 py-2 text-xs text-[#9a6b00]">저장되지 않은 수정이 있습니다. 잠시 후 다시 시도하세요.</p> : null}
      {isFirst ? (
        <p className="text-xs text-text-muted">현재 초안을 Rev 0(확정본)으로 저장합니다. 이후 변경은 사유와 함께 Rev 1, 2…로 기록됩니다.</p>
      ) : (
        <div className="space-y-3 text-xs">
          <p className="text-text-muted">확정 후 변경이므로 변경 사유를 반드시 기록합니다 (FR-04).</p>
          <div>
            <div className="mb-1 font-medium text-text-muted">사유 구분</div>
            <div className="flex flex-wrap gap-1.5">
              {REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setCategory(r)}
                  className={`rounded-full border px-3 py-1 ${category === r ? "border-brand bg-brand text-white" : "border-border bg-white text-text hover:bg-bg-sub"}`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1 font-medium text-text-muted">변경 내용</div>
            <textarea className={`${inputClass} h-20 py-2`} value={text} onChange={(e) => setText(e.target.value)} placeholder="예: PET 7호기 고장으로 500ml 원형 물량을 PET 3호기로 이동" />
          </div>
        </div>
      )}
      {error ? <p className="mt-3 text-xs text-danger">{error}</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          취소
        </Button>
        <Button variant="primary" data-testid="revision-confirm" disabled={!valid || busy || dirty} onClick={submit}>
          {busy ? "저장 중…" : isFirst ? "Rev 0으로 확정" : `Rev ${nextRevNo} 저장`}
        </Button>
      </div>
    </Modal>
  );
}

export function DowntimeDialog({ lines, downtimes, periodStart, onClose }: { lines: Line[]; downtimes: (Downtime & { id?: string })[]; periodStart: string; onClose: () => void }) {
  const router = useRouter();
  const [lineId, setLineId] = useState(lines[0]?.id ?? "");
  const [start, setStart] = useState(periodStart);
  const [end, setEnd] = useState(periodStart);
  const [reason, setReason] = useState("설비 고장");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lineName = new Map(lines.map((l) => [l.id, l.name]));

  async function add() {
    setBusy(true);
    setError(null);
    const r = await upsertDowntime({ lineId, startDate: start, endDate: end, reason });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    router.refresh();
  }
  async function remove(id: string) {
    const r = await deleteDowntime(id);
    if (!r.ok) return setError(r.error);
    router.refresh();
  }

  return (
    <Modal title="가동 불가일 등록 (FR-06)" onClose={onClose}>
      <div className="grid grid-cols-[1fr_130px_130px] gap-2 text-xs">
        <select className={inputClass} value={lineId} onChange={(e) => setLineId(e.target.value)}>
          {lines.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <input type="date" className={inputClass} value={start} onChange={(e) => setStart(e.target.value)} />
        <input type="date" className={inputClass} value={end} onChange={(e) => setEnd(e.target.value)} />
        <input className={`${inputClass} col-span-2`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="사유 (정전, 고장, 명절 휴무…)" />
        <Button variant="primary" onClick={add} disabled={busy}>
          추가
        </Button>
      </div>
      {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
      <ul className="mt-4 max-h-56 divide-y divide-border overflow-auto rounded-[var(--radius-sm)] border border-border text-xs">
        {downtimes.length === 0 ? <li className="px-3 py-2 text-text-muted">등록된 가동 불가일이 없습니다.</li> : null}
        {downtimes.map((d, i) => (
          <li key={d.id ?? i} className="flex items-center justify-between px-3 py-2">
            <span>
              <span className="font-medium">{lineName.get(d.lineId) ?? d.lineId}</span> · {fmtMD(d.startDate)}
              {d.endDate !== d.startDate ? ` ~ ${fmtMD(d.endDate)}` : ""} · {d.reason}
            </span>
            {d.id ? (
              <button className="text-text-muted hover:text-danger" onClick={() => remove(d.id!)}>
                삭제
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

export function ImportDialog({ periodStart, onClose }: { periodStart: string; onClose: () => void }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ cellCount: number; unmatched: { sheet: string; cellRef: string; lineCode: string; date: string; text: string }[]; warnings: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upload() {
    if (!file) return;
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("periodStart", periodStart);
    const res = await fetch("/api/import/plan", { method: "POST", body: fd });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) return setError(json.error ?? "업로드 실패");
    setResult(json);
    router.refresh();
  }

  return (
    <Modal title="현행 엑셀 계획표 가져오기 (FR-03)" onClose={onClose}>
      <p className="mb-3 text-xs text-text-muted">
        공정별 시트(1팀 PET1)의 호기 × 날짜 셀을 읽어 <b>현재 초안을 전체 교체</b>합니다. 제품명이 기준정보와 매칭되지 않은 셀은 아래 목록으로 보여줍니다. 사출기 행 숫자(Q1)는 무시됩니다.
      </p>
      <div className="flex items-center gap-2">
        <input type="file" accept=".xlsx" className="text-xs" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <Button variant="primary" size="sm" disabled={!file || busy} onClick={upload}>
          {busy ? "읽는 중…" : "가져오기"}
        </Button>
      </div>
      {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
      {result ? (
        <div className="mt-3 space-y-2 text-xs">
          <p className="text-ok">셀 {result.cellCount.toLocaleString()}개를 초안에 반영했습니다.</p>
          {result.unmatched.length ? (
            <div>
              <div className="mb-1 font-medium text-danger">매칭 실패 셀 {result.unmatched.length}개</div>
              <ul className="max-h-40 overflow-auto rounded-[var(--radius-sm)] border border-border">
                {result.unmatched.map((u, i) => (
                  <li key={i} className="flex justify-between px-2 py-1 odd:bg-bg-sub">
                    <span>
                      {u.lineCode} · {fmtMD(u.date)} · {u.cellRef}
                    </span>
                    <span className="text-text-muted">&ldquo;{u.text}&rdquo;</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {result.warnings.length ? (
            <details>
              <summary className="cursor-pointer text-text-muted">경고 {result.warnings.length}건</summary>
              <ul className="mt-1 max-h-32 overflow-auto text-text-muted">
                {result.warnings.map((w, i) => (
                  <li key={i}>· {w}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}

export function UploadDemandDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(kind: "shipments" | "inventory", file: File) {
    setBusy(kind);
    setError(null);
    setMsg(null);
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`/api/import/${kind}`, { method: "POST", body: fd });
    const json = await res.json();
    setBusy(null);
    if (!res.ok) return setError(json.error ?? "업로드 실패");
    const n = json.inserted ?? json.upserted ?? 0;
    setMsg(`${kind === "shipments" ? "출고일정표" : "제품수불일보"} ${n}건 반영${json.unmatched?.length ? ` · 매칭 실패 ${json.unmatched.length}건: ${json.unmatched.slice(0, 5).join(", ")}` : ""}`);
    router.refresh();
  }

  return (
    <Modal title="수요·재고 불러오기 (FR-05)" onClose={onClose}>
      <div className="space-y-3 text-xs">
        <div className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-border p-3">
          <div>
            <div className="font-medium">출고일정표 (.xlsx)</div>
            <div className="text-text-muted">출고예정일 · 거래처 · 대형거래선 · 제품명 · 수량. 파일 날짜 범위의 기존 출고계획을 교체합니다.</div>
          </div>
          <input type="file" accept=".xlsx" disabled={busy !== null} onChange={(e) => e.target.files?.[0] && send("shipments", e.target.files[0])} />
        </div>
        <div className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-border p-3">
          <div>
            <div className="font-medium">제품수불일보 (.xlsx)</div>
            <div className="text-text-muted">기준일 · 제품코드 · 제품명 · 양품현재고. (제품, 기준일) 기준으로 갱신합니다.</div>
          </div>
          <input type="file" accept=".xlsx" disabled={busy !== null} onChange={(e) => e.target.files?.[0] && send("inventory", e.target.files[0])} />
        </div>
        {busy ? <p className="text-text-muted">업로드 중…</p> : null}
        {msg ? <p className="text-ok">{msg}</p> : null}
        {error ? <p className="text-danger">{error}</p> : null}
      </div>
    </Modal>
  );
}
