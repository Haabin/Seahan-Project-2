/**
 * 현행 "제품배치 운용안" 원본 양식 → 개발 DB 가져오기 (미리보기 → 승인 → 쓰기)
 *
 *   미리보기 (DB 읽기만, 쓰기 없음):
 *     npm run import:operation-plan -- <운용안.xlsx> [--sheet <시트명>] [--rules <설비규칙.json>]
 *     → data/samples/import-preview/<previewId>.json 저장 (gitignore 대상, 실제 값 백업 겸용)
 *
 *   쓰기 (미리보기 JSON 그대로 적용):
 *     npm run import:operation-plan -- --apply data/samples/import-preview/<previewId>.json [--allow-delete-confirmed]
 *     → 파일 내용 해시가 previewId 와 같을 때만 실행. 한 트랜잭션.
 *     → 지울 계획에 확정 Rev 가 있으면 --allow-delete-confirmed 없이는 멈춘다 (개발 DB 전용, 운영 DB 금지).
 *
 * 쓰기 내용:
 *   1) products upsert (code = 제품명 해시) · 2) 파일에 있는 호기의 허용 금형·호기별 Capa 교체
 *   3) line_specs 제조사·모델·메모 (같은 호기의 가상 상세값은 비움) · 4) settings.master_source = "real"
 *   5) uploads 기록 · 6) 1STAGE(F1) 기존 계획 삭제(확정 Rev 트리거는 삭제 구간에서만 끔) · 7) 데모 계획(초안) 생성
 * 손대지 않음: 가상 제품·출고·재고·월별 운용 물량·다운타임·씨벌크 데이터.
 *
 * 실제 설비 제조사 규칙은 코드에 두지 않는다. 기본 위치: data/samples/equipment-rules.json
 *   { "prefixes": { "<접두어>": "<제조사>" }, "aliases": { "<모델 원문>": { "maker": "...", "model": "..." } } }
 */
import { config } from "dotenv";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import postgres from "postgres";
import { buildDemoPlanCells } from "../lib/data/demo-plan";
import { addDays, dateRange } from "../lib/excel/common";
import { BUNDLE_NOTE, parseOperationPlanWorkbook, type EquipmentRules, type OperationPlanResult } from "../lib/excel/import-operation-plan";
import { thisWeekThursday } from "../lib/engine/calendar";

config({ path: ".env.local", override: false });

const ROOT = process.cwd();
const PREVIEW_DIR = join(ROOT, "data", "samples", "import-preview");
const DEFAULT_RULES = join(ROOT, "data", "samples", "equipment-rules.json");
const FACTORY = "F1";
const PROCESS_TAB = "1STAGE";
const PERIOD_DAYS = 15;

interface PreviewPayload {
  version: 1;
  source: { file: string; sha256: string; sheet: string | null };
  parsed: Pick<OperationPlanResult, "headerRows" | "capaHeader" | "rows" | "products" | "lineSpecs" | "skipped" | "warnings">;
  demoPeriodStart: string;
}

interface PreviewFile extends PreviewPayload {
  previewId: string;
}

function previewIdOf(payload: PreviewPayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 12);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function todaySeoul(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date());
}

function sqlClient() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL 이 .env.local 에 없습니다.");
    process.exit(1);
  }
  return postgres(url, { max: 1, prepare: false, onnotice: () => {} });
}

type Sql = ReturnType<typeof postgres>;

