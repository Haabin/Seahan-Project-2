/**
 * FR-14 씨벌크(PET 원료) 사용량, FR-15 사일로 재고 6주 예측.
 * 1~2주: 계획 셀 기반(basis 'plan'), 3~6주: 월 운용안 기반 추정(basis 'estimate').
 * 사일로 2기는 합계 기준으로 계산한다.
 */
import type {
  CellResult,
  EngineInput,
  ExplainStep,
  ISODate,
  Product,
  SiloDay,
  SiloStatus,
} from "./types";
import { dateRange, isWeekend, shortDate, yearMonthOf } from "./calendar";

/** 수량(본/천본) × 프리폼 중량(g) → 톤 */
export function qtyToTon(qty: number, product: Product): number {
  const pieces = product.unit === "KEA" ? qty * 1000 : qty;
  return (pieces * product.preformWeightG) / 1e6;
}

/** periodStart 이전(포함) 사일로별 최신 실측치 합계 */
export function openingSiloTon(input: EngineInput): { total: number; measured: boolean; detail: string } {
  const latest = new Map<string, { date: ISODate; ton: number }>();
  for (const m of input.siloMeasurements) {
    if (m.date > input.periodStart) continue;
    const cur = latest.get(m.siloCode);
    if (!cur || m.date > cur.date) latest.set(m.siloCode, { date: m.date, ton: m.measuredTon });
  }
  if (latest.size === 0) return { total: 0, measured: false, detail: "실측치 없음 → 0톤으로 가정" };
  let total = 0;
  const parts: string[] = [];
  const codes = Array.from(latest.keys()).sort();
  for (const code of codes) {
    const v = latest.get(code) as { date: ISODate; ton: number };
    total += v.ton;
    parts.push(`${code} ${v.ton}t(${shortDate(v.date)})`);
  }
  return { total, measured: true, detail: parts.join(" + ") };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function computeSilo(
  input: EngineInput,
  cells: CellResult[],
  horizonDates: ISODate[] = dateRange(input.periodStart, input.horizonDays),
  periodDates: ISODate[] = dateRange(input.periodStart, input.periodDays),
): SiloDay[] {
  const lineById = new Map(input.lines.map((l) => [l.id, l] as const));
  const productById = new Map(input.products.map((p) => [p.id, p] as const));
  const periodSet = new Set(periodDates);

  // 계획 기반 일별 사용량(공장별)
  const planUsage = new Map<ISODate, { F1: number; F2: number }>();
  for (const c of cells) {
    if (c.productId == null || c.expectedQty === 0) continue;
    const line = lineById.get(c.lineId);
    if (!line || !line.usesSeabulk) continue;
    const product = productById.get(c.productId);
    if (!product) continue;
    const ton = qtyToTon(c.expectedQty, product);
    let u = planUsage.get(c.date);
    if (!u) {
      u = { F1: 0, F2: 0 };
      planUsage.set(c.date, u);
    }
    if (line.factoryCode === "F2") u.F2 += ton;
    else u.F1 += ton;
  }

  // 입고
  const receiptByDate = new Map<ISODate, { ton: number; labels: string[] }>();
  for (const r of input.siloReceipts) {
    if (r.status === "cancelled") continue;
    let e = receiptByDate.get(r.plannedDate);
    if (!e) {
      e = { ton: 0, labels: [] };
      receiptByDate.set(r.plannedDate, e);
    }
    e.ton += r.qtyTon;
    e.labels.push(`${r.supplier} ${r.qtyTon}t${r.status === "received" ? "(입고완료)" : ""}`);
  }

  // 월 운용안 (yearMonth별)
  const monthlyByYm = new Map<string, typeof input.monthlyPlans>();
  for (const mp of input.monthlyPlans) {
    const line = lineById.get(mp.lineId);
    if (!line || !line.usesSeabulk) continue;
    const arr = monthlyByYm.get(mp.yearMonth);
    if (arr) arr.push(mp);
    else monthlyByYm.set(mp.yearMonth, [mp]);
  }

  const externalFor = (factory: string, weekend: boolean): { ton: number; labels: string[] } => {
    let ton = 0;
    const labels: string[] = [];
    for (const e of input.externalUsage) {
      if (e.factoryCode !== factory) continue;
      const v = weekend ? e.weekendTon : e.weekdayTon;
      ton += v;
      labels.push(`${e.label} ${v}t`);
    }
    return { ton, labels };
  };

  const opening0 = openingSiloTon(input);
  const { siloLowerBoundTon: lower, siloUpperBoundTon: upper, weekendFactor } = input.settings;

  const out: SiloDay[] = [];
  let running = opening0.total;
  for (let i = 0; i < horizonDates.length; i++) {
    const date = horizonDates[i];
    const weekend = isWeekend(date);
    const explain: ExplainStep[] = [];
    const opening = running;
    explain.push({
      label: "기초",
      value: round3(opening),
      note: i === 0 ? opening0.detail : "전일 기말",
    });

    const rec = receiptByDate.get(date);
    const receipt = rec?.ton ?? 0;
    explain.push({ label: "입고", value: round3(receipt), note: rec ? rec.labels.join(", ") : undefined });

    let usageF1 = 0;
    let usageF2 = 0;
    const basis: SiloDay["basis"] = periodSet.has(date) ? "plan" : "estimate";
    const ext1 = externalFor("F1", weekend);
    const ext2 = externalFor("F2", weekend);

    if (basis === "plan") {
      const pu = planUsage.get(date);
      const planF1 = pu?.F1 ?? 0;
      const planF2 = pu?.F2 ?? 0;
      usageF1 = planF1 + ext1.ton;
      usageF2 = planF2 + ext2.ton;
      explain.push({
        label: "1공장 사용",
        value: round3(usageF1),
        note: `계획 ${round3(planF1)}t` + (ext1.labels.length ? ` + 외부(${ext1.labels.join(", ")})` : ""),
      });
      explain.push({
        label: "2공장 사용",
        value: round3(usageF2),
        note: (planF2 ? `계획 ${round3(planF2)}t` : "") + (ext2.labels.length ? `${planF2 ? " + " : ""}외부(${ext2.labels.join(", ")})` : "") || "사용 없음",
      });
      explain.push({ label: "근거", value: "계획", note: "주간 계획 셀의 예상 생산량 × 프리폼 중량" });
    } else {
      const ym = yearMonthOf(date);
      const plans = monthlyByYm.get(ym) ?? [];
      let estF1 = 0;
      let estF2 = 0;
      for (const mp of plans) {
        if (mp.workingDays <= 0) continue;
        const product = productById.get(mp.productId);
        const line = lineById.get(mp.lineId);
        if (!product || !line) continue;
        const dailyQty = (mp.qty / mp.workingDays) * (weekend ? weekendFactor : 1);
        const ton = qtyToTon(dailyQty, product);
        if (line.factoryCode === "F2") estF2 += ton;
        else estF1 += ton;
      }
      usageF1 = estF1 + ext1.ton;
      usageF2 = estF2 + ext2.ton;
      explain.push({
        label: "1공장 사용",
        value: round3(usageF1),
        note: `추정 ${round3(estF1)}t` + (ext1.labels.length ? ` + 외부(${ext1.labels.join(", ")})` : ""),
      });
      explain.push({
        label: "2공장 사용",
        value: round3(usageF2),
        note: (estF2 ? `추정 ${round3(estF2)}t` : "") + (ext2.labels.length ? `${estF2 ? " + " : ""}외부(${ext2.labels.join(", ")})` : "") || "사용 없음",
      });
      explain.push({
        label: "추정 근거",
        value: `${ym} 월 운용안`,
        note:
          plans.length === 0
            ? "해당 월 운용안 없음 → 계획 설비 사용량 0"
            : `월 물량 ÷ 가동일수 × 중량${weekend ? ` × 주말 계수 ${weekendFactor}` : ""} (${plans.length}건)`,
      });
    }

    const usageTotal = usageF1 + usageF2;
    const closing = opening + receipt - usageTotal;
    let status: SiloStatus = "ok";
    if (closing < lower) status = "below_lower";
    else if (closing > upper) status = "above_upper";
    explain.push({
      label: "기말",
      value: round3(closing),
      note: status === "below_lower" ? `하한 ${lower}t 미달` : status === "above_upper" ? `상한 ${upper}t 초과` : undefined,
    });

    out.push({
      date,
      opening: round3(opening),
      receipt: round3(receipt),
      usageF1: round3(usageF1),
      usageF2: round3(usageF2),
      usageTotal: round3(usageTotal),
      closing: round3(closing),
      basis,
      status,
      explain,
    });
    running = closing;
  }
  return out;
}
