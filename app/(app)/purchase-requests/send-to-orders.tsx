"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ProductCombobox, type ComboProduct } from "@/components/product-combobox";
import { sendPurchaseToOrders } from "@/lib/actions/purchase-orders";
import { purchaseCodeKey, purchaseOrderNo, suggestPurchaseLinks, type LinkSource, type PurchaseItemForOrder } from "@/lib/orders/from-purchase";

const SOURCE_LABEL: Record<LinkSource, string> = {
  saved: "지난번 연결",
  code: "품번 일치",
  name: "이름으로 제안",
  none: "",
};

/**
 * 저장한 발주서 검토본을 주문(orders)으로 보낸다.
 * 품목마다 생산계획 제품을 제안하고, 사람이 확인·수정한 뒤 「주문으로 보내기」를 누른다.
 * 저장된 검토본 기준이다. 표를 고쳤으면 먼저 검토본을 저장해야 한다.
 */
export function SendToOrders({ db, requestId, requestNumber }: { db: SupabaseClient; requestId: string; requestNumber: string }) {
  const [items, setItems] = useState<PurchaseItemForOrder[] | null>(null);
  const [products, setProducts] = useState<ComboProduct[]>([]);
  const [links, setLinks] = useState<Record<number, string>>({});
  const [sources, setSources] = useState<Record<number, LinkSource>>({});
  const [sentLines, setSentLines] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      const [itemRes, productRes, linkRes, orderRes] = await Promise.all([
        db.from("purchase_request_items").select("line_number, product_code, product_name, quantity, requested_date, customer_name, note").eq("request_id", requestId).order("line_number"),
        db.from("products").select("id, code, name").order("name"),
        db.from("purchase_product_links").select("product_code, product_id"),
        db.from("orders").select("purchase_line, product_id").eq("purchase_request_id", requestId),
      ]);
      if (!alive) return;
      const firstError = itemRes.error ?? productRes.error ?? linkRes.error ?? orderRes.error;
      if (firstError) {
        setError(firstError.message);
        setItems([]);
        return;
      }
      const loaded: PurchaseItemForOrder[] = (itemRes.data ?? []).map((r) => ({
        line: Number(r.line_number),
        productCode: r.product_code ?? "",
        productName: r.product_name ?? "",
        quantity: Number(r.quantity),
        requestedDate: r.requested_date ?? null,
        customer: r.customer_name ?? "",
        note: r.note ?? "",
      }));
      const productList = (productRes.data ?? []) as ComboProduct[];
      const saved: Record<string, string> = {};
      for (const l of linkRes.data ?? []) saved[purchaseCodeKey(l.product_code)] = l.product_id;
      const suggestions = suggestPurchaseLinks(loaded, productList, saved);
      const nextLinks: Record<number, string> = {};
      const nextSources: Record<number, LinkSource> = {};
      for (const it of loaded) {
        nextLinks[it.line] = suggestions[it.line]?.productId ?? "";
        nextSources[it.line] = suggestions[it.line]?.source ?? "none";
      }
      // 이미 보낸 품목은 그때 고른 제품이 우선
      const sent = new Set<number>();
      for (const o of orderRes.data ?? []) {
        if (o.purchase_line === null) continue;
        const line = Number(o.purchase_line);
        sent.add(line);
        if (o.product_id && line in nextLinks) {
          nextLinks[line] = o.product_id;
          nextSources[line] = "saved";
        }
      }
      setItems(loaded);
      setProducts(productList);
      setLinks(nextLinks);
      setSources(nextSources);
      setSentLines(sent);
    })();
    return () => {
      alive = false;
    };
  }, [db, requestId]);

  const unlinked = useMemo(() => (items ?? []).filter((it) => !links[it.line]).length, [items, links]);

  async function send() {
    if (!items?.length) return;
    setBusy(true);
    setError("");
    setDone("");
    const res = await sendPurchaseToOrders({ requestId, links: items.map((it) => ({ line: it.line, productId: links[it.line] || null })) });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setSentLines(new Set(items.map((it) => it.line)));
    const d = res.data;
    setDone(
      [`주문으로 보냈습니다: 새로 ${d.inserted}건`, d.updated ? `갱신 ${d.updated}건` : "", d.removed ? `삭제 ${d.removed}건` : "", d.unlinked ? `제품 미연결 ${d.unlinked}건` : ""]
        .filter(Boolean)
        .join(" · "),
    );
  }

  if (items === null) return <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">주문으로 보낼 품목을 불러오는 중…</div>;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4" data-testid="send-to-orders">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold text-slate-900">주문으로 보내기</h2>
        <Link href="/orders" className="text-sm text-blue-700 underline">
          주문 목록 보기
        </Link>
      </div>
      <p className="mt-1 text-sm text-slate-600">
        저장한 검토본의 품목을 주문 목록에 넣습니다. 품목마다 생산계획 제품을 확인하세요. 한 번 고른 연결은 기억해 두었다가 다음 발주서에서 먼저 채웁니다. 표를 고쳤다면 검토본을 먼저 저장하세요.
      </p>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">저장된 품목이 없습니다.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="text-left text-slate-500">
                <th className="border-b p-2 font-medium">주문번호</th>
                <th className="border-b p-2 font-medium">발주서 품번 · 품명</th>
                <th className="border-b p-2 text-right font-medium">수량(본)</th>
                <th className="border-b p-2 font-medium">납기일</th>
                <th className="border-b p-2 font-medium">생산계획 제품</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.line} className={links[it.line] ? "" : "bg-amber-50"}>
                  <td className="border-b p-2 align-top">
                    {purchaseOrderNo(requestNumber, it.line)}
                    {sentLines.has(it.line) ? <span className="ml-1 text-xs text-slate-500">(보냄)</span> : null}
                  </td>
                  <td className="border-b p-2 align-top">
                    <div className="text-xs text-slate-500">{it.productCode}</div>
                    <div>{it.productName}</div>
                  </td>
                  <td className="border-b p-2 text-right align-top tabular-nums">{it.quantity.toLocaleString("ko-KR")}</td>
                  <td className="border-b p-2 align-top">{it.requestedDate ?? ""}</td>
                  <td className="border-b p-2 align-top">
                    <div className="w-72">
                      <ProductCombobox
                        label={`${it.line}행 생산계획 제품`}
                        products={products}
                        value={links[it.line] ?? ""}
                        emptyOptionLabel="연결 안 함"
                        disabled={busy}
                        onChange={(id) => {
                          setLinks((cur) => ({ ...cur, [it.line]: id }));
                          setSources((cur) => ({ ...cur, [it.line]: "none" }));
                        }}
                      />
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500">{links[it.line] ? SOURCE_LABEL[sources[it.line] ?? "none"] : "미연결 · 초안 자동 생성에서 빠집니다"}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || !items.length}
          onClick={() => void send()}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          data-testid="send-to-orders-button"
        >
          {busy ? "보내는 중…" : sentLines.size ? `주문 다시 보내기 (${items.length}건)` : `주문으로 보내기 (${items.length}건)`}
        </button>
        {unlinked ? <span className="text-sm text-amber-700">제품 미연결 {unlinked}건</span> : null}
        {done ? (
          <span className="text-sm text-green-700" role="status">
            {done}
          </span>
        ) : null}
      </div>
      {error ? (
        <p className="mt-2 whitespace-pre-line text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