// ---------------------------------------------------------------------------
// DB 현황 (읽기만)
// ---------------------------------------------------------------------------
async function inspectDb(sql: Sql, p: PreviewPayload) {
  const lineCodes = p.parsed.lineSpecs.map((l) => l.lineCode);
  const codes = p.parsed.products.map((x) => x.code);
  const names = p.parsed.products.map((x) => x.name.toLowerCase());

  const lines = await sql<{ id: string; code: string; is_plan_target: boolean }[]>`
    select id, code, is_plan_target from lines where code in ${sql(lineCodes)}`;
  const sameCode = await sql<{ code: string }[]>`select code from products where code in ${sql(codes)}`;
  // 이름이 같은데(공백·대소문자 무시) 코드가 다른 기존 제품 → products.name unique 충돌
  const nameClash = await sql<{ code: string; name: string }[]>`
    select code, name from products
    where lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) in ${sql(names)} and code not in ${sql(codes)}`;
  const lineIds = lines.map((l) => l.id);
  const [molds] = await sql<{ n: number }[]>`select count(*)::int n from line_allowed_molds where line_id in ${sql(lineIds.length ? lineIds : ["00000000-0000-0000-0000-000000000000"])}`;
  const [caps] = await sql<{ n: number }[]>`select count(*)::int n from line_product_capacity where line_id in ${sql(lineIds.length ? lineIds : ["00000000-0000-0000-0000-000000000000"])}`;
  const [specs] = await sql<{ n: number }[]>`select count(*)::int n from line_specs where line_id in ${sql(lineIds.length ? lineIds : ["00000000-0000-0000-0000-000000000000"])}`;
  const [monthly] = await sql<{ n: number }[]>`select count(*)::int n from monthly_operation_plan where line_id in ${sql(lineIds.length ? lineIds : ["00000000-0000-0000-0000-000000000000"])}`;
  const plans = await sql<{ id: string; period_start: string; confirmed: number; draft: number; cells: number }[]>`
    select p.id, p.period_start::text,
      (select count(*)::int from plan_revisions r where r.plan_id = p.id and r.status = 'confirmed') confirmed,
      (select count(*)::int from plan_revisions r where r.plan_id = p.id and r.status = 'draft') draft,
      (select count(*)::int from plan_cells c join plan_revisions r on r.id = c.revision_id where r.plan_id = p.id) cells
    from plans p join factories f on f.id = p.factory_id
    where f.code = ${FACTORY} and p.process_tab = ${PROCESS_TAB} order by p.period_start`;
  const [marker] = await sql<{ value: unknown }[]>`select value from settings where key = 'master_source'`;
  return { lines, sameCode, nameClash, molds: molds.n, caps: caps.n, specs: specs.n, monthly: monthly.n, plans, marker: marker?.value ?? null };
}

