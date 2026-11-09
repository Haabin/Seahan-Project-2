"use client";

import { useEffect, useRef } from "react";
import type { CellResult, ChangeoverType, PlanCell, Product } from "@/lib/engine/types";
import { Button, inputSmClass } from "@/components/ui";
import { fmtInt, fmtMDW } from "@/lib/format";

export interface CellEditorProps {
  anchor: DOMRect;
  lineName: string;
  date: string;
  cell: PlanCell | null;
  result: CellResult | undefined;
  allowedProducts: Product[];
  allProducts: Product[];
  readOnly: boolean;
  onChange: (patch: Partial<Pick<PlanCell, "productId" | "qty" | "changeoverType" | "memo">>) => void;
  onClear: () => void;
  onClose: () => void;
}

const CHANGEOVER_LABEL: Record<ChangeoverType, string> = { NONE: "없음", BM: "B/M만", FULL: "Full set" };

export function CellEditor(p: CellEditorProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) p.onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") p.onClose();
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
        <button className="text-xs text-text-muted hover:text-text" onClick={p.onClose} aria-label="닫기">
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
          className={inputSmClass}
          disabled={p.readOnly || !p.cell?.productId}
          value={p.cell?.changeoverType ?? "NONE"}
          onChange={(e) => p.onChange({ changeoverType: e.target.value as ChangeoverType })}
        >
          {(Object.keys(CHANGEOVER_LABEL) as ChangeoverType[]).map((k) => (
            <option key={k} value={k}>
              {CHANGEOVER_LABEL[k]}
            </option>
          ))}
        </select>

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
                  {typeof s.value === "number" ? fmtInt(s.value) : s.value}
                  {s.note ? <span className="ml-1 text-text-faint">({s.note})</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!p.readOnly ? (
        <div className="mt-3 flex justify-between">
          <Button size="sm" variant="ghost" onClick={p.onClear} disabled={!p.cell?.productId && !p.cell?.memo}>
            빈 셀로
          </Button>
          <Button size="sm" variant="primary" onClick={p.onClose}>
            완료
          </Button>
        </div>
      ) : null}
    </div>
  );
}
