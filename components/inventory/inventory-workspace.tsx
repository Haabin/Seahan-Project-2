"use client";

import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { saveStockMonth } from "@/lib/actions/stock";
import { daysInMonth, stockTotals } from "@/lib/excel/stock-ledger";
import type { StockRowView } from "@/lib/data/stock";
import { Badge, Button, Card, cx, inputSmClass } from "@/components/ui";
import { fmtDateTime, fmtInt } from "@/lib/format";

interface ProductOption {
  id: string;
  name: string;
  safetyStock: number;
}

interface RowState {
  /** 화면용 키: 기존 행은 id, 새 행은 임시 키 */
  key: string;
  id: string | null;
  section: string;
  process: string;
  machineLabel: string;
  itemCode: string | null;
  name: string;
  opening: number;
  packUnit: number | null;
  unitsPerPallet: number | null;
  productId: string | null;
  /** day → [생산, 출고] */
  days: Record<number, [number, number]>;
}

type TextField = "section" | "process" | "machineLabel" | "itemCode" | "name";
type NumField = "opening" | "packUnit" | "unitsPerPallet";
type EditTarget = { key: string; field: TextField | NumField | `p${number}` | `s${number}` };

function toState(r: StockRowView): RowState {
  const days: RowState["days"] = {};
  for (const d of r.days) days[d.day] = [d.produced, d.shipped];
  return {
    key: r.id,
    id: r.id,
    section: r.section,
    process: r.process,
    machineLabel: r.machineLabel,
    itemCode: r.itemCode,
    name: r.name,
    opening: r.opening,
    packUnit: r.packUnit,
    unitsPerPallet: r.unitsPerPallet,
    productId: r.productId,
    days,
  };
}

function totalsOf(r: RowState) {
  return stockTotals({
    opening: r.opening,
    packUnit: r.packUnit,
    unitsPerPallet: r.unitsPerPallet,
    days: Object.entries(r.days).map(([d, [p, s]]) => ({ day: Number(d), produced: p, shipped: s })),
  });
}

function fieldValue(r: RowState, field: EditTarget["field"]): string | number | null {
  if (field[0] === "p" && /^p\d+$/.test(field)) return r.days[Number(field.slice(1))]?.[0] ?? 0;
  if (field[0] === "s" && /^s\d+$/.test(field)) return r.days[Number(field.slice(1))]?.[1] ?? 0;
  return r[field as TextField | NumField];
}

function sameRow(a: RowState, b: RowState): boolean {
  if (a.section !== b.section || a.process !== b.process || a.machineLabel !== b.machineLabel) return false;
  if ((a.itemCode ?? "") !== (b.itemCode ?? "") || a.name !== b.name || a.opening !== b.opening) return false;
  if (a.packUnit !== b.packUnit || a.unitsPerPallet !== b.unitsPerPallet || a.productId !== b.productId) return false;
  for (let d = 1; d <= 31; d++) {
    const x = a.days[d] ?? [0, 0];
    const y = b.days[d] ?? [0, 0];
    if (x[0] !== y[0] || x[1] !== y[1]) return false;
  }
  return true;
}

const th = "border-b border-r border-border bg-bg-sub px-1.5 py-1 text-[11px] font-semibold text-text-muted whitespace-nowrap";
const td = "border-b border-r border-border px-1.5 py-0.5 text-xs whitespace-nowrap";
const DIRTY = "bg-warn-bg";

