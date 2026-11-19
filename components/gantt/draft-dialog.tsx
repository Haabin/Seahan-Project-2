"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { generateDraft, type DraftResult } from "@/lib/engine/draft";
import type { EngineInput, PlanCell } from "@/lib/engine/types";
import type { DraftData } from "@/lib/data/draft-data";
import { Badge, Button } from "@/components/ui";
import { Modal } from "@/components/gantt/dialogs";
import { fmtInt, fmtMD } from "@/lib/format";

/**
 * 초안 자동 생성 창. 계산은 브라우저에서 한다(lib/engine/draft.ts).
 * 만든 초안은 화면의 초안에만 들어가고, 확정은 사람이 기존 「확정 / 변경 저장」으로 한다.
 */
export function DraftDialog({
  input,
  cells,
  data,
  onApply,
  onClose,
}: {
  input: EngineInput;
  cells: PlanCell[];
  data: DraftData;
  onApply: (result: DraftResult) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"fill" | "rebuild">("fill");
  const [useNet, setUseNet] = useState(data.useNetRequirementDefault);
  const periodEnd = useMemo(() => {
    const d = new Date(`${input.periodStart}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + input.periodDays - 1);
    return d.toISOString().slice(0, 10);
  }, [input.periodStart, input.periodDays]);

  const open = data.orders.filter((o) => o.status === "open");
  const unmatched = open.filter((o) => !o.productId);
  const beyond = open.filter((o) => o.dueDate > periodEnd);
  const before = open.filter((o) => o.dueDate < input.periodStart);
  const existing = cells.filter((c) => c.productId).length;
  const manual = cells.filter((c) => c.productId && c.origin !== "auto").length;

  function run() {
    if (mode === "rebuild" && existing > 0 && !window.confirm(`지금 초안의 셀 ${existing}개(사람이 넣은 셀 ${manual}개 포함)를 모두 지우고 다시 만듭니다. 계속할까요?`)) return;
    const result = generateDraft({
      engine: input,
      existingCells: cells,
      mode,
      orders: open,
      history: data.history,
      molds: data.molds,
      stockByProduct: data.stockByProduct,
      useNetRequirement: useNet,
      prevLastProductByLine: data.prevLastProductByLine,
    });
    onApply(result);
  }

  return (
    <Modal title="생산계획 초안 자동 생성" onClose={onClose} testId="draft-dialog">
      <div className="space-y-3 text-xs">
        <p className="text-text-muted">
          진행 중인 주문을 과거 확정 계획과 같은 호기·금형에 납기 순으로 배정해 초안을 채웁니다. 초안까지만 만들며, <b>확정은 직접</b> 하셔야 합니다.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-[var(--radius-sm)] border border-border px-3 py-2">
            <div className="text-[11px] text-text-muted">진행 중 주문</div>
            <div className="tnum text-sm font-semibold text-brand-deep">
              {open.length}건 · {fmtInt(open.reduce((a, o) => a + o.qty, 0))}본
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {unmatched.length ? <Badge tone="danger">제품 매칭 안 됨 {unmatched.length}</Badge> : null}
              {before.length ? <Badge tone="warn">납기가 기간 앞 {before.length}</Badge> : null}
              {beyond.length ? <Badge tone="neutral">납기가 기간 뒤 {beyond.length}</Badge> : null}
            </div>
            <Link href="/orders" className="mt-1 inline-block text-accent hover:underline">
              주문 입력으로 이동
            </Link>
          </div>
          <div className="rounded-[var(--radius-sm)] border border-border px-3 py-2">
            <div className="text-[11px] text-text-muted">참고하는 과거 확정 계획 (최근 {data.historyWeeks}주)</div>
            {data.historySources.length ? (
              <ul className="mt-0.5 space-y-0.5">
                {data.historySources.map((s) => (
                  <li key={s.label} className="tnum">
                    {s.label} <span className="text-text-muted">· 셀 {s.cellCount}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-0.5 text-[#9a6b00]">과거 확정 계획이 없습니다. 모든 제품이 「신규」로 Capa 최대 호기에 배정됩니다. 「엑셀 가져오기」로 생산배대를 먼저 올리면 이력이 생깁니다.</p>
            )}
          </div>
        </div>

        <fieldset className="space-y-1.5">
          <legend className="mb-1 font-medium text-text-muted">기존 셀 처리</legend>
          <label className="flex items-start gap-2">
            <input type="radio" name="draft-mode" checked={mode === "fill"} onChange={() => setMode("fill")} className="mt-0.5" />
            <span>
              <b>빈 셀만 채우기</b> <span className="text-text-muted">— 지금 초안의 셀 {existing}개는 그대로 둡니다</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" name="draft-mode" checked={mode === "rebuild"} onChange={() => setMode("rebuild")} className="mt-0.5" />
            <span>
              <b>전체 다시 만들기</b> <span className="text-text-muted">— 초안을 비우고 주문만으로 다시 만듭니다 (확인창이 뜹니다)</span>
            </span>
          </label>
        </fieldset>

        <label className="flex items-start gap-2">
          <input type="checkbox" checked={useNet} onChange={(e) => setUseNet(e.target.checked)} className="mt-0.5" />
          <span>
            <b>순 소요량으로 계산</b>{" "}
            <span className="text-text-muted">
              — 주문 − (현재고 − 안전재고). 재고현황 {data.stockAsOf ? `${data.stockAsOf.replace("-", "년 ")}월` : "데이터 없음"} 기준, 제품에 연결된 품목 {Object.keys(data.stockByProduct).length}개
            </span>
          </span>
        </label>

        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <Button size="sm" variant="ghost" onClick={onClose}>
            닫기
          </Button>
          <Button size="sm" variant="primary" data-testid="draft-run" disabled={open.length === 0} onClick={run}>
            초안 만들기
          </Button>
        </div>
        {beyond.length ? <p className="text-text-muted">납기가 계획 기간({fmtMD(periodEnd)}) 뒤인 주문은 기간 안의 빈 자리에 미리 배정합니다.</p> : null}
      </div>
    </Modal>
  );
}
