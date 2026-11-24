"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ChangeoverCoefficient, Line, Product } from "@/lib/engine/types";
import { recalcChangeoverFactors, updateFactorTable, setAllowedMolds, setCustomerMajor, setLineProductCapacity, updateChangeoverCoefficient, updateProduct, updateSetting, setUserRole } from "@/lib/actions/master";
import {
  changeoverSiteLabel,
  coefficientFactor,
  floorRate2,
  HOURS_PER_DAY,
  isFactorOutOfSync,
  parseFactorTable,
  rateFromLostHours,
  type FactorTableRow,
} from "@/lib/engine/changeover";
import { Badge, Button, Card, cx, inputSmClass } from "@/components/ui";
import { LineSpecPanel } from "@/components/master/line-spec-panel";
import type { LineSpec } from "@/lib/data/line-specs";
import { MASTER_SOURCE_KEY, REAL_MASTER_UPLOAD_BLOCKED, isRealMasterSource } from "@/lib/data/master-source";
import { fmtDateTime, fmtInt } from "@/lib/format";
import { FileButton } from "@/components/file-button";

export interface MasterProps {
  lines: Line[];
  products: Product[];
  allowed: { lineId: string; productId: string }[];
  capacities: { lineId: string; productId: string; dailyCapa: number }[];
  coefficients: ChangeoverCoefficient[];
  /** 설비 상세 (line_specs). 없으면 빈 칸으로 표시 */
  lineSpecs?: LineSpec[];
  settings: { key: string; value: unknown; description: string | null; updatedAt: string }[];
  customers: { id: string; name: string; isMajor: boolean }[];
  users: { userId: string; displayName: string; role: "viewer" | "planner" | "admin"; team: string | null }[];
  lastMasterUpload: string | null;
}

const TABS = [
  ["products", "제품 · Capa"],
  ["lines", "호기 · 허용 금형"],
  ["coefs", "교체 손실 계수"],
  ["settings", "설정값 (9장)"],
  ["customers", "거래처"],
  ["users", "계정 · 역할"],
  ["upload", "운용안 일괄 등록"],
] as const;

export function MasterPanels(p: MasterProps) {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("products");
  return (
    <Card>
      <div className="flex items-center gap-1 border-b border-border px-3 py-2">
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={cx("h-7 rounded-[var(--radius-sm)] px-3 text-xs font-medium", tab === k ? "bg-brand text-white" : "text-text-muted hover:bg-bg-sub")}>
            {label}
          </button>
        ))}
      </div>
      <div className="p-3">
        {tab === "products" ? <ProductsPanel products={p.products} /> : null}
        {tab === "lines" ? <LinesPanel lines={p.lines} products={p.products} allowed={p.allowed} capacities={p.capacities} lineSpecs={p.lineSpecs ?? []} /> : null}
        {tab === "coefs" ? (
          <CoefPanel coefficients={p.coefficients} table={parseFactorTable(p.settings.find((s) => s.key === "changeover_factor_table")?.value)} />
        ) : null}
        {tab === "settings" ? <SettingsPanel settings={p.settings} /> : null}
        {tab === "customers" ? <CustomersPanel customers={p.customers} /> : null}
        {tab === "users" ? <UsersPanel users={p.users} /> : null}
        {tab === "upload" ? (
          <UploadPanel last={p.lastMasterUpload} blocked={isRealMasterSource(p.settings.find((s) => s.key === MASTER_SOURCE_KEY)?.value)} />
        ) : null}
      </div>
    </Card>
  );
}

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function run(fn: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, okText = "저장됨") {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: okText } : { ok: false, text: r.error });
    if (r.ok) router.refresh();
    setTimeout(() => setMsg(null), 2500);
  }
  return { busy, msg, run };
}

function Msg({ msg }: { msg: { ok: boolean; text: string } | null }) {
  return msg ? <span className={cx("text-xs", msg.ok ? "text-ok" : "text-danger")}>{msg.text}</span> : null;
}

