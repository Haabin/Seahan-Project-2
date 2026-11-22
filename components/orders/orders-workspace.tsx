"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { deleteOrder, setOrderStatus, upsertOrder } from "@/lib/actions/orders";
import type { OrderRow } from "@/lib/data/draft-data";
import { Badge, Button, Card, cx, inputSmClass } from "@/components/ui";
import { fmtInt, fmtMDW } from "@/lib/format";

interface ProductOption {
  id: string;
  code: string;
  name: string;
}

const th = "border-b border-border bg-bg-sub px-2 py-1.5 text-left text-[11px] font-semibold text-text-muted";
const td = "border-b border-border px-2 py-1.5 text-xs";
const STATUS: Record<OrderRow["status"], { label: string; tone: "info" | "ok" | "neutral" }> = {
  open: { label: "진행 중", tone: "info" },
  done: { label: "완료", tone: "ok" },
  cancelled: { label: "취소", tone: "neutral" },
};

export function OrdersWorkspace({ orders, products, customers }: { orders: OrderRow[]; products: ProductOption[]; customers: string[] }) {
  const router = useRouter();
  const [form, setForm] = useState({ orderNo: "", productId: "", customerName: "", qty: "", dueDate: "", memo: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [replace, setReplace] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const productById = new Map(products.map((p) => [p.id, p] as const));

  async function run(fn: () => Promise<{ ok: true } | { ok: false; error: string }>, okText: string) {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    if (!r.ok) setMsg({ tone: "danger", text: r.error });
    else {
      setMsg({ tone: "ok", text: okText });
      router.refresh();
    }
    return r.ok;
  }

  async function add() {
    const product = productById.get(form.productId);
    if (!product) {
      setMsg({ tone: "danger", text: "제품을 고르세요" });
      return;
    }
    const ok = await run(
      () =>
        upsertOrder({
          orderNo: form.orderNo || null,
          productId: product.id,
          productNameRaw: product.name,
          customerName: form.customerName || null,
          qty: Number(form.qty),
          dueDate: form.dueDate,
          memo: form.memo || null,
        }),
      `주문을 추가했습니다: ${product.name} ${fmtInt(Number(form.qty))}본`,
    );
    if (ok) setForm({ ...form, orderNo: "", qty: "", memo: "" });
  }

  async function upload(file: File) {
    setBusy(true);
    setMsg(null);
    const fd = new FormData();
    fd.set("file", file);
    fd.set("replace", replace ? "1" : "0");
    try {
      const res = await fetch("/api/import/orders", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) setMsg({ tone: "danger", text: json.error ?? "업로드에 실패했습니다" });
      else {
        const un = (json.unmatched as string[]).length ? ` · 제품 매칭 안 됨 ${json.unmatched.length}건: ${json.unmatched.slice(0, 5).join(", ")}` : "";
        const warn = (json.warnings as string[]).length ? ` · 경고 ${json.warnings.length}건: ${json.warnings.slice(0, 2).join(" / ")}` : "";
        setMsg({ tone: un || warn ? "danger" : "ok", text: `주문 ${json.inserted}건을 넣었습니다${un}${warn}` });
        router.refresh();
      }
    } catch (e) {
      setMsg({ tone: "danger", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const list = showAll ? orders : orders.filter((o) => o.status === "open");
  const open = orders.filter((o) => o.status === "open");
  const unmatched = open.filter((o) => !o.productId);

  return (
    <div className="space-y-3">
      <Card className="p-4">
        <h2 className="mb-2 text-sm font-semibold text-brand-deep">주문 직접 입력</h2>
        <div className="grid grid-cols-[110px_minmax(200px,1fr)_150px_120px_140px_minmax(120px,1fr)_auto] items-end gap-2 text-xs">
          <label className="space-y-1">
            <span className="text-text-muted">주문번호</span>
            <input aria-label="주문번호" className={inputSmClass} value={form.orderNo} onChange={(e) => setForm({ ...form, orderNo: e.target.value })} />
          </label>
          <label className="space-y-1">
            <span className="text-text-muted">품명(제품)</span>
            <select aria-label="품명" className={inputSmClass} value={form.productId} onChange={(e) => setForm({ ...form, productId: e.target.value })}>
              <option value="">제품을 고르세요</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.code})
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-text-muted">고객사</span>
            <input aria-label="고객사" list="order-customers" className={inputSmClass} value={form.customerName} onChange={(e) => setForm({ ...form, customerName: e.target.value })} />
            <datalist id="order-customers">
              {customers.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
          <label className="space-y-1">
            <span className="text-text-muted">수량(본)</span>
            <input aria-label="수량" type="number" min={1} step={1000} className={`${inputSmClass} tnum`} value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} />
          </label>
          <label className="space-y-1">
            <span className="text-text-muted">납기일</span>
            <input aria-label="납기일" type="date" className={inputSmClass} value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
          </label>
          <label className="space-y-1">
            <span className="text-text-muted">비고</span>
            <input aria-label="비고" className={inputSmClass} value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} />
          </label>
          <Button size="sm" variant="primary" disabled={busy || !form.productId || !form.qty || !form.dueDate} onClick={add}>
            주문 추가
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-3 text-xs">
          <span className="font-medium text-text-muted">엑셀로 한꺼번에</span>
          <a href="/api/export/orders-template" className="text-accent hover:underline">
            템플릿 내려받기
          </a>
          {/* 브라우저 기본 「파일 선택」 대신 눈에 띄는 버튼을 쓴다. 실제 파일 입력은 숨겨 둔다 */}
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx"
            aria-label="주문내역 엑셀"
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = "";
            }}
          />
          <Button variant="primary" data-testid="orders-upload" disabled={busy} onClick={() => fileRef.current?.click()}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 16V4" />
              <path d="m7 9 5-5 5 5" />
              <path d="M5 20h14" />
            </svg>
            {busy ? "올리는 중…" : "엑셀파일 업로드"}
          </Button>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
            진행 중 주문을 지우고 새로 넣기
          </label>
        </div>
        {msg ? (
          <p role="status" className={cx("mt-3 rounded-[var(--radius-sm)] border px-3 py-2 text-xs", msg.tone === "ok" ? "border-ok/30 bg-ok-bg text-ok" : "border-danger/30 bg-danger-bg text-danger")}>
            {msg.text}
          </p>
        ) : null}
      </Card>

      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-xs">
          <h2 className="text-sm font-semibold text-brand-deep">주문 목록</h2>
          <Badge tone="info">진행 중 {open.length}</Badge>
          {unmatched.length ? <Badge tone="danger">제품 매칭 안 됨 {unmatched.length}</Badge> : null}
          <label className="ml-auto flex items-center gap-1.5">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            완료·취소 포함
          </label>
        </div>
        {list.length === 0 ? (
          <p className="p-6 text-sm text-text-muted">주문이 없습니다. 위에서 직접 입력하거나 엑셀로 올리세요.</p>
        ) : (
          <table className="tnum w-full border-separate border-spacing-0" data-testid="orders-table">
            <thead>
              <tr>
                {["납기일", "주문번호", "품명", "고객사", "수량(본)", "상태", "비고", ""].map((h) => (
                  <th key={h} className={th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.map((o) => (
                <tr key={o.id} className={cx("hover:bg-bg-muted", !o.productId && "bg-danger-bg/50")}>
                  <td className={td}>{fmtMDW(o.dueDate)}</td>
                  <td className={td}>{o.orderNo ?? "–"}</td>
                  <td className={td}>
                    {o.productId ? (
                      (productById.get(o.productId)?.name ?? o.productNameRaw)
                    ) : (
                      <span className="flex items-center gap-2">
                        <span className="text-danger">{o.productNameRaw}</span>
                        <select
                          aria-label={`${o.productNameRaw} 제품 연결`}
                          className="h-6 rounded border border-border bg-white text-xs"
                          value=""
                          disabled={busy}
                          onChange={(e) => {
                            const p = productById.get(e.target.value);
                            if (p) void run(() => upsertOrder({ id: o.id, orderNo: o.orderNo, productId: p.id, productNameRaw: o.productNameRaw, customerName: o.customerName, qty: o.qty, dueDate: o.dueDate, memo: o.memo }), `"${o.productNameRaw}" 을(를) ${p.name}에 연결했습니다`);
                          }}
                        >
                          <option value="">제품 연결…</option>
                          {products.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </span>
                    )}
                  </td>
                  <td className={td}>
                    {o.customerName ?? "–"}
                    {o.isMajorCustomer ? <Badge tone="info" className="ml-1">대형</Badge> : null}
                  </td>
                  <td className={cx(td, "text-right")}>{fmtInt(o.qty)}</td>
                  <td className={td}>
                    <Badge tone={STATUS[o.status].tone}>{STATUS[o.status].label}</Badge>
                  </td>
                  <td className={cx(td, "max-w-[240px] truncate text-text-muted")}>{o.memo ?? ""}</td>
                  <td className={cx(td, "whitespace-nowrap text-right")}>
                    {o.status === "open" ? (
                      <button className="mr-2 text-accent hover:underline" disabled={busy} onClick={() => run(() => setOrderStatus(o.id, "done"), "완료로 바꿨습니다")}>
                        완료
                      </button>
                    ) : (
                      <button className="mr-2 text-accent hover:underline" disabled={busy} onClick={() => run(() => setOrderStatus(o.id, "open"), "진행 중으로 되돌렸습니다")}>
                        되돌리기
                      </button>
                    )}
                    <button
                      className="text-text-muted hover:text-danger"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm("이 주문을 삭제할까요? 이 주문으로 자동 생성한 초안 셀도 함께 지웁니다. (확정된 계획과 사람이 고친 셀은 그대로 둡니다)")) return;
                        void (async () => {
                          setBusy(true);
                          const r = await deleteOrder(o.id);
                          setBusy(false);
                          if (!r.ok) setMsg({ tone: "danger", text: r.error });
                          else {
                            setMsg({ tone: "ok", text: r.data.removedCells ? `주문을 삭제하고, 생산계획 초안에서 이 주문의 셀 ${r.data.removedCells}개를 지웠습니다` : "주문을 삭제했습니다 (생산계획 초안에 이 주문으로 만든 셀은 없었습니다)" });
                            router.refresh();
                          }
                        })();
                      }}
                    >
                      삭제
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
