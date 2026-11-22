"use client";

import { useMemo, useState } from "react";
import { linkStockItems } from "@/lib/actions/stock";
import { proposeProductLinks, type MatchProposal } from "@/lib/stock/match-products";
import { Badge, Button, Card, cx } from "@/components/ui";
import { ProductCombobox, type ComboProduct } from "@/components/product-combobox";

export interface AutoLinkItem {
  id: string;
  name: string;
  section: string;
  machineLabel: string;
  productId: string | null;
}

const KIND: Record<MatchProposal["kind"], { label: string; tone: "ok" | "info" | "warn" }> = {
  auto: { label: "자동 제안", tone: "ok" },
  parent: { label: "윗 품목과 동일", tone: "info" },
  candidates: { label: "골라 주세요", tone: "warn" },
};

/**
 * 제품 자동 연결. 품명이 완전히 같지 않아도 낱말 단위로 비교해 제안하고, 사람이 확인한 것만 한꺼번에 연결한다.
 * 확실한 제안(자동·윗 품목과 동일)은 처음부터 체크돼 있고, 애매한 것은 체크가 풀려 있다.
 */
export function AutoLinkDialog({ yearMonth, items, products, onClose, onDone }: { yearMonth: string; items: AutoLinkItem[]; products: ComboProduct[]; onClose: () => void; onDone: (notice: string) => void }) {
  const result = useMemo(() => proposeProductLinks(items.map((i) => ({ key: i.id, name: i.name, productId: i.productId })), products), [items, products]);
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i] as const)), [items]);
  const [choice, setChoice] = useState<Record<string, string>>(() => Object.fromEntries(result.proposals.map((p) => [p.key, p.productId])));
  const [checked, setChecked] = useState<Set<string>>(() => new Set(result.proposals.filter((p) => p.kind !== "candidates").map((p) => p.key)));
  const [filter, setFilter] = useState<"all" | MatchProposal["kind"]>("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const count = (k: MatchProposal["kind"]) => result.proposals.filter((p) => p.kind === k).length;
  const shown = filter === "all" ? result.proposals : result.proposals.filter((p) => p.kind === filter);
  const selected = result.proposals.filter((p) => checked.has(p.key) && choice[p.key]);

  const toggle = (key: string, on: boolean) =>
    setChecked((prev) => {
      const n = new Set(prev);
      if (on) n.add(key);
      else n.delete(key);
      return n;
    });

  async function apply() {
    setBusy(true);
    setError(null);
    const res = await linkStockItems({ yearMonth, links: selected.map((p) => ({ id: p.key, productId: choice[p.key] })) });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    onDone(`품목 ${res.data.linked}개를 생산계획 제품에 연결했습니다. 수급 검증용 재고 ${res.data.snapshots}건을 다시 맞췄습니다.`);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label="제품 자동 연결">
      <Card className="flex max-h-[88vh] w-full max-w-4xl flex-col p-5 text-sm">
        <h2 className="text-base font-semibold text-brand-deep">제품 자동 연결</h2>
        <p className="mt-1 text-xs text-text-muted">
          수불표 품목을 생산계획 제품과 연결해야 그 재고가 수급 검증·순 소요량·생산 예정에 쓰입니다. 품명이 조금 달라도(단위 생략, 낱말 순서, 색 이름 한글·영문, 뒤에 붙은 구분) 같은 제품을 찾아 제안합니다. <b>체크한 것만</b> 연결됩니다.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs" data-testid="autolink-summary">
          <Badge tone="neutral">이미 연결 {result.linked}</Badge>
          {(["all", "auto", "parent", "candidates"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={cx("rounded-full border px-2.5 py-0.5", filter === k ? "border-brand bg-brand text-white" : "border-border bg-white text-text-muted hover:bg-bg-sub")}
            >
              {k === "all" ? `제안 전체 ${result.proposals.length}` : `${KIND[k].label} ${count(k)}`}
            </button>
          ))}
          <Badge tone="surplus" title="생산계획 제품 목록에 비슷한 이름이 없는 품목입니다. 2-Stage·PE 제품처럼 지금 계획 대상이 아닌 품목이 여기에 들어갑니다">
            제안 없음 {result.unmatched.length}
          </Badge>
          <span className="ml-auto flex items-center gap-2">
            <Button size="sm" data-testid="autolink-check-all" disabled={shown.length === 0} onClick={() => setChecked(new Set(shown.filter((p) => choice[p.key]).map((p) => p.key).concat([...checked])))}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="3" width="18" height="18" rx="3" />
                <path d="m8 12 3 3 5-6" />
              </svg>
              보이는 것 모두 체크
            </Button>
            <Button size="sm" data-testid="autolink-uncheck-all" disabled={shown.length === 0} onClick={() => setChecked((prev) => new Set([...prev].filter((k) => !shown.some((p) => p.key === k))))}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="3" width="18" height="18" rx="3" />
              </svg>
              보이는 것 체크 풀기
            </Button>
          </span>
        </div>

        <div className="mt-3 min-h-0 flex-1 overflow-auto rounded-[var(--radius-sm)] border border-border">
          {shown.length === 0 ? (
            <p className="p-6 text-center text-xs text-text-muted">{result.proposals.length === 0 ? "새로 제안할 연결이 없습니다." : "이 종류의 제안이 없습니다."}</p>
          ) : (
            <table className="w-full border-separate border-spacing-0 text-xs" data-testid="autolink-table">
              <thead className="sticky top-0 z-10 bg-bg-sub text-left text-[11px] text-text-muted">
                <tr>
                  <th className="w-8 border-b border-border px-2 py-1.5" />
                  <th className="border-b border-border px-2 py-1.5 font-semibold">수불표 품목</th>
                  <th className="border-b border-border px-2 py-1.5 font-semibold">구분</th>
                  <th className="w-[320px] border-b border-border px-2 py-1.5 font-semibold">연결할 생산계획 제품 (바꿀 수 있음)</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => {
                  const it = itemById.get(p.key);
                  return (
                    <tr key={p.key} className={cx("hover:bg-bg-muted", checked.has(p.key) ? "" : "opacity-70")}>
                      <td className="border-b border-border px-2 py-1 text-center">
                        <input type="checkbox" aria-label={`${p.name} 연결`} checked={checked.has(p.key)} disabled={!choice[p.key]} onChange={(e) => toggle(p.key, e.target.checked)} />
                      </td>
                      <td className="border-b border-border px-2 py-1">
                        <div className="font-medium text-text">{p.name}</div>
                        <div className="text-[11px] text-text-faint">
                          {it?.section || "–"} · {it?.machineLabel || "–"}
                        </div>
                      </td>
                      <td className="whitespace-nowrap border-b border-border px-2 py-1">
                        <Badge tone={KIND[p.kind].tone}>{KIND[p.kind].label}</Badge>
                        {p.kind !== "parent" ? <span className="tnum ml-1 text-[11px] text-text-faint">{Math.round(p.score * 100)}점</span> : null}
                      </td>
                      <td className="border-b border-border px-2 py-1">
                        <ProductCombobox
                          label={`${p.name} 연결할 제품`}
                          placeholder="제품 검색"
                          products={products}
                          value={choice[p.key] ?? ""}
                          onChange={(id) => {
                            setChoice((c) => ({ ...c, [p.key]: id }));
                            toggle(p.key, !!id);
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {result.unmatched.length ? (
          <details className="mt-2 text-xs text-text-muted">
            <summary className="cursor-pointer">제안이 없는 품목 {result.unmatched.length}개 보기</summary>
            <p className="mt-1 max-h-24 overflow-auto leading-relaxed">{result.unmatched.join(" · ")}</p>
            <p className="mt-1">이 품목들은 표의 「계획 제품」 칸에서 직접 검색해 연결할 수 있습니다.</p>
          </details>
        ) : null}
        {error ? <p className="mt-2 rounded-[var(--radius-sm)] border border-danger/30 bg-danger-bg px-3 py-2 text-xs text-danger">{error}</p> : null}

        <div className="mt-4 flex items-center justify-end gap-2">
          <span className="mr-auto text-xs text-text-muted">체크한 연결 {selected.length}개</span>
          <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
            닫기
          </Button>
          <Button size="sm" variant="primary" data-testid="autolink-apply" disabled={busy || selected.length === 0} onClick={apply}>
            {busy ? "연결 중…" : `체크한 ${selected.length}개 연결`}
          </Button>
        </div>
      </Card>
    </div>
  );
}
