"use client";

import { Fragment, useState } from "react";
import { columns } from "@/lib/purchase-request/export";
import type { PurchaseRow } from "@/lib/purchase-request/normalize";

type Props = {
  nameImages: Map<string,string>;
  rows: PurchaseRow[];
  issues: string[];
  change: (index: number, key: keyof PurchaseRow, value: string) => void;
  remove: (index: number) => void;
  add: () => void;
};

const size = 10;
const count = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 12 });
const button = "rounded-md border border-border-strong bg-white px-3 py-1.5 text-sm disabled:opacity-40";

export function ItemList({ nameImages, rows, issues, change, remove, add }: Props) {
  const [page, setPage] = useState(0);
  const [onlyReview, setOnlyReview] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const reasons = new Map<number, string[]>();
  for (const issue of issues) {
    const match = /^(\d+)행 · (.+)$/.exec(issue);
    if (!match) continue;
    const index = Number(match[1]) - 1;
    reasons.set(index, [...(reasons.get(index) ?? []), match[2]]);
  }
  const indices = rows.map((_, i) => i).filter(i => !onlyReview || reasons.has(i) || editing === i);
  const pages = Math.max(1, Math.ceil(indices.length / size));
  const current = Math.min(page, pages - 1);
  function turnPage(next: number) {
    setEditing(null);
    setPage(next);
  }
  return <section className="rounded-lg border border-border bg-white">
    <header className="flex flex-wrap items-center justify-between gap-3 p-4">
      <h2 className="font-bold">발주 품목 <span className="text-brand">{rows.length.toLocaleString()}건</span></h2>
      <div className="flex items-center gap-3">
        <label className="text-sm"><input type="checkbox" checked={onlyReview} onChange={e=>{setOnlyReview(e.target.checked); turnPage(0);}} /> 확인 필요만 보기 ({reasons.size})</label>
        <button className={button} onClick={()=>{setOnlyReview(false);setPage(Math.floor(rows.length / size));setEditing(rows.length);add();}}>품목 추가</button>
      </div>
    </header>
    <table className="w-full table-fixed text-left text-sm">
      <thead className="border-y border-border bg-bg-sub text-text-muted"><tr>
        {["거래처 · 납품처","품명 · 품번","납품예정일","발주수량","검토"].map(h=><th className="px-3 py-2" key={h}>{h}</th>)}
      </tr></thead>
      <tbody>{indices.slice(current*size,(current+1)*size).map(i=>{
        const r=rows[i];
        const crop=nameImages.get(r.originalName ?? "");
        const messages=reasons.get(i) ?? [];
        const formatted=r.quantity == null ? "수량 확인" : count.format(r.quantity)+" "+(r.unit || "EA");
        return <Fragment key={i}><tr className="border-b border-border align-top">
          <td className="px-3 py-2">{r.customer || "거래처 미입력"}{r.destination && r.destination!==r.customer && <small className="block text-text-muted">{r.destination}</small>}</td>
          <td className="px-3 py-2 font-medium">{crop && <img src={crop} alt="발주서 원본 품명" className="mb-1 block max-h-9 max-w-full object-contain" />}
            {crop && <span className="text-xs text-text-muted">입력값 · </span>}{r.productName || "품명 미입력"}<small className="block font-normal text-text-muted">{r.productCode}</small></td>
          <td className="px-3 py-2">{r.requestedDate || "미입력"}<small className="block text-text-muted">{r.condition}</small></td>
          <td className="px-3 py-2 font-semibold tabular-nums">{formatted}{r.boxes!=null && <small className="block font-normal text-text-muted">{count.format(r.boxes)}박스</small>}</td>
          <td className="px-3 py-2"><button aria-expanded={editing===i} onClick={()=>setEditing(editing===i?null:i)} className={messages.length ? "rounded bg-warn-bg px-3 py-1 text-amber-900" : button}>{editing===i?"접기":messages.length?"확인 필요":"상세"}</button></td>
        </tr>{editing===i && <tr><td colSpan={5} className="border-b border-border bg-bg-muted p-4">
          <p className="mb-2 font-semibold">{i+1}행 상세</p>
          {messages.length>0 && <p className="mb-2 text-amber-900">{messages.join(" · ")}</p>}
          {r.originalQuantity && <p className="mb-3 text-text-muted">원문 {r.originalName} · {r.originalQuantity} {r.originalUnit && !r.originalQuantity.toUpperCase().endsWith(r.originalUnit) ? r.originalUnit : ""} {r.conversion}</p>}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{columns.filter(c=>c.key!=="unit").map(c=><label key={c.key} className="text-xs text-text-muted">{c.key==="quantity"?"발주수량 (EA · 본)":c.label}
            <input className="mt-1 block w-full rounded border border-border-strong bg-white p-2 text-sm text-text" readOnly={c.key==="boxes"} type={c.key==="quantity"?"number":c.key==="requestedDate"?"date":"text"} step={c.key==="quantity"?1:undefined} min={c.key==="quantity"?1:undefined} value={r[c.key]??""} onChange={e=>change(i,c.key,e.target.value)}/>
          </label>)}</div>
          <div className="mt-3 flex gap-3">{r.reviewReason && <button className={button} onClick={()=>change(i,"reviewReason","")}>원본 대조 완료</button>}<button className="text-sm text-text-muted underline" onClick={()=>{setEditing(null);remove(i);}}>이 행 삭제</button></div>
        </td></tr>}</Fragment>;
      })}</tbody>
    </table>
    {!indices.length && <p className="p-4 text-sm text-text-muted">표시할 품목이 없습니다.</p>}
    <footer className="flex justify-end items-center gap-3 p-3 text-sm"><button className={button} disabled={current===0} onClick={()=>turnPage(current-1)}>이전</button>{current+1} / {pages}쪽<button className={button} disabled={current+1>=pages} onClick={()=>turnPage(current+1)}>다음</button></footer>
  </section>;
}