function ProductsPanel({ products }: { products: Product[] }) {
  const { busy, msg, run } = useAction();
  const [rows, setRows] = useState(products);
  const [q, setQ] = useState("");
  const shown = rows.filter((r) => r.name.toLowerCase().includes(q.toLowerCase()) || r.code.toLowerCase().includes(q.toLowerCase()));
  const edit = (id: string, patch: Partial<Product>) => setRows(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <div className="text-xs">
      <div className="mb-2 flex items-center gap-2">
        <input className={`${inputSmClass} w-64`} placeholder="제품명·코드 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="text-text-muted">{shown.length}개</span>
        <Msg msg={msg} />
      </div>
      <div className="overflow-auto" style={{ maxHeight: "calc(100vh - 260px)" }}>
        <table className="w-full">
          <thead className="sticky top-0 bg-white text-left text-text-muted">
            <tr>
              {["코드", "제품명", "캐비티", "포장", "중량(g)", "기본 Capa/일", "안전재고", "과잉기준(일)", "단위", ""].map((h) => (
                <th key={h} className="border-b border-border px-2 py-1.5 font-semibold">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className="hover:bg-bg-muted">
                <td className="border-b border-border px-2 py-1 text-text-muted">{r.code}</td>
                <td className="border-b border-border px-2 py-1">
                  <input className={`${inputSmClass} w-44`} value={r.name} onChange={(e) => edit(r.id, { name: e.target.value })} />
                </td>
                <td className="border-b border-border px-2 py-1">
                  <input type="number" className={`${inputSmClass} tnum w-16`} value={r.cavity ?? ""} onChange={(e) => edit(r.id, { cavity: e.target.value === "" ? null : Number(e.target.value) })} />
                </td>
                <td className="border-b border-border px-2 py-1">
                  <input type="number" className={`${inputSmClass} tnum w-16`} value={r.packUnit ?? ""} onChange={(e) => edit(r.id, { packUnit: e.target.value === "" ? null : Number(e.target.value) })} />
                </td>
                <td className="border-b border-border px-2 py-1">
                  <input type="number" step={0.1} className={`${inputSmClass} tnum w-20`} value={r.preformWeightG} onChange={(e) => edit(r.id, { preformWeightG: Number(e.target.value) })} />
                </td>
                <td className="border-b border-border px-2 py-1">
                  <input type="number" step={1000} className={`${inputSmClass} tnum w-28`} value={r.defaultDailyCapa} onChange={(e) => edit(r.id, { defaultDailyCapa: Number(e.target.value) })} />
                </td>
                <td className="border-b border-border px-2 py-1">
                  <input type="number" step={1000} className={`${inputSmClass} tnum w-24`} value={r.safetyStock} onChange={(e) => edit(r.id, { safetyStock: Number(e.target.value) })} />
                </td>
                <td className="border-b border-border px-2 py-1">
                  <input type="number" className={`${inputSmClass} tnum w-16`} placeholder="전역" value={r.surplusDays ?? ""} onChange={(e) => edit(r.id, { surplusDays: e.target.value === "" ? null : Number(e.target.value) })} />
                </td>
                <td className="border-b border-border px-2 py-1">
                  <select className={inputSmClass} value={r.unit} onChange={(e) => edit(r.id, { unit: e.target.value as Product["unit"] })}>
                    <option value="EA">본</option>
                    <option value="KEA">천본</option>
                  </select>
                </td>
                <td className="border-b border-border px-2 py-1">
                  <Button size="sm" disabled={busy} onClick={() => run(() => updateProduct(r))}>
                    저장
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LinesPanel({ lines, products, allowed, capacities, lineSpecs }: { lines: Line[]; products: Product[]; allowed: MasterProps["allowed"]; capacities: MasterProps["capacities"]; lineSpecs: LineSpec[] }) {
  const { busy, msg, run } = useAction();
  const targets = lines.filter((l) => l.isPlanTarget);
  const [lineId, setLineId] = useState(targets[0]?.id ?? "");
  const current = new Set(allowed.filter((a) => a.lineId === lineId).map((a) => a.productId));
  const [sel, setSel] = useState<Set<string>>(current);
  const [capEdit, setCapEdit] = useState<Record<string, string>>({});
  const capOf = (pid: string) => capacities.find((c) => c.lineId === lineId && c.productId === pid)?.dailyCapa;

  function pick(id: string) {
    setLineId(id);
    setSel(new Set(allowed.filter((a) => a.lineId === id).map((a) => a.productId)));
    setCapEdit({});
  }
  const line = lines.find((l) => l.id === lineId);
  const dirty = sel.size !== current.size || [...sel].some((x) => !current.has(x));

  return (
    <div className="grid grid-cols-[200px_1fr] gap-4 text-xs">
      <ul className="max-h-[calc(100vh-260px)] overflow-auto rounded-[var(--radius-sm)] border border-border">
        {targets.map((l) => (
          <li key={l.id}>
            <button className={cx("flex w-full items-center justify-between px-3 py-1.5 text-left", l.id === lineId ? "bg-brand text-white" : "hover:bg-bg-sub")} onClick={() => pick(l.id)}>
              <span>{l.name}</span>
              <span className={cx("tnum", l.id === lineId ? "text-white/80" : "text-text-muted")}>{allowed.filter((a) => a.lineId === l.id).length}</span>
            </button>
          </li>
        ))}
      </ul>
      <div>
        {line ? <LineSpecPanel key={line.id} lineId={line.id} lineName={line.name} spec={lineSpecs.find((s) => s.lineId === line.id)} /> : null}
        <div className="mb-2 flex items-center gap-2">
          <span className="font-semibold text-brand-deep">{line?.name}</span>
          <Badge tone="neutral">{line?.processType}</Badge>
          <span className="text-text-muted">허용 금형 {sel.size}개 · 체크로 허용, Capa 비우면 제품 기본 Capa 사용</span>
          <span className="ml-auto flex items-center gap-2">
            <Msg msg={msg} />
            <Button size="sm" variant="primary" disabled={!dirty || busy} onClick={() => run(() => setAllowedMolds(lineId, [...sel]), "허용 금형 저장됨")}>
              허용 금형 저장
            </Button>
          </span>
        </div>
        <div className="overflow-auto" style={{ maxHeight: "calc(100vh - 300px)" }}>
          <table className="w-full">
            <thead className="sticky top-0 bg-white text-left text-text-muted">
              <tr>
                <th className="border-b border-border px-2 py-1.5 font-semibold">허용</th>
                <th className="border-b border-border px-2 py-1.5 font-semibold">제품</th>
                <th className="border-b border-border px-2 py-1.5 text-right font-semibold">기본 Capa</th>
                <th className="border-b border-border px-2 py-1.5 text-right font-semibold">호기 Capa</th>
                <th className="border-b border-border px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {[...products].sort((a, b) => Number(sel.has(b.id)) - Number(sel.has(a.id)) || a.name.localeCompare(b.name, "ko")).map((pr) => (
                <tr key={pr.id} className={cx("hover:bg-bg-muted", sel.has(pr.id) ? "" : "text-text-muted")}>
                  <td className="border-b border-border px-2 py-1">
                    <input
                      type="checkbox"
                      checked={sel.has(pr.id)}
                      onChange={(e) => {
                        const n = new Set(sel);
                        if (e.target.checked) n.add(pr.id);
                        else n.delete(pr.id);
                        setSel(n);
                      }}
                    />
                  </td>
                  <td className="border-b border-border px-2 py-1">{pr.name}</td>
                  <td className="tnum border-b border-border px-2 py-1 text-right">{fmtInt(pr.defaultDailyCapa)}</td>
                  <td className="border-b border-border px-2 py-1 text-right">
                    <input
                      type="number"
                      step={1000}
                      className={`${inputSmClass} tnum w-28 text-right`}
                      placeholder="기본값"
                      disabled={!current.has(pr.id)}
                      value={capEdit[pr.id] ?? (capOf(pr.id) ?? "")}
                      onChange={(e) => setCapEdit({ ...capEdit, [pr.id]: e.target.value })}
                    />
                  </td>
                  <td className="border-b border-border px-2 py-1">
                    {current.has(pr.id) && capEdit[pr.id] !== undefined ? (
                      <Button size="sm" disabled={busy} onClick={() => run(() => setLineProductCapacity(lineId, pr.id, capEdit[pr.id] === "" ? null : Number(capEdit[pr.id])), "Capa 저장됨")}>
                        저장
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

const PT_LABEL: Record<string, string> = { PET1_1STAGE: "1공장 PET1 (1-Stage)", PET2_INJ: "PET2 사출 (2-Stage)", PET2_BLOW: "PET2 블로우 (2-Stage)", PE: "PE" };

function CoefPanel({ coefficients, table }: { coefficients: ChangeoverCoefficient[]; table: FactorTableRow[] }) {
  const { busy, msg, run } = useAction();
  const [rows, setRows] = useState(coefficients);
  const edit = (i: number, patch: Partial<ChangeoverCoefficient>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const outOfSync = coefficients.filter((c) => isFactorOutOfSync(c, table));
  return (
    <div className="text-xs">
      <p className="mb-2 text-text-muted">
        예상 생산량 = 일일 Capa × 교체 가동률 계수(교체일) × 주말 계수. 가동률은 손실 시간(0~24 정수)을 아래 「비가동 시간 → 가동률 기준표」에서 찾아 소수 둘째 자리 내림한 값입니다.
        기준표에 없는 시간(10h 이상 등)은 (24 − h) ÷ 24 를 둘째 자리 내림하고 「기준표 밖」으로 표시합니다. 「익일가동」을 켜면 시간과 무관하게 교체일 생산량 0. <Msg msg={msg} />
      </p>
      {outOfSync.length > 0 ? (
        <div className="mb-2 flex max-w-3xl items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-warn bg-warn-bg px-2 py-1.5">
          <span>저장된 가동률 {outOfSync.length}건이 기준표 계산값과 다릅니다. 다시 계산하면 계산값으로 저장됩니다.</span>
          <Button size="sm" disabled={busy} onClick={() => run(() => recalcChangeoverFactors(), "가동률 다시 계산됨")}>
            전체 다시 계산
          </Button>
        </div>
      ) : null}
      <table className="w-full max-w-3xl">
        <thead className="text-left text-text-muted">
          <tr>
            {["공정", "교체 유형", "손실 시간(h)", "가동률 계수 (자동)", "익일가동", ""].map((h) => (
              <th key={h} className="border-b border-border px-2 py-1.5 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const rate = rateFromLostHours(r.hours, table);
            return (
              <tr key={`${r.processType}-${r.changeoverType}`} className="hover:bg-bg-muted">
                <td className="border-b border-border px-2 py-1">{PT_LABEL[r.processType] ?? r.processType}</td>
                <td className="border-b border-border px-2 py-1">{changeoverSiteLabel(r.changeoverType)}</td>
                <td className="border-b border-border px-2 py-1">
                  <input
                    type="number"
                    step={1}
                    min={0}
                    max={HOURS_PER_DAY}
                    className={`${inputSmClass} tnum w-20`}
                    value={r.hours}
                    disabled={r.nextDayStart}
                    onChange={(e) => edit(i, { hours: e.target.value === "" ? 0 : Math.min(HOURS_PER_DAY, Math.max(0, Math.trunc(Number(e.target.value)))) })}
                  />
                </td>
                <td className="tnum border-b border-border px-2 py-1">
                  {r.nextDayStart ? (
                    <span className="text-text-muted">0 (익일가동)</span>
                  ) : (
                    <span>
                      {coefficientFactor(r, table).toFixed(2)}
                      {rate.source === "outside" ? <span className="ml-1 text-warn">(기준표 밖 → 계산값)</span> : null}
                    </span>
                  )}
                  {isFactorOutOfSync(coefficients[i] ?? r, table) ? (
                    <span className="ml-1.5 text-warn" title="DB에 저장된 값">
                      (저장값 {coefficients[i]?.factor})
                    </span>
                  ) : null}
                </td>
                <td className="border-b border-border px-2 py-1">
                  <label className="flex items-center gap-1">
                    <input type="checkbox" checked={r.nextDayStart} onChange={(e) => edit(i, { nextDayStart: e.target.checked })} data-testid="next-day-start" />
                    <span className="text-text-muted">{r.nextDayStart ? "켜짐" : "꺼짐"}</span>
                  </label>
                </td>
                <td className="border-b border-border px-2 py-1">
                  <Button size="sm" disabled={busy} onClick={() => run(() => updateChangeoverCoefficient({ processType: r.processType, changeoverType: r.changeoverType, hours: r.hours, nextDayStart: r.nextDayStart }))}>
                    저장
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <FactorTableEditor table={table} />
    </div>
  );
}

/** 비가동 시간 → 가동률 기준표 (settings.changeover_factor_table): 원본 값 그대로 보이고 고치며, 옆에 적용 값(둘째 자리 내림) */
function FactorTableEditor({ table }: { table: FactorTableRow[] }) {
  const { busy, msg, run } = useAction();
  const [rows, setRows] = useState(() => table.map((r) => ({ hours: r.hours, rate: String(r.rate) })));
  const parsed = rows.map((r) => ({ hours: r.hours, rate: Number(r.rate) }));
  const invalid = parsed.some((r) => !Number.isFinite(r.rate) || r.rate < 0 || r.rate > 1);
  return (
    <div className="mt-5 max-w-xl" data-testid="factor-table">
      <h3 className="mb-1 text-[13px] font-semibold text-brand-deep">비가동 시간 → 가동률 기준표</h3>
      <p className="mb-2 text-text-muted">
        출처: 주간 생산계획표 「생산1_1STAGE」 I65:J73. 원본 값을 그대로 저장하고, 계산에는 소수 둘째 자리 내림한 「적용 값」을 씁니다. 0h는 1.00. 저장 후 위 계수표가 어긋나면 「전체 다시 계산」을 누르세요. <Msg msg={msg} />
      </p>
      <table className="w-full">
        <thead className="text-left text-text-muted">
          <tr>
            {["비가동 시간", "가동률 원본 값", "적용 값 (둘째 자리 내림)"].map((h) => (
              <th key={h} className="border-b border-border px-2 py-1.5 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const n = Number(r.rate);
            return (
              <tr key={r.hours} className="hover:bg-bg-muted">
                <td className="tnum border-b border-border px-2 py-1">{r.hours}h</td>
                <td className="border-b border-border px-2 py-1">
                  <input
                    className={`${inputSmClass} tnum w-24`}
                    value={r.rate}
                    inputMode="decimal"
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)))}
                  />
                </td>
                <td className="tnum border-b border-border px-2 py-1">{Number.isFinite(n) && n >= 0 && n <= 1 ? floorRate2(n).toFixed(2) : <span className="text-danger">0~1 숫자</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-2 flex justify-end">
        <Button size="sm" disabled={busy || invalid} onClick={() => run(() => updateFactorTable(parsed), "기준표 저장됨")}>
          기준표 저장
        </Button>
      </div>
    </div>
  );
}

/** 설정값 표에서 숨기는 키: 기준표는 「교체 손실 계수」 탭에서 고치고, 예전 반올림 설정은 사용하지 않는다(0004) */
const HIDDEN_SETTING_KEYS = ["changeover_factor_table", "changeover_factor_rounding"];

function SettingsPanel({ settings }: { settings: MasterProps["settings"] }) {
  const { busy, msg, run } = useAction();
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(settings.map((s) => [s.key, typeof s.value === "string" ? s.value : JSON.stringify(s.value)])));
  function parse(key: string, raw: string): unknown {
    if (key === "default_changeover_type" || key === "qty_unit") return raw.replace(/"/g, "");
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  return (
    <div className="text-xs">
      <p className="mb-2 text-text-muted">요구사항 9장 미확정 항목. 고객 답변이 오면 여기서 값만 바꾸면 전체 계산에 반영됩니다 (NFR-07). <Msg msg={msg} /></p>
      <table className="w-full max-w-4xl">
        <thead className="text-left text-text-muted">
          <tr>
            {["키", "설명", "값", "수정 시각", ""].map((h) => (
              <th key={h} className="border-b border-border px-2 py-1.5 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {settings.filter((s) => !HIDDEN_SETTING_KEYS.includes(s.key)).map((s) => (
            <tr key={s.key} className="hover:bg-bg-muted">
              <td className="border-b border-border px-2 py-1 font-mono text-[11px]">{s.key}</td>
              <td className="border-b border-border px-2 py-1 text-text-muted">{s.description}</td>
              <td className="border-b border-border px-2 py-1">
                {s.key === "default_changeover_type" ? (
                  <select className={`${inputSmClass} w-28`} value={vals[s.key]?.replace(/"/g, "")} onChange={(e) => setVals({ ...vals, [s.key]: e.target.value })}>
                    <option value="BM">BM (B/M만)</option>
                    <option value="FULL">FULL (Full set)</option>
                  </select>

                ) : s.key === "qty_unit" ? (
                  <select className={`${inputSmClass} w-28`} value={vals[s.key]?.replace(/"/g, "")} onChange={(e) => setVals({ ...vals, [s.key]: e.target.value })}>
                    <option value="EA">EA (본)</option>
                    <option value="KEA">KEA (천본)</option>
                  </select>
                ) : (
                  <input className={`${inputSmClass} tnum w-28`} value={vals[s.key] ?? ""} onChange={(e) => setVals({ ...vals, [s.key]: e.target.value })} />
                )}
              </td>
              <td className="tnum border-b border-border px-2 py-1 text-text-muted">{fmtDateTime(s.updatedAt)}</td>
              <td className="border-b border-border px-2 py-1">
                <Button size="sm" disabled={busy} onClick={() => run(() => updateSetting(s.key, parse(s.key, vals[s.key] ?? "")))}>
                  저장
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CustomersPanel({ customers }: { customers: MasterProps["customers"] }) {
  const { msg, run } = useAction();
  return (
    <div className="text-xs">
      <p className="mb-2 text-text-muted">대형 거래선 표시는 수급 검증 우선순위(FR-11)에 사용됩니다 (Q12). <Msg msg={msg} /></p>
      <ul className="grid max-w-3xl grid-cols-2 gap-1">
        {customers.map((c) => (
          <li key={c.id} className="flex items-center justify-between rounded-[var(--radius-sm)] border border-border px-3 py-1.5">
            <span>{c.name}</span>
            <label className="flex items-center gap-1.5 text-text-muted">
              <input type="checkbox" checked={c.isMajor} onChange={(e) => run(() => setCustomerMajor(c.id, e.target.checked))} /> 대형 거래선
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

function UsersPanel({ users }: { users: MasterProps["users"] }) {
  const { msg, run } = useAction();
  return (
    <div className="text-xs">
      <p className="mb-2 text-text-muted">
        계정은 Supabase 대시보드(Authentication → Users → Add user) 또는 <code className="rounded bg-bg-sub px-1">npm run create-user</code>로 만듭니다. 가입 직후 역할은 「조회」입니다. <Msg msg={msg} />
      </p>
      <table className="w-full max-w-2xl">
        <thead className="text-left text-text-muted">
          <tr>
            <th className="border-b border-border px-2 py-1.5 font-semibold">이름</th>
            <th className="border-b border-border px-2 py-1.5 font-semibold">팀</th>
            <th className="border-b border-border px-2 py-1.5 font-semibold">역할</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.userId} className="hover:bg-bg-muted">
              <td className="border-b border-border px-2 py-1">{u.displayName}</td>
              <td className="border-b border-border px-2 py-1 text-text-muted">{u.team ?? "–"}</td>
              <td className="border-b border-border px-2 py-1">
                <select className={`${inputSmClass} w-36`} value={u.role} onChange={(e) => run(() => setUserRole(u.userId, e.target.value as MasterProps["users"][number]["role"]), "역할 변경됨")}>
                  <option value="viewer">조회 (생산팀·영업팀)</option>
                  <option value="planner">작성 (생산지원팀장)</option>
                  <option value="admin">관리</option>
                </select>
              </td>
            </tr>
          ))}
          {users.length === 0 ? (
            <tr>
              <td colSpan={3} className="px-2 py-4 text-text-muted">
                계정이 없습니다.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function UploadPanel({ last, blocked }: { last: string | null; blocked: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    setResult(null);
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/import/master", { method: "POST", body: fd });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) return setError(json.error ?? "업로드 실패");
    setResult(json);
    router.refresh();
  }

  return (
    <div className="max-w-2xl text-xs">
      <p className="mb-2 text-text-muted">
        제품배치 운용안 엑셀(시트 「운용안」: 호기 · 제품코드 · 제품명 · 캐비티 · 포장단위 · 중량 · 일일Capa · 안전재고 · 월별 물량·가동일수)을 올리면 제품을 갱신하고, 파일에 등장한 호기의 허용 금형·Capa·월별 물량을 교체합니다 (FR-01).
      </p>
      <p className="mb-3 text-text-muted">마지막 등록: {fmtDateTime(last)}</p>
      {blocked ? (
        // settings.master_source = "real": 실제 운용안이 들어간 DB. 이 양식으로 올리면 섞이거나 덮어써지므로 막는다
        <div className="rounded-[var(--radius-sm)] bg-bg-sub p-3 text-text" data-testid="master-upload-blocked">
          <p className="font-semibold">이 DB에는 실제 운용안이 등록되어 있어 여기서는 업로드할 수 없습니다.</p>
          <p className="mt-1 text-text-muted">{REAL_MASTER_UPLOAD_BLOCKED}</p>
        </div>
      ) : (
        <FileButton ariaLabel="제품배치 운용안 파일" busy={busy} onFile={(f) => void upload(f)} />
      )}
      {busy ? <p className="mt-2 text-text-muted">처리 중…</p> : null}
      {error ? <p className="mt-2 text-danger">{error}</p> : null}
      {result ? (
        <div className="mt-3 rounded-[var(--radius-sm)] bg-ok-bg p-3 text-ok">
          제품 {String(result.products)}개 · 호기 {String(result.lines)}개 · 허용 금형 {String(result.molds)} · Capa {String(result.capacities)} · 월별 물량 {String(result.monthly)}
          {Array.isArray(result.warnings) && result.warnings.length ? <div className="mt-1 text-[#9a6b00]">경고 {result.warnings.length}건: {(result.warnings as string[]).slice(0, 3).join(" / ")}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
