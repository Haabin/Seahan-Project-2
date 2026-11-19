/**
 * 가상 「제품수불표」 생성기. 실제 파일과 같은 구조(헤더 2행, 구간 소계, 맨 아래 요약·합계, 파생값 수식)로 만든다.
 * 내보내기(lib/excel/stock-ledger.ts)와 같은 코드로 표를 만들고, 실제 파일에서 본 변형을 일부러 섞는다:
 *   품명 끝 공백, 같은 구간의 같은 품명 두 번, 공정·호기가 빈 하위 행, 품번이 일부 행에만 있음, 음수 생산(보정).
 * 실제 고객 자료는 들어 있지 않다(NFR-01).
 */
import { buildStockLedgerWorkbookObject, type StockLedgerRow } from "../../lib/excel/stock-ledger";
import { workbookToBuffer } from "../../lib/excel/common";

export interface FakeStockProduct {
  code: string;
  name: string;
  packUnit: number | null;
}

export const FAKE_STOCK_YEAR = 2026;
export const FAKE_STOCK_MONTH = 11;

/** 고정 시드 난수(다시 만들어도 같은 값) */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const SECTIONS: { section: string; process: string; machines: string[] }[] = [
  { section: "PS", process: "P S", machines: ["BNP", "대림"] },
  { section: "1211", process: "1211", machines: ["형제", "S1", "S2"] },
  { section: "1219", process: "1219", machines: ["S6", "S7"] },
];

/** 가상 수불표 행. products 는 기준정보 제품(이름이 같아야 자동 매칭된다) */
export function generateFakeStockRows(products: FakeStockProduct[], filledUntilDay = 11): StockLedgerRow[] {
  const rnd = lcg(20261101);
  const rows: StockLedgerRow[] = [];
  products.forEach((p, i) => {
    const sec = SECTIONS[i % SECTIONS.length];
    const machine = sec.machines[Math.floor(i / SECTIONS.length) % sec.machines.length];
    const packUnit = p.packUnit ?? 100;
    const days: StockLedgerRow["days"] = [];
    const active = rnd() < 0.7;
    for (let d = 1; d <= filledUntilDay && active; d++) {
      const produced = rnd() < 0.45 ? Math.round(rnd() * 40) * packUnit : 0;
      const shipped = rnd() < 0.4 ? Math.round(rnd() * 30) * packUnit : 0;
      if (produced || shipped) days.push({ day: d, produced, shipped });
    }
    rows.push({
      section: sec.section,
      process: sec.process,
      machineLabel: machine,
      itemCode: i % 3 === 0 ? p.code : null,
      name: p.name,
      dupIndex: 0,
      opening: Math.round(rnd() * 400) * packUnit,
      packUnit,
      unitsPerPallet: 10 + Math.floor(rnd() * 5) * 2,
      days,
    });
  });
  // 구간 순서로 묶는다(원본은 구간이 이어져 있다)
  rows.sort((a, b) => SECTIONS.findIndex((s) => s.section === a.section) - SECTIONS.findIndex((s) => s.section === b.section));

  // 기준정보에 없는 품목(매칭 안 됨), 같은 품명 두 번, 음수 보정
  const last = rows[rows.length - 1];
  rows.push(
    { section: last.section, process: last.process, machineLabel: last.machineLabel, itemCode: null, name: "가상 소주 1.8L 35%", dupIndex: 0, opening: 0, packUnit: 6, unitsPerPallet: 60, days: [] },
    { section: last.section, process: last.process, machineLabel: last.machineLabel, itemCode: null, name: "가상 소주 1.8L 35%", dupIndex: 1, opening: 1200, packUnit: 6, unitsPerPallet: 60, days: [{ day: 3, produced: -30, shipped: 0 }] },
  );
  return rows;
}

export interface FakeStockQuirks {
  /** 품명 끝에 공백을 붙일 행(품목 순번) */
  trailingSpaceAt?: number[];
  /** 공정·호기를 비울 행(품목 순번). 윗 행 값을 이어받아야 한다 */
  blankProcessAt?: number[];
}

/** 가상 수불표 xlsx. quirks 로 원본의 지저분한 부분을 흉내 낸다 */
export async function buildFakeStockLedgerBuffer(
  rows: StockLedgerRow[],
  opts: { year?: number; month?: number; quirks?: FakeStockQuirks; sheetName?: string } = {},
): Promise<Buffer> {
  const wb = buildStockLedgerWorkbookObject({ year: opts.year ?? FAKE_STOCK_YEAR, month: opts.month ?? FAKE_STOCK_MONTH, rows });
  const ws = wb.worksheets[0];
  if (opts.sheetName) ws.name = opts.sheetName;
  const quirks = opts.quirks ?? {};
  // 품목 순번 → 시트 행 번호 (소계 행을 건너뛴다)
  const itemRows: number[] = [];
  for (let r = 3; r <= ws.rowCount; r++) {
    const a = String(ws.getCell(r, 1).value ?? "");
    if (a === "공정" || a === "합계") break;
    if (ws.getCell(r, 4).value) itemRows.push(r);
  }
  for (const i of quirks.trailingSpaceAt ?? []) {
    const r = itemRows[i];
    if (r) ws.getCell(r, 4).value = `${ws.getCell(r, 4).value}  `;
  }
  for (const i of quirks.blankProcessAt ?? []) {
    const r = itemRows[i];
    if (r) {
      ws.getCell(r, 1).value = null;
      ws.getCell(r, 2).value = null;
    }
  }
  return workbookToBuffer(wb);
}
