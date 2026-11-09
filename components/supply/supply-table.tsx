"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { recalc } from "@/lib/engine";
import type { EngineInput, PriorityWeights, SupplyStatus } from "@/lib/engine/types";
import { updatePriorityWeights } from "@/lib/actions/master";
import { Badge, Button, Card, cx } from "@/components/ui";
import { dowKo, fmtInt, fmtMD } from "@/lib/format";

const STATUS_LABEL: Record<SupplyStatus, { label: string; tone: "danger" | "warn" | "surplus" | "neutral" | "ok" }> = {
  shortage: { label: "부족", tone: "danger" },
  warning: { label: "안전재고 미달", tone: "warn" },
  surplus: { label: "과잉", tone: "surplus" },
  no_shipment: { label: "출고 계획 없음", tone: "neutral" },
  ok: { label: "정상", tone: "ok" },
};

export function SupplyTable({ input, canWrite, planPeriod }: { input: EngineInput; canWrite: boolean; planPeriod: string }) {
  const [weights, setWeights] = useState<PriorityWeights>(input.priorityWeights);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState<"all" | "issues">("issues");

  const result = useMemo(() => recalc({ ...input, priorityWeights: weights }), [input, weights]);
  const dates = result.periodDates;
  const rows = filter === "all" ? result.supply : result.supply.filter((r) => r.status === "shortage" || r.status === "warning");
  const dirty = weights.dueSoon !== input.priorityWeights.dueSoon || weights.majorCustomer !== input.priorityWeights.majorCustomer || weights.belowSafety !== input.priorityWeights.belowSafety;

  async function persist() {
    setSaving(true);
    await updatePriorityWeights({ due_soon: weights.dueSoon, major_customer: weights.majorCustomer, below_safety: weights.belowSafety });
    setSaving(false);
  }

  const counts = {
    shortage: result.supply.filter((r) => r.status === "shortage").length,
    warning: result.supply.filter((r) => r.status === "warning").length,
    surplus: result.supply.filter((r) => r.status === "surplus").length,
    none: result.supply.filter((r) => r.status === "no_shipment").length,
  };

  return (
    <div className="space-y-3">
      <Card className="flex flex-wrap items-center gap-4 px-4 py-2.5">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium text-text-muted">우선순위 가중치 (FR-11)</span>
          <WeightSlider label="납기 임박" value={weights.dueSoon} onChange={(v) => setWeights({ ...weights, dueSoon: v })} />
          <WeightSlider label="대형 거래선" value={weights.majorCustomer} onChange={(v) => setWeights({ ...weights, majorCustomer: v })} />
          <WeightSlider label="안전재고 미달" value={weights.belowSafety} onChange={(v) => setWeights({ ...weights, belowSafety: v })} />
          {canWrite ? (
            <Button size="sm" variant="primary" disabled={!dirty || saving} onClick={persist}>
              {saving ? "저장 중…" : "가중치 저장"}
            </Button>
          ) : null}
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs">
          <Badge tone="danger">부족 {counts.shortage}</Badge>
          <Badge tone="warn">미달 {counts.warning}</Badge>
          <Badge tone="surplus">과잉 {counts.surplus}</Badge>
          <Badge tone="neutral">출고 없음 {counts.none}</Badge>
          <span className="mx-1 h-5 w-px bg-border" />
          <button className={cx("rounded-full px-2.5 py-0.5", filter === "issues" ? "bg-brand text-white" : "text-text-muted hover:bg-bg-sub")} onClick={() => setFilter("issues")}>
            문제 품목만
          </button>
          <button className={cx("rounded-full px-2.5 py-0.5", filter === "all" ? "bg-brand text-white" : "text-text-muted hover:bg-bg-sub")} onClick={() => setFilter("all")}>
            전체 {result.supply.length}
          </button>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-auto" style={{ maxHeight: "calc(100vh - 230px)" }}>
          <table className="w-full border-separate border-spacing-0 text-xs">
            <thead className="sticky top-0 z-20 bg-white">
              <tr>
                <th className="sticky left-0 z-30 min-w-[180px] border-b border-r border-border bg-white px-2 py-1.5 text-left font-semibold text-text-muted">제품</th>
                <th className="border-b border-r border-border px-2 py-1.5 text-left font-semibold text-text-muted">상태</th>
                <th className="tnum border-b border-r border-border px-2 py-1.5 text-right font-semibold text-text-muted">점수</th>
                <th className="tnum border-b border-r border-border px-2 py-1.5 text-right font-semibold text-text-muted">기초재고</th>
                <th className="border-b border-r border-border px-2 py-1.5 text-left font-semibold text-text-muted">최초 부족</th>
                {dates.map((d) => {
                  const dow = dowKo(d);
                  return (
                    <th key={d} className={cx("tnum min-w-[64px] border-b border-r border-border px-1 py-1.5 text-center font-medium", dow === "토" || dow === "일" ? "bg-bg-sub text-text-muted" : "text-text")}>
                      {fmtMD(d)}
                      <span className="ml-0.5 text-[10px] text-text-faint">{dow}</span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const st = STATUS_LABEL[r.status];
                return (
                  <tr key={r.productId} className="group hover:bg-bg-muted">
                    <th className="sticky left-0 z-10 border-b border-r border-border bg-white px-2 py-1 text-left font-medium text-text group-hover:bg-bg-muted">
                      <Link href={`/plan?period=${planPeriod}&focus=${r.productId}`} className="hover:text-brand hover:underline" title="간트에서 보기">
                        {r.productName}
                      </Link>
                      {r.hasMajorCustomer ? <span className="ml-1 text-[10px] text-accent">대형</span> : null}
                    </th>
                    <td className="border-b border-r border-border px-2 py-1">
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </td>
                    <td className="tnum border-b border-r border-border px-2 py-1 text-right text-text-muted" title={`납기 ${r.priority.dueSoon.toFixed(2)} + 거래선 ${r.priority.majorCustomer.toFixed(2)} + 안전재고 ${r.priority.belowSafety.toFixed(2)}`}>
                      {r.priority.total.toFixed(2)}
                    </td>
                    <td className="tnum border-b border-r border-border px-2 py-1 text-right">{fmtInt(r.openingStock)}</td>
                    <td className="border-b border-r border-border px-2 py-1 text-danger">
                      {r.firstShortageDate ? (
                        <span className="tnum">
                          {fmtMD(r.firstShortageDate)} · −{fmtInt(r.firstShortageQty)}
                        </span>
                      ) : (
                        <span className="text-text-faint">–</span>
                      )}
                    </td>
                    {r.days.map((d) => (
                      <td
                        key={d.date}
                        className={cx(
                          "tnum border-b border-r border-border px-1 py-1 text-right",
                          d.status === "shortage" ? "bg-danger-bg font-medium text-danger" : d.status === "warning" ? "bg-warn-bg text-[#9a6b00]" : d.status === "surplus" ? "bg-surplus-bg text-text-muted" : "",
                        )}
                        title={`기초 ${fmtInt(d.opening)} + 생산 ${fmtInt(d.production)} − 출고 ${fmtInt(d.shipment)} = ${fmtInt(d.closing)}`}
                      >
                        {fmtInt(d.closing)}
                        {d.shipment > 0 ? <div className="text-[9px] text-text-faint">출고 {fmtInt(d.shipment)}</div> : null}
                      </td>
                    ))}
                  </tr>
                );
              })}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5 + dates.length} className="px-4 py-8 text-center text-text-muted">
                    표시할 품목이 없습니다.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="flex items-center gap-4 border-t border-border px-3 py-1.5 text-[11px] text-text-muted">
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-4 bg-danger-bg" /> 부족 (재고 &lt; 0)
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-4 bg-warn-bg" /> 안전재고 미달
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-4 bg-surplus-bg" /> 과잉 (향후 {input.settings.surplusDays}일 출고합 초과)
          </span>
          <span className="ml-auto">셀에 마우스를 올리면 계산 근거(기초 + 생산 − 출고)가 보입니다.</span>
        </div>
      </Card>
    </div>
  );
}

function WeightSlider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-text-muted">{label}</span>
      <input type="range" min={0} max={5} step={0.5} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-20 accent-[var(--brand)]" />
      <span className="tnum w-6 text-right font-medium">{value}</span>
    </label>
  );
}
