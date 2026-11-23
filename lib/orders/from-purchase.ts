/**
 * 발주서 접수(purchase_requests) → 주문(orders) 변환 (순수 함수, DB 접근 없음).
 *
 *  - 발주서 한 건은 품목이 여러 개다. 품목 하나가 주문 한 건이 되고, 주문번호는 "발주번호-행번호".
 *  - 발주서 품번(TM00648 등)과 생산계획 제품은 체계가 달라, 제품 연결은 사람이 확정한다.
 *    한 번 확정한 "품번 → 제품" 연결은 저장해 두었다가 다음 발주서에서 먼저 채운다.
 *  - 같은 발주서를 다시 보내면 같은 품목의 주문을 고치고, 발주서에서 빠진 품목의 진행 중 주문은 지운다.
 *    완료·취소한 주문은 지우지 않는다.
 */
import { AUTO_SCORE, MARGIN, matchScore } from "../stock/match-products";
import { checkDueDate } from "./validate";

export interface PurchaseItemForOrder {
  line: number;
  productCode: string;
  productName: string;
  quantity: number;
  requestedDate: string | null;
  customer: string;
  note: string;
}

export interface LinkProduct {
  id: string;
  code: string;
  name: string;
}

/** 발주서 품번을 연결 표의 키로 (앞뒤 공백 정리, 대문자) */
export function purchaseCodeKey(code: string | null | undefined): string {
  return (code ?? "").normalize("NFC").trim().toUpperCase();
}

/** 발주서 품목의 주문번호: "발주번호-행번호" */
export function purchaseOrderNo(requestNumber: string, line: number): string {
  return `${requestNumber.normalize("NFC").trim()}-${line}`;
}

export type LinkSource = "saved" | "code" | "name" | "none";
export interface LinkSuggestion {
  productId: string | null;
  source: LinkSource;
}

/**
 * 품목마다 제품 연결을 제안한다.
 *  1) 저장된 연결(품번 → 제품)  2) 품번이 제품 코드와 같음  3) 품명이 충분히 비슷하고 2등과 차이가 뚜렷함  4) 없음
 */
export function suggestPurchaseLinks(
  items: Pick<PurchaseItemForOrder, "line" | "productCode" | "productName">[],
  products: LinkProduct[],
  savedLinks: Record<string, string>,
): Record<number, LinkSuggestion> {
  const ids = new Set(products.map((p) => p.id));
  const byCode = new Map(products.map((p) => [purchaseCodeKey(p.code), p.id] as const));
  const out: Record<number, LinkSuggestion> = {};
  for (const it of items) {
    const key = purchaseCodeKey(it.productCode);
    const saved = key ? savedLinks[key] : undefined;
    if (saved && ids.has(saved)) {
      out[it.line] = { productId: saved, source: "saved" };
      continue;
    }
    const sameCode = key ? byCode.get(key) : undefined;
    if (sameCode) {
      out[it.line] = { productId: sameCode, source: "code" };
      continue;
    }
    const scored = products
      .map((p) => ({ id: p.id, score: matchScore(it.productName, p.name) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    const top = scored[0];
    if (top && top.score >= AUTO_SCORE && top.score - (scored[1]?.score ?? 0) >= MARGIN) out[it.line] = { productId: top.id, source: "name" };
    else out[it.line] = { productId: null, source: "none" };
  }
  return out;
}

export interface PurchaseOrderRow {
  line: number;
  orderNo: string;
  productId: string | null;
  productNameRaw: string;
  itemCodeRaw: string | null;
  customerName: string | null;
  qty: number;
  dueDate: string;
  memo: string | null;
}

export interface ExistingPurchaseOrder {
  id: string;
  line: number | null;
  status: string;
}

export interface PurchaseOrderPlan {
  errors: string[];
  inserts: PurchaseOrderRow[];
  updates: { id: string; row: PurchaseOrderRow }[];
  /** 발주서에서 빠진 품목의 진행 중 주문 */
  removes: string[];
  /** 제품을 연결하지 않은 품목 수 (초안 자동 생성에서 빠진다) */
  unlinked: number;
}

export function planPurchaseOrders(args: {
  requestNumber: string;
  customer: string;
  items: PurchaseItemForOrder[];
  /** 행번호 → 연결한 제품 (없으면 미연결) */
  links: Record<number, string | null | undefined>;
  existing: ExistingPurchaseOrder[];
  today: string;
}): PurchaseOrderPlan {
  const errors: string[] = [];
  const rows: PurchaseOrderRow[] = [];
  if (!args.requestNumber.trim()) errors.push("발주번호가 없습니다.");
  if (!args.items.length) errors.push("보낼 품목이 없습니다. 검토본을 먼저 저장하세요.");

  for (const it of args.items) {
    const qty = Number(it.quantity);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) {
      errors.push(`${it.line}행 · 수량은 0보다 큰 정수(본)여야 합니다.`);
      continue;
    }
    if (!it.requestedDate) {
      errors.push(`${it.line}행 · 납기일이 없습니다.`);
      continue;
    }
    const due = checkDueDate(it.requestedDate, args.today);
    if (!due.ok) {
      errors.push(`${it.line}행 · ${due.reason}`);
      continue;
    }
    rows.push({
      line: it.line,
      orderNo: purchaseOrderNo(args.requestNumber, it.line),
      productId: args.links[it.line] ?? null,
      productNameRaw: it.productName.trim() || it.productCode.trim(),
      itemCodeRaw: it.productCode.trim() || null,
      customerName: it.customer.trim() || args.customer.trim() || null,
      qty,
      dueDate: it.requestedDate,
      memo: it.note.trim() ? it.note.trim().slice(0, 300) : null,
    });
  }

  const existingByLine = new Map<number, ExistingPurchaseOrder>();
  for (const e of args.existing) if (e.line !== null && !existingByLine.has(e.line)) existingByLine.set(e.line, e);
  const lines = new Set(args.items.map((it) => it.line));

  const inserts: PurchaseOrderRow[] = [];
  const updates: { id: string; row: PurchaseOrderRow }[] = [];
  for (const row of rows) {
    const cur = existingByLine.get(row.line);
    if (cur) updates.push({ id: cur.id, row });
    else inserts.push(row);
  }
  const removes = args.existing.filter((e) => e.status === "open" && (e.line === null || !lines.has(e.line))).map((e) => e.id);
  return { errors, inserts, updates, removes, unlinked: rows.filter((r) => !r.productId).length };
}
