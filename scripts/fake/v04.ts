/**
 * v0.4 가상 데이터: 가상 생산배대(과거 계획) · 가상 제품수불표 · 그 시드 SQL.
 * make-fake-data.ts 의 난수 순서를 건드리지 않도록 여기서는 고정 값과 별도 난수만 쓴다
 * (기존 시드의 UUID 가 바뀌지 않는다).
 */
import { addDays, escapeSqlString } from "../../lib/excel/common";
import type { ISODate, PlanCell } from "../../lib/engine/types";
import { planToBaedaeShapes, type FakeBaedaePlanCell, type FakeBaedaeSheetSpec } from "./baedae";
import { FAKE_STOCK_MONTH, FAKE_STOCK_YEAR, generateFakeStockRows } from "./stock-ledger";
import { stockItemKey, type StockLedgerRow } from "../../lib/excel/stock-ledger";

export const FAKE_V04_FILES = {
  baedae: "가상_생산배대_2610_4주 (Rev. 1).xlsx",
  stockLedger: "가상_제품수불표_2026-11.xlsx",
} as const;

/** 가상 생산배대의 기간: 가상 계획(Rev 0)보다 3주 앞 */
export const FAKE_BAEDAE_SHIFT_DAYS = -21;

interface DsLike {
  periodStart: ISODate;
  dates: ISODate[];
  lines: { id: string; code: string; isPlanTarget: boolean; sortOrder: number }[];
  products: { id: string; code: string; name: string; packUnit: number }[];
  allowedMolds: { lineId: string; productId: string }[];
  rev0: { cells: PlanCell[] };
}

/** 가상 계획(Rev 0)을 3주 앞으로 옮겨 생산배대 모양으로 만든다 + 2-Stage 시트 한 장 */
export function buildFakeBaedaeSheets(ds: DsLike): FakeBaedaeSheetSpec[] {
  const pet = ds.lines.filter((l) => l.isPlanTarget).sort((a, b) => a.sortOrder - b.sortOrder);
  const nameById = new Map(ds.products.map((p) => [p.id, p.name] as const));
  const lineIndex = new Map(pet.map((l, i) => [l.id, i] as const));
  const dayIndex = new Map(ds.dates.map((d, i) => [d, i] as const));
  const startDate = addDays(ds.periodStart, FAKE_BAEDAE_SHIFT_DAYS);

  const cells: FakeBaedaePlanCell[] = [];
  const prevByLine = new Map<number, string>();
  const sorted = ds.rev0.cells
    .filter((c) => c.productId && lineIndex.has(c.lineId) && dayIndex.has(c.date))
    .slice()
    .sort((a, b) => lineIndex.get(a.lineId)! - lineIndex.get(b.lineId)! || (a.date < b.date ? -1 : 1));
  for (const c of sorted) {
    const machine = lineIndex.get(c.lineId)!;
    const productName = nameById.get(c.productId as string) ?? "";
    if (!productName) continue;
    // 제품이 바뀌는 날은 네모가 있어야 한다. 원래 교체유형이 비어 있으면 B/M 으로 둔다
    const changed = prevByLine.has(machine) && prevByLine.get(machine) !== productName;
    const changeover = c.changeoverType !== "NONE" ? c.changeoverType : changed ? "BM" : "NONE";
    cells.push({ machine, day: dayIndex.get(c.date)!, productName, changeover, qty: null });
    prevByLine.set(machine, productName);
  }
  const { texts, shapes } = planToBaedaeShapes(cells, ds.dates.length);

  const machines = pet.map((l, i) => {
    const names = ds.allowedMolds.filter((a) => a.lineId === l.id).map((a) => nameById.get(a.productId) ?? "");
    const per = Math.ceil(names.length / 3) || 1;
    return {
      label: i % 2 === 0 ? String(i + 1).padStart(2, "0") : i + 1, // 문자열·숫자 호기 번호를 섞는다
      maker: i % 3 === 0 ? "NISSEI" : "AOKI",
      model: ["1000H-60", "500LL-75", "ASB-70DPH"][i % 3],
      allowed: [0, 1, 2].map((k) => names.slice(k * per, (k + 1) * per).join(" / ")),
    };
  });
  // 메모 행, 글자 박스, HR 네모, 색 다른 네모를 조금 섞는다
  texts.push({ machine: 0, day: 0, rowOffset: 0, text: "가상 발주 - 24,300" });
  shapes.push({ kind: "rect", machine: 1, day: 3, size: "small", text: "HR" });
  shapes.push({ kind: "rect", machine: 2, day: 5, size: "small", text: "가상 TEST T3", frac: 0 });

  const stage2: FakeBaedaeSheetSpec = {
    name: "생산2_PET",
    title: "생산 2팀 - PET",
    startDate,
    machines: [
      { label: "P1", model: "(WJ-350)", layout: "middle", allowed: ["가상 프리폼 38g (32)", "가상 프리폼 49g (32)", ""] },
      { label: "S1", model: "PISCO1", layout: "middle", allowed: ["가상 2.7L", "가상 4.0L", ""] },
    ],
    texts: [
      ...Array.from({ length: 15 }, (_, d) => ({ machine: 0, rowOffset: 0, day: d, text: d % 7 === 2 || d % 7 === 3 ? 1.5 : 2 })),
      { machine: 0, rowOffset: 1, day: 0, text: "가상 프리폼 38g (32)" },
      { machine: 0, rowOffset: 1, day: 7, text: "       가상 프리폼 49g (32)" },
      { machine: 1, rowOffset: 1, day: 0, text: "가상 4.0L   25% 214,445본" },
    ],
    shapes: [
      { kind: "arrow", machine: 0, fromDay: 1, fromFrac: 0.02, toDay: 6, toFrac: 0.97 },
      { kind: "rect", machine: 0, day: 7, size: "small", widthEmu: 182_678, fill: "FF0000" },
      { kind: "arrow", machine: 0, fromDay: 8, fromFrac: 0.02, toDay: 14, toFrac: 0.97, color: "0066FF" },
      { kind: "arrow", machine: 1, fromDay: 1, fromFrac: 0.02, toDay: 3, toFrac: 0.97 },
    ],
  };

  return [{ name: "생산1_1STAGE", title: "생산 1팀 - PET 1", startDate, machines, texts, shapes }, stage2];
}

