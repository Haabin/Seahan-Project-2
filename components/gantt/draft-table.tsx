"use client";

import { useMemo, useState } from "react";
import type { CellResult, ChangeoverType, Line, PlanCell, Product } from "@/lib/engine/types";
import { EDITED_AUTO_PREFIX } from "@/lib/engine/types";
import { Badge, cx } from "@/components/ui";
import { ChangeoverMark } from "@/components/gantt/marks";
import { fmtInt, fmtMD } from "@/lib/format";

interface MoldOption {
  id: string;
  moldNo: string;
  name: string;
  productIds: string[];
}

interface RunRow {
  key: string;
  lineId: string;
  productId: string;
  /** 그 호기에서의 생산 순서 (1부터) */
  seq: number;
  cells: PlanCell[];
  qty: number;
  moldId: string | null;
  moldMixed: boolean;
  changeover: ChangeoverType;
  state: "auto" | "edited" | "manual" | "imported";
  basis: string | null;
}

const th = "sticky top-0 z-10 border-b border-border bg-bg-sub px-2 py-1.5 text-left text-[11px] font-semibold text-text-muted whitespace-nowrap";
const td = "border-b border-border px-2 py-1 text-xs";
const STATE: Record<RunRow["state"], { label: string; tone: "info" | "warn" | "neutral" | "surplus" }> = {
  auto: { label: "자동 생성", tone: "info" },
  edited: { label: "사람이 수정", tone: "warn" },
  manual: { label: "직접 입력", tone: "neutral" },
  imported: { label: "엑셀 가져오기", tone: "surplus" },
};

/**
 * 생산계획 초안을 표로 보여준다: 품번별 생산 일자 · 호기 · 계획 수량 · 생산 순서 · 금형번호 · 교체 시점 · 근거.
 * 금형과 교체 유형은 표에서 바로 고치고, 날짜별 수량은 「셀 열기」로 고친다.
 */
