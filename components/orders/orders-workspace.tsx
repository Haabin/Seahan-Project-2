"use client";

import { useEffect, useState } from "react";
import { Notice } from "@/components/notice";
import { flashRow } from "@/lib/hooks/flash-row";
import { useRouter } from "next/navigation";
import { deleteOrder, setOrderStatus, upsertOrder } from "@/lib/actions/orders";
import type { OrderRow } from "@/lib/data/draft-data";
import { Badge, Button, Card, cx, inputSmClass } from "@/components/ui";
import { fmtInt } from "@/lib/format";
import { ProductCombobox } from "@/components/product-combobox";
import { FileButton } from "@/components/file-button";
import { checkDueDate, duplicateOrderNoKeys, formatDueDate, orderNoKey } from "@/lib/orders/validate";

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

export function OrdersWorkspace({ orders, products, customers, today }: { orders: OrderRow[]; products: ProductOption[]; customers: string[]; /** 오늘(한국 시간) */ today: string }) {
  const dupNos = duplicateOrderNoKeys(orders);
  const router = useRouter();
  const [form, setForm] = useState({ orderNo: "", productId: "", customerName: "", qty: "", dueDate: "", memo: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [showAll, setShowAll] = useState(false);
  // 방금 추가한 주문의 줄로 화면을 옮긴다(목록이 새로 그려져 그 줄이 생긴 뒤에)
  const [focusId, setFocusId] = useState<string | null>(null);
  const focusReady = focusId !== null && orders.some((o) => o.id === focusId);
  useEffect(() => {
    if (!focusReady) return;
    const timer = setTimeout(() => {
      const tr = Array.from(document.querySelectorAll("tr[data-order-id]")).find((el) => el.getAttribute("data-order-id") === focusId);
      flashRow(tr);
      setFocusId(null);
    }, 150);
    return () => clearTimeout(timer);
  }, [focusReady, focusId]);
  const [replace, setReplace] = useState(false);
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
    let newId: string | null = null;
    const ok = await run(
      async () => {
        const r = await upsertOrder({
          orderNo: form.orderNo || null,
          productId: product.id,
          productNameRaw: product.name,
          customerName: form.customerName || null,
          qty: Number(form.qty),
          dueDate: form.dueDate,
          memo: form.memo || null,
        });
        if (r.ok) newId = r.data.id;
        return r;
      },
      `주문을 추가했습니다: ${product.name} ${fmtInt(Number(form.qty))}본`,
    );
    if (ok) {
      setForm({ ...form, orderNo: "", qty: "", memo: "" });
      setFocusId(newId);
    }
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
        setMsg({ tone: un || warn ? "danger" : "ok", text: `주문 ${json.inserted}건을 새로 넣고${json.updated ? `, 주문번호가 같은 ${json.updated}건은 덮어썼습니다` : " (덮어쓴 주문 없음)"}${json.skipped ? ` · 납기일이 이상해 넣지 않은 주문 ${json.skipped}건` : ""}${un}${warn}` });
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
  const overdue = open.filter((o) => o.dueDate < today);
  const dupCount = open.filter((o) => dupNos.has(orderNoKey(o.orderNo) ?? "")).length;

  return (
    <div className="space-y-3">
      <Card className="p-4">
        <h2 className="mb-2 text-sm font-semibold text-brand-deep">주문 직접 입력</h2>
        <div className="grid grid-cols-[110px_minmax(200px,1fr)_150px_120px_140px_minmax(120px,1fr)_auto] items-end gap-2 text-xs">
          <label className="space-y-1">
            <span className="text-text-muted">주문번호</span>
            <input aria-label="주문번호" className={inputSmClass} value={form.orderNo} onChange={(e) => setForm({ ...form, orderNo: e.target.value })} />
          </label>
          <div className="space-y-1">
            <span className="text-text-muted">품명(제품) · 검색해서 고르기</span>
            <ProductCombobox label="품명" products={products} value={form.productId} onChange={(id) => setForm((f) => ({ ...f, productId: id }))} />
          </div>
          <label className="space-y-1">
            <span className="text-text-muted">고객사</span>
            <input aria-label="고객사" list="order-customers" className={inputSmClass} value={form.customerName} onChange={(e) => setForm({ ...form, customerName: e.target.value })} />
          </label>
          <datalist id="order-customers">
            {customers.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
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
          <a href="/api/export/orders-template" className="text-accent hover:underline">
            주문목록 내려받기
          </a>
          <FileButton ariaLabel="주문내역 엑셀" testId="orders-upload" busy={busy} onFile={(f) => void upload(f)} />
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
            진행 중 주문을 지우고 새로 넣기
          </label>
        </div>
        <Notice msg={msg} onHide={() => setMsg(null)} className="mt-3" />
      </Card>

      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-xs">
          <h2 className="text-sm font-semibold text-brand-deep">주문 목록</h2>
          <Badge tone="info">진행 중 {open.length}</Badge>
          {unmatched.length ? <Badge tone="danger">제품 매칭 안 됨 {unmatched.length}</Badge> : null}
          {dupCount ? <Badge tone="danger">주문번호 중복 {dupCount}</Badge> : null}
          {overdue.length ? <Badge tone="warn">납기 지남 {overdue.length}</Badge> : null}
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
                  <th key={h} className={h === "수량(본)" ? th.replace("text-left", "text-center") : th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.map((o) => (
                <tr key={o.id} data-order-id={o.id} className={cx("hover:bg-bg-muted", !o.productId && "bg-danger-bg/50")}>
                  <td className={cx(td, "whitespace-nowrap")}>
                    {formatDueDate(o.dueDate, today)}
                    {o.status === "open" && o.dueDate < today ? (
                      <Badge tone={checkDueDate(o.dueDate, today).ok ? "warn" : "danger"} className="ml-1.5" title={checkDueDate(o.dueDate, today).ok ? "납기일이 지났습니다" : "납기일이 너무 과거입니다. 연도를 확인하고 고치거나 삭제하세요"}>
                        {checkDueDate(o.dueDate, today).ok ? "납기 지남" : "날짜 확인"}
                      </Badge>
                    ) : null}
                  </td>
                  <td className={cx(td, "whitespace-nowrap")}>
                    {o.orderNo ?? "–"}
                    {dupNos.has(orderNoKey(o.orderNo) ?? "") ? (
                      <Badge tone="danger" className="ml-1.5" title="같은 주문번호가 두 건 이상 있습니다. 하나를 삭제하거나 번호를 바꾸세요">
                        번호 중복
                      </Badge>
                    ) : null}
                  </td>
                  <td className={td}>
                    {o.productId ? (
                      (productById.get(o.productId)?.name ?? o.productNameRaw)
                    ) : (
                      <span className="flex items-center gap-2">
                        <span className="text-danger">{o.productNameRaw}</span>
                        <span className="w-56">
                          <ProductCombobox
                            label={`${o.productNameRaw} 제품 연결`}
                            placeholder="제품 검색해서 연결"
                            products={products}
                            value=""
                            disabled={busy}
                            onChange={(id) => {
                              const p = productById.get(id);
                              if (p) void run(() => upsertOrder({ id: o.id, orderNo: o.orderNo, productId: p.id, productNameRaw: o.productNameRaw, customerName: o.customerName, qty: o.qty, dueDate: o.dueDate, memo: o.memo }), `"${o.productNameRaw}" 을(를) ${p.name}에 연결했습니다`);
                            }}
                          />
                        </span>
                      </span>
                    )}
                  </td>
                  <td className={td}>
                    {o.customerName ?? "–"}
                    {o.isMajorCustomer ? <Badge tone="info" className="ml-1">대형</Badge> : null}
                  </td>
                  <td className={cx(td, "text-center")}>{fmtInt(o.qty)}</td>
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
