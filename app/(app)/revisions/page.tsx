import Link from "next/link";
import { createSupabaseServer } from "@/lib/supabase/server";
import { requireSession } from "@/lib/auth/session";
import { loadCells, loadMasterData, loadRevisions } from "@/lib/data/load-engine-input";
import { diffCells } from "@/lib/engine/diff";
import { Badge, Card, CardHeader, PageHeader, cx } from "@/components/ui";
import { fmtDateTime, fmtInt, fmtMDW } from "@/lib/format";

/** FR-04 Rev 이력과 두 Rev 비교 */
export default async function RevisionsPage({ searchParams }: { searchParams: Promise<{ plan?: string; a?: string; b?: string }> }) {
  await requireSession();
  const { plan: planParam, a, b } = await searchParams;
  const db = await createSupabaseServer();

  const { data: plans } = await db.from("plans").select("id, period_start, period_end").order("period_start", { ascending: false });
  if (!plans?.length) {
    return (
      <>
        <PageHeader title="Rev 이력" />
        <Card className="p-6 text-sm text-text-muted">계획이 없습니다.</Card>
      </>
    );
  }
  const plan = plans.find((p) => p.id === planParam) ?? plans[0];
  const revisions = await loadRevisions(db, plan.id);
  const confirmed = revisions.filter((r) => r.status === "confirmed").sort((x, y) => (y.revNo ?? -1) - (x.revNo ?? -1));
  const draft = revisions.find((r) => r.status === "draft");

  // 기본 비교: 최신 확정 vs 그 직전 확정 (없으면 초안 vs 최신 확정)
  const revA = revisions.find((r) => r.id === a) ?? confirmed[1] ?? confirmed[0] ?? null;
  const revB = revisions.find((r) => r.id === b) ?? (confirmed.length >= 2 ? confirmed[0] : draft ?? confirmed[0] ?? null);

  let diff: ReturnType<typeof diffCells> = [];
  let lineName = new Map<string, string>();
  let productName = new Map<string, string>();
  if (revA && revB && revA.id !== revB.id) {
    const [cellsA, cellsB, master] = await Promise.all([loadCells(db, revA.id), loadCells(db, revB.id), loadMasterData(db)]);
    diff = diffCells(cellsA, cellsB).sort((x, y) => (lineOrder(master.lines, x.lineId) - lineOrder(master.lines, y.lineId)) || x.date.localeCompare(y.date));
    lineName = new Map(master.lines.map((l) => [l.id, l.name]));
    productName = new Map(master.products.map((p) => [p.id, p.name]));
  }
  const label = (r: { revNo: number | null; status: string }) => (r.status === "draft" ? "초안" : `Rev ${r.revNo}`);

  return (
    <>
      <PageHeader
        title="Rev 이력"
        sub={`${plan.period_start} ~ ${plan.period_end}`}
        right={
          <form className="flex items-center gap-2 text-xs" action="/revisions" method="get">
            <select name="plan" defaultValue={plan.id} className="h-7 rounded-[var(--radius-sm)] border border-border bg-white px-2 text-xs">
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.period_start} ~ {p.period_end}
                </option>
              ))}
            </select>
            <button className="h-7 rounded-[var(--radius-sm)] border border-brand/40 bg-white px-2.5 text-xs font-medium text-brand hover:bg-brand-tint">기간 변경</button>
          </form>
        }
      />
      <div className="grid grid-cols-[420px_1fr] gap-3">
        <Card>
          <CardHeader title="Rev 목록" sub="확정 시각 · 변경 사유" />
          <ul className="divide-y divide-border text-xs">
            {revisions.map((r) => (
              <li key={r.id} className="px-4 py-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-brand-deep">{label(r)}</span>
                  <span className="flex items-center gap-2">
                    {r.status === "confirmed" ? <Badge tone="info">확정</Badge> : <Badge tone="neutral">편집 중</Badge>}
                    <span className="tnum text-text-muted">{fmtDateTime(r.confirmedAt ?? r.createdAt)}</span>
                  </span>
                </div>
                {r.reasonCategory || r.reasonText ? (
                  <div className="mt-1 text-text">
                    <span className="mr-1 rounded bg-bg-sub px-1.5 py-0.5 text-[11px] text-text-muted">{r.reasonCategory}</span>
                    {r.reasonText}
                  </div>
                ) : r.revNo === 0 ? (
                  <div className="mt-1 text-text-muted">최초 확정</div>
                ) : null}
                <div className="mt-1.5 flex gap-3 text-[11px]">
                  <Link className="text-brand hover:underline" href={`/revisions?plan=${plan.id}&a=${r.id}&b=${revB?.id ?? ""}`}>
                    기준(A)으로
                  </Link>
                  <Link className="text-brand hover:underline" href={`/revisions?plan=${plan.id}&a=${revA?.id ?? ""}&b=${r.id}`}>
                    비교(B)로
                  </Link>
                  {r.status === "confirmed" ? (
                    <a className="text-text-muted hover:underline" href={`/api/export/plan?revisionId=${r.id}`}>
                      엑셀
                    </a>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardHeader
            title={revA && revB ? `${label(revA)} → ${label(revB)} 바뀐 셀 ${diff.length}개` : "비교할 Rev를 선택하세요"}
            sub="추가 / 삭제 / 변경(금형·수량·교체유형·메모)"
          />
          <div className="overflow-auto" style={{ maxHeight: "calc(100vh - 220px)" }}>
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-white">
                <tr className="text-left text-text-muted">
                  <th className="border-b border-border px-3 py-1.5 font-semibold">호기</th>
                  <th className="border-b border-border px-3 py-1.5 font-semibold">일자</th>
                  <th className="border-b border-border px-3 py-1.5 font-semibold">구분</th>
                  <th className="border-b border-border px-3 py-1.5 font-semibold">{revA ? label(revA) : "A"}</th>
                  <th className="border-b border-border px-3 py-1.5 font-semibold">{revB ? label(revB) : "B"}</th>
                </tr>
              </thead>
              <tbody>
                {diff.map((d, i) => (
                  <tr key={i} className="hover:bg-bg-muted">
                    <td className="border-b border-border px-3 py-1.5 font-medium">{lineName.get(d.lineId) ?? d.lineId}</td>
                    <td className="tnum border-b border-border px-3 py-1.5">{fmtMDW(d.date)}</td>
                    <td className="border-b border-border px-3 py-1.5">
                      <Badge tone={d.kind === "added" ? "ok" : d.kind === "removed" ? "danger" : "warn"}>{d.kind === "added" ? "추가" : d.kind === "removed" ? "삭제" : "변경"}</Badge>
                    </td>
                    <td className={cx("border-b border-border px-3 py-1.5", d.kind === "removed" ? "text-danger line-through" : "text-text-muted")}>{cellText(d.before, productName)}</td>
                    <td className={cx("border-b border-border px-3 py-1.5", d.kind === "added" ? "font-medium text-ok" : d.kind === "changed" ? "font-medium" : "text-text-muted")}>
                      {cellText(d.after, productName)}
                      {d.kind === "changed" ? <span className="ml-1 text-[10px] text-text-faint">({d.changedFields.map(fieldKo).join(", ")})</span> : null}
                    </td>
                  </tr>
                ))}
                {revA && revB && diff.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-text-muted">
                      {revA.id === revB.id ? "같은 Rev입니다. 다른 Rev를 선택하세요." : "두 Rev의 계획이 동일합니다."}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}

function lineOrder(lines: { id: string; sortOrder: number }[], id: string) {
  return lines.find((l) => l.id === id)?.sortOrder ?? 999;
}

function cellText(c: { productId: string | null; qty: number | null; changeoverType: string; memo?: string | null } | null, names: Map<string, string>) {
  if (!c || !c.productId) return c?.memo ? `(메모) ${c.memo}` : "–";
  const parts = [names.get(c.productId) ?? "?"];
  if (c.qty !== null) parts.push(fmtInt(c.qty));
  if (c.changeoverType !== "NONE") parts.push(c.changeoverType === "FULL" ? "Full set" : "B/M");
  if (c.memo) parts.push(`메모: ${c.memo}`);
  return parts.join(" · ");
}

function fieldKo(f: string) {
  return { productId: "금형", qty: "수량", changeoverType: "교체유형", memo: "메모" }[f] ?? f;
}