export function DraftTable({
  cells,
  results,
  lines,
  products,
  molds,
  dates,
  editable,
  exceptionKeys,
  focusKey,
  onPatch,
  onOpen,
}: {
  cells: PlanCell[];
  results: Map<string, CellResult>;
  lines: Line[];
  products: Product[];
  molds: MoldOption[];
  dates: string[];
  editable: boolean;
  /** "호기|날짜" → 확인 필요 표시 */
  exceptionKeys: Map<string, string>;
  /** 오른쪽 목록에서 고른 칸("호기|날짜"). 그 칸이 든 줄을 잠깐 강조한다 */
  focusKey?: string | null;
  /** 한 번의 선택 = 한 번 호출 (여러 칸이어도). 규칙은 칸마다 적용되고, 되돌리기는 한 단계로 묶인다 */
  onPatch: (targets: { lineId: string; date: string }[], patch: Partial<Pick<PlanCell, "moldId" | "changeoverType">>) => void;
  onOpen: (lineId: string, date: string) => void;
}) {
  const [sort, setSort] = useState<"product" | "line">("product");
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p] as const)), [products]);
  const lineById = useMemo(() => new Map(lines.map((l) => [l.id, l] as const)), [lines]);
  const moldById = useMemo(() => new Map(molds.map((m) => [m.id, m] as const)), [molds]);
  const dateIdx = useMemo(() => new Map(dates.map((d, i) => [d, i] as const)), [dates]);

  const runs = useMemo(() => {
    const byLine = new Map<string, PlanCell[]>();
    for (const c of cells) {
      if (!c.productId || !dateIdx.has(c.date) || !lineById.has(c.lineId)) continue;
      const arr = byLine.get(c.lineId);
      if (arr) arr.push(c);
      else byLine.set(c.lineId, [c]);
    }
    const out: RunRow[] = [];
    for (const line of lines) {
      const list = (byLine.get(line.id) ?? []).sort((a, b) => (a.date < b.date ? -1 : 1));
      let seq = 0;
      let cur: PlanCell[] = [];
      const flush = () => {
        if (!cur.length) return;
        seq++;
        const first = cur[0];
        const qty = cur.reduce((a, c) => a + (c.qty ?? results.get(`${c.lineId}|${c.date}`)?.expectedQty ?? 0), 0);
        const moldIds = new Set(cur.map((c) => c.moldId ?? ""));
        const anyAuto = cur.some((c) => c.origin === "auto");
        const anyEdited = cur.some((c) => c.origin === "manual" && c.basis?.startsWith(EDITED_AUTO_PREFIX));
        const state: RunRow["state"] = anyEdited ? "edited" : anyAuto ? "auto" : cur.every((c) => c.origin === "imported") ? "imported" : "manual";
        out.push({
          key: `${first.lineId}|${first.date}`,
          lineId: first.lineId,
          productId: first.productId as string,
          seq,
          cells: cur,
          qty,
          moldId: moldIds.size === 1 ? first.moldId ?? null : null,
          moldMixed: moldIds.size > 1,
          changeover: results.get(`${first.lineId}|${first.date}`)?.effectiveChangeover ?? first.changeoverType,
          state,
          basis: cur.find((c) => c.basis)?.basis ?? null,
        });
        cur = [];
      };
      for (const c of list) {
        const prev = cur[cur.length - 1];
        const contiguous = prev && prev.productId === c.productId && (dateIdx.get(c.date) ?? 0) === (dateIdx.get(prev.date) ?? 0) + 1 && c.changeoverType === "NONE";
        if (!contiguous) flush();
        cur.push(c);
      }
      flush();
    }
    if (sort === "product") {
      out.sort((a, b) => (productById.get(a.productId)?.name ?? "").localeCompare(productById.get(b.productId)?.name ?? "", "ko") || (a.cells[0].date < b.cells[0].date ? -1 : a.cells[0].date > b.cells[0].date ? 1 : 0));
    }
    return out;
  }, [cells, results, lines, lineById, productById, dateIdx, sort]);

  if (!runs.length) return <p className="p-6 text-sm text-text-muted">계획 셀이 없습니다. 「초안 자동 생성」을 누르거나 생산계획표에서 셀을 넣으세요.</p>;

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
        <span className="text-text-muted">정렬</span>
        {(["product", "line"] as const).map((s) => (
          <button key={s} onClick={() => setSort(s)} className={cx("rounded-full border px-2.5 py-0.5", sort === s ? "border-brand bg-brand text-white" : "border-border bg-white text-text-muted")}>
            {s === "product" ? "품번별" : "호기·생산 순서별"}
          </button>
        ))}
        <span className="ml-auto text-text-muted">구간 {runs.length}개 · 금형·교체는 여기서 바로, 날짜별 수량은 「셀 열기」에서 고칩니다</span>
      </div>
      <div className="overflow-auto" style={{ maxHeight: "calc(100vh - 235px)" }}>
        <table className="tnum w-full border-separate border-spacing-0" data-testid="draft-table">
          <thead>
            <tr>
              {["품번", "품명", "호기", "순서", "생산 일자", "일수", "계획 수량", "금형번호", "교체 시점", "구분", "근거", ""].map((h) => (
                <th key={h} className={th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => {
              const product = productById.get(r.productId);
              const first = r.cells[0];
              const last = r.cells[r.cells.length - 1];
              const options = molds.filter((m) => m.productIds.includes(r.productId));
              const flagged = r.cells.some((c) => exceptionKeys.has(`${c.lineId}|${c.date}`));
              return (
                <tr
                  key={r.key}
                  data-state={r.state}
                  data-run-cells={r.cells.map((c) => `${c.lineId}|${c.date}`).join(" ")}
                  data-focused={focusKey && r.cells.some((c) => `${c.lineId}|${c.date}` === focusKey) ? "true" : undefined}
                  className={cx(
                    "hover:bg-bg-muted",
                    flagged && "bg-warn-bg/60",
                    r.state === "edited" && !flagged && "bg-info-bg/50",
                    focusKey && r.cells.some((c) => `${c.lineId}|${c.date}` === focusKey) ? "outline outline-2 -outline-offset-2 outline-accent bg-info-bg" : "",
                  )}
                >
                  <td className={cx(td, "whitespace-nowrap text-text-muted")}>{product?.code ?? "–"}</td>
                  <td className={cx(td, "font-medium")}>{product?.name ?? "알 수 없는 제품"}</td>
                  <td className={cx(td, "whitespace-nowrap")}>{lineById.get(r.lineId)?.name}</td>
                  <td className={cx(td, "text-center")}>{r.seq}</td>
                  <td className={cx(td, "whitespace-nowrap")}>
                    {fmtMD(first.date)}
                    {last.date !== first.date ? ` ~ ${fmtMD(last.date)}` : ""}
                  </td>
                  <td className={cx(td, "text-right")}>{r.cells.length}</td>
                  <td className={cx(td, "text-right font-semibold")}>{fmtInt(r.qty)}</td>
                  <td className={td}>
                    {editable ? (
                      <select
                        aria-label={`${product?.name ?? ""} 금형번호`}
                        className={cx("h-6 max-w-[190px] rounded border bg-white text-xs", r.moldId ? "border-border" : "border-warn bg-warn-bg")}
                        value={r.moldId ?? ""}
                        onChange={(e) => onPatch(r.cells.map((c) => ({ lineId: c.lineId, date: c.date })), { moldId: e.target.value || null })}
                      >
                        <option value="">{r.moldMixed ? "날짜마다 다름" : options.length ? "확인 필요 (미정)" : "등록된 금형 없음"}</option>
                        {options.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.moldNo} · {m.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      (r.moldId ? moldById.get(r.moldId)?.moldNo : null) ?? <span className="text-[#9a6b00]">미정</span>
                    )}
                  </td>
                  <td className={cx(td, "whitespace-nowrap")}>
                    <span className="flex items-center gap-1.5">
                      {r.changeover !== "NONE" ? <ChangeoverMark type={r.changeover} /> : null}
                      {editable ? (
                        <select
                          aria-label={`${product?.name ?? ""} 교체 유형`}
                          className="h-6 rounded border border-border bg-white text-xs"
                          value={first.changeoverType}
                          onChange={(e) => onPatch([{ lineId: first.lineId, date: first.date }], { changeoverType: e.target.value as ChangeoverType })}
                        >
                          <option value="NONE">{r.changeover !== "NONE" ? `${fmtMD(first.date)} 기본값` : "교체 없음"}</option>
                          <option value="BM">{fmtMD(first.date)} B/M</option>
                          <option value="FULL">{fmtMD(first.date)} Full set</option>
                        </select>
                      ) : r.changeover === "NONE" ? (
                        "교체 없음"
                      ) : (
                        `${fmtMD(first.date)} ${r.changeover === "FULL" ? "Full set" : "B/M"}`
                      )}
                    </span>
                  </td>
                  <td className={cx(td, "whitespace-nowrap")}>
                    <Badge tone={STATE[r.state].tone}>{STATE[r.state].label}</Badge>
                    {flagged ? <Badge tone="warn" className="ml-1">확인 필요</Badge> : null}
                  </td>
                  <td className={cx(td, "max-w-[280px] truncate text-text-muted")} title={r.basis ?? ""}>
                    {r.basis ?? "–"}
                  </td>
                  <td className={cx(td, "whitespace-nowrap text-right")}>
                    <button className="text-accent hover:underline" onClick={() => onOpen(first.lineId, first.date)}>
                      셀 열기
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
