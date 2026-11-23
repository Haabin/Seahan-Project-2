"use client";

import { useMemo, useState } from "react";
import { Badge, Button, cx, inputSmClass } from "@/components/ui";
import { ChangeoverMark } from "@/components/gantt/marks";
import { dowKo, fmtInt, fmtMD } from "@/lib/format";

export interface BaedaePreview {
  format: "baedae";
  filename: string;
  revNo: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  dates: string[];
  isThursday: boolean;
  lines: { code: string; name: string; allowedText: string[] }[];
  cells: { lineCode: string; date: string; productName: string; changeoverType: "NONE" | "BM" | "FULL"; qty: number | null; memo: string | null; source: "name" | "arrow"; cover: number | null }[];
  names: { name: string; days: number; lines: string[]; productId: string | null; candidates: string[] }[];
  existingRevs: number[];
  resinCount: number;
  sheets: { sheetName: string; stats: { rectFull: number; rectBm: number; textBoxes: number; hrBoxes: number; arrows: number }; machineCount: number; stored: boolean; warnings: string[]; infoCount: number }[];
  warnings: string[];
  skippedSheets: string[];
}

interface ProductOption {
  id: string;
  name: string;
}

/**
 * 생산배대 가져오기 미리보기.
 * 원본을 간트로 보여주고, 도형 해석 결과(네모 = 교체, 화살표 = 진행 기간)를 겹쳐 표시해 사람이 눈으로 확인한다.
 */
