/**
 * FR-16 씨벌크 발주 추천.
 * 최초 하한 미달일 − 리드타임 = 발주 기한. 리드타임 구간 최저 예상재고를 하한 위로 올리는 양을 입고 단위로 올림.
 */
import type { OrderRecommendation, Settings, SiloDay } from "./types";
import { addDays, diffDays, isWeekend, shortDate } from "./calendar";

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function averageUsage(silo: SiloDay[]): { weekday: number; weekend: number } {
  let wdSum = 0;
  let wdN = 0;
  let weSum = 0;
  let weN = 0;
  for (const d of silo) {
    if (isWeekend(d.date)) {
      weSum += d.usageTotal;
      weN++;
    } else {
      wdSum += d.usageTotal;
      wdN++;
    }
  }
  return { weekday: wdN ? wdSum / wdN : 0, weekend: weN ? weSum / weN : 0 };
}

export function recommendOrder(silo: SiloDay[], settings: Settings): OrderRecommendation {
  const { siloLowerBoundTon: lower, leadTimeDays, receiptUnitTon } = settings;
  const avg = averageUsage(silo);
  const weeks = Math.round(silo.length / 7);
  const avgLine = `일평균 사용량 평일 ${round1(avg.weekday).toFixed(1)}톤 · 주말 ${round1(avg.weekend).toFixed(1)}톤`;

  const firstBelow = silo.find((d) => d.status === "below_lower");
  if (!firstBelow) {
    return {
      needed: false,
      orderBy: null,
      firstBelowDate: null,
      minProjected: null,
      qtyTon: 0,
      avgDailyUsageWeekday: round1(avg.weekday),
      avgDailyUsageWeekend: round1(avg.weekend),
      explain: [`${weeks}주 내 하한 미달 없음`, avgLine],
    };
  }

  const firstBelowDate = firstBelow.date;
  const orderBy = addDays(firstBelowDate, -leadTimeDays);
  const windowEnd = addDays(firstBelowDate, leadTimeDays);
  let minProjected = Number.POSITIVE_INFINITY;
  let minDate = firstBelowDate;
  for (const d of silo) {
    if (d.date < firstBelowDate || d.date > windowEnd) continue;
    if (d.closing < minProjected) {
      minProjected = d.closing;
      minDate = d.date;
    }
  }
  if (!Number.isFinite(minProjected)) minProjected = firstBelow.closing;

  const unit = receiptUnitTon > 0 ? receiptUnitTon : 1;
  const deficit = lower - minProjected;
  const units = Math.max(1, Math.ceil(deficit / unit));
  const qtyTon = units * unit;

  const horizonStart = silo[0]?.date ?? firstBelowDate;
  const daysUntilOrder = diffDays(horizonStart, orderBy);
  const urgency =
    daysUntilOrder < 0
      ? ` (발주 기한 ${-daysUntilOrder}일 경과 · 즉시 발주 필요)`
      : daysUntilOrder === 0
        ? " (오늘 발주 필요)"
        : "";

  const explain = [
    `${shortDate(firstBelowDate)} 하한(${lower}톤) 미달 예상`,
    `리드타임 ${leadTimeDays}일 → ${shortDate(orderBy)}까지 발주${urgency}`,
    `리드타임 구간 최저 예상재고 ${round1(minProjected).toFixed(1)}톤 (${shortDate(minDate)})`,
    `부족분 ${round1(Math.max(0, deficit)).toFixed(1)}톤 → 입고 단위 ${unit}톤 × ${units} = ${qtyTon}톤 추천`,
    avgLine,
  ];

  return {
    needed: true,
    orderBy,
    firstBelowDate,
    minProjected: round1(minProjected),
    qtyTon,
    avgDailyUsageWeekday: round1(avg.weekday),
    avgDailyUsageWeekend: round1(avg.weekend),
    explain,
  };
}