export function buildFakeStockRows(ds: DsLike): StockLedgerRow[] {
  return generateFakeStockRows(ds.products.map((p) => ({ code: p.code, name: p.name, packUnit: p.packUnit })));
}

const q = (s: string) => `'${escapeSqlString(s)}'`;

/** 재고현황 시드: 가상 수불표를 stock_* 테이블에 넣는다. 품명이 같은 제품에 자동 연결 */
export function buildV04SeedSql(ds: DsLike): string {
  const rows = buildFakeStockRows(ds);
  const ym = `${FAKE_STOCK_YEAR}-${String(FAKE_STOCK_MONTH).padStart(2, "0")}`;
  const codeByName = new Map(ds.products.map((p) => [p.name, p.code] as const));
  const out: string[] = [];
  out.push(`-- ---------- 재고현황: stock_items / stock_ledger_months / stock_ledger_days (가상 수불표 ${ym}, ${rows.length}품목) ----------`);
  out.push(`delete from stock_ledger_days; delete from stock_ledger_months; delete from stock_items;`);
  const id = (r: StockLedgerRow) => `md5(${q("stock:" + stockItemKey(r))})::uuid`;
  out.push(`insert into stock_items (id, section, process, machine_label, item_code, name, dup_index, pack_unit, units_per_pallet, product_id) values`);
  out.push(
    rows
      .map((r) => {
        const code = codeByName.get(r.name);
        const product = code ? `(select id from products where code = ${q(code)})` : "null";
        return `  (${id(r)}, ${q(r.section)}, ${q(r.process)}, ${q(r.machineLabel)}, ${r.itemCode ? q(r.itemCode) : "null"}, ${q(r.name)}, ${r.dupIndex}, ${r.packUnit ?? "null"}, ${r.unitsPerPallet ?? "null"}, ${product})`;
      })
      .join(",\n") + ";",
  );
  out.push(`insert into stock_ledger_months (item_id, year_month, opening_qty, sort_order) values`);
  out.push(rows.map((r, i) => `  (${id(r)}, ${q(ym)}, ${r.opening}, ${i})`).join(",\n") + ";");
  const days = rows.flatMap((r) => r.days.map((d) => `  (${id(r)}, ${q(`${ym}-${String(d.day).padStart(2, "0")}`)}, ${d.produced}, ${d.shipped})`));
  if (days.length) {
    out.push(`insert into stock_ledger_days (item_id, date, produced, shipped) values`);
    out.push(days.join(",\n") + ";");
  }
  out.push("");
  return out.join("\n");
}