function printSummary(p: PreviewFile, db: Awaited<ReturnType<typeof inspectDb>>, mode: "preview" | "apply" = "preview") {
  const { parsed } = p;
  const missingLines = parsed.lineSpecs.map((l) => l.lineCode).filter((c) => !db.lines.some((l) => l.code === c));
  const bundles = parsed.products.filter((x) => x.bundle).length;
  const fractional = parsed.rows.filter((r) => r.dailyCapaRaw !== null && !Number.isInteger(r.dailyCapaRaw)).length;
  const demoLines = db.lines.filter((l) => l.is_plan_target).length;

  console.log(mode === "preview" ? `\n=== 미리보기 ${p.previewId} (DB 쓰기 없음) ===` : `\n=== 쓰기 ${p.previewId} · 아래 내용을 DB 에 씁니다 ===`);
  console.log(`원본: ${p.source.file} · 시트 '${p.source.sheet}' · 헤더 행 ${parsed.headerRows.join(",")} · Capa 헤더 '${parsed.capaHeader}' → 본/일(EA)로 저장`);
  console.log(`데이터 행 ${parsed.rows.length} · 건너뜀 소계 ${parsed.skipped.subtotal} / 합계 ${parsed.skipped.total} / 빈 행 ${parsed.skipped.blank}`);
  console.log(`제품 ${parsed.products.length} (신규 ${parsed.products.length - db.sameCode.length} · 기존 코드 갱신 ${db.sameCode.length}) · 묶음 표기 ${bundles} · Capa 내림 ${fractional}행`);
  console.log(`\n호기별 요약`);
  for (const spec of parsed.lineSpecs) {
    const n = parsed.rows.filter((r) => r.lineCode === spec.lineCode).length;
    console.log(`  ${spec.lineCode.padEnd(6)} 제품 ${String(n).padStart(2)} · 제조사 ${spec.maker ?? "(규칙 없음)"} · 모델 ${spec.model ?? "-"}`);
  }
  console.log(`\nDB 변경 예정`);
  console.log(`  products            upsert ${parsed.products.length} (가상 제품은 그대로 둠)`);
  console.log(`  line_allowed_molds  ${parsed.lineSpecs.length}개 호기 기존 ${db.molds}건 삭제 → ${parsed.rows.length}건`);
  console.log(`  line_product_capacity 기존 ${db.caps}건 삭제 → ${parsed.rows.filter((r) => r.dailyCapa !== null).length}건`);
  console.log(`  line_specs          ${parsed.lineSpecs.length}건 upsert (기존 ${db.specs}건의 가상 도입일·도입처·취출·H/R·캐비티·B열 원문은 비움)`);
  console.log(`  settings            master_source = "real" (현재 ${JSON.stringify(db.marker)})`);
  console.log(`  uploads             kind=master 1건 (경고 ${parsed.warnings.length + bundles}건 기록)`);
  console.log(`  plans (${FACTORY}·${PROCESS_TAB}) 삭제 ${db.plans.length}건:`);
  for (const pl of db.plans) console.log(`    ${pl.period_start} · 확정 Rev ${pl.confirmed} · 초안 ${pl.draft} · 셀 ${pl.cells}`);
  const confirmed = db.plans.reduce((n, pl) => n + pl.confirmed, 0);
  if (confirmed > 0) {
    console.log(`    ⚠ 확정 Rev ${confirmed}건: NFR-09 트리거가 삭제를 막습니다.`);
    console.log(`      --apply 에 --allow-delete-confirmed 를 붙여야 삭제 구간에서만 트리거를 끄고 지웁니다 (개발 DB 전용, 운영 DB 금지).`);
  }
  console.log(`  데모 계획           ${p.demoPeriodStart} ~ ${addDays(p.demoPeriodStart, PERIOD_DAYS - 1)} 초안 1건 · 계획 대상 호기 ${demoLines}개 · 셀 약 ${demoLines * PERIOD_DAYS}`);
  console.log(`  그대로 둠           월별 운용 물량 ${db.monthly}건(가상 제품 기준), 가상 제품·출고·재고·다운타임·씨벌크`);

  const problems: string[] = [];
  if (missingLines.length) problems.push(`DB 에 없는 호기: ${missingLines.join(", ")}`);
  if (db.nameClash.length) problems.push(`이름이 같고 코드가 다른 기존 제품 ${db.nameClash.length}건 (products.name unique 충돌)`);
  if (problems.length) {
    console.log(`\n✖ 쓰기 불가`);
    problems.forEach((x) => console.log(`  - ${x}`));
  }
  if (parsed.warnings.length) {
    console.log(`\n경고 ${parsed.warnings.length}건`);
    parsed.warnings.forEach((w) => console.log(`  - ${w}`));
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 미리보기
// ---------------------------------------------------------------------------
async function preview(file: string) {
  const buf = readFileSync(file);
  const rulesPath = arg("--rules") ?? DEFAULT_RULES;
  const rules: EquipmentRules = existsSync(rulesPath) ? JSON.parse(readFileSync(rulesPath, "utf8")) : {};
  if (!existsSync(rulesPath)) console.warn(`설비 규칙 파일이 없습니다 (${rulesPath}). 제조사는 비워 둡니다.`);
  const parsed = await parseOperationPlanWorkbook(buf, { sheetName: arg("--sheet"), equipment: rules });
  if (parsed.rows.length === 0) {
    console.error(parsed.warnings.join("\n") || "읽은 행이 없습니다.");
    process.exit(1);
  }
  const payload: PreviewPayload = {
    version: 1,
    source: { file: basename(file), sha256: createHash("sha256").update(buf).digest("hex"), sheet: parsed.sheetName },
    parsed: {
      headerRows: parsed.headerRows,
      capaHeader: parsed.capaHeader,
      rows: parsed.rows,
      products: parsed.products,
      lineSpecs: parsed.lineSpecs,
      skipped: parsed.skipped,
      warnings: parsed.warnings,
    },
    demoPeriodStart: thisWeekThursday(todaySeoul()),
  };
  const out: PreviewFile = { previewId: previewIdOf(payload), ...payload };
  mkdirSync(PREVIEW_DIR, { recursive: true });
  const outPath = join(PREVIEW_DIR, `${out.previewId}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");

  const sql = sqlClient();
  try {
    const db = await inspectDb(sql, out);
    const problems = printSummary(out, db);
    console.log(`\n미리보기 저장: ${outPath}`);
    if (!problems.length) console.log(`승인 후 쓰기: npm run import:operation-plan -- --apply ${join("data", "samples", "import-preview", `${out.previewId}.json`)}`);
  } finally {
    await sql.end();
  }
}

// ---------------------------------------------------------------------------
// 쓰기
// ---------------------------------------------------------------------------
async function apply(previewPath: string) {
  const file = JSON.parse(readFileSync(resolve(previewPath), "utf8")) as PreviewFile;
  const { previewId, ...payload } = file;
  if (previewIdOf(payload) !== previewId) {
    console.error(`미리보기 파일 내용이 바뀌었습니다 (previewId 불일치). 미리보기를 다시 만드세요.`);
    process.exit(1);
  }
  const { parsed } = payload;
  const sql = sqlClient();
  try {
    const db = await inspectDb(sql, file);
    const problems = printSummary(file, db, "apply");
    if (problems.length) process.exit(1);
    const confirmedRevs = db.plans.reduce((n, pl) => n + pl.confirmed, 0);
    if (confirmedRevs > 0 && !process.argv.includes("--allow-delete-confirmed")) {
      console.error(
        `\n✖ 쓰지 않고 멈춥니다: 지울 ${FACTORY}·${PROCESS_TAB} 계획에 확정 Rev ${confirmedRevs}건이 있습니다.\n` +
          `  확정 Rev 는 NFR-09 에 따라 바꿀 수 없어, 지우려면 불변 트리거를 잠시 꺼야 합니다.\n` +
          `  개발 DB 이고 지워도 되는 가상 계획이 맞다면 --allow-delete-confirmed 를 붙여 다시 실행하세요. 운영 DB 에서는 절대 쓰지 마세요.`,
      );
      process.exit(1);
    }

    const lineId = new Map(db.lines.map((l) => [l.code, l.id]));
    const lineIds = [...lineId.values()];
    const bundleByLine = new Map<string, string[]>();
    for (const r of parsed.rows) if (r.bundle) bundleByLine.set(r.lineCode, [...(bundleByLine.get(r.lineCode) ?? []), r.productName]);

    await sql.begin(async (tx) => {
      // 1) products
      const products = parsed.products.map((p) => ({
        code: p.code,
        name: p.name,
        cavity: p.cavity,
        pack_unit: p.packUnit,
        default_daily_capa: p.defaultDailyCapa,
        unit: "EA",
      }));
      const saved = await tx<{ id: string; code: string }[]>`
        insert into products ${tx(products, "code", "name", "cavity", "pack_unit", "default_daily_capa", "unit")}
        on conflict (code) do update set name = excluded.name, cavity = excluded.cavity, pack_unit = excluded.pack_unit,
          default_daily_capa = excluded.default_daily_capa, unit = excluded.unit, updated_at = now()
        returning id, code`;
      const productId = new Map(saved.map((p) => [p.code, p.id]));

      // 2) 허용 금형·Capa (파일에 있는 호기만 교체)
      await tx`delete from line_allowed_molds where line_id in ${tx(lineIds)}`;
      await tx`delete from line_product_capacity where line_id in ${tx(lineIds)}`;
      const molds = parsed.rows.map((r) => ({ line_id: lineId.get(r.lineCode)!, product_id: productId.get(r.productCode)! }));
      await tx`insert into line_allowed_molds ${tx(molds, "line_id", "product_id")}`;
      const caps = parsed.rows
        .filter((r) => r.dailyCapa !== null)
        .map((r) => ({ line_id: lineId.get(r.lineCode)!, product_id: productId.get(r.productCode)!, daily_capa: r.dailyCapa! }));
      if (caps.length) await tx`insert into line_product_capacity ${tx(caps, "line_id", "product_id", "daily_capa")}`;

      // 3) line_specs
      const specs = parsed.lineSpecs.map((s) => {
        const bundles = bundleByLine.get(s.lineCode);
        const memo = [s.memo, bundles ? `${bundles.join(", ")}: ${BUNDLE_NOTE}` : null].filter(Boolean).join(" / ") || null;
        return { line_id: lineId.get(s.lineCode)!, maker: s.maker, model: s.model, memo };
      });
      await tx`
        insert into line_specs ${tx(specs, "line_id", "maker", "model", "memo")}
        on conflict (line_id) do update set maker = excluded.maker, model = excluded.model, memo = excluded.memo,
          installed_on = null, installed_note = null, install_source = null, take_out = null, hot_runner = null,
          cavity_note = null, allowed_products_raw = null, updated_at = now()`;

      // 4) 실제 데이터 표시 (seed/reset 가드가 읽는다)
      await tx`
        insert into settings (key, value, description)
        values ('master_source', '"real"'::jsonb, '기준정보 출처. "real" 이면 npm run db:seed / db:reset 이 --force 없이 실행되지 않는다')
        on conflict (key) do update set value = excluded.value, description = excluded.description, updated_at = now()`;

      // 5) uploads
      const warnings = [
        ...parsed.warnings,
        ...parsed.products.filter((p) => p.bundle).map((p) => `${p.name}: ${BUNDLE_NOTE}`),
      ];
      await tx`
        insert into uploads (kind, filename, row_count, warnings)
        values ('master', ${payload.source.file}, ${parsed.rows.length}, ${tx.json(warnings)})`;

      // 6) 기존 1STAGE 계획 삭제 (확정 Rev 불변 트리거는 이 구간에서만 끈다)
      await tx`alter table plan_cells disable trigger plan_cells_immutable`;
      await tx`alter table plan_revisions disable trigger plan_revisions_immutable`;
      await tx`delete from plans where factory_id = (select id from factories where code = ${FACTORY}) and process_tab = ${PROCESS_TAB}`;
      await tx`alter table plan_revisions enable trigger plan_revisions_immutable`;
      await tx`alter table plan_cells enable trigger plan_cells_immutable`;

      // 7) 데모 계획 (초안)
      const start = payload.demoPeriodStart;
      const [plan] = await tx<{ id: string }[]>`
        insert into plans (factory_id, process_tab, period_start, period_end)
        values ((select id from factories where code = ${FACTORY}), ${PROCESS_TAB}, ${start}, ${addDays(start, PERIOD_DAYS - 1)})
        returning id`;
      const [rev] = await tx<{ id: string }[]>`insert into plan_revisions (plan_id, status) values (${plan.id}, 'draft') returning id`;
      const targets = await tx<{ id: string }[]>`select id from lines where is_plan_target order by sort_order, code`;
      const allowedRows = await tx<{ line_id: string; product_id: string }[]>`
        select m.line_id, m.product_id from line_allowed_molds m join products p on p.id = m.product_id
        join lines l on l.id = m.line_id where l.is_plan_target order by m.line_id, p.code`;
      const allowedByLine = new Map<string, string[]>();
      for (const a of allowedRows) allowedByLine.set(a.line_id, [...(allowedByLine.get(a.line_id) ?? []), a.product_id]);
      const cells = buildDemoPlanCells({ lines: targets, allowedByLine, dates: dateRange(start, PERIOD_DAYS) }).map((c) => ({
        revision_id: rev.id,
        line_id: c.lineId,
        date: c.date,
        product_id: c.productId,
        qty: c.qty,
        changeover_type: c.changeoverType,
      }));
      if (cells.length) await tx`insert into plan_cells ${tx(cells, "revision_id", "line_id", "date", "product_id", "qty", "changeover_type")}`;
      console.log(`\n데모 계획 셀 ${cells.length}건 생성`);
    });
    console.log(`쓰기 완료 (${previewId})`);
  } finally {
    await sql.end();
  }
}

(async () => {
  try {
    const applyPath = arg("--apply");
    if (applyPath) await apply(applyPath);
    else {
      const file = process.argv.slice(2).find((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1].startsWith("--")));
      if (!file) {
        console.error("usage: npm run import:operation-plan -- <운용안.xlsx> [--sheet <시트명>] [--rules <json>]\n       npm run import:operation-plan -- --apply <미리보기.json>");
        process.exit(1);
      }
      await preview(resolve(file));
    }
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
