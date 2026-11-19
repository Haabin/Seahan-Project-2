/**
 * 실제 자료를 DB 에 넣는 스크립트 (로컬 전용, 고객 허락을 받은 DB 에만 쓴다).
 *   npx tsx scripts/load-real-data.ts          → 무엇이 들어갈지 요약만 보여준다(쓰지 않음)
 *   npx tsx scripts/load-real-data.ts --yes    → 가상 기준정보·계획을 지우고 실제 자료로 채운다
 *
 * 읽는 파일 (data/samples/, git 에 올리지 않는다)
 *   - 제품 및 설비 정보.xlsx  시트 '1. P1-1stage' : 호기별 제품, 포장 수량, 프리폼 중량(INJ), 캐비티(CAV), 일일 Capa
 *   - 26년 10월 5주간 생산배대 (Rev. 1).xlsx     : 과거 계획(확정 Rev), 호기별 생산 제품
 *   - 재고현황_제품수불표 예시.xlsx               : 재고현황(연도는 --year 로, 기본 2026)
 *
 * 만드는 것
 *   - products / molds / mold_products / line_allowed_molds / line_product_capacity (PET 1~18호기)
 *       · 금형 = 운용안에서 INJ·CAV 칸이 병합된 제품 묶음(같은 프리폼·캐비티를 쓰는 제품들)
 *       · 생산배대에만 있는 이름(금형 단위 이름 등)은 같은 호기의 비슷한 제품과 같은 금형·Capa 로 등록한다
 *   - plans / plan_revisions(confirmed) / plan_cells : 생산배대의 1-Stage 계획
 *   - 이번 주 계획(빈 초안), stock_* (제품수불표), line_resin_usage(원료 소비량)
 * 지우는 것: 기존 제품·금형·계획·주문·출고계획·재고 스냅샷·수불표·월 운용안 (호기, 설정, 교체 계수, 사일로, 계정은 그대로)
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { config } from "dotenv";
import postgres from "postgres";
import ExcelJS from "exceljs";
import { parseBaedaeWorkbook } from "../lib/excel/import-baedae";
import { parseStockLedgerWorkbook } from "../lib/excel/stock-ledger";
import { cellText, compactName, rawValue } from "../lib/excel/common";
import { addDays, thisWeekThursday } from "../lib/engine/calendar";

config({ path: ".env.local" });

const DIR = join(process.cwd(), "data", "samples");
const find = (re: RegExp) => {
  const f = readdirSync(DIR).find((n) => re.test(n.normalize("NFC")) && n.endsWith(".xlsx") && !n.startsWith("~$"));
  if (!f) throw new Error(`data/samples 에서 ${re} 파일을 찾지 못했습니다`);
  return join(DIR, f);
};
const norm = (s: string) => compactName(s.replace(/^#\s*/, ""));
const clean = (s: string) => s.normalize("NFC").replace(/^#\s*/, "").replace(/\s+/g, " ").trim();
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

interface MasterProduct {
  name: string;
  lineCode: string;
  capa: number;
  cavity: number | null;
  packUnit: number | null;
  weightG: number;
  moldKey: string;
  category: string;
}

/** 운용안 '1. P1-1stage' 시트 → 호기별 제품 */
async function readMaster(path: string): Promise<MasterProduct[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.worksheets.find((w) => /1-?stage/i.test(w.name)) ?? wb.worksheets[0];
  const out: MasterProduct[] = [];
  let line = 0;
  for (let r = 7; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const b = cellText(row.getCell(2)).trim();
    const name = cellText(row.getCell(5)).trim();
    if (/합계/.test(cellText(row.getCell(1))) || /합계/.test(b)) break;
    if (b === "소계" || name === "소계") continue;
    if (/^\d{1,2}$/.test(b)) line = Number(b);
    if (!name || !line) continue;
    const capa = num(rawValue(row.getCell(12)));
    if (capa === null || capa <= 0) continue;
    const jCell = row.getCell(10);
    const master = (jCell as unknown as { master?: ExcelJS.Cell }).master ?? jCell;
    out.push({
      name: clean(name),
      lineCode: `PET${line}`,
      capa: Math.round(capa), // 열 제목은 '천본/일' 이지만 값은 본/일이다(일사용량·가동일수 계산으로 확인)
      cavity: num(rawValue(row.getCell(11))),
      packUnit: num(rawValue(row.getCell(6))),
      weightG: num(rawValue(jCell)) ?? 0,
      moldKey: `PET${line}|${master.address}`,
      category: cellText(row.getCell(4)).trim(),
    });
  }
  return out;
}

async function main() {
  const apply = process.argv.includes("--yes");
  const yearArg = process.argv.find((a) => a.startsWith("--year="));
  const stockYear = yearArg ? Number(yearArg.split("=")[1]) : 2026;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL 이 .env.local 에 없습니다");

  const baedaePath = find(/생산배대/);
  const master = await readMaster(find(/제품 및 설비|운용안/));
  const baedae = await parseBaedaeWorkbook(readFileSync(baedaePath), { filename: baedaePath.split(/[\\/]/).pop() });
  const stockPath = find(/수불/);
  const stock = await parseStockLedgerWorkbook(readFileSync(stockPath), { filename: stockPath.split(/[\\/]/).pop() });
  const stage1 = baedae.sheets.find((s) => s.machines.some((m) => m.code === "PET1"));
  if (!stage1 || !baedae.periodStart) throw new Error("생산배대에서 1-Stage 시트를 찾지 못했습니다");

  // ---------- 제품·금형 ----------
  interface Prod { id: string; code: string; name: string; cavity: number | null; packUnit: number | null; weightG: number; capaByLine: Map<string, number>; moldKeys: Set<string>; source: string }
  const products = new Map<string, Prod>(); // norm(name) → 제품
  const moldNames = new Map<string, string[]>();
  let seq = 0;
  const addProduct = (name: string, source: string): Prod => {
    const k = norm(name);
    let p = products.get(k);
    if (!p) {
      p = { id: randomUUID(), code: `P${String(++seq).padStart(4, "0")}`, name, cavity: null, packUnit: null, weightG: 0, capaByLine: new Map(), moldKeys: new Set(), source };
      products.set(k, p);
    }
    return p;
  };
  for (const m of master) {
    const p = addProduct(m.name, "운용안");
    p.cavity ??= m.cavity;
    p.packUnit ??= m.packUnit;
    if (!p.weightG) p.weightG = m.weightG;
    p.capaByLine.set(m.lineCode, m.capa);
    p.moldKeys.add(m.moldKey);
    moldNames.set(m.moldKey, [...(moldNames.get(m.moldKey) ?? []), m.name]);
  }
  const masterCount = products.size;

  // 생산배대 제품명 → 제품. 같은 이름 → 같은 호기의 접두 일치(금형 단위 이름) → 새 제품
  const byLine = new Map<string, MasterProduct[]>();
  for (const m of master) byLine.set(m.lineCode, [...(byLine.get(m.lineCode) ?? []), m]);
  const median = (xs: number[]) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
  const matchNote = new Map<string, string>();
  const cellProduct = new Map<string, Prod>(); // "호기|원문 이름" → 제품
  let exact = 0;
  let viaSibling = 0;
  let brandNew = 0;
  for (const c of stage1.cells) {
    const ck = `${c.lineCode}|${c.productName}`;
    if (cellProduct.has(ck)) continue;
    const k = norm(c.productName);
    const existing = products.get(k);
    if (existing) {
      if (!existing.capaByLine.has(c.lineCode)) {
        const sibs = byLine.get(c.lineCode) ?? [];
        existing.capaByLine.set(c.lineCode, existing.capaByLine.values().next().value ?? median(sibs.map((s) => s.capa)));
      }
      cellProduct.set(ck, existing);
      if (existing.source === "운용안") exact++;
      continue;
    }
    const sibs = (byLine.get(c.lineCode) ?? []).filter((s) => norm(s.name).startsWith(k) || k.startsWith(norm(s.name)));
    const p = addProduct(clean(c.productName), "생산배대");
    if (sibs.length) {
      viaSibling++;
      p.cavity = sibs[0].cavity;
      p.packUnit = sibs[0].packUnit;
      p.weightG = sibs[0].weightG;
      p.capaByLine.set(c.lineCode, median(sibs.map((s) => s.capa)));
      for (const s of sibs) p.moldKeys.add(s.moldKey);
      matchNote.set(p.name, `같은 호기의 "${sibs[0].name}"${sibs.length > 1 ? ` 외 ${sibs.length - 1}개` : ""}와 같은 금형·Capa`);
    } else {
      brandNew++;
      const lineCapas = (byLine.get(c.lineCode) ?? []).map((s) => s.capa);
      p.capaByLine.set(c.lineCode, median(lineCapas));
      p.moldKeys.add(`own|${p.id}`);
      moldNames.set(`own|${p.id}`, [p.name]);
      matchNote.set(p.name, lineCapas.length ? `운용안에 없음 → ${c.lineCode} 제품들의 Capa 중앙값(${median(lineCapas).toLocaleString("ko-KR")})을 임시로 넣음` : "운용안에 없음 · Capa 없음");
    }
    cellProduct.set(ck, p);
  }

  // 금형: 묶음마다 하나. 이름은 묶음 제품명의 공통 앞부분
  const molds = new Map<string, { id: string; moldNo: string; name: string; cavity: number | null }>();
  const commonPrefix = (names: string[]) => {
    if (names.length === 1) return names[0];
    let p = names[0];
    for (const n of names) while (p && !n.startsWith(p)) p = p.slice(0, -1);
    p = p.replace(/[\s\-_.(]+$/, "").trim();
    return p.length >= 3 ? p : names[0];
  };
  let moldSeq = 0;
  for (const [key, names] of moldNames) {
    const line = key.startsWith("own|") ? "X" : key.split("|")[0].replace("PET", "");
    const cav = master.find((m) => m.moldKey === key)?.cavity ?? null;
    // 금형 이름: 묶음이 한 제품이면 그 이름, 여러 제품이면 "공통 이름 (프리폼 중량 · 캐비티 · 제품 수)"
    const uniq = Array.from(new Set(names));
    const m0 = master.find((m) => m.moldKey === key);
    const spec = m0 ? [m0.weightG ? `${m0.weightG}g` : "", cav ? `${cav}캐비티` : ""].filter(Boolean).join(" · ") : "";
    const prefix = commonPrefix(uniq);
    const name = uniq.length === 1 ? uniq[0] : `${prefix === uniq[0] ? (m0?.category || "공용") : prefix} (${[spec, `${uniq.length}종 공용`].filter(Boolean).join(" · ")})`;
    molds.set(key, { id: randomUUID(), moldNo: `M${line.padStart(2, "0")}-${String(++moldSeq).padStart(3, "0")}`, name, cavity: cav });
  }

  // ---------- 요약 ----------
  const planCells = stage1.cells.filter((c) => c.date >= baedae.periodStart! && c.date <= addDays(baedae.periodStart!, 14));
  const thisThursday = thisWeekThursday(new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10));
  const stockLinked = stock.rows.filter((r) => products.has(norm(r.name))).length;
  const resin = baedae.sheets.flatMap((s) => s.resinUsage);
  console.log(`운용안: 제품 ${masterCount}종 (호기×제품 ${master.length}행), 금형 묶음 ${new Set(master.map((m) => m.moldKey)).size}개`);
  console.log(`생산배대: ${baedae.periodStart} ~ ${baedae.periodEnd}, Rev ${baedae.revNo}, 1-Stage 생산 칸 ${planCells.length}개, 제품명 ${cellProduct.size}종`);
  console.log(`  제품명 매칭: 운용안과 같은 이름 ${exact} · 비슷한 제품의 금형·Capa 로 등록 ${viaSibling} · 운용안에 없어 새로 등록 ${brandNew}`);
  for (const [name, note] of matchNote) console.log(`    - ${name}: ${note}`);
  console.log(`수불표: ${stockYear}년 ${stock.month}월, 품목 ${stock.rows.length}개 (계획 제품과 이름이 같아 연결되는 품목 ${stockLinked}개)`);
  console.log(`원료 소비량: ${resin.length}건 · 이번 주 계획 시작일: ${thisThursday}`);
  console.log(`→ 제품 ${products.size}종, 금형 ${molds.size}개를 넣습니다.`);
  if (!apply) {
    console.log("\n(요약만 보여줬습니다. 실제로 넣으려면 --yes 를 붙이세요. 기존 가상 제품·계획·주문·재고는 지워집니다)");
    return;
  }

  // ---------- 쓰기 ----------
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      const lines = await tx<{ id: string; code: string }[]>`select id, code from lines`;
      const lineId = new Map(lines.map((l) => [l.code, l.id] as const));
      const [{ id: factoryId }] = await tx<{ id: string }[]>`select id from factories where code = 'F1'`;

      // 지우기 (확정 Rev 불변 트리거는 잠깐 끈다)
      await tx`alter table plan_cells disable trigger plan_cells_immutable`;
      await tx`alter table plan_revisions disable trigger plan_revisions_immutable`;
      await tx`delete from plans`;
      await tx`alter table plan_revisions enable trigger plan_revisions_immutable`;
      await tx`alter table plan_cells enable trigger plan_cells_immutable`;
      await tx`delete from orders`;
      await tx`delete from shipments`;
      await tx`delete from inventory_snapshots`;
      await tx`delete from monthly_operation_plan`;
      await tx`delete from stock_ledger_days`;
      await tx`delete from stock_ledger_months`;
      await tx`delete from stock_items`;
      await tx`delete from line_resin_usage`;
      await tx`delete from downtimes`;
      await tx`delete from mold_products`;
      await tx`delete from molds`;
      await tx`delete from line_allowed_molds`;
      await tx`delete from line_product_capacity`;
      await tx`delete from products`;

      const plist = Array.from(products.values());
      for (const p of plist) {
        const capas = Array.from(p.capaByLine.values());
        await tx`insert into products (id, code, name, cavity, pack_unit, preform_weight_g, default_daily_capa, unit)
                 values (${p.id}, ${p.code}, ${p.name}, ${p.cavity === null ? null : Math.round(p.cavity)}, ${p.packUnit === null ? null : Math.round(p.packUnit)}, ${p.weightG}, ${capas.length ? Math.max(...capas) : 0}, 'EA')`;
        for (const [code, capa] of p.capaByLine) {
          const lid = lineId.get(code);
          if (!lid) continue;
          await tx`insert into line_allowed_molds (line_id, product_id) values (${lid}, ${p.id}) on conflict do nothing`;
          if (capa > 0) await tx`insert into line_product_capacity (line_id, product_id, daily_capa) values (${lid}, ${p.id}, ${capa}) on conflict do nothing`;
        }
      }
      for (const m of molds.values()) await tx`insert into molds (id, mold_no, name, cavity) values (${m.id}, ${m.moldNo}, ${m.name}, ${m.cavity === null ? null : Math.round(m.cavity)})`;
      for (const p of plist) for (const k of p.moldKeys) await tx`insert into mold_products (mold_id, product_id) values (${molds.get(k)!.id}, ${p.id}) on conflict do nothing`;

      // 과거 계획: 생산배대 → 확정 Rev
      const periodStart = baedae.periodStart!;
      const [{ id: planId }] = await tx<{ id: string }[]>`insert into plans (factory_id, process_tab, period_start, period_end) values (${factoryId}, '1STAGE', ${periodStart}, ${addDays(periodStart, 14)}) returning id`;
      const [{ id: revId }] = await tx<{ id: string }[]>`insert into plan_revisions (plan_id, status, source) values (${planId}, 'draft', ${"생산배대: " + baedaePath.split(/[\\/]/).pop()}) returning id`;
      const file = baedaePath.split(/[\\/]/).pop() ?? "";
      for (const c of planCells) {
        const p = cellProduct.get(`${c.lineCode}|${c.productName}`)!;
        const lid = lineId.get(c.lineCode);
        if (!lid) continue;
        // 금형 후보가 여럿이면 그 호기의 금형을 쓴다(같은 제품을 호기마다 다른 금형으로 생산하는 경우)
        const pm = Array.from(p.moldKeys);
        const own = pm.filter((k) => k.startsWith(`${c.lineCode}|`));
        const moldId = pm.length === 1 ? molds.get(pm[0])!.id : own.length === 1 ? molds.get(own[0])!.id : null;
        const basis = `가져오기: ${file}${c.source === "arrow" ? " · 화살표 구간" : ""}${c.changeoverColor ? ` · 네모 색 ${c.changeoverColor}` : ""}`.slice(0, 300);
        await tx`insert into plan_cells (revision_id, line_id, date, product_id, qty, changeover_type, memo, mold_id, origin, basis)
                 values (${revId}, ${lid}, ${c.date}, ${p.id}, ${c.qty}, ${c.changeoverType}, ${c.memo}, ${moldId}, 'imported', ${basis})`;
      }
      const revNo = baedae.revNo ?? 0;
      await tx`update plan_revisions set status = 'confirmed', rev_no = ${revNo}, reason_category = ${revNo > 0 ? "기타" : null}, reason_text = ${revNo > 0 ? "엑셀 가져오기: " + file : null}, confirmed_at = now() where id = ${revId}`;

      // 이번 주 계획(빈 초안)
      if (thisThursday !== periodStart) {
        const [{ id: curPlan }] = await tx<{ id: string }[]>`insert into plans (factory_id, process_tab, period_start, period_end) values (${factoryId}, '1STAGE', ${thisThursday}, ${addDays(thisThursday, 14)}) returning id`;
        await tx`insert into plan_revisions (plan_id, status) values (${curPlan}, 'draft')`;
      }

      // 원료 소비량
      for (const u of resin) {
        const lid = lineId.get(u.lineCode);
        if (lid) await tx`insert into line_resin_usage (line_id, date, ton) values (${lid}, ${u.date}, ${u.ton}) on conflict (line_id, date) do update set ton = excluded.ton`;
      }

      // 수불표
      const ym = `${stockYear}-${String(stock.month ?? 11).padStart(2, "0")}`;
      let i = 0;
      for (const r of stock.rows) {
        const id = createHash("md5").update(`stock:${r.section}|${r.process}|${r.machineLabel}|${r.name}|${r.dupIndex}`).digest("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
        const productId = products.get(norm(r.name))?.id ?? null;
        await tx`insert into stock_items (id, section, process, machine_label, item_code, name, dup_index, pack_unit, units_per_pallet, product_id)
                 values (${id}, ${r.section}, ${r.process}, ${r.machineLabel}, ${r.itemCode}, ${r.name}, ${r.dupIndex}, ${r.packUnit}, ${r.unitsPerPallet}, ${productId})`;
        await tx`insert into stock_ledger_months (item_id, year_month, opening_qty, sort_order) values (${id}, ${ym}, ${Math.round(r.opening)}, ${i++})`;
        for (const d of r.days) {
          await tx`insert into stock_ledger_days (item_id, date, produced, shipped) values (${id}, ${`${ym}-${String(d.day).padStart(2, "0")}`}, ${Math.round(d.produced)}, ${Math.round(d.shipped)})`;
        }
      }
      await tx`select sync_inventory_from_ledger(${ym})`;
    });
    const [c] = await sql`select (select count(*) from products)::int products, (select count(*) from molds)::int molds, (select count(*) from plan_cells)::int cells, (select count(*) from stock_items)::int stock, (select count(*) from line_product_capacity)::int capa`;
    console.log(`\n완료: 제품 ${c.products} · 금형 ${c.molds} · 호기×제품 Capa ${c.capa} · 계획 셀 ${c.cells} · 수불 품목 ${c.stock}`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
