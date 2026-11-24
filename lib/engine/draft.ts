/**
 * lib/engine/draft.ts · 생산계획 초안 자동 생성 (금형 배정 포함)
 *
 * 순수 함수. DB·프레임워크에 의존하지 않고 브라우저에서도 돈다. 같은 입력이면 항상 같은 결과가 나온다(난수·현재 시각 없음).
 * 시스템은 초안까지만 만든다. 확정은 사람이 한다.
 *
 * 규칙 (UI 도움말에 그대로 적을 것)
 *  1. 과거 이력 우선: 과거 확정 계획에서 그 제품을 생산한 호기를 먼저 쓴다. 여러 호기면 최근에 많이 쓴 호기가 먼저.
 *  2. 납기 순: 납기 빠른 주문부터 배정. 같으면 대형 거래선(가중치) → 수량 큰 순.
 *  3. 교체 최소화: 같은 제품은 같은 호기에 이어 붙인다. 제품이 바뀌면 과거 교체 이력(이 제품 → 저 제품)에서
 *     B/M 으로 한 적이 있으면 B/M(2h), Full 만 있으면 Full(6h). 이력이 없으면 Full 로 가정하고 "확인 필요".
 *  4. Capa 준수: 하루 수량 ≤ Capa × 교체 계수 × 주말 계수. 가동 불가일은 0. 넘치면 여러 날·다른 허용 호기로 나눈다.
 *  5. 제약: 허용 금형, 공장 하루 교체 횟수, 가동 불가일. 못 지키면 배정하되 경고를 남긴다.
 *  6. 기존 셀 보존: 'fill' 은 빈 칸만 채운다. 'rebuild' 는 전부 비우고 다시 만든다.
 *     기간 첫날은 직전 확정 계획의 마지막 제품이 이어진다고 본다(prevLastProductByLine).
 */
import { addDays, dateRange, isWeekend } from "./calendar";
import type { ChangeoverKind, ChangeoverType, EngineInput, ISODate, PlanCell } from "./types";

export interface DraftOrder {
  id: string;
  /** 기준정보와 매칭 안 된 주문은 null → 초안에서 제외 */
  productId: string | null;
  productNameRaw: string;
  qty: number;
  dueDate: ISODate;
  isMajorCustomer?: boolean;
  customerName?: string | null;
}

/** 과거 확정 계획의 셀 */
export interface DraftHistoryCell {
  lineId: string;
  date: ISODate;
  productId: string;
  changeoverType: ChangeoverType;
  moldId?: string | null;
  /** 근거에 쓸 출처 이름 (예: "10/22 주 Rev 1") */
  sourceLabel: string;
}

export interface DraftMold {
  id: string;
  moldNo: string;
  name: string;
  productIds: string[];
}

export interface DraftInput {
  engine: Pick<
    EngineInput,
    "periodStart" | "periodDays" | "lines" | "products" | "allowedMolds" | "capacities" | "changeoverCoefficients" | "settings" | "downtimes" | "priorityWeights"
  >;
  /** 지금 초안에 있는 셀 */
  existingCells: PlanCell[];
  mode: "fill" | "rebuild";
  orders: DraftOrder[];
  history: DraftHistoryCell[];
  molds: DraftMold[];
  /** 제품별 현재고(재고현황 최신). 없으면 0 */
  stockByProduct: Record<string, number>;
  /** 순 소요량(주문 − (현재고 − 안전재고)) 사용 */
  useNetRequirement: boolean;
  /** 호기별 직전 확정 계획의 마지막 제품 */
  prevLastProductByLine: Record<string, string>;
}

export type DraftExceptionCode =
  | "NEW_PRODUCT" // 과거 이력 없는 신규 제품 → Capa 최대 호기에 임시 배정
  | "MOLD_CONFLICT" // 같은 날 같은 금형이 두 호기에
  | "SHORTAGE" // 납기 내 수량 부족
  | "MOLD_UNKNOWN" // 금형 정보 없음 / 후보 여럿
  | "CHANGEOVER_ASSUMED" // 교체유형을 이력으로 판단 못 함 → Full 가정
  | "UNMATCHED_ORDER" // 주문 품명이 기준정보와 매칭 안 됨
  | "CONSTRAINT"; // 허용 금형·교체 횟수 등 제약을 지키지 못함

