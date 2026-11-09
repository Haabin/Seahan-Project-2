/**
 * FR-09 제품별 수급(예상 재고) 계산, FR-11 우선순위 점수.
 * 기초재고 + 예상 생산 − 출고 = 기말재고 를 기간 내 일별로 전개한다.
 */
import type {
  CellResult,
  EngineInput,
  ISODate,
  PriorityBreakdown,
  ProductSupplyRow,
  Shipment,
  SupplyDay,
  SupplyStatus,
} from "./types";
import { addDays, dateRange, diffDays } from "./calendar";

interface ShipmentAgg {
  byDate: Map<ISODate, number>;
  hasMajor: boolean;
  hasAny: boolean;
}

function aggregateShipments(shipments: Shipment[]): Map<string, ShipmentAgg> {
  const out = new Map<string, ShipmentAgg>();
  for (const s of shipments) {
    let agg = out.get(s.productId);
    if (!agg) {
      agg = { byDate: new Map(), hasMajor: false, hasAny: false };
      out.set(s.productId, agg);
    }
    agg.byDate.set(s.shipDate, (agg.byDate.get(s.shipDate) ?? 0) + s.qty);
    agg.hasAny = true;
    if (s.isMajorCustomer) agg.hasMajor = true;
  }
  return out;
}

/** periodStart 이전(포함) 최신 재고 스냅샷 */
export function openingStockOf(input: EngineInput, productId: string): number {
  let best: { asOfDate: ISODate; qty: number } | null = null;
  for (const inv of input.inventory) {
    if (inv.productId !== productId || inv.asOfDate > input.periodStart) continue;
    if (!best || inv.asOfDate > best.asOfDate) best = { asOfDate: inv.asOfDate, qty: inv.qty };
  }
  return best ? best.qty : 0;
}

/** (date, date+N] 구간 출고 합계 */
function shipmentsInWindow(agg: ShipmentAgg | undefined, date: ISODate, n: number): number {
  if (!agg || n <= 0) return 0;
  let sum = 0;
  for (let i = 1; i <= n; i++) {
    sum += agg.byDate.get(addDays(date, i)) ?? 0;
  }
  return sum;
}

/** [start, start+n] 구간 출고 존재 여부 */
function hasShipmentInRange(agg: ShipmentAgg | undefined, start: ISODate, n: number): boolean {
  if (!agg) return false;
  const end = addDays(start, n);
  let found = false;
  agg.byDate.forEach((qty, d) => {
    if (qty !== 0 && d >= start && d <= end) found = true;
  });
  return found;
}

export function computePriority(
  input: EngineInput,
  row: Pick<ProductSupplyRow, "firstShortageDate" | "firstWarningDate" | "hasMajorCustomer">,
): PriorityBreakdown {
  const w = input.priorityWeights;
  const dueSoonRaw = row.firstShortageDate
    ? 1 / (diffDays(input.periodStart, row.firstShortageDate) + 1)
    : 0;
  const majorRaw = row.hasMajorCustomer ? 1 : 0;
  const belowRaw = row.firstWarningDate || row.firstShortageDate ? 1 : 0;
  const dueSoon = w.dueSoon * dueSoonRaw;
  const majorCustomer = w.majorCustomer * majorRaw;
  const belowSafety = w.belowSafety * belowRaw;
  return { dueSoon, majorCustomer, belowSafety, total: dueSoon + majorCustomer + belowSafety };
}

export function computeSupply(
  input: EngineInput,
  cells: CellResult[],
  periodDates: ISODate[] = dateRange(input.periodStart, input.periodDays),
): ProductSupplyRow[] {
  const periodEnd = periodDates.length ? periodDates[periodDates.length - 1] : input.periodStart;
  const productById = new Map(input.products.map((p) => [p.id, p] as const));
  const shipAgg = aggregateShipments(input.shipments);

  // 생산 집계: productId|date → qty (계획 대상 설비의 결과만 들어온다)
  const prodByKey = new Map<string, number>();
  const productIds = new Set<string>();
  for (const c of cells) {
    if (c.productId == null) continue;
    productIds.add(c.productId);
    const k = `${c.productId}|${c.date}`;
    prodByKey.set(k, (prodByKey.get(k) ?? 0) + c.expectedQty);
  }
  for (const s of input.shipments) {
    if (s.shipDate >= input.periodStart && s.shipDate <= periodEnd) productIds.add(s.productId);
  }
  for (const inv of input.inventory) productIds.add(inv.productId);

  const rows: ProductSupplyRow[] = [];
  productIds.forEach((productId) => {
    const product = productById.get(productId);
    const agg = shipAgg.get(productId);
    const safetyStock = product?.safetyStock ?? 0;
    const surplusDays = product?.surplusDays ?? input.settings.surplusDays;
    const opening = openingStockOf(input, productId);

    const days: SupplyDay[] = [];
    let running = opening;
    let firstShortageDate: ISODate | null = null;
    let firstShortageQty: number | null = null;
    let firstWarningDate: ISODate | null = null;
    let totalShipment = 0;
    let anyShortage = false;
    let anyWarning = false;

    for (const date of periodDates) {
      const production = prodByKey.get(`${productId}|${date}`) ?? 0;
      const shipment = agg?.byDate.get(date) ?? 0;
      const dayOpening = running;
      const closing = dayOpening + production - shipment;
      totalShipment += shipment;

      let status: SupplyStatus = "ok";
      if (closing < 0) {
        status = "shortage";
        anyShortage = true;
        if (!firstShortageDate) {
          firstShortageDate = date;
          firstShortageQty = Math.abs(closing);
        }
      } else if (closing < safetyStock) {
        status = "warning";
        anyWarning = true;
        if (!firstWarningDate) firstWarningDate = date;
      } else {
        const windowSum = shipmentsInWindow(agg, date, surplusDays);
        if (windowSum > 0 && closing > windowSum) status = "surplus";
      }

      days.push({ date, opening: dayOpening, production, shipment, closing, status });
      running = closing;
    }

    const hasMajorCustomer = agg?.hasMajor ?? false;
    const lookahead = Math.max(surplusDays, periodDates.length);
    let status: SupplyStatus;
    if (anyShortage) status = "shortage";
    else if (anyWarning) status = "warning";
    else if (!hasShipmentInRange(agg, input.periodStart, lookahead)) status = "no_shipment";
    else if (days.length && days[days.length - 1].status === "surplus") status = "surplus";
    else status = "ok";

    const priority = computePriority(input, { firstShortageDate, firstWarningDate, hasMajorCustomer });

    rows.push({
      productId,
      productName: product?.name ?? productId,
      openingStock: opening,
      safetyStock,
      days,
      firstShortageDate,
      firstShortageQty,
      firstWarningDate,
      hasMajorCustomer,
      totalShipment,
      status,
      priority,
    });
  });

  rows.sort((a, b) => {
    if (b.priority.total !== a.priority.total) return b.priority.total - a.priority.total;
    const ad = a.firstShortageDate ?? "9999-12-31";
    const bd = b.firstShortageDate ?? "9999-12-31";
    if (ad !== bd) return ad < bd ? -1 : 1;
    return a.productName.localeCompare(b.productName, "ko");
  });

  return rows;
}