export function InventoryWorkspace({
  yearMonth,
  months,
  rows: initialRows,
  products,
  canWrite,
  uploadedAt,
  uploadFilename,
  editedAt,
  notice,
}: {
  yearMonth: string;
  months: string[];
  rows: StockRowView[];
  products: ProductOption[];
  canWrite: boolean;
  uploadedAt: string | null;
  uploadFilename: string | null;
  editedAt: string | null;
  /** 저장·업로드 직후 보여줄 안내 */
  notice?: string | null;
}) {
  const router = useRouter();
  const [year, month] = yearMonth.split("-").map(Number);
  const dayCount = daysInMonth(year, month);
  const dayList = useMemo(() => Array.from({ length: dayCount }, (_, i) => i + 1), [dayCount]);

  const original = useMemo(() => new Map(initialRows.map((r) => [r.id, toState(r)] as const)), [initialRows]);
  const [rows, setRows] = useState<RowState[]>(() => initialRows.map(toState));
  const [deleted, setDeleted] = useState<string[]>([]);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [search, setSearch] = useState("");
  const [hideZero, setHideZero] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(notice ? { tone: "ok", text: notice } : null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const tempSeq = useRef(0);

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p] as const)), [products]);

  // 제품별 현재고 합(안전재고 미달 강조용)
  const currentByProduct = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) if (r.productId) m.set(r.productId, (m.get(r.productId) ?? 0) + totalsOf(r).current);
    return m;
  }, [rows]);

  const dirtyKeys = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) {
      const o = r.id ? original.get(r.id) : undefined;
      if (!o || !sameRow(r, o)) s.add(r.key);
    }
    return s;
  }, [rows, original]);
  const dirtyCount = dirtyKeys.size + deleted.length;

  const visible = useMemo(() => {
    const q = search.normalize("NFC").trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !`${r.name} ${r.itemCode ?? ""}`.toLowerCase().includes(q)) return false;
      if (hideZero && totalsOf(r).current === 0 && !dirtyKeys.has(r.key)) return false;
      return true;
    });
  }, [rows, search, hideZero, dirtyKeys]);

  // 구간 → 호기 순서로 묶는다 (원본 표 순서 유지)
  const groups = useMemo(() => {
    const out: { section: string; machines: { label: string; rows: RowState[] }[] }[] = [];
    for (const r of visible) {
      let g = out.find((x) => x.section === r.section);
      if (!g) {
        g = { section: r.section, machines: [] };
        out.push(g);
      }
      let m = g.machines.find((x) => x.label === r.machineLabel);
      if (!m) {
        m = { label: r.machineLabel, rows: [] };
        g.machines.push(m);
      }
      m.rows.push(r);
    }
    return out;
  }, [visible]);

  const commit = useCallback((key: string, field: EditTarget["field"], raw: string) => {
    setRows((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r;
        if (/^[ps]\d+$/.test(field)) {
          const day = Number(field.slice(1));
          const n = raw.trim() === "" ? 0 : Number(raw.replace(/,/g, ""));
          if (!Number.isFinite(n)) return r;
          const cur = r.days[day] ?? [0, 0];
          const next: [number, number] = field[0] === "p" ? [Math.round(n), cur[1]] : [cur[0], Math.round(n)];
          return { ...r, days: { ...r.days, [day]: next } };
        }
        if (field === "opening") {
          const n = raw.trim() === "" ? 0 : Number(raw.replace(/,/g, ""));
          return Number.isFinite(n) ? { ...r, opening: Math.round(n) } : r;
        }
        if (field === "packUnit" || field === "unitsPerPallet") {
          const n = raw.trim() === "" ? null : Number(raw.replace(/,/g, ""));
          return n === null || (Number.isFinite(n) && n > 0) ? { ...r, [field]: n } : r;
        }
        if (field === "itemCode") return { ...r, itemCode: raw.trim() || null };
        return { ...r, [field]: raw.normalize("NFC").replace(/\s+/g, " ").trim() };
      }),
    );
    setEditing(null);
  }, []);

  const setProduct = useCallback((key: string, productId: string | null) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, productId } : r)));
  }, []);

  const removeRow = useCallback((key: string) => {
    setRows((prev) => {
      const target = prev.find((r) => r.key === key);
      if (target?.id) setDeleted((d) => (d.includes(target.id as string) ? d : [...d, target.id as string]));
      return prev.filter((r) => r.key !== key);
    });
  }, []);

  function addRow(section: string, after?: RowState) {
    const base = after ?? rows.filter((r) => r.section === section).slice(-1)[0];
    const key = `new-${++tempSeq.current}`;
    const row: RowState = {
      key,
      id: null,
      section,
      process: base?.process ?? "",
      machineLabel: base?.machineLabel ?? "",
      itemCode: null,
      name: "",
      opening: 0,
      packUnit: base?.packUnit ?? null,
      unitsPerPallet: base?.unitsPerPallet ?? null,
      productId: null,
      days: {},
    };
    setRows((prev) => {
      const idx = base ? prev.findIndex((r) => r.key === base.key) : prev.length - 1;
      const next = prev.slice();
      next.splice(idx + 1, 0, row);
      return next;
    });
    setCollapsed((c) => {
      const n = new Set(c);
      n.delete(`s:${section}`);
      n.delete(`m:${section}:${row.machineLabel}`);
      return n;
    });
    setEditing({ key, field: "name" });
  }

  async function save() {
    const blank = rows.find((r) => dirtyKeys.has(r.key) && !r.name.trim());
    if (blank) {
      setMsg({ tone: "danger", text: "품명이 빈 행이 있습니다. 품명을 넣거나 행을 삭제하세요." });
      return;
    }
    setBusy(true);
    setMsg(null);
    const upserts = rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => dirtyKeys.has(r.key))
      .map(({ r, i }) => ({
        id: r.id,
        section: r.section,
        process: r.process,
        machineLabel: r.machineLabel,
        itemCode: r.itemCode,
        name: r.name,
        opening: r.opening,
        packUnit: r.packUnit,
        unitsPerPallet: r.unitsPerPallet,
        productId: r.productId,
        sortOrder: i,
        days: Object.entries(r.days).map(([d, [p, s]]) => ({ day: Number(d), produced: p, shipped: s })),
      }));
    const res = await saveStockMonth({ yearMonth, upserts, deletes: deleted });
    setBusy(false);
    if (!res.ok) {
      setMsg({ tone: "danger", text: res.error });
      return;
    }
    // 서버 값으로 다시 그린다(새 행에 id 가 붙는다). 결과 안내는 주소의 notice 로 넘긴다
    const notice = `저장했습니다 (수정 ${res.data.saved}행, 삭제 ${res.data.deleted}행). 수급 검증용 재고 ${res.data.snapshots}건을 다시 맞췄습니다.`;
    router.replace(`/inventory?ym=${yearMonth}&notice=${encodeURIComponent(notice)}&t=${Date.now()}`);
    router.refresh();
  }

  const toggle = (id: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const grand = useMemo(() => {
    let opening = 0;
    let produced = 0;
    let shipped = 0;
    let current = 0;
    for (const r of rows) {
      const t = totalsOf(r);
      opening += r.opening;
      produced += t.produced;
      shipped += t.shipped;
      current += t.current;
    }
    return { opening, produced, shipped, current };
  }, [rows]);

  const belowSafetyCount = useMemo(() => {
    let n = 0;
    for (const [pid, cur] of currentByProduct) {
      const p = productById.get(pid);
      if (p && p.safetyStock > 0 && cur < p.safetyStock) n++;
    }
    return n;
  }, [currentByProduct, productById]);

  const monthOptions = months.includes(yearMonth) ? months : [yearMonth, ...months];
  const fixedCols = 14; // 접기 버튼 포함 고정 열 수(합계 행 colSpan 계산용)

  return (
    <div className="space-y-3">
      <Card className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-xs">
        <label className="flex items-center gap-1.5">
          <span className="font-medium text-text-muted">월</span>
          <select
            aria-label="월 선택"
            className={`${inputSmClass} w-28`}
            value={yearMonth}
            onChange={(e) => {
              if (dirtyCount && !window.confirm("저장하지 않은 변경이 있습니다. 다른 달로 이동할까요?")) return;
              router.push(`/inventory?ym=${e.target.value}`);
            }}
          >
            {monthOptions.map((m) => (
              <option key={m} value={m}>
                {m.replace("-", "년 ")}월
              </option>
            ))}
          </select>
        </label>
        {canWrite ? (
          <label className="flex items-center gap-1.5 text-text-muted">
            다른 달 열기
            <input
              type="month"
              aria-label="다른 달 열기"
              className={`${inputSmClass} w-32`}
              onChange={(e) => {
                if (/^\d{4}-\d{2}$/.test(e.target.value)) router.push(`/inventory?ym=${e.target.value}`);
              }}
            />
          </label>
        ) : null}
        <input
          aria-label="품명 검색"
          placeholder="품명·품번 검색"
          className={`${inputSmClass} w-48`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={hideZero} onChange={(e) => setHideZero(e.target.checked)} />
          현재고 0 숨기기
        </label>
        <div className="flex items-center gap-1.5">
          <Badge tone="neutral">품목 {rows.length}</Badge>
          <Badge tone="info">현재고 {fmtInt(grand.current)}</Badge>
          {belowSafetyCount ? <Badge tone="warn">안전재고 미달 {belowSafetyCount}</Badge> : null}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {dirtyCount ? <Badge tone="warn">저장 전 변경 {dirtyCount}행</Badge> : null}
          {canWrite ? (
            <>
              <Button size="sm" onClick={() => setUploadOpen(true)}>
                엑셀 업로드
              </Button>
              <Button size="sm" variant="primary" disabled={busy || !dirtyCount} onClick={save}>
                {busy ? "저장 중…" : "저장"}
              </Button>
            </>
          ) : null}
          <a
            href={`/api/export/stock-ledger?ym=${yearMonth}`}
            className="inline-flex h-7 items-center rounded-[var(--radius-sm)] border border-brand/40 bg-white px-2.5 text-xs font-medium text-brand hover:bg-brand-tint"
          >
            엑셀 다운로드
          </a>
        </div>
      </Card>

      <p className="text-xs text-text-muted">
        데이터 기준 시각: {uploadedAt ? `${fmtDateTime(uploadedAt)} 업로드${uploadFilename ? ` (${uploadFilename})` : ""}` : "업로드 없음"}
        {editedAt ? ` · 마지막 수정 ${fmtDateTime(editedAt)}` : ""} · 현재고 = 기초재고 + 생산 − 출고 (저장하지 않고 계산)
        {canWrite ? " · 셀을 누르면 고칠 수 있습니다. 노란 칸은 저장 전 변경입니다." : ""}
      </p>
      {msg ? (
        <p role="status" className={cx("rounded-[var(--radius-sm)] border px-3 py-2 text-xs", msg.tone === "ok" ? "border-ok/30 bg-ok-bg text-ok" : "border-danger/30 bg-danger-bg text-danger")}>
          {msg.text}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <Card className="p-6 text-sm text-text-muted">
          {yearMonth.replace("-", "년 ")}월 수불 데이터가 없습니다.
          {canWrite ? " 「엑셀 업로드」로 제품수불표를 올리거나 아래에서 행을 추가하세요." : ""}
          {canWrite ? (
            <div className="mt-3">
              <Button size="sm" onClick={() => addRow("")}>
                행 추가
              </Button>
            </div>
          ) : null}
        </Card>
      ) : (
        <Card className="overflow-auto" style={{ maxHeight: "calc(100vh - 230px)" }}>
          <table className="tnum border-separate border-spacing-0 text-xs" data-testid="inventory-table">
            <thead className="sticky top-0 z-20">
              <tr>
                <th rowSpan={2} className={cx(th, "sticky left-0 z-30 w-7")} />
                <th rowSpan={2} className={th}>공정</th>
                <th rowSpan={2} className={th}>호기</th>
                <th rowSpan={2} className={th}>품번</th>
                <th rowSpan={2} className={cx(th, "sticky left-7 z-30 min-w-[220px] text-left")}>품명/규격</th>
                <th colSpan={3} className={th}>수불현황</th>
                <th rowSpan={2} className={th}>현재고</th>
                <th colSpan={2} className={th}>PACKAGE</th>
                <th rowSpan={2} className={th}>UNIT수/P</th>
                <th rowSpan={2} className={th}>EA/1P</th>
                <th rowSpan={2} className={th}>PT 수</th>
                <th rowSpan={2} className={cx(th, "min-w-[150px] text-left")}>계획 제품</th>
                {dayList.map((d) => (
                  <th key={d} colSpan={2} className={th}>
                    {d}일
                  </th>
                ))}
              </tr>
              <tr>
                <th className={th}>기초재고</th>
                <th className={th}>생산</th>
                <th className={th}>출고</th>
                <th className={th}>포장수량</th>
                <th className={th}>unit</th>
                {dayList.map((d) => (
                  <FragmentPair key={d} />
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const sKey = `s:${g.section}`;
                const sClosed = collapsed.has(sKey);
                const all = g.machines.flatMap((m) => m.rows);
                const st = all.reduce(
                  (a, r) => {
                    const t = totalsOf(r);
                    return { opening: a.opening + r.opening, produced: a.produced + t.produced, shipped: a.shipped + t.shipped, current: a.current + t.current };
                  },
                  { opening: 0, produced: 0, shipped: 0, current: 0 },
                );
                return (
                  <SectionBlock key={sKey}>
                    <tr className="bg-brand-tint">
                      <td className={cx(td, "sticky left-0 z-10 bg-brand-tint text-center")}>
                        <button type="button" aria-label={`${g.section || "구간 없음"} 접기/펴기`} onClick={() => toggle(sKey)} className="w-5 text-text-muted">
                          {sClosed ? "▸" : "▾"}
                        </button>
                      </td>
                      <td colSpan={3} className={cx(td, "font-semibold text-brand-deep")}>
                        {g.section || "구간 없음"} <span className="font-normal text-text-muted">({all.length})</span>
                      </td>
                      <td className={cx(td, "sticky left-7 z-10 bg-brand-tint")}>
                        {canWrite ? (
                          <button type="button" className="text-[11px] text-accent hover:underline" onClick={() => addRow(g.section)}>
                            + 행 추가
                          </button>
                        ) : null}
                      </td>
                      <td className={cx(td, "text-right font-semibold")}>{fmtInt(st.opening)}</td>
                      <td className={cx(td, "text-right font-semibold")}>{fmtInt(st.produced)}</td>
                      <td className={cx(td, "text-right font-semibold")}>{fmtInt(st.shipped)}</td>
                      <td className={cx(td, "text-right font-semibold")}>{fmtInt(st.current)}</td>
                      <td colSpan={fixedCols - 8 + dayCount * 2} className={td}>
                        <span className="text-text-muted">{g.section ? `${g.section} 계` : ""}</span>
                      </td>
                    </tr>
                    {sClosed
                      ? null
                      : g.machines.map((m) => {
                          const mKey = `m:${g.section}:${m.label}`;
                          const mClosed = collapsed.has(mKey);
                          return (
                            <SectionBlock key={mKey}>
                              {g.machines.length > 1 ? (
                                <tr className="bg-bg-sub">
                                  <td className={cx(td, "sticky left-0 z-10 bg-bg-sub text-center")}>
                                    <button type="button" aria-label={`${m.label || "호기 없음"} 접기/펴기`} onClick={() => toggle(mKey)} className="w-5 text-text-muted">
                                      {mClosed ? "▸" : "▾"}
                                    </button>
                                  </td>
                                  <td colSpan={fixedCols + dayCount * 2} className={cx(td, "text-text-muted")}>
                                    호기 {m.label || "–"} ({m.rows.length})
                                  </td>
                                </tr>
                              ) : null}
                              {mClosed && g.machines.length > 1
                                ? null
                                : m.rows.map((r) => {
                                    const p = r.productId ? productById.get(r.productId) : undefined;
                                    const below = !!p && p.safetyStock > 0 && (currentByProduct.get(p.id) ?? 0) < p.safetyStock;
                                    return (
                                      <Row
                                        key={r.key}
                                        row={r}
                                        orig={r.id ? original.get(r.id) : undefined}
                                        dayList={dayList}
                                        canWrite={canWrite}
                                        editingField={editing?.key === r.key ? editing.field : null}
                                        onEdit={setEditing}
                                        onCommit={commit}
                                        onRemove={removeRow}
                                        onProduct={setProduct}
                                        products={products}
                                        belowSafety={below}
                                        safetyStock={p?.safetyStock ?? 0}
                                      />
                                    );
                                  })}
                            </SectionBlock>
                          );
                        })}
                  </SectionBlock>
                );
              })}
              <tr className="bg-bg-sub">
                <td className={cx(td, "sticky left-0 z-10 bg-bg-sub")} />
                <td colSpan={3} className={cx(td, "font-semibold")}>합계</td>
                <td className={cx(td, "sticky left-7 z-10 bg-bg-sub")} />
                <td className={cx(td, "text-right font-semibold")}>{fmtInt(grand.opening)}</td>
                <td className={cx(td, "text-right font-semibold")}>{fmtInt(grand.produced)}</td>
                <td className={cx(td, "text-right font-semibold")}>{fmtInt(grand.shipped)}</td>
                <td className={cx(td, "text-right font-semibold")}>{fmtInt(grand.current)}</td>
                <td colSpan={fixedCols - 8 + dayCount * 2} className={td} />
              </tr>
            </tbody>
          </table>
        </Card>
      )}

      {uploadOpen ? <UploadDialog
          yearMonth={yearMonth}
          onClose={() => setUploadOpen(false)}
          onDone={(ym, text) => {
            setUploadOpen(false);
            router.replace(`/inventory?ym=${ym}&notice=${encodeURIComponent(text)}&t=${Date.now()}`);
            router.refresh();
          }}
        /> : null}
    </div>
  );
}

function FragmentPair() {
  return (
    <>
      <th className={th}>생산</th>
      <th className={th}>출고</th>
    </>
  );
}

function SectionBlock({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

interface RowProps {
  row: RowState;
  orig: RowState | undefined;
  dayList: number[];
  canWrite: boolean;
  editingField: EditTarget["field"] | null;
  onEdit: (t: EditTarget | null) => void;
  onCommit: (key: string, field: EditTarget["field"], raw: string) => void;
  onRemove: (key: string) => void;
  onProduct: (key: string, productId: string | null) => void;
  products: ProductOption[];
  belowSafety: boolean;
  safetyStock: number;
}

const Row = memo(function Row({ row, orig, dayList, canWrite, editingField, onEdit, onCommit, onRemove, onProduct, products, belowSafety, safetyStock }: RowProps) {
  const t = totalsOf(row);
  const isNew = !orig;
  // 제품 목록 select 는 누를 때만 그린다(행마다 그리면 수백 행에서 느려진다)
  const [picking, setPicking] = useState(false);
  const linkedName = row.productId ? (products.find((p) => p.id === row.productId)?.name ?? null) : null;

  const cell = (field: EditTarget["field"], opts: { align?: "left" | "right"; className?: string; blankZero?: boolean; label: string }) => {
    const value = fieldValue(row, field);
    const dirty = isNew || fieldValue(orig as RowState, field) !== value;
    const numeric = typeof value === "number" || field === "packUnit" || field === "unitsPerPallet" || field === "opening" || /^[ps]\d+$/.test(field);
    const shown = value === null || value === "" ? "" : numeric ? (opts.blankZero && value === 0 ? "" : fmtInt(value as number)) : String(value);
    if (editingField === field) {
      return (
        <td className={cx(td, "p-0", opts.className)}>
          <input
            autoFocus
            aria-label={opts.label}
            defaultValue={value === null || (opts.blankZero && value === 0) ? "" : String(value)}
            inputMode={numeric ? "numeric" : undefined}
            className={cx("h-6 w-full min-w-[56px] border-2 border-accent bg-white px-1 text-xs outline-none", numeric && "text-right")}
            onBlur={(e) => onCommit(row.key, field, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") onEdit(null);
            }}
          />
        </td>
      );
    }
    return (
      <td
        className={cx(td, opts.align === "left" ? "text-left" : "text-right", dirty && DIRTY, canWrite && "cursor-cell hover:bg-info-bg", opts.className)}
        title={canWrite ? `${opts.label} · 눌러서 수정` : opts.label}
        onClick={canWrite ? () => onEdit({ key: row.key, field }) : undefined}
      >
        {shown || (canWrite && !numeric ? <span className="text-text-faint">–</span> : "")}
      </td>
    );
  };

  const productDirty = isNew || orig?.productId !== row.productId;
  return (
    <tr data-row-key={row.key} style={{ contentVisibility: "auto", containIntrinsicSize: "auto 26px" } as React.CSSProperties}>
      <td className={cx(td, "sticky left-0 z-10 bg-white text-center")}>
        {canWrite ? (
          <button
            type="button"
            aria-label={`${row.name || "새 행"} 삭제`}
            title="행 삭제"
            className="w-5 text-text-faint hover:text-danger"
            onClick={() => {
              if (window.confirm(`"${row.name || "새 행"}" 행을 이 달에서 삭제할까요? 저장을 눌러야 반영됩니다.`)) onRemove(row.key);
            }}
          >
            ×
          </button>
        ) : null}
      </td>
      {cell("process", { align: "left", label: "공정" })}
      {cell("machineLabel", { align: "left", label: "호기" })}
      {cell("itemCode", { align: "left", label: "품번" })}
      {cell("name", { align: "left", label: "품명", className: cx("sticky left-7 z-10 max-w-[320px] overflow-hidden text-ellipsis", !(isNew || orig?.name !== row.name) && "bg-white") })}
      {cell("opening", { label: "기초재고" })}
      <td className={cx(td, "text-right text-text-muted")}>{fmtInt(t.produced)}</td>
      <td className={cx(td, "text-right text-text-muted")}>{fmtInt(t.shipped)}</td>
      <td
        className={cx(td, "text-right font-semibold", belowSafety ? "bg-warn-bg text-[#9a6b00]" : t.current < 0 ? "bg-danger-bg text-danger" : "text-brand-deep")}
        title={belowSafety ? `안전재고 ${fmtInt(safetyStock)} 미달` : t.current < 0 ? "현재고가 음수입니다" : undefined}
      >
        {fmtInt(t.current)}
      </td>
      <td className={cx(td, "text-right text-text-muted")}>{t.packQty === null ? "" : (Math.round(t.packQty * 10) / 10).toLocaleString("ko-KR")}</td>
      {cell("packUnit", { label: "unit" })}
      {cell("unitsPerPallet", { label: "UNIT수/P" })}
      <td className={cx(td, "text-right text-text-muted")}>{t.eaPerPallet === null ? "" : fmtInt(t.eaPerPallet)}</td>
      <td className={cx(td, "text-right text-text-muted")}>{t.pallets === null ? "" : fmtInt(t.pallets)}</td>
      <td className={cx(td, "text-left", productDirty && DIRTY)}>
        {canWrite && picking ? (
          <select
            autoFocus
            aria-label={`${row.name} 계획 제품 연결`}
            className="h-6 w-full max-w-[180px] bg-white text-xs"
            value={row.productId ?? ""}
            onBlur={() => setPicking(false)}
            onChange={(e) => {
              onProduct(row.key, e.target.value || null);
              setPicking(false);
            }}
          >
            <option value="">연결 안 함</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : canWrite ? (
          <button
            type="button"
            className="w-full max-w-[180px] truncate text-left hover:underline"
            title="눌러서 생산계획 제품과 연결"
            aria-label={`${row.name} 계획 제품: ${linkedName ?? "연결 안 함"}`}
            onClick={() => setPicking(true)}
          >
            {linkedName ?? <span className="text-text-faint">연결 안 함</span>}
          </button>
        ) : (
          (linkedName ?? <span className="text-text-faint">–</span>)
        )}
      </td>
      {dayList.map((d) => (
        <DayCells key={d} day={d} render={cell} />
      ))}
    </tr>
  );
});

function DayCells({ day, render }: { day: number; render: (field: EditTarget["field"], opts: { blankZero?: boolean; label: string }) => React.ReactNode }) {
  return (
    <>
      {render(`p${day}`, { blankZero: true, label: `${day}일 생산` })}
      {render(`s${day}`, { blankZero: true, label: `${day}일 출고` })}
    </>
  );
}

// ---------------------------------------------------------------------------
// 업로드: 파일 선택 → 미리보기 → 확인 → 반영
// ---------------------------------------------------------------------------
interface UploadPreview {
  sheetName: string | null;
  year: number | null;
  month: number | null;
  rowCount: number;
  dayValueCount: number;
  newItems: string[];
  unlinkedItems: string[];
  suggestions: { name: string; productName: string }[];
  totals: { opening: number; produced: number; shipped: number; current: number };
  sections: string[];
  warnings: string[];
}

function UploadDialog({ yearMonth, onClose, onDone }: { yearMonth: string; onClose: () => void; onDone: (yearMonth: string, notice: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<UploadPreview | null>(null);
  const [year, setYear] = useState<number>(Number(yearMonth.slice(0, 4)));
  const [month, setMonth] = useState<number>(Number(yearMonth.slice(5, 7)));
  const [applySuggestions, setApplySuggestions] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(mode: "preview" | "apply", f: File) {
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.set("file", f);
    fd.set("mode", mode);
    if (mode === "apply") {
      fd.set("year", String(year));
      fd.set("month", String(month));
      fd.set("applySuggestions", applySuggestions ? "1" : "0");
    }
    try {
      const res = await fetch("/api/import/stock-ledger", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "업로드에 실패했습니다");
        return;
      }
      if (mode === "preview") {
        setPreview(json as UploadPreview);
        if (json.year) setYear(json.year);
        if (json.month) setMonth(json.month);
      } else {
        onDone(json.yearMonth, `${json.yearMonth.replace("-", "년 ")}월 수불표 ${json.applied}행을 반영했습니다. 수급 검증용 재고 ${json.snapshots}건을 맞췄습니다.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const list = (items: string[], max = 8) => (items.length > max ? `${items.slice(0, max).join(", ")} 외 ${items.length - max}건` : items.join(", "));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label="제품수불표 업로드">
      <Card className="max-h-[85vh] w-full max-w-2xl overflow-auto p-5 text-sm">
        <h2 className="text-base font-semibold text-brand-deep">제품수불표 엑셀 업로드</h2>
        <p className="mt-1 text-xs text-text-muted">
          파일을 고르면 먼저 미리보기를 보여줍니다. 확인을 눌러야 반영되며, 같은 월을 다시 올리면 그 월 데이터를 통째로 교체합니다.
        </p>
        <input
          type="file"
          accept=".xlsx"
          aria-label="제품수불표 파일"
          className="mt-3 block w-full text-xs"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setFile(f);
            setPreview(null);
            if (f) void send("preview", f);
          }}
        />
        {busy ? <p className="mt-3 text-xs text-text-muted">처리 중…</p> : null}
        {error ? <p className="mt-3 rounded-[var(--radius-sm)] border border-danger/30 bg-danger-bg px-3 py-2 text-xs text-danger">{error}</p> : null}

        {preview ? (
          <div className="mt-4 space-y-3 text-xs" data-testid="stock-upload-preview">
            <div className="grid grid-cols-4 gap-2">
              <PreviewStat label="반영될 품목" value={`${preview.rowCount}행`} />
              <PreviewStat label="일자별 수량" value={`${preview.dayValueCount}건`} />
              <PreviewStat label="새 품목" value={`${preview.newItems.length}건`} />
              <PreviewStat label="현재고 합계" value={fmtInt(preview.totals.current)} />
            </div>
            <div className="flex items-center gap-2">
              <span className="font-medium text-text-muted">반영할 월</span>
              <input type="number" aria-label="연도" className={`${inputSmClass} w-20`} value={year} min={2020} max={2100} onChange={(e) => setYear(Number(e.target.value))} />
              <span>년</span>
              <select aria-label="월" className={`${inputSmClass} w-16`} value={month} onChange={(e) => setMonth(Number(e.target.value))}>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <span>월</span>
              <span className="text-text-muted">
                (시트 「{preview.sheetName}」 · 구간 {preview.sections.join(", ") || "없음"})
              </span>
            </div>
            {preview.newItems.length ? (
              <p>
                <b>새 품목 {preview.newItems.length}건:</b> {list(preview.newItems)}
              </p>
            ) : null}
            <div>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={applySuggestions} onChange={(e) => setApplySuggestions(e.target.checked)} />
                <b>품명이 같은 생산계획 제품과 연결 ({preview.suggestions.length}건 제안)</b>
              </label>
              {preview.suggestions.length ? <p className="mt-1 text-text-muted">{list(preview.suggestions.map((s) => s.name))}</p> : null}
            </div>
            {preview.unlinkedItems.length ? (
              <p>
                <b>제품과 매칭 안 된 품목 {preview.unlinkedItems.length}건:</b> {list(preview.unlinkedItems)}
                <span className="block text-text-muted">재고현황에는 그대로 나오고, 수급 검증에만 쓰이지 않습니다. 반영 뒤 표의 「계획 제품」 칸에서 직접 연결할 수 있습니다.</span>
              </p>
            ) : null}
            {preview.warnings.length ? (
              <details open={preview.warnings.length <= 6}>
                <summary className="cursor-pointer font-medium text-[#9a6b00]">경고 {preview.warnings.length}건</summary>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-text-muted">
                  {preview.warnings.slice(0, 60).map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                  {preview.warnings.length > 60 ? <li>… 외 {preview.warnings.length - 60}건</li> : null}
                </ul>
              </details>
            ) : null}
          </div>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
            닫기
          </Button>
          <Button size="sm" variant="primary" disabled={busy || !preview || !file} onClick={() => file && send("apply", file)}>
            확인 · {year}년 {month}월에 반영
          </Button>
        </div>
      </Card>
    </div>
  );
}

function PreviewStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-sm)] border border-border px-3 py-2">
      <div className="text-[11px] text-text-muted">{label}</div>
      <div className="tnum text-sm font-semibold text-brand-deep">{value}</div>
    </div>
  );
}