export interface DraftException {
  code: DraftExceptionCode;
  lineId: string | null;
  date: ISODate | null;
  orderId: string | null;
  productId: string | null;
  message: string;
}

export interface DraftOrderResult {
  orderId: string;
  productId: string | null;
  productName: string;
  dueDate: ISODate;
  required: number;
  /** 재고를 뺀 순 소요량 */
  netRequired: number;
  stockUsed: number;
  planned: number;
  plannedByDue: number;
  /** 납기 안에 못 채운 수량 */
  shortage: number;
  onTime: boolean;
  status: "ok" | "late" | "short" | "stock" | "unmatched";
  assignments: { lineId: string; date: ISODate; qty: number }[];
}

export interface DraftResult {
  /** 초안 전체 셀(보존한 셀 + 새로 만든 셀) */
  cells: PlanCell[];
  createdCount: number;
  keptCount: number;
  orders: DraftOrderResult[];
  exceptions: DraftException[];
  /** 학습한 교체 표: "이전 제품>다음 제품" → 유형 */
  transitions: Record<string, ChangeoverKind>;
}

const k2 = (a: string, b: string) => `${a}|${b}`;

/** 과거 교체 이력에서 "이 제품 → 저 제품" 전환 때 어떤 교체를 했는지 표로 만든다. B/M 으로 한 적이 있으면 B/M */
export function learnTransitions(history: DraftHistoryCell[]): Record<string, ChangeoverKind> {
  const byLine = new Map<string, DraftHistoryCell[]>();
  for (const h of history) {
    const arr = byLine.get(h.lineId);
    if (arr) arr.push(h);
    else byLine.set(h.lineId, [h]);
  }
  const seen = new Map<string, { BM: number; FULL: number }>();
  for (const cells of byLine.values()) {
    cells.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    for (let i = 1; i < cells.length; i++) {
      const prev = cells[i - 1];
      const cur = cells[i];
      if (prev.productId === cur.productId || cur.changeoverType === "NONE") continue;
      // 날짜가 많이 떨어진 두 계획 사이의 전환은 근거로 쓰지 않는다
      if (addDays(prev.date, 7) < cur.date) continue;
      const key = `${prev.productId}>${cur.productId}`;
      const e = seen.get(key) ?? { BM: 0, FULL: 0 };
      e[cur.changeoverType]++;
      seen.set(key, e);
    }
  }
  const out: Record<string, ChangeoverKind> = {};
  for (const [key, e] of Array.from(seen).sort((a, b) => (a[0] < b[0] ? -1 : 1))) out[key] = e.BM > 0 ? "BM" : "FULL";
  return out;
}