export function BaedaeImportPreview({ preview, file, products, onDone }: { preview: BaedaePreview; file: File; products: ProductOption[]; onDone: (periodStart: string, message: string) => void }) {
  const unmatched = preview.names.filter((n) => !n.productId);
  const [mapping, setMapping] = useState<Record<string, string>>(() => Object.fromEntries(unmatched.map((n) => [n.name, "new"])));
  const [revNo, setRevNo] = useState<string>(preview.revNo === null ? "" : String(preview.revNo));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cellByKey = useMemo(() => new Map(preview.cells.map((c) => [`${c.lineCode}|${c.date}`, c] as const)), [preview.cells]);
  const matched = useMemo(() => new Set(preview.names.filter((n) => n.productId).map((n) => n.name)), [preview.names]);
  const stored = preview.sheets.filter((s) => s.stored);
  const others = preview.sheets.filter((s) => !s.stored);
  const full = stored.reduce((a, s) => a + s.stats.rectFull, 0);
  const bm = stored.reduce((a, s) => a + s.stats.rectBm, 0);
  const arrows = stored.reduce((a, s) => a + s.stats.arrows, 0);
  const warnings = stored.flatMap((s) => s.warnings);
  const revTaken = revNo !== "" && preview.existingRevs.includes(Number(revNo));
  const nextRev = preview.existingRevs.length ? Math.max(...preview.existingRevs) + 1 : 0;

  async function apply() {
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.set("file", file);
    fd.set("mode", "apply");
    fd.set("revNo", revNo);
    fd.set("mapping", JSON.stringify(mapping));
    try {
      const res = await fetch("/api/import/baedae", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) setError(json.error ?? "저장에 실패했습니다");
      else {
        const extra = [json.createdProducts?.length ? `새 제품 ${json.createdProducts.length}개 등록` : "", json.skippedCells ? `건너뛴 칸 ${json.skippedCells}개` : ""].filter(Boolean).join(" · ");
        onDone(json.periodStart, `생산배대를 Rev ${json.savedRevNo}(확정)로 저장했습니다. 셀 ${json.savedCells}개${extra ? ` · ${extra}` : ""}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 text-xs" data-testid="baedae-preview">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="info">생산배대 형식</Badge>
        <span className="font-medium text-text">{preview.filename}</span>
        <span className="text-text-muted">
          {preview.periodStart} ~ {preview.periodEnd} · 호기 {preview.lines.length} · 생산 칸 {preview.cells.length}
        </span>
        {!preview.isThursday ? <Badge tone="warn">시작일이 목요일이 아닙니다</Badge> : null}
      </div>
      <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-sm)] bg-bg-sub px-3 py-2">
        <span className="flex items-center gap-1.5">
          <ChangeoverMark type="FULL" /> 엑셀의 큰 네모 = Full set 교체 <b className="tnum">{full}</b>
        </span>
        <span className="flex items-center gap-1.5">
          <ChangeoverMark type="BM" /> 엑셀의 작은 네모 = B/M 교체 <b className="tnum">{bm}</b>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-brand-deep">⟶</span> 엑셀의 가로 화살표 = 진행 기간 <b className="tnum">{arrows}</b>
        </span>
        <span className="text-text-muted">빈 칸 = 대기 · 주황 글자 = 기준정보에 없는 제품명</span>
      </div>

      {/* 원본을 간트로 */}
      <div className="max-h-[38vh] overflow-auto rounded-[var(--radius-sm)] border border-border">
        <table className="border-separate border-spacing-0 text-[11px]" data-testid="baedae-gantt">
          <thead className="sticky top-0 z-10 bg-white">
            <tr>
              <th className="sticky left-0 z-20 border-b border-r border-border bg-white px-2 py-1 text-left">호기</th>
              {preview.dates.map((d) => (
                <th key={d} className={cx("min-w-[92px] border-b border-r border-border px-1 py-1 font-medium", dowKo(d) === "토" || dowKo(d) === "일" ? "bg-bg-sub text-text-muted" : "")}>
                  {fmtMD(d)} {dowKo(d)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.lines.map((l) => (
              <tr key={l.code}>
                <th className="sticky left-0 z-10 whitespace-nowrap border-b border-r border-border bg-white px-2 py-1 text-left font-medium" title={l.allowedText.join(" / ")}>
                  {l.name}
                </th>
                {preview.dates.map((d) => {
                  const c = cellByKey.get(`${l.code}|${d}`);
                  if (!c) return <td key={d} className="border-b border-r border-border" />;
                  const known = matched.has(c.productName);
                  return (
                    <td key={d} className={cx("border-b border-r border-border px-1 py-1 align-top", c.source === "arrow" ? "bg-info-bg/60" : "bg-info-bg")} title={[c.productName, c.memo, c.cover !== null ? `화살표 ${Math.round(c.cover * 100)}%` : ""].filter(Boolean).join(" · ")}>
                      <div className="flex items-center gap-1">
                        {c.changeoverType !== "NONE" ? <ChangeoverMark type={c.changeoverType} /> : null}
                        {c.source === "arrow" ? (
                          <span className="flex-1 text-center text-brand-deep">⟶</span>
                        ) : (
                          <span className={cx("max-w-[110px] truncate font-medium", known ? "text-text" : "text-[#b45309]")}>{c.productName}</span>
                        )}
                      </div>
                      {c.qty !== null ? <div className="tnum text-[10px] text-text-muted">{fmtInt(c.qty)}본</div> : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 제품명 매칭 */}
      {unmatched.length ? (
        <div>
          <div className="mb-1 flex items-center gap-2">
            <b className="text-[#b45309]">기준정보에 없는 제품명 {unmatched.length}개</b>
            <span className="text-text-muted">기존 제품에 연결하거나, 새 제품으로 등록하거나, 건너뛰세요.</span>
            <button className="text-accent hover:underline" onClick={() => setMapping(Object.fromEntries(unmatched.map((n) => [n.name, "new"])))}>
              모두 새 제품으로
            </button>
            <button className="text-accent hover:underline" onClick={() => setMapping(Object.fromEntries(unmatched.map((n) => [n.name, "skip"])))}>
              모두 건너뛰기
            </button>
          </div>
          <div className="max-h-[22vh] overflow-auto rounded-[var(--radius-sm)] border border-border" data-testid="baedae-matching">
            {unmatched.map((n) => (
              <div key={n.name} className="grid grid-cols-[minmax(160px,1fr)_70px_220px] items-center gap-2 border-b border-border px-2 py-1 last:border-b-0">
                <div className="min-w-0">
                  <div className="truncate font-medium">{n.name}</div>
                  <div className="truncate text-[10px] text-text-muted" title={n.candidates.join(", ")}>
                    {n.lines.join(", ")} · 생산 가능 금형: {n.candidates.slice(0, 5).join(", ") || "–"}
                  </div>
                </div>
                <span className="tnum text-text-muted">{n.days}일</span>
                <select aria-label={`${n.name} 매칭`} className={inputSmClass} value={mapping[n.name] ?? "skip"} onChange={(e) => setMapping({ ...mapping, [n.name]: e.target.value })}>
                  <option value="new">새 제품으로 등록</option>
                  <option value="skip">건너뛰기(이 칸은 저장 안 함)</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      연결: {p.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-ok">제품명 {preview.names.length}종이 모두 기준정보와 매칭됐습니다.</p>
      )}

      {warnings.length || preview.warnings.length ? (
        <details open={warnings.length <= 5}>
          <summary className="cursor-pointer font-medium text-[#9a6b00]">확인할 점 {warnings.length + preview.warnings.length}건</summary>
          <ul className="mt-1 max-h-28 list-disc space-y-0.5 overflow-auto pl-5 text-text-muted">
            {[...preview.warnings, ...warnings].map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {others.length || preview.skippedSheets.length ? (
        <p className="text-text-muted">
          저장하지 않는 시트: {[...others.map((s) => `${s.sheetName}(호기 ${s.machineCount}, 네모 ${s.stats.rectFull + s.stats.rectBm}, 화살표 ${s.stats.arrows})`), ...preview.skippedSheets].join(" · ")}
          {preview.resinCount ? ` · 사출 설비의 일일 원료 소비량 ${preview.resinCount}건은 함께 저장합니다` : ""}
        </p>
      ) : null}

      {error ? <p className="rounded-[var(--radius-sm)] border border-danger/30 bg-danger-bg px-3 py-2 text-danger">{error}</p> : null}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <label className="flex items-center gap-1.5">
          <span className="text-text-muted">Rev 번호{preview.revNo === null ? " (파일 이름에 없어 직접 입력)" : " (파일 이름에서 읽음)"}</span>
          <input aria-label="Rev 번호" type="number" min={0} className={`${inputSmClass} tnum w-16`} value={revNo} onChange={(e) => setRevNo(e.target.value)} />
        </label>
        {revTaken ? <span className="text-[#9a6b00]">이 기간에 Rev {revNo}이 이미 있어 Rev {nextRev}로 쌓입니다</span> : null}
        <Button variant="primary" size="sm" disabled={busy || revNo === ""} onClick={apply}>
          {busy ? "저장 중…" : "확정 Rev로 저장"}
        </Button>
      </div>
    </div>
  );
}
