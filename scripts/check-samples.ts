/**
 * 실제 생산배대 파일 검증 스크립트 (로컬 전용).
 *   npx tsx scripts/check-samples.ts [파일 경로] [--full]
 * data/samples/ 의 실제 파일을 파싱해 시트·호기별로 날짜별 제품(대기 포함), 교체 개수, 경고를 표로 찍는다.
 * 결과는 화면에만 찍고 파일로 남기지 않는다. data/samples/ 는 git 에 올리지 않는다.
 * DATABASE_URL 이 있으면 products 와 대조해 매칭 안 된 제품명도 보여준다. 없으면 제품명 목록만 보여준다.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "dotenv";
import { parseBaedaeWorkbook, type BaedaeSheet } from "../lib/excel/import-baedae";
import { normalizeName } from "../lib/excel/common";

config({ path: ".env.local" });

function findSample(): string | null {
  const dir = join(process.cwd(), "data", "samples");
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((n) => /생산배대/.test(n.normalize("NFC")) && n.endsWith(".xlsx") && !n.startsWith("~$"));
  return f ? join(dir, f) : null;
}

const W = 13;
function pad(s: string, w = W): string {
  // 한글은 두 칸으로 센다
  let len = 0;
  let out = "";
  for (const ch of s) {
    const cw = /[ᄀ-ￜ]/.test(ch) ? 2 : 1;
    if (len + cw > w) break;
    out += ch;
    len += cw;
  }
  return out + " ".repeat(w - len);
}

function printSheet(s: BaedaeSheet, full: boolean) {
  console.log(`\n${"=".repeat(100)}\n시트 「${s.sheetName}」  ${s.titles.join(" / ")}`);
  console.log(`기간 ${s.dates[0]} ~ ${s.dates[s.dates.length - 1]} (${s.dates.length}일) · 호기 ${s.machines.length}`);
  console.log(
    `도형: 큰 네모(Full) ${s.stats.rectFull} · 작은 네모(B/M) ${s.stats.rectBm} · 글자 박스 ${s.stats.textBoxes} · HR ${s.stats.hrBoxes} · 테두리 없음 ${s.stats.borderless} · 가로 화살표 ${s.stats.arrows} · 무시한 선 ${s.stats.ignoredLines} · 기타 ${s.stats.ignoredOther}`,
  );
  console.log("\n날짜별 제품  (■ Full  ▪ B/M  → 화살표로 이어진 날  · 대기)");
  console.log(pad("호기", 6) + s.dates.map((d) => pad(d.slice(5))).join(""));
  for (const m of s.machines) {
    const row = s.dates.map((d) => {
      const c = s.cells.find((x) => x.lineCode === m.code && x.date === d);
      if (!c) return pad("·");
      const mark = c.changeoverType === "FULL" ? "■" : c.changeoverType === "BM" ? "▪" : "";
      return pad(mark + (c.source === "arrow" ? "→" : "") + c.productName);
    });
    console.log(pad(m.code, 6) + row.join(""));
  }

  console.log("\n호기별 요약");
  console.log(pad("호기", 6) + pad("행", 8) + pad("생산일", 7) + pad("Full", 5) + pad("B/M", 5) + "제품 (일수)");
  for (const m of s.machines) {
    const cells = s.cells.filter((c) => c.lineCode === m.code);
    const cos = s.changeovers.filter((c) => c.lineCode === m.code);
    const byProduct = new Map<string, number>();
    for (const c of cells) byProduct.set(c.productName, (byProduct.get(c.productName) ?? 0) + 1);
    console.log(
      pad(m.code, 6) +
        pad(`${m.startRow}-${m.endRow}`, 8) +
        pad(String(cells.length), 7) +
        pad(String(cos.filter((c) => c.type === "FULL").length), 5) +
        pad(String(cos.filter((c) => c.type === "BM").length), 5) +
        Array.from(byProduct, ([n, d]) => `${n}(${d})`).join(", "),
    );
  }

  const qty = s.cells.filter((c) => c.qty !== null);
  if (qty.length) {
    console.log("\n수량(본)이 적힌 칸");
    for (const c of qty) console.log(`  ${c.lineCode} ${c.date} ${c.productName}: ${c.qty?.toLocaleString("ko-KR")}`);
  }
  if (s.resinUsage.length) {
    console.log("\n설비별 일일 원료 소비량(톤)");
    const codes = Array.from(new Set(s.resinUsage.map((u) => u.lineCode)));
    console.log(pad("설비", 6) + s.dates.map((d) => pad(d.slice(5), 6)).join("") + " 합계");
    for (const code of codes) {
      const vals = s.dates.map((d) => s.resinUsage.find((u) => u.lineCode === code && u.date === d)?.ton);
      console.log(pad(code, 6) + vals.map((v) => pad(v === undefined ? "·" : String(v), 6)).join("") + " " + Math.round(vals.reduce<number>((a, v) => a + (v ?? 0), 0) * 10) / 10);
    }
    if (s.resinTotals.length) console.log(pad("합계행", 6) + s.dates.map((d) => pad(String(s.resinTotals.find((t) => t.date === d)?.ton ?? "·"), 6)).join(""));
  }

  const warns = s.warnings.filter((w) => w.level === "warn");
  const infos = s.warnings.filter((w) => w.level === "info");
  console.log(`\n경고 ${warns.length}건 · 참고 ${infos.length}건`);
  for (const w of warns) console.log(`  [경고] ${w.lineCode ?? "-"} ${w.date ?? ""} ${w.message}`);
  for (const w of full ? infos : infos.slice(0, 12)) console.log(`  [참고] ${w.lineCode ?? "-"} ${w.date ?? ""} ${w.message}`);
  if (!full && infos.length > 12) console.log(`  … 참고 ${infos.length - 12}건 더 (--full 로 전부 보기)`);
}

async function loadProductNames(): Promise<Set<string> | null> {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  try {
    const postgres = (await import("postgres")).default;
    const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
    const rows = await sql<{ name: string }[]>`select name from products`;
    await sql.end();
    return new Set(rows.map((r) => normalizeName(r.name)));
  } catch (e) {
    console.log(`(products 조회 실패: ${e instanceof Error ? e.message : String(e)})`);
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const full = args.includes("--full");
  const path = args.find((a) => !a.startsWith("--")) ?? findSample();
  if (!path || !existsSync(path)) {
    console.error("data/samples/ 에서 생산배대 파일을 찾지 못했습니다. 경로를 인자로 주세요.");
    process.exit(1);
  }
  const result = await parseBaedaeWorkbook(readFileSync(path), { filename: basename(path) });
  console.log(`파일: ${basename(path)}`);
  console.log(`Rev(파일 이름): ${result.revNo ?? "찾지 못함"} · 기간 ${result.periodStart} ~ ${result.periodEnd}`);
  console.log(`읽은 시트: ${result.sheets.map((s) => s.sheetName).join(", ")} · 건너뛴 시트: ${result.skippedSheets.join(", ") || "-"}`);
  console.log(
    `네모 폭(EMU): ${result.rectWidths.map((w) => `${w.widthEmu.toLocaleString("ko-KR")}×${w.count}`).join(", ")} → 기준 ${result.rectThresholdEmu?.toLocaleString("ko-KR")} (${result.rectThresholdBasis === "gap" ? "가장 큰 간격" : "절대 기준"}) 이상이면 Full`,
  );
  for (const s of result.sheets) {
    if (s.stats.rectFull === 0 && s.stats.rectBm > 0) console.log(`  ※ 「${s.sheetName}」 네모 ${s.stats.rectBm}개는 워크북 전체 기준으로 모두 작은 네모(B/M)입니다`);
  }
  for (const w of result.warnings) console.log(`[${w.level === "warn" ? "경고" : "참고"}] ${w.message}`);
  for (const s of result.sheets) printSheet(s, full);

  // 제품명 매칭
  const names = new Map<string, number>();
  for (const s of result.sheets) for (const c of s.cells) names.set(c.productName, (names.get(c.productName) ?? 0) + 1);
  const known = await loadProductNames();
  console.log(`\n${"=".repeat(100)}`);
  if (known) {
    const unmatched = Array.from(names).filter(([n]) => !known.has(normalizeName(n)));
    console.log(`제품명 ${names.size}종 중 기준정보(products)와 매칭 안 된 것 ${unmatched.length}종`);
    for (const [n, d] of unmatched) console.log(`  ${n}  (${d}일)`);
  } else {
    console.log(`DATABASE_URL 이 없어 기준정보와 대조하지 못했습니다. 읽은 제품명 ${names.size}종 (모두 매칭 화면 대상):`);
    for (const [n, d] of Array.from(names).sort((a, b) => a[0].localeCompare(b[0], "ko"))) console.log(`  ${n}  (${d}일)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
