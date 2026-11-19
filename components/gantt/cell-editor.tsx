"use client";

import { useEffect, useRef } from "react";
import type { CellResult, ChangeoverType, PlanCell, Product } from "@/lib/engine/types";
import { Button, cx, inputSmClass } from "@/components/ui";
import { fmtInt, fmtMDW } from "@/lib/format";
import { changeoverSiteLabel, fmtExplainValue, noneOptionLabel, type CellTimeInfo } from "@/lib/engine/changeover";
import type { CloseVia } from "@/components/gantt/cell-edit-session";

export interface CellEditorProps {
  anchor: DOMRect;
  lineName: string;
  date: string;
  /** 편집 중인 값(draft). 계획표에는 "완료" 전까지 반영되지 않는다 */
  cell: PlanCell | null;
  /** draft 기준 미리보기 계산 결과 (생산 가능시간·계산 근거 표시용) */
  result: CellResult | undefined;
  /** 교체 종류·소요시간·생산 가능시간 (없으면 표시 안 함) */
  timeInfo?: CellTimeInfo | null;
  allowedProducts: Product[];
  allProducts: Product[];
  readOnly: boolean;
  onChange: (patch: Partial<Pick<PlanCell, "productId" | "qty" | "changeoverType" | "memo">>) => void;
  /** "빈 셀로": 계획표 칸을 바로 비우고 닫는다 (기존 동작 그대로) */
  onClear: () => void;
  /** "빈 셀로" 비활성 여부 (편집 전 칸 기준). 없으면 draft 기준 */
  clearDisabled?: boolean;
  /** "완료": 바꾼 값을 계획표에 반영하고 닫는다 */
  onDone: () => void;
  /** X · Esc · 바깥 클릭: 바꾼 값을 버리고 닫는다 */
  onCancel: (via: Exclude<CloseVia, "done">) => void;
}

// 화면 표시는 현장 용어 (B/M교체, FULLSET교체)
const CHANGEOVER_OPTIONS: ChangeoverType[] = ["NONE", "BM", "FULL"];