export function generateDraft(input: DraftInput): DraftResult {
  const { engine } = input;
  const dates = dateRange(engine.periodStart, engine.periodDays);
  const lastDate = dates[dates.length - 1];
  const lines = engine.lines.filter((l) => l.isPlanTarget).sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1));
  const lineById = new Map(lines.map((l) => [l.id, l] as const));
  const productById = new Map(engine.products.map((p) => [p.id, p] as const));
  const capaByKey = new Map(engine.capacities.map((c) => [k2(c.lineId, c.productId), c.dailyCapa] as const));
  const coefByKey = new Map(engine.changeoverCoefficients.map((c) => [k2(c.processType, c.changeoverType), c] as const));
  const allowedLines = new Map<string, Set<string>>();
  for (const a of engine.allowedMolds) {
    const s = allowedLines.get(a.productId) ?? new Set<string>();
    s.add(a.lineId);
    allowedLines.set(a.productId, s);
  }
  const downtime = (lineId: string, date: ISODate) => engine.downtimes.some((d) => d.lineId === lineId && d.startDate <= date && date <= d.endDate);
  const capaOf = (lineId: string, productId: string) => capaByKey.get(k2(lineId, productId)) ?? productById.get(productId)?.defaultDailyCapa ?? 0;

  const exceptions: DraftException[] = [];
  const exc = (code: DraftExceptionCode, message: string, at: Partial<Pick<DraftException, "lineId" | "date" | "orderId" | "productId">> = {}) =>
    exceptions.push({ code, message, lineId: at.lineId ?? null, date: at.date ?? null, orderId: at.orderId ?? null, productId: at.productId ?? null });

  // ---- 이력 정리 ----
  const transitions = learnTransitions(input.history);
  const histDates = Array.from(new Set(input.history.map((h) => h.date))).sort();
  const recency = new Map(histDates.map((d, i) => [d, 1 + (i + 1) / histDates.length] as const)); // 1~2, 최근일수록 큼
  const lineScore = new Map<string, number>(); // product|line → 점수
  const lineSource = new Map<string, string>(); // product|line → 가장 최근 출처
  const lineSourceDate = new Map<string, string>();
  const histMold = new Map<string, string>(); // product|line → 가장 최근 금형
  for (const h of input.history.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.lineId < b.lineId ? -1 : 1))) {
    const key = k2(h.productId, h.lineId);
    lineScore.set(key, (lineScore.get(key) ?? 0) + (recency.get(h.date) ?? 1));
    if ((lineSourceDate.get(key) ?? "") <= h.date) {
      lineSourceDate.set(key, h.date);
      lineSource.set(key, h.sourceLabel);
      if (h.moldId) histMold.set(key, h.moldId);
    }
  }
  const moldsByProduct = new Map<string, DraftMold[]>();
  for (const m of input.molds.slice().sort((a, b) => (a.moldNo < b.moldNo ? -1 : 1))) {
    for (const pid of m.productIds) {
      const arr = moldsByProduct.get(pid) ?? [];
      arr.push(m);
      moldsByProduct.set(pid, arr);
    }
  }

  // ---- 격자 ----
  const grid = new Map<string, PlanCell>();
  const kept = input.mode === "fill" ? input.existingCells.filter((c) => c.productId) : [];
  for (const c of kept) if (lineById.has(c.lineId) && dates.includes(c.date)) grid.set(k2(c.lineId, c.date), c);
  const keptCount = grid.size;
  const created = new Set<string>();

  /** 그 칸 바로 앞의 생산 제품(같은 호기). 기간 앞이면 직전 확정 계획의 마지막 제품 */
  const prevProduct = (lineId: string, idx: number): string | null => {
    for (let i = idx - 1; i >= 0; i--) {
      const c = grid.get(k2(lineId, dates[i]));
      if (c?.productId) return c.productId;
    }
    return input.prevLastProductByLine[lineId] ?? null;
  };
  const nextProduct = (lineId: string, idx: number): string | null => {
    for (let i = idx + 1; i < dates.length; i++) {
      const c = grid.get(k2(lineId, dates[i]));
      if (c?.productId) return c.productId;
    }
    return null;
  };
  const changeoversOn = (date: ISODate): number => {
    let n = 0;
    for (const l of lines) {
      const c = grid.get(k2(l.id, date));
      if (c?.productId && c.changeoverType !== "NONE") n++;
    }
    return n;
  };
  /** 금형이 하나로 정해지는 품번의 금형 id */
  const uniqueMold = (productId: string | null): string | null => {
    if (!productId) return null;
    const ms = moldsByProduct.get(productId) ?? [];
    return ms.length === 1 ? ms[0].id : null;
  };
  /** 두 품번이 같은 금형을 쓰는가 (같은 품번 포함) */
  const sameMold = (a: string | null, b: string | null): boolean => !!a && !!b && (a === b || (uniqueMold(a) !== null && uniqueMold(a) === uniqueMold(b)));
  /** 같은 금형을 쓰는 다른 품번들 */
  const siblings = (productId: string): string[] => {
    const m = uniqueMold(productId);
    if (!m) return [];
    return (input.molds.find((x) => x.id === m)?.productIds ?? []).filter((p) => p !== productId).sort();
  };
  const transitionType = (from: string | null, to: string): { type: ChangeoverType; assumed: boolean } => {
    if (!from || from === to) return { type: "NONE", assumed: false };
    // 같은 금형을 쓰는 품번끼리는 금형 교체가 없다
    if (sameMold(from, to)) return { type: "NONE", assumed: false };
    const t = transitions[`${from}>${to}`] ?? transitions[`${to}>${from}`];
    return t ? { type: t, assumed: false } : { type: "FULL", assumed: true };
  };
  const dayCapacity = (lineId: string, productId: string, date: ISODate, type: ChangeoverType): number => {
    if (downtime(lineId, date)) return 0;
    let v = capaOf(lineId, productId);
    if (type !== "NONE") {
      const line = lineById.get(lineId)!;
      const coef = coefByKey.get(k2(line.processType, type));
      if (coef) v = coef.nextDayStart ? 0 : v * coef.factor;
    }
    if (isWeekend(date)) v *= engine.settings.weekendFactor;
    return Math.round(v);
  };

  // ---- 순 소요량: 납기 빠른 주문부터 재고를 쓴다 ----
  const sorted = input.orders.slice().sort((a, b) => {
    if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
    const ma = a.isMajorCustomer ? 1 : 0;
    const mb = b.isMajorCustomer ? 1 : 0;
    if (ma !== mb && engine.priorityWeights.majorCustomer > 0) return mb - ma;
    if (a.qty !== b.qty) return b.qty - a.qty;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const stockLeft = new Map<string, number>();
  const results: DraftOrderResult[] = [];

  for (const order of sorted) {
    const product = order.productId ? productById.get(order.productId) : undefined;
    if (!order.productId || !product) {
      exc("UNMATCHED_ORDER", `주문 "${order.productNameRaw}" 이(가) 기준정보 제품과 매칭되지 않아 초안에서 뺐습니다`, { orderId: order.id });
      results.push({
        orderId: order.id,
        productId: null,
        productName: order.productNameRaw,
        dueDate: order.dueDate,
        required: order.qty,
        netRequired: order.qty,
        stockUsed: 0,
        planned: 0,
        plannedByDue: 0,
        shortage: order.qty,
        onTime: false,
        status: "unmatched",
        assignments: [],
      });
      continue;
    }
    const pid = product.id;
    let stockUsed = 0;
    if (input.useNetRequirement) {
      if (!stockLeft.has(pid)) stockLeft.set(pid, Math.max(0, (input.stockByProduct[pid] ?? 0) - product.safetyStock));
      stockUsed = Math.min(stockLeft.get(pid)!, order.qty);
      stockLeft.set(pid, stockLeft.get(pid)! - stockUsed);
    }
    const net = order.qty - stockUsed;
    const res: DraftOrderResult = {
      orderId: order.id,
      productId: pid,
      productName: product.name,
      dueDate: order.dueDate,
      required: order.qty,
      netRequired: net,
      stockUsed,
      planned: 0,
      plannedByDue: 0,
      shortage: 0,
      onTime: true,
      status: net === 0 ? "stock" : "ok",
      assignments: [],
    };
    results.push(res);
    if (net === 0) continue;

    // ---- 후보 호기 순서 ----
    const allowed = allowedLines.get(pid) ?? new Set<string>();
    let candidates = lines.filter((l) => allowed.has(l.id));
    const withHistory = lines.filter((l) => lineScore.has(k2(pid, l.id)));
    let constraintBroken = false;
    if (!candidates.length) {
      // 허용 호기가 하나도 없으면 이력 호기, 그것도 없으면 Capa 가 있는 호기에 배정하되 경고
      candidates = withHistory.length ? withHistory : lines.filter((l) => capaOf(l.id, pid) > 0);
      constraintBroken = true;
    }
    candidates = candidates.filter((l) => capaOf(l.id, pid) > 0);
    // 같은 금형을 쓰는 다른 품번의 이력도 참고한다(자기 이력 다음 순위)
    const sibs = siblings(pid);
    const sibScore = (lineId: string) => sibs.reduce((a, s) => a + (lineScore.get(k2(s, lineId)) ?? 0), 0);
    const sibSource = (lineId: string): string | null => {
      for (const s of sibs) {
        const src = lineSource.get(k2(s, lineId));
        if (src) return `같은 금형을 쓰는 ${productById.get(s)?.name ?? "품번"} 이력(${src})`;
      }
      return null;
    };
    const isNew = !candidates.some((l) => lineScore.has(k2(pid, l.id)) || sibScore(l.id) > 0);
    candidates.sort((a, b) => {
      const sa = lineScore.get(k2(pid, a.id)) ?? 0;
      const sb = lineScore.get(k2(pid, b.id)) ?? 0;
      if (sa !== sb) return sb - sa;
      const ma = sibScore(a.id);
      const mb = sibScore(b.id);
      if (ma !== mb) return mb - ma;
      const ca = capaOf(a.id, pid);
      const cb = capaOf(b.id, pid);
      if (ca !== cb) return cb - ca;
      return a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1);
    });
    if (!candidates.length) {
      res.shortage = net;
      res.onTime = false;
      res.status = "short";
      exc("SHORTAGE", `${product.name}: 배정할 수 있는 호기가 없습니다(허용 금형·Capa 정보 없음). 부족 ${net.toLocaleString("ko-KR")}본`, { orderId: order.id, productId: pid });
      continue;
    }
    if (isNew) exc("NEW_PRODUCT", `${product.name}: 과거 이력이 없는 신규 제품입니다. Capa 가 가장 큰 호기(${candidates[0].name})에 임시 배정했습니다`, { orderId: order.id, productId: pid, lineId: candidates[0].id });
    if (constraintBroken) exc("CONSTRAINT", `${product.name}: 허용 호기가 등록돼 있지 않아 ${candidates[0].name}에 배정했습니다. 허용 금형을 확인하세요`, { orderId: order.id, productId: pid, lineId: candidates[0].id });

    // ---- 금형 ----
    const moldOptions = moldsByProduct.get(pid) ?? [];
    const moldFor = (lineId: string): string | null => {
      if (moldOptions.length === 1) return moldOptions[0].id;
      const h = histMold.get(k2(pid, lineId));
      return h && moldOptions.some((m) => m.id === h) ? h : null;
    };
    let moldWarned = false;

    // ---- 배정 ----
    let remaining = net;
    const place = (lineId: string, idx: number, respectLimit: boolean): boolean => {
      const date = dates[idx];
      if (grid.has(k2(lineId, date)) || downtime(lineId, date)) return false;
      const prev = prevProduct(lineId, idx);
      const tr = transitionType(prev, pid);
      if (tr.type !== "NONE" && changeoversOn(date) >= engine.settings.dailyChangeoverLimit) {
        if (respectLimit) return false;
        exc("CONSTRAINT", `${date.slice(5)} 공장 하루 교체 횟수(${engine.settings.dailyChangeoverLimit}회)를 넘겨 배정했습니다 (${lineById.get(lineId)!.name} ${product.name})`, { lineId, date, orderId: order.id, productId: pid });
      }
      const cap = dayCapacity(lineId, pid, date, tr.type);
      if (cap <= 0) return false;
      const qty = Math.min(cap, remaining);
      const moldId = moldFor(lineId);
      const line = lineById.get(lineId)!;
      const src = lineSource.get(k2(pid, lineId));
      const sib = src ? null : sibSource(lineId);
      const basis = src ? `${src} ${line.name}와 동일` : sib ? `${sib} ${line.name}` : isNew ? "이력 없음 – Capa 최대 호기" : "이력 호기가 가득 차 다른 허용 호기에 배정";
      grid.set(k2(lineId, date), { lineId, date, productId: pid, qty, changeoverType: tr.type, memo: null, moldId, origin: "auto", basis, orderId: order.id });
      created.add(k2(lineId, date));
      if (tr.assumed) exc("CHANGEOVER_ASSUMED", `${line.name} ${date.slice(5)}: ${productById.get(prev!)?.name ?? "이전 제품"} → ${product.name} 전환 이력이 없어 Full set 으로 가정했습니다`, { lineId, date, orderId: order.id, productId: pid });
      if (!moldId && !moldWarned) {
        moldWarned = true;
        exc("MOLD_UNKNOWN", moldOptions.length ? `${product.name}: 금형 후보가 ${moldOptions.length}개라 금형 칸을 비웠습니다` : `${product.name}: 등록된 금형이 없어 금형 칸을 비웠습니다`, { lineId, date, orderId: order.id, productId: pid });
      }
      // 뒤에 이어지는 다른 제품 셀이 이제 교체가 필요해졌으면 표시만 한다(사람이 넣은 셀은 건드리지 않는다)
      const after = idx + 1 < dates.length ? grid.get(k2(lineId, dates[idx + 1])) : undefined;
      if (after?.productId && after.productId !== pid && created.has(k2(lineId, after.date)) && after.changeoverType === "NONE") {
        const t2 = transitionType(pid, after.productId);
        after.changeoverType = t2.type;
      }
      res.assignments.push({ lineId, date, qty });
      res.planned += qty;
      if (date <= order.dueDate) res.plannedByDue += qty;
      remaining -= qty;
      return true;
    };

    /** 한 호기에서 [fromIdx, toIdx] 범위의 빈 칸을 앞에서부터 채운다. 같은 제품에 이어 붙일 수 있는 칸을 먼저 쓴다 */
    const fillLine = (lineId: string, toIdx: number, respectLimit: boolean) => {
      const idxs: number[] = [];
      for (let i = 0; i <= toIdx; i++) idxs.push(i);
      // 교체가 필요 없는 칸(앞이 같은 품번이거나 같은 금형을 쓰는 품번) 먼저, 그다음 날짜순
      const noChange = idxs.filter((i) => sameMold(prevProduct(lineId, i), pid) || (prevProduct(lineId, i) === null && sameMold(nextProduct(lineId, i), pid)));
      const order2 = [...noChange, ...idxs.filter((i) => !noChange.includes(i))];
      let startedAt = -1;
      for (const i of order2) {
        if (remaining <= 0) return;
        if (startedAt >= 0 && i < startedAt) continue;
        if (place(lineId, i, respectLimit) && startedAt < 0) startedAt = i;
      }
      // 시작한 뒤로는 날짜순으로 이어서 채운다
      if (startedAt >= 0) for (let i = startedAt + 1; i <= toIdx && remaining > 0; i++) place(lineId, i, respectLimit);
    };

    const dueIdx = Math.min(dates.length - 1, order.dueDate < dates[0] ? -1 : dates.filter((d) => d <= order.dueDate).length - 1);
    // ① 납기 안, 교체 한도 지키며
    for (const l of candidates) {
      if (remaining <= 0) break;
      if (dueIdx >= 0) fillLine(l.id, dueIdx, true);
    }
    // ② 납기 안, 한도를 넘겨서라도 (경고)
    for (const l of candidates) {
      if (remaining <= 0) break;
      if (dueIdx >= 0) fillLine(l.id, dueIdx, false);
    }
    const shortByDue = remaining;
    // ③ 납기 뒤(지연)
    for (const l of candidates) {
      if (remaining <= 0) break;
      fillLine(l.id, dates.length - 1, false);
    }
    if (shortByDue > 0) {
      res.shortage = shortByDue;
      res.onTime = false;
      res.status = remaining > 0 ? "short" : "late";
      const lateNote = remaining > 0 ? `기간(${lastDate.slice(5)}) 안에 ${remaining.toLocaleString("ko-KR")}본을 배정하지 못했습니다` : "나머지는 납기 뒤에 배정했습니다";
      exc("SHORTAGE", `${product.name} (납기 ${order.dueDate.slice(5)}): 납기 안 수량이 ${shortByDue.toLocaleString("ko-KR")}본 부족합니다. ${lateNote}`, {
        orderId: order.id,
        productId: pid,
        lineId: res.assignments[0]?.lineId ?? candidates[0].id,
        date: res.assignments[0]?.date ?? null,
      });
    }
  }

  // ---- 같은 날 같은 금형이 두 호기에 ----
  const moldUse = new Map<string, PlanCell[]>();
  for (const c of grid.values()) {
    if (!c.moldId) continue;
    const key = k2(c.moldId, c.date);
    const arr = moldUse.get(key) ?? [];
    arr.push(c);
    moldUse.set(key, arr);
  }
  const moldName = new Map(input.molds.map((m) => [m.id, m.name] as const));
  for (const [key, cells] of Array.from(moldUse).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (cells.length < 2 || !cells.some((c) => created.has(k2(c.lineId, c.date)))) continue;
    const [moldId, date] = key.split("|");
    const names = cells.map((c) => lineById.get(c.lineId)?.name ?? c.lineId).sort();
    const target = cells.find((c) => created.has(k2(c.lineId, c.date))) ?? cells[0];
    exc("MOLD_CONFLICT", `${date.slice(5)} 금형 "${moldName.get(moldId) ?? moldId}" 이(가) ${names.join(", ")}에 동시에 배정됐습니다`, { lineId: target.lineId, date, productId: target.productId });
  }

  const order3 = new Map(lines.map((l, i) => [l.id, i] as const));
  // 제품 없이 메모만 있는 기존 셀은 그 칸에 새 셀이 생기지 않았으면 그대로 둔다
  if (input.mode === "fill") {
    for (const c of input.existingCells) {
      if (!c.productId && c.memo && !grid.has(k2(c.lineId, c.date))) grid.set(k2(c.lineId, c.date), c);
    }
  }
  const cells = Array.from(grid.values()).sort((a, b) => (order3.get(a.lineId) ?? 0) - (order3.get(b.lineId) ?? 0) || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { cells, createdCount: created.size, keptCount, orders: results, exceptions, transitions };
}
