"use client";

import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { saveStockMonth } from "@/lib/actions/stock";
import { daysInMonth, stockTotals } from "@/lib/excel/stock-ledger";
import type { StockRowView } from "@/lib/data/stock";
import { Badge, Button, Card, cx, inputSmClass } from "@/components/ui";
import { fmtDateTime, fmtInt } from "@/lib/format";
import { ProductCombobox } from "@/components/product-combobox";
import { FileButton } from "@/components/file-button";
import { AutoLinkDialog } from "@/components/inventory/auto-link-dialog";

interface ProductOption {
  id: string;
  code: string;
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

/** 기초재고·생산·출고에 음수가 있거나 현재고가 음수인가 */
function hasNegative(r: RowState): boolean {
  if (r.opening < 0) return true;
  for (const d of Object.values(r.days)) if (d[0] < 0 || d[1] < 0) return true;
  return totalsOf(r).current < 0;
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
  planned,
  plannedSources,
  todayDay,
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
  /** 생산 예정: 제품 id → 일 → 확정 계획 수량 */
  planned?: Record<string, Record<number, number>>;
  plannedSources?: string[];
  /** 오늘이 이 달의 며칠인지. 지난 달이면 32(예정 없음), 다음 달이면 0(전부 예정) */
  todayDay?: number;
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
  const [onlyNegative, setOnlyNegative] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(notice ? { tone: "ok", text: notice } : null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
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
      if (onlyNegative && !hasNegative(r)) return false;
      return true;
    });
  }, [rows, search, hideZero, onlyNegative, dirtyKeys]);
  const negativeCount = useMemo(() => rows.filter(hasNegative).length, [rows]);

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
    // 음수 검사: 기초재고는 음수가 될 수 없고, 생산·출고의 음수는 보정(반품·수량 정정)일 때만 쓰므로 한 번 물어본다
    const typed = raw.trim() === "" ? 0 : Number(raw.replace(/,/g, ""));
    if (Number.isFinite(typed) && typed < 0) {
      if (field === "opening") {
        setMsg({ tone: "danger", text: `기초재고에는 음수를 넣을 수 없습니다 (입력값 ${typed.toLocaleString("ko-KR")}). 재고가 모자란 것은 생산·출고 수량으로 맞추세요.` });
        setEditing(null);
        return;
      }
      if (/^[ps]d+$/.test(field)) {
        const what = `${field.slice(1)}일 ${field[0] === "p" ? "생산" : "출고"}`;
        const ok = window.confirm(`${what}에 음수 ${typed.toLocaleString("ko-KR")} 을(를) 넣으려고 합니다.

음수는 반품·수량 정정 같은 보정일 때만 씁니다. 잘못 누른 것이라면 「취소」를 누르세요.

보정으로 넣을까요?`);
        if (!ok) {
          setEditing(null);
          return;
        }
      }
    }
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

  /** 「품목 추가」 창에서 받은 품목을 넣는다. 저장 전 변경이 없으면 바로 저장하고, 있으면 표에만 넣어 함께 저장하게 한다 */
  async function addItem(item: NewItem): Promise<string | null> {
    const base = rows.filter((r) => r.section === item.section).slice(-1)[0];
    if (dirtyCount === 0) {
      setBusy(true);
      const sortOrder = base ? rows.findIndex((r) => r.key === base.key) + 1 : rows.length;
      const res = await saveStockMonth({
        yearMonth,
        upserts: [{ id: null, ...item, sortOrder, days: [] }],
        deletes: [],
      });
      setBusy(false);
      if (!res.ok) return res.error;
      setAddOpen(false);
      router.replace(`/inventory?ym=${yearMonth}&notice=${encodeURIComponent(`"${item.name}" 품목을 추가했습니다.`)}&t=${Date.now()}`);
      router.refresh();
      return null;
    }
    const key = `new-${++tempSeq.current}`;
    const row: RowState = { key, id: null, ...item, days: {} };
    setRows((prev) => {
      const idx = base ? prev.findIndex((r) => r.key === base.key) : prev.length - 1;
      const next = prev.slice();
      next.splice(idx + 1, 0, row);
      return next;
    });
    setCollapsed((c) => {
      const n = new Set(c);
      n.delete(`s:${item.section}`);
      n.delete(`m:${item.section}:${item.machineLabel}`);
      return n;
    });
    setAddOpen(false);
    setMsg({ tone: "ok", text: `"${item.name}" 품목을 표에 넣었습니다. 다른 변경과 함께 「저장」을 눌러야 반영됩니다.` });
    return null;
  }

  /** 품목 삭제. 저장 전 변경이 없으면 바로 삭제하고, 있으면 표에서만 빼 두고 함께 저장하게 한다 */
  async function deleteItem(key: string) {
    const target = rows.find((r) => r.key === key);
    if (!target) return;
    if (!target.id || dirtyCount > 0) {
      removeRow(key);
      if (target.id) setMsg({ tone: "ok", text: `"${target.name}" 을(를) 표에서 뺐습니다. 다른 변경과 함께 「저장」을 눌러야 반영됩니다.` });
      return;
    }
    setBusy(true);
    const res = await saveStockMonth({ yearMonth, upserts: [], deletes: [target.id] });
    setBusy(false);
    if (!res.ok) {
      setMsg({ tone: "danger", text: res.error });
      return;
    }
    router.replace(`/inventory?ym=${yearMonth}&notice=${encodeURIComponent(`"${target.name}" 품목을 이 달에서 삭제했습니다.`)}&t=${Date.now()}`);
    router.refresh();
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
  // 생산 예정은 제품에 연결된 품목 가운데 첫 행에만 보여준다(같은 제품의 여러 품목에 중복해서 더하지 않게)
  const plannedByRow = useMemo(() => {
    const m = new Map<string, Record<number, number>>();
    const seen = new Set<string>();
    for (const r of rows) {
      if (!r.productId || seen.has(r.productId)) continue;
      seen.add(r.productId);
      const p = planned?.[r.productId];
      if (p) m.set(r.key, p);
    }
    return m;
  }, [rows, planned]);
  const from = todayDay ?? 32;
  const futurePlanned = (p: Record<number, number> | undefined) => {
    if (!p) return 0;
    let s = 0;
    for (const [d, q] of Object.entries(p)) if (Number(d) >= from) s += q;
    return s;
  };
  const grandPlanned = useMemo(() => {
    let s = 0;
    for (const p of plannedByRow.values()) for (const [d, q] of Object.entries(p)) if (Number(d) >= from) s += q;
    return s;
  }, [plannedByRow, from]);
  const fixedCols = 16; // 접기 버튼 포함 고정 열 수(합계 행 colSpan 계산용)

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
          className={inputSmClass}
          style={{ width: 200 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={hideZero} onChange={(e) => setHideZero(e.target.checked)} />
          현재고 0 숨기기
        </label>
        {negativeCount || onlyNegative ? (
          <label className="flex items-center gap-1.5 text-danger" title="기초재고·생산·출고에 음수가 있거나 현재고가 음수인 품목">
            <input type="checkbox" checked={onlyNegative} onChange={(e) => setOnlyNegative(e.target.checked)} />
            음수 있는 품목만 ({negativeCount})
          </label>
        ) : null}
        <div className="flex items-center gap-1.5">
          <Badge tone="neutral">품목 {rows.length}</Badge>
          <Badge tone="info">현재고 {fmtInt(grand.current)}</Badge>
          {belowSafetyCount ? <Badge tone="warn">안전재고 미달 {belowSafetyCount}</Badge> : null}
          <Badge tone={rows.some((r) => r.productId) ? "neutral" : "warn"} title="생산계획 제품에 연결된 품목 수. 연결된 품목의 재고만 수급 검증에 쓰입니다">
            제품 연결 {rows.filter((r) => r.productId).length}/{rows.length}
          </Badge>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {dirtyCount ? <Badge tone="warn">저장 전 변경 {dirtyCount}행</Badge> : null}
          {canWrite ? (
            <>
              <Button
                size="sm"
                data-testid="autolink-open"
                disabled={dirtyCount > 0}
                title={dirtyCount > 0 ? "저장하지 않은 변경이 있습니다. 먼저 저장하세요" : "연결되지 않은 품목을 생산계획 제품과 한꺼번에 연결합니다"}
                onClick={() => setLinkOpen(true)}
              >
                제품 자동 연결
              </Button>
              <Button size="sm" data-testid="stock-add-open" onClick={() => setAddOpen(true)}>
                품목 추가
              </Button>
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
        {plannedSources?.length ? ` · 회색 기울임 숫자 = 생산 예정(확정 계획 ${plannedSources.join(", ")}, 실적 아님)` : " · 이 달에 걸친 확정 계획이 없어 생산 예정은 표시되지 않습니다"}
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
                <th rowSpan={2} className={cx(th, "text-text-faint")} title="확정된 생산계획에서 오늘 이후로 잡혀 있는 수량 (실적 아님)">
                  생산 예정
                </th>
                <th rowSpan={2} className={cx(th, "text-text-faint")} title="현재고 + 생산 예정">
                  예상 재고
                </th>
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
                      <td className={cx(td, "text-right italic text-text-faint")}>{(() => {
                        const v = all.reduce((a, r) => a + futurePlanned(plannedByRow.get(r.key)), 0);
                        return v ? fmtInt(v) : "";
                      })()}</td>
                      <td className={td} />
                      <td colSpan={fixedCols - 10 + dayCount * 2} className={td}>
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
                                        onRemove={deleteItem}
                                        onProduct={setProduct}
                                        products={products}
                                        belowSafety={below}
                                        safetyStock={p?.safetyStock ?? 0}
                                        planned={plannedByRow.get(r.key)}
                                        plannedFrom={from}
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
                <td className={cx(td, "text-right italic text-text-faint")}>{grandPlanned ? fmtInt(grandPlanned) : ""}</td>
                <td className={cx(td, "text-right italic text-text-faint")}>{grandPlanned ? fmtInt(grand.current + grandPlanned) : ""}</td>
                <td colSpan={fixedCols - 10 + dayCount * 2} className={td} />
              </tr>
            </tbody>
          </table>
        </Card>
      )}

      {linkOpen ? (
        <AutoLinkDialog
          yearMonth={yearMonth}
          items={rows.filter((r) => r.id).map((r) => ({ id: r.id as string, name: r.name, section: r.section, machineLabel: r.machineLabel, productId: r.productId }))}
          products={products}
          onClose={() => setLinkOpen(false)}
          onDone={(text) => {
            setLinkOpen(false);
            router.replace(`/inventory?ym=${yearMonth}&notice=${encodeURIComponent(text)}&t=${Date.now()}`);
            router.refresh();
          }}
        />
      ) : null}
      {addOpen ? (
        <AddItemDialog
          sections={Array.from(new Set(rows.map((r) => r.section)))}
          defaults={(section) => {
            const b = rows.filter((r) => r.section === section).slice(-1)[0];
            return { process: b?.process ?? "", machineLabel: b?.machineLabel ?? "" };
          }}
          products={products}
          busy={busy}
          willSaveNow={dirtyCount === 0}
          onAdd={addItem}
          onClose={() => setAddOpen(false)}
        />
      ) : null}
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
  /** 이 품목(제품)의 일자별 생산 예정 */
  planned?: Record<number, number>;
  /** 이 날부터를 "예정"으로 본다 */
  plannedFrom: number;
}

const Row = memo(function Row({ row, orig, dayList, canWrite, editingField, onEdit, onCommit, onRemove, onProduct, products, belowSafety, safetyStock, planned, plannedFrom }: RowProps) {
  const t = totalsOf(row);
  let plannedTotal = 0;
  if (planned) for (const [d, q] of Object.entries(planned)) if (Number(d) >= plannedFrom) plannedTotal += q;
  const isNew = !orig;
  // 제품 목록 select 는 누를 때만 그린다(행마다 그리면 수백 행에서 느려진다)
  const [picking, setPicking] = useState(false);
  const linkedName = row.productId ? (products.find((p) => p.id === row.productId)?.name ?? null) : null;

  const cell = (field: EditTarget["field"], opts: { align?: "left" | "right"; className?: string; blankZero?: boolean; label: string }) => {
    const value = fieldValue(row, field);
    const dirty = isNew || fieldValue(orig as RowState, field) !== value;
    const numeric = typeof value === "number" || field === "packUnit" || field === "unitsPerPallet" || field === "opening" || /^[ps]\d+$/.test(field);
    const shown = value === null || value === "" ? "" : numeric ? (opts.blankZero && value === 0 ? "" : fmtInt(value as number)) : String(value);
    const negative = typeof value === "number" && value < 0;
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
        className={cx(td, opts.align === "left" ? "text-left" : "text-right", dirty && DIRTY, negative && "bg-danger-bg font-semibold text-danger", canWrite && "cursor-cell hover:bg-info-bg", opts.className)}
        data-negative={negative ? "true" : undefined}
        title={negative ? `${opts.label} · 음수입니다. 보정(반품·수량 정정)이 아니라면 고치세요` : canWrite ? `${opts.label} · 눌러서 수정` : opts.label}
        onClick={canWrite ? () => onEdit({ key: row.key, field }) : undefined}
      >
        {shown ||
          (() => {
            // 실적이 비어 있는 오늘 이후 생산 칸에는 확정 계획 수량을 회색으로 보여준다
            const pm = /^p(\d+)$/.exec(field);
            const q = pm && Number(pm[1]) >= plannedFrom ? planned?.[Number(pm[1])] : undefined;
            if (q) return <span className="italic text-text-faint" title="생산 예정 (확정된 생산계획 · 실적 아님)">{fmtInt(q)}</span>;
            return canWrite && !numeric ? <span className="text-text-faint">–</span> : "";
          })()}
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
            title="이 품목을 이 달에서 삭제"
            className="w-5 rounded text-sm font-bold text-text-muted hover:bg-danger-bg hover:text-danger"
            onClick={() => {
              if (window.confirm(`"${row.name || "새 행"}" 품목을 이 달에서 삭제할까요? 이 달의 기초재고와 일자별 생산·출고 기록이 함께 지워집니다.`)) onRemove(row.key);
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
      <td className={cx(td, "text-right italic text-text-faint")} title="확정된 생산계획에서 오늘 이후로 잡혀 있는 수량 (실적 아님)">
        {plannedTotal ? fmtInt(plannedTotal) : ""}
      </td>
      <td className={cx(td, "text-right italic text-text-faint")} title="현재고 + 생산 예정">
        {plannedTotal ? fmtInt(t.current + plannedTotal) : ""}
      </td>
      <td className={cx(td, "text-right text-text-muted")} title={t.current < 0 ? "현재고가 음수라 포장수량을 계산하지 않습니다" : undefined}>
        {t.packQty === null || t.current < 0 ? (t.current < 0 ? "–" : "") : (Math.round(t.packQty * 10) / 10).toLocaleString("ko-KR")}
      </td>
      {cell("packUnit", { label: "unit" })}
      {cell("unitsPerPallet", { label: "UNIT수/P" })}
      <td className={cx(td, "text-right text-text-muted")}>{t.eaPerPallet === null ? "" : fmtInt(t.eaPerPallet)}</td>
      <td className={cx(td, "text-right text-text-muted")} title={t.current < 0 ? "현재고가 음수라 PT 수를 계산하지 않습니다" : undefined}>
        {t.pallets === null || t.current < 0 ? (t.current < 0 ? "–" : "") : fmtInt(t.pallets)}
      </td>
      <td className={cx(td, "text-left", productDirty && DIRTY)}>
        {canWrite && picking ? (
          <div className="w-[180px] whitespace-normal">
            <ProductCombobox
              autoFocus
              label={`${row.name} 계획 제품 연결`}
              placeholder="제품 검색"
              emptyOptionLabel="연결 안 함"
              products={products}
              value=""
              onChange={(id) => onProduct(row.key, id || null)}
              onDismiss={() => setPicking(false)}
            />
          </div>
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
  suggestions: { name: string; productName: string; kind?: "auto" | "parent" }[];
  ambiguousItems?: { name: string; candidates: string[] }[];
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
        <div className="mt-3">
          <FileButton
            label="엑셀파일 선택"
            ariaLabel="제품수불표 파일"
            fileName={file?.name}
            disabled={busy}
            onFile={(f) => {
              setFile(f);
              setPreview(null);
              void send("preview", f);
            }}
          />
        </div>
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
                <b>품명이 맞는 생산계획 제품과 연결 ({preview.suggestions.length}건 제안)</b>
              </label>
              <p className="mt-1 text-text-muted">품명이 완전히 같지 않아도 됩니다(단위 생략, 낱말 순서, 색 이름 한글·영문, 뒤에 붙은 구분). 확실한 것만 제안합니다.</p>
              {preview.suggestions.length ? (
                <details className="mt-1">
                  <summary className="cursor-pointer text-text-muted">제안 {preview.suggestions.length}건 보기 (품목 → 제품)</summary>
                  <ul className="mt-1 max-h-40 space-y-0.5 overflow-auto rounded-[var(--radius-sm)] border border-border p-2 text-text-muted" data-testid="stock-upload-suggestions">
                    {preview.suggestions.map((sg, i) => (
                      <li key={i}>
                        {sg.name} → <span className="text-text">{sg.productName}</span>
                        {sg.kind === "parent" ? <span className="text-text-faint"> (윗 품목과 동일)</span> : null}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
            {preview.ambiguousItems?.length ? (
              <p>
                <b>후보가 여럿이라 골라야 하는 품목 {preview.ambiguousItems.length}건:</b> {list(preview.ambiguousItems.map((a) => a.name))}
                <span className="block text-text-muted">지금은 연결하지 않습니다. 반영한 뒤 「제품 자동 연결」을 누르면 후보 중에서 고를 수 있습니다.</span>
              </p>
            ) : null}
            {preview.unlinkedItems.length ? (
              <p>
                <b>비슷한 제품이 없는 품목 {preview.unlinkedItems.length}건:</b> {list(preview.unlinkedItems)}
                <span className="block text-text-muted">재고현황에는 그대로 나오고, 수급 검증에만 쓰이지 않습니다. 반영 뒤 표의 「계획 제품」 칸에서 직접 검색해 연결할 수 있습니다.</span>
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


// ---------------------------------------------------------------------------
// 품목 추가
// ---------------------------------------------------------------------------
interface NewItem {
  section: string;
  process: string;
  machineLabel: string;
  itemCode: string | null;
  name: string;
  opening: number;
  packUnit: number | null;
  unitsPerPallet: number | null;
  productId: string | null;
}

function AddItemDialog({
  sections,
  defaults,
  products,
  busy,
  willSaveNow,
  onAdd,
  onClose,
}: {
  sections: string[];
  defaults: (section: string) => { process: string; machineLabel: string };
  products: ProductOption[];
  busy: boolean;
  willSaveNow: boolean;
  onAdd: (item: NewItem) => Promise<string | null>;
  onClose: () => void;
}) {
  const first = sections[0] ?? "";
  const [form, setForm] = useState({ section: first, ...defaults(first), itemCode: "", name: "", opening: "", packUnit: "", unitsPerPallet: "", productId: "" });
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v.replace(/,/g, "")));

  async function submit() {
    const name = form.name.normalize("NFC").replace(/\s+/g, " ").trim();
    if (!name) return setError("품명을 입력하세요");
    const opening = numOrNull(form.opening) ?? 0;
    const packUnit = numOrNull(form.packUnit);
    const unitsPerPallet = numOrNull(form.unitsPerPallet);
    if (!Number.isFinite(opening)) return setError("기초재고는 숫자로 입력하세요");
    if (opening < 0) return setError("기초재고에는 음수를 넣을 수 없습니다");
    if ((packUnit !== null && !(packUnit > 0)) || (unitsPerPallet !== null && !(unitsPerPallet > 0))) return setError("unit 과 UNIT수/P 는 0보다 큰 숫자여야 합니다");
    setError(null);
    const err = await onAdd({
      section: form.section.trim(),
      process: form.process.trim(),
      machineLabel: form.machineLabel.trim(),
      itemCode: form.itemCode.trim() || null,
      name,
      opening: Math.round(opening),
      packUnit,
      unitsPerPallet,
      productId: form.productId || null,
    });
    if (err) setError(err);
  }

  const field = "space-y-1 text-xs";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label="품목 추가">
      <Card className="w-full max-w-xl p-5 text-sm">
        <h2 className="text-base font-semibold text-brand-deep">품목 추가</h2>
        <p className="mt-1 text-xs text-text-muted">
          재고현황에 새 품목(행)을 넣습니다. 일자별 생산·출고는 추가한 뒤 표의 칸을 눌러 넣으세요.
          {willSaveNow ? " 「추가」를 누르면 바로 저장됩니다." : " 저장 전 변경이 있어, 추가한 뒤 「저장」을 눌러야 함께 반영됩니다."}
        </p>
        <div className="mt-4 grid grid-cols-3 gap-3">
          <label className={field}>
            <span className="text-text-muted">구간</span>
            <input
              aria-label="구간"
              list="stock-sections"
              className={inputSmClass}
              value={form.section}
              onChange={(e) => set({ section: e.target.value, ...(sections.includes(e.target.value) ? defaults(e.target.value) : {}) })}
              placeholder="예: PS, 1211"
            />
            <datalist id="stock-sections">
              {sections.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </label>
          <label className={field}>
            <span className="text-text-muted">공정</span>
            <input aria-label="공정" className={inputSmClass} value={form.process} onChange={(e) => set({ process: e.target.value })} />
          </label>
          <label className={field}>
            <span className="text-text-muted">호기</span>
            <input aria-label="호기" className={inputSmClass} value={form.machineLabel} onChange={(e) => set({ machineLabel: e.target.value })} />
          </label>
          <label className={cx(field, "col-span-2")}>
            <span className="text-text-muted">품명/규격 (필수)</span>
            <input aria-label="품명/규격" autoFocus className={inputSmClass} value={form.name} onChange={(e) => set({ name: e.target.value })} />
          </label>
          <label className={field}>
            <span className="text-text-muted">품번</span>
            <input aria-label="품번" className={inputSmClass} value={form.itemCode} onChange={(e) => set({ itemCode: e.target.value })} />
          </label>
          <label className={field}>
            <span className="text-text-muted">기초재고</span>
            <input aria-label="기초재고 입력" inputMode="numeric" className={`${inputSmClass} tnum`} value={form.opening} onChange={(e) => set({ opening: e.target.value })} placeholder="0" />
          </label>
          <label className={field}>
            <span className="text-text-muted">unit (포장 단위당 본수)</span>
            <input aria-label="unit 입력" inputMode="numeric" className={`${inputSmClass} tnum`} value={form.packUnit} onChange={(e) => set({ packUnit: e.target.value })} />
          </label>
          <label className={field}>
            <span className="text-text-muted">UNIT수/P</span>
            <input aria-label="UNIT수/P 입력" inputMode="numeric" className={`${inputSmClass} tnum`} value={form.unitsPerPallet} onChange={(e) => set({ unitsPerPallet: e.target.value })} />
          </label>
          <div className={cx(field, "col-span-3")}>
            <span className="text-text-muted">생산계획 제품과 연결 (선택) — 연결하면 수급 검증·순 소요량·생산 예정에 쓰입니다</span>
            <ProductCombobox label="생산계획 제품 연결" placeholder="제품 검색 (비워 두면 연결 안 함)" products={products} value={form.productId} onChange={(id) => set({ productId: id })} />
          </div>
        </div>
        {error ? <p className="mt-3 rounded-[var(--radius-sm)] border border-danger/30 bg-danger-bg px-3 py-2 text-xs text-danger">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
            닫기
          </Button>
          <Button size="sm" variant="primary" data-testid="stock-add-submit" disabled={busy || !form.name.trim()} onClick={submit}>
            {busy ? "저장 중…" : "추가"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