export function CellEditor(p: CellEditorProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) p.onCancel("outside");
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") p.onCancel("escape");
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [p]);

  const width = 340;
  const left = Math.min(Math.max(8, p.anchor.left), window.innerWidth - width - 8);
  const top = p.anchor.bottom + 6 + 320 > window.innerHeight ? p.anchor.top - 6 - 320 : p.anchor.bottom + 6;

  // 제품이 바뀌었는데 교체유형 미입력 → 기본값 적용 중 (저장 값은 NONE 그대로)
  const changeoverDefaulted = !!p.result?.changeoverDefaulted && (p.cell?.changeoverType ?? "NONE") === "NONE";

  const currentProductInList = p.cell?.productId ? p.allowedProducts.some((x) => x.id === p.cell!.productId) : true;
  const options = currentProductInList
    ? p.allowedProducts
    : [...p.allowedProducts, ...p.allProducts.filter((x) => x.id === p.cell?.productId)];

  return (
    <div
      ref={ref}
      data-testid="cell-editor"
      className="fixed z-50 rounded-[var(--radius-md)] border border-border bg-white p-3 shadow-[0_8px_24px_rgba(0,16,78,0.12)]"
      style={{ left, top, width }}
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-semibold text-brand-deep">
          {p.lineName} · {fmtMDW(p.date)}
        </div>
        <button className="text-xs text-text-muted hover:text-text" onClick={() => p.onCancel("x")} aria-label="닫기 (바꾼 내용 취소)" title="닫기 (바꾼 내용 취소)">
          ✕
        </button>
      </div>

      <div className="grid grid-cols-[72px_1fr] items-center gap-x-2 gap-y-2 text-xs">
        <label className="text-text-muted">금형(제품)</label>
        <select
          data-testid="product-select"
          className={inputSmClass}
          disabled={p.readOnly}
          value={p.cell?.productId ?? ""}
          onChange={(e) => p.onChange({ productId: e.target.value || null })}
        >
          <option value="">(없음)</option>
          {options.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
              {!p.allowedProducts.some((a) => a.id === x.id) ? " ⚠ 허용 외" : ""}
            </option>
          ))}
        </select>

        <label className="text-text-muted">계획 수량</label>
        <input
          type="number"
          className={`${inputSmClass} tnum`}
          disabled={p.readOnly || !p.cell?.productId}
          placeholder={p.result ? `비우면 예상 ${fmtInt(p.result.expectedQty)}` : ""}
          value={p.cell?.qty ?? ""}
          min={0}
          step={1000}
          onChange={(e) => p.onChange({ qty: e.target.value === "" ? null : Number(e.target.value) })}
        />

        <label className="text-text-muted">교체 유형</label>
        <select
          data-testid="changeover-select"
          className={cx(inputSmClass, changeoverDefaulted ? "border-warn text-warn" : "")}
          disabled={p.readOnly || !p.cell?.productId}
          value={p.cell?.changeoverType ?? "NONE"}
          onChange={(e) => p.onChange({ changeoverType: e.target.value as ChangeoverType })}
        >
          {CHANGEOVER_OPTIONS.map((k) => (
            <option key={k} value={k}>
              {k === "NONE" ? noneOptionLabel(changeoverDefaulted, p.result?.effectiveChangeover ?? "NONE") : changeoverSiteLabel(k)}
            </option>
          ))}
        </select>

        {p.timeInfo ? (
          <>
            <label className="text-text-muted">생산 가능</label>
            <div data-testid="cell-time-info" className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="tnum font-semibold text-text">
                {p.timeInfo.availableHours != null ? `${p.timeInfo.availableHours}h / 24h` : "계수 정보 없음"}
              </span>
              {p.timeInfo.changeover !== "NONE" ? (
                <span className="text-text-muted">
                  {p.timeInfo.label}
                  {p.timeInfo.defaulted ? "(기본값)" : ""}
                  {p.timeInfo.nextDayStart ? " · 익일가동 (교체일 생산 0)" : p.timeInfo.lostHours != null ? ` · 생산 불가 ${p.timeInfo.lostHours}h` : ""}
                </span>
              ) : null}
            </div>
          </>
        ) : null}

        <label className="text-text-muted">메모</label>
        <input
          className={inputSmClass}
          disabled={p.readOnly}
          value={p.cell?.memo ?? ""}
          placeholder="배치 이유 등"
          onChange={(e) => p.onChange({ memo: e.target.value || null })}
        />
      </div>

      {p.result ? (
        <div className="mt-3 rounded-[var(--radius-sm)] bg-bg-sub p-2">
          <div className="mb-1 flex items-center justify-between text-[11px] font-semibold text-brand-deep">
            <span>계산 근거 (NFR-04)</span>
            <span className="tnum">예상 생산량 {fmtInt(p.result.expectedQty)}</span>
          </div>
          <ul className="space-y-0.5 text-[11px] text-text">
            {p.result.explain.map((s, i) => (
              <li key={i} className="flex justify-between gap-2">
                <span className="text-text-muted">{s.label}</span>
                <span className="tnum text-right">
                  {typeof s.value === "number" ? fmtExplainValue(s.value) : s.value}
                  {s.note ? <span className="ml-1 text-text-faint">({s.note})</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!p.readOnly ? (
        <div className="mt-3 flex justify-between">
          <Button size="sm" variant="ghost" onClick={p.onClear} disabled={p.clearDisabled ?? (!p.cell?.productId && !p.cell?.memo)}>
            빈 셀로
          </Button>
          <Button size="sm" variant="primary" onClick={p.onDone} data-testid="cell-editor-done">
            완료
          </Button>
        </div>
      ) : null}
    </div>
  );
}
