"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { recalc } from "@/lib/engine";
import type { EngineInput } from "@/lib/engine/types";
import { deleteSiloReceipt, updateExternalUsage, upsertSiloMeasurement, upsertSiloReceipt } from "@/lib/actions/seabulk";
import { Badge, Button, Card, CardHeader, cx, inputSmClass } from "@/components/ui";
import { addDays } from "@/lib/engine/calendar";
import { dowKo, fmtMD, fmtTon } from "@/lib/format";

export interface SeabulkViewProps {
  input: EngineInput;
  canWrite: boolean;
  externalRows: { id: string; label: string; factoryCode: string; weekdayTon: number; weekendTon: number }[];
  siloCodes: string[];
}

export function SeabulkView({ input, canWrite, externalRows, siloCodes }: SeabulkViewProps) {
  const router = useRouter();
  const result = useMemo(() => recalc(input), [input]);
  const silo = result.silo;
  const order = result.order;
  const s = input.settings;
  const periodEnd = result.periodDates[result.periodDates.length - 1];

  const chartData = silo.map((d) => ({ date: d.date, label: fmtMD(d.date), plan: d.basis === "plan" ? d.closing : null, est: d.basis === "estimate" || d.date === periodEnd ? d.closing : null, receipt: d.receipt }));
  const firstBelow = silo.find((d) => d.status === "below_lower");
  const receipts = input.siloReceipts.filter((r) => r.status !== "cancelled").sort((a, b) => a.plannedDate.localeCompare(b.plannedDate));

  const [tab, setTab] = useState<"table" | "receipts" | "measure" | "external">("table");

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[1fr_320px] gap-3">
        <Card>
          <CardHeader
            title="사일로 재고 6주 추이 (합계)"
            sub={`상한 ${s.siloUpperBoundTon}톤 (40 + 120) · 하한 ${s.siloLowerBoundTon}톤 (Q2) · 1~2주 계획 기준, 3~6주 운용안·출고 예측 추정`}
            right={
              <div className="flex gap-1.5">
                {firstBelow ? <Badge tone="danger">{fmtMD(firstBelow.date)} 하한 미달 예상</Badge> : <Badge tone="ok">6주 내 하한 미달 없음</Badge>}
                {silo.some((d) => d.status === "above_upper") ? <Badge tone="warn">상한 초과 구간 있음</Badge> : null}
              </div>
            }
          />
          <div className="h-[320px] px-2 pt-3">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 10, right: 20, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#eef0f4" vertical={false} />
                <ReferenceArea x1={chartData[0]?.label} x2={fmtMD(periodEnd)} fill="#e8edfb" fillOpacity={0.5} label={{ value: "1~2주 · 확정 계획 기준", position: "insideTop", fontSize: 11, fill: "#042892" }} />
                <ReferenceArea x1={fmtMD(periodEnd)} x2={chartData[chartData.length - 1]?.label} fill="#f8f8f4" fillOpacity={0.6} label={{ value: "3~6주 · 운용안·출고 예측 추정", position: "insideTop", fontSize: 11, fill: "#6b7280" }} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#6b7280" }} interval={6} tickLine={false} axisLine={{ stroke: "#e5e7eb" }} />
                <YAxis
                  tick={{ fontSize: 11, fill: "#6b7280" }}
                  tickLine={false}
                  axisLine={false}
                  unit="t"
                  width={44}
                  domain={[Math.min(0, Math.floor(Math.min(...silo.map((d) => d.closing)) / 20) * 20), Math.max(s.siloUpperBoundTon + 20, Math.ceil(Math.max(...silo.map((d) => d.closing)) / 20) * 20)]}
                  tickFormatter={(v) => String(Math.round(Number(v)))}
                  tickCount={7}
                />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 6, border: "1px solid #e5e7eb" }}
                  formatter={(v, name) => [v === undefined || v === null ? "" : `${Number(v).toFixed(1)}t`, String(name) === "plan" ? "계획 기준" : "추정"]}
                  labelFormatter={(l) => `${l}`}
                />
                <ReferenceLine y={s.siloUpperBoundTon} stroke="#e5484d" strokeDasharray="4 4" label={{ value: `상한 ${s.siloUpperBoundTon}톤`, position: "right", fontSize: 11, fill: "#e5484d" }} />
                <ReferenceLine y={s.siloLowerBoundTon} stroke="#e0a21b" strokeDasharray="4 4" label={{ value: `하한 ${s.siloLowerBoundTon}톤`, position: "right", fontSize: 11, fill: "#e0a21b" }} />
                <Line type="monotone" dataKey="plan" stroke="#3e76fe" strokeWidth={2.5} dot={false} isAnimationActive={false} connectNulls={false} />
                <Line type="monotone" dataKey="est" stroke="#3e76fe" strokeWidth={2.5} strokeDasharray="6 5" dot={false} isAnimationActive={false} connectNulls={false} />
                {receipts.map((r) => {
                  const d = silo.find((x) => x.date === r.plannedDate);
                  return d ? <ReferenceDot key={r.id} x={fmtMD(r.plannedDate)} y={d.closing} r={4} fill="#3d9a4a" stroke="#fff" /> : null;
                })}
                {firstBelow ? <ReferenceDot x={fmtMD(firstBelow.date)} y={firstBelow.closing} r={6} fill="#e5484d" stroke="#fff" /> : null}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="flex items-center gap-4 border-t border-border px-4 py-1.5 text-[11px] text-text-muted">
            <span className="flex items-center gap-1">
              <span className="inline-block h-0.5 w-5 bg-accent" /> 계획 기준
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-0.5 w-5 border-t-2 border-dashed border-accent" /> 추정
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-ok" /> 입고 예정
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-danger" /> 하한 미달 예상
            </span>
          </div>
        </Card>

        {/* 발주 추천 카드 FR-16 */}
        <Card className={cx("border-2 p-4", order.needed ? "border-accent bg-info-bg/40" : "border-border")}>
          <div className="text-xs font-semibold text-brand">발주 추천</div>
          {order.needed ? (
            <>
              <div className="mt-1 text-lg font-bold text-brand-deep">
                {order.orderBy ? `${fmtMD(order.orderBy)}까지 발주` : "즉시 발주"} · 약 {order.qtyTon}톤
              </div>
              <p className="mt-2 text-xs leading-relaxed text-text">
                {order.firstBelowDate ? `${fmtMD(order.firstBelowDate)} 하한(${s.siloLowerBoundTon}톤) 미달 예상. ` : ""}
                리드타임 약 {s.leadTimeDays}일을 고려한 발주 기한입니다. 입고 단위 {s.receiptUnitTon}톤 기준 {Math.round(order.qtyTon / s.receiptUnitTon)}회분.
              </p>
            </>
          ) : (
            <div className="mt-1 text-base font-semibold text-ok">6주 내 발주 불필요</div>
          )}
          <div className="mt-3 border-t border-border pt-2 text-[11px] text-text-muted">
            <div className="mb-1 font-medium text-text">근거</div>
            <ul className="space-y-0.5">
              {order.explain.map((l, i) => (
                <li key={i}>· {l}</li>
              ))}
              <li>· 입고 예정 {receipts.filter((r) => r.status === "planned").length}건</li>
              {order.minProjected !== null ? <li>· 리드타임 구간 최저 예상 재고 {fmtTon(order.minProjected)}</li> : null}
            </ul>
          </div>
          <p className="mt-3 text-[11px] text-text-faint">발주는 사람이 합니다. 발주 후 아래 「입고 일정」에 등록하세요.</p>
        </Card>
      </div>

      <Card>
        <div className="flex items-center gap-1 border-b border-border px-3 py-2">
          {(
            [
              ["table", "일자별 표"],
              ["receipts", `입고 일정 (${receipts.length})`],
              ["measure", "실측 재고 입력"],
              ["external", "외부 설비 사용량 (Q9)"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} className={cx("h-7 rounded-[var(--radius-sm)] px-3 text-xs font-medium", tab === k ? "bg-brand text-white" : "text-text-muted hover:bg-bg-sub")}>
              {label}
            </button>
          ))}
        </div>

        {tab === "table" ? (
          <div className="overflow-auto" style={{ maxHeight: 420 }}>
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-white">
                <tr className="text-text-muted">
                  {["일자", "구분", "기초재고", "입고", "1공장 사용", "2공장 사용", "사용 합계", "기말재고", "상태"].map((h) => (
                    <th key={h} className={cx("border-b border-border px-2 py-1.5 font-semibold", h === "일자" || h === "구분" || h === "상태" ? "text-left" : "text-right")}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="tnum">
                {silo.map((d) => {
                  const dow = dowKo(d.date);
                  return (
                    <tr key={d.date} className={cx("hover:bg-bg-muted", d.status === "below_lower" ? "bg-danger-bg/60" : d.status === "above_upper" ? "bg-warn-bg/60" : "")} title={d.explain.map((e) => `${e.label}: ${e.value}${e.note ? ` (${e.note})` : ""}`).join("\n")}>
                      <td className="border-b border-border px-2 py-1">
                        {fmtMD(d.date)} <span className={cx("text-[10px]", dow === "토" || dow === "일" ? "text-accent" : "text-text-faint")}>{dow}</span>
                      </td>
                      <td className="border-b border-border px-2 py-1 text-text-muted">{d.basis === "plan" ? "계획" : "추정"}</td>
                      <td className="border-b border-border px-2 py-1 text-right">{d.opening.toFixed(1)}</td>
                      <td className={cx("border-b border-border px-2 py-1 text-right", d.receipt > 0 ? "font-medium text-ok" : "text-text-faint")}>{d.receipt > 0 ? `+${d.receipt.toFixed(1)}` : "–"}</td>
                      <td className="border-b border-border px-2 py-1 text-right">{d.usageF1.toFixed(1)}</td>
                      <td className="border-b border-border px-2 py-1 text-right">{d.usageF2.toFixed(1)}</td>
                      <td className="border-b border-border px-2 py-1 text-right">{d.usageTotal.toFixed(1)}</td>
                      <td className={cx("border-b border-border px-2 py-1 text-right font-medium", d.status === "below_lower" ? "text-danger" : "")}>{d.closing.toFixed(1)}</td>
                      <td className="border-b border-border px-2 py-1">{d.status === "below_lower" ? <Badge tone="danger">하한 미달</Badge> : d.status === "above_upper" ? <Badge tone="warn">상한 초과</Badge> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        {tab === "receipts" ? <ReceiptsPanel receipts={receipts} canWrite={canWrite} defaultDate={addDays(input.periodStart, 7)} onDone={() => router.refresh()} /> : null}
        {tab === "measure" ? <MeasurePanel siloCodes={siloCodes} measurements={input.siloMeasurements} canWrite={canWrite} periodStart={input.periodStart} onDone={() => router.refresh()} /> : null}
        {tab === "external" ? <ExternalPanel rows={externalRows} canWrite={canWrite} onDone={() => router.refresh()} /> : null}
      </Card>
    </div>
  );
}

function ReceiptsPanel({ receipts, canWrite, defaultDate, onDone }: { receipts: EngineInput["siloReceipts"]; canWrite: boolean; defaultDate: string; onDone: () => void }) {
  const [supplier, setSupplier] = useState("롯데케미칼");
  const [date, setDate] = useState(defaultDate);
  const [qty, setQty] = useState(22.5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    setBusy(true);
    setError(null);
    const r = await upsertSiloReceipt({ supplier, plannedDate: date, qtyTon: qty, orderDate: new Date().toISOString().slice(0, 10), status: "planned" });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onDone();
  }
  async function setStatus(id: string, status: "planned" | "received" | "cancelled", r: EngineInput["siloReceipts"][number]) {
    const res = await upsertSiloReceipt({ id, supplier: r.supplier, plannedDate: r.plannedDate, qtyTon: r.qtyTon, status });
    if (!res.ok) return setError(res.error);
    onDone();
  }
  async function remove(id: string) {
    const res = await deleteSiloReceipt(id);
    if (!res.ok) return setError(res.error);
    onDone();
  }

  return (
    <div className="p-3 text-xs">
      {canWrite ? (
        <div className="mb-3 flex items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-text-muted">공급사</span>
            <input className={inputSmClass} value={supplier} onChange={(e) => setSupplier(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-text-muted">입고 예정일</span>
            <input type="date" className={inputSmClass} value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-text-muted">수량(톤)</span>
            <input type="number" step={0.5} className={`${inputSmClass} tnum w-24`} value={qty} onChange={(e) => setQty(Number(e.target.value))} />
          </label>
          <Button size="sm" variant="primary" disabled={busy} onClick={add}>
            입고 일정 추가
          </Button>
          {error ? <span className="text-danger">{error}</span> : null}
        </div>
      ) : null}
      <table className="w-full">
        <thead>
          <tr className="text-left text-text-muted">
            <th className="border-b border-border px-2 py-1.5 font-semibold">입고 예정일</th>
            <th className="border-b border-border px-2 py-1.5 font-semibold">공급사</th>
            <th className="border-b border-border px-2 py-1.5 text-right font-semibold">수량</th>
            <th className="border-b border-border px-2 py-1.5 font-semibold">상태</th>
            {canWrite ? <th className="border-b border-border px-2 py-1.5" /> : null}
          </tr>
        </thead>
        <tbody>
          {receipts.map((r) => (
            <tr key={r.id} className="hover:bg-bg-muted">
              <td className="tnum border-b border-border px-2 py-1.5">{r.plannedDate}</td>
              <td className="border-b border-border px-2 py-1.5">{r.supplier}</td>
              <td className="tnum border-b border-border px-2 py-1.5 text-right">{r.qtyTon.toFixed(1)}t</td>
              <td className="border-b border-border px-2 py-1.5">
                <Badge tone={r.status === "received" ? "ok" : "info"}>{r.status === "received" ? "입고 완료" : "입고 예정"}</Badge>
              </td>
              {canWrite ? (
                <td className="border-b border-border px-2 py-1.5 text-right">
                  {r.status === "planned" ? (
                    <button className="mr-2 text-ok hover:underline" onClick={() => setStatus(r.id, "received", r)}>
                      입고 완료
                    </button>
                  ) : null}
                  <button className="text-text-muted hover:text-danger" onClick={() => remove(r.id)}>
                    삭제
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
          {receipts.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-2 py-6 text-center text-text-muted">
                입고 일정이 없습니다.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function MeasurePanel({ siloCodes, measurements, canWrite, periodStart, onDone }: { siloCodes: string[]; measurements: EngineInput["siloMeasurements"]; canWrite: boolean; periodStart: string; onDone: () => void }) {
  const [date, setDate] = useState(periodStart);
  const [vals, setVals] = useState<Record<string, number>>(() => Object.fromEntries(siloCodes.map((c) => [c, measurements.filter((m) => m.siloCode === c).sort((a, b) => b.date.localeCompare(a.date))[0]?.measuredTon ?? 0])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recent = [...measurements].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);

  async function save() {
    setBusy(true);
    setError(null);
    const r = await upsertSiloMeasurement({ date, values: siloCodes.map((c) => ({ siloCode: c, measuredTon: vals[c] ?? 0 })) });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onDone();
  }

  return (
    <div className="grid grid-cols-2 gap-4 p-3 text-xs">
      <div>
        <p className="mb-2 text-text-muted">아침 실측 재고를 사일로별로 입력합니다. 계획 시작일 이전·당일의 최신 실측치 합계가 예측의 기초재고가 됩니다.</p>
        <div className="flex items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-text-muted">일자</span>
            <input type="date" className={inputSmClass} value={date} onChange={(e) => setDate(e.target.value)} disabled={!canWrite} />
          </label>
          {siloCodes.map((c) => (
            <label key={c} className="flex flex-col gap-1">
              <span className="text-text-muted">{c === "S55" ? "55m³ (최대 40t)" : c === "S150" ? "150m³ (최대 120t)" : c}</span>
              <input type="number" step={0.5} className={`${inputSmClass} tnum w-28`} value={vals[c] ?? 0} onChange={(e) => setVals({ ...vals, [c]: Number(e.target.value) })} disabled={!canWrite} />
            </label>
          ))}
          {canWrite ? (
            <Button size="sm" variant="primary" disabled={busy} onClick={save}>
              저장
            </Button>
          ) : null}
        </div>
        {error ? <p className="mt-2 text-danger">{error}</p> : null}
      </div>
      <div>
        <div className="mb-1 font-medium text-text-muted">최근 실측</div>
        <ul className="divide-y divide-border rounded-[var(--radius-sm)] border border-border">
          {recent.map((m, i) => (
            <li key={i} className="tnum flex justify-between px-2 py-1">
              <span>
                {m.date} · {m.siloCode}
              </span>
              <span>{m.measuredTon.toFixed(1)}t</span>
            </li>
          ))}
          {recent.length === 0 ? <li className="px-2 py-2 text-text-muted">실측치가 없습니다.</li> : null}
        </ul>
      </div>
    </div>
  );
}

function ExternalPanel({ rows, canWrite, onDone }: { rows: SeabulkViewProps["externalRows"]; canWrite: boolean; onDone: () => void }) {
  const [vals, setVals] = useState(rows);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(r: (typeof rows)[number]) {
    setBusy(r.id);
    setError(null);
    const res = await updateExternalUsage({ id: r.id, weekdayTon: r.weekdayTon, weekendTon: r.weekendTon });
    setBusy(null);
    if (!res.ok) return setError(res.error);
    onDone();
  }

  return (
    <div className="p-3 text-xs">
      <p className="mb-2 text-text-muted">1단계 계획 대상이 아닌 사출 설비(A1, 2공장 P1~4)의 씨벌크 사용량은 고정값으로 더합니다 (Q9 확정 전 기준값).</p>
      <table className="w-full max-w-xl">
        <thead>
          <tr className="text-left text-text-muted">
            <th className="border-b border-border px-2 py-1.5 font-semibold">설비 그룹</th>
            <th className="border-b border-border px-2 py-1.5 font-semibold">공장</th>
            <th className="border-b border-border px-2 py-1.5 text-right font-semibold">평일(톤/일)</th>
            <th className="border-b border-border px-2 py-1.5 text-right font-semibold">주말(톤/일)</th>
            {canWrite ? <th className="border-b border-border" /> : null}
          </tr>
        </thead>
        <tbody>
          {vals.map((r, i) => (
            <tr key={r.id}>
              <td className="border-b border-border px-2 py-1.5">{r.label}</td>
              <td className="border-b border-border px-2 py-1.5 text-text-muted">{r.factoryCode === "F1" ? "1공장" : "2공장"}</td>
              <td className="border-b border-border px-2 py-1.5 text-right">
                <input type="number" step={0.1} className={`${inputSmClass} tnum w-24 text-right`} value={r.weekdayTon} disabled={!canWrite} onChange={(e) => setVals(vals.map((x, j) => (j === i ? { ...x, weekdayTon: Number(e.target.value) } : x)))} />
              </td>
              <td className="border-b border-border px-2 py-1.5 text-right">
                <input type="number" step={0.1} className={`${inputSmClass} tnum w-24 text-right`} value={r.weekendTon} disabled={!canWrite} onChange={(e) => setVals(vals.map((x, j) => (j === i ? { ...x, weekendTon: Number(e.target.value) } : x)))} />
              </td>
              {canWrite ? (
                <td className="border-b border-border px-2 py-1.5 text-right">
                  <Button size="sm" disabled={busy === r.id} onClick={() => save(r)}>
                    저장
                  </Button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {error ? <p className="mt-2 text-danger">{error}</p> : null}
    </div>
  );
}
