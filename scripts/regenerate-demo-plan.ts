/**
 * 데모 계획(1STAGE 초안)의 셀만 다시 만든다 (미리보기 → 승인 → 쓰기). 기준정보는 읽기만 한다.
 *
 *   미리보기 (DB 읽기만, 쓰기 없음):
 *     npm run demo-plan:regenerate [-- --period YYYY-MM-DD]
 *     → 기간을 주지 않으면 가장 최근 F1·1STAGE 계획. data/samples/import-preview/demo-<previewId>.json 저장
 *
 *   쓰기:
 *     npm run demo-plan:regenerate -- --apply data/samples/import-preview/demo-<previewId>.json
 *     → 파일 내용 해시가 previewId 와 같고, 그 사이 계획·초안·허용 금형이 그대로일 때만. 한 트랜잭션.
 *
 * 바꾸는 것: 해당 계획의 초안 Rev 1건의 plan_cells (삭제 후 다시 넣음). 그 밖의 테이블은 쓰지 않는다.
 * 멈추는 경우: 확정 Rev 가 있는 계획(확정 이력 보호), 초안이 1건이 아닌 계획.
 */
import { config } from "dotenv";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import postgres from "postgres";
import { buildDemoPlanCells, isDowntimeDate } from "../lib/data/demo-plan";
import { dateRange } from "../lib/excel/common";
import { resolveChangeover } from "../lib/engine/production";
import type { ChangeoverKind, ChangeoverType, PlanCell } from "../lib/engine/types";

config({ path: ".env.local", override: false });

const PREVIEW_DIR = join(process.cwd(), "data", "samples", "import-preview");
const FACTORY = "F1";
const PROCESS_TAB = "1STAGE";

interface DemoPayload {
  version: 1;
  planId: string;
  revisionId: string;
  periodStart: string;
  periodEnd: string;
  cells: { lineId: string; date: string; productId: string; changeoverType: ChangeoverType }[];
}
interface DemoFile extends DemoPayload {
  previewId: string;
}

const previewIdOf = (p: DemoPayload) => createHash("sha256").update(JSON.stringify(p)).digest("hex").slice(0, 12);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type Sql = ReturnType<typeof postgres>;

function fail(msg: string): never {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

/** 현재 DB 상태를 읽고 새 셀을 만든다 (쓰기 없음) */
async function build(sql: Sql, period?: string) {
  const plans = await sql<{ id: string; period_start: string; period_end: string }[]>`
    select p.id, p.period_start::text, p.period_end::text from plans p join factories f on f.id = p.factory_id
    where f.code = ${FACTORY} and p.process_tab = ${PROCESS_TAB} ${period ? sql`and p.period_start = ${period}` : sql``}
    order by p.period_start desc limit 1`;
  const plan = plans[0];
  if (!plan) fail(period ? `${period} 시작 ${FACTORY}·${PROCESS_TAB} 계획이 없습니다.` : `${FACTORY}·${PROCESS_TAB} 계획이 없습니다.`);

  const revs = await sql<{ id: string; status: string }[]>`select id, status::text from plan_revisions where plan_id = ${plan.id}`;
  const confirmed = revs.filter((r) => r.status === "confirmed").length;
  const drafts = revs.filter((r) => r.status === "draft");
  if (confirmed > 0) fail(`이 계획에는 확정 Rev ${confirmed}건이 있어 다시 만들지 않습니다 (확정 이력 보호).`);
  if (drafts.length !== 1) fail(`이 계획의 초안이 ${drafts.length}건입니다. 초안이 정확히 1건일 때만 다시 만듭니다.`);

  const lines = await sql<{ id: string; code: string }[]>`select id, code from lines where is_plan_target order by sort_order, code`;
  const allowedRows = await sql<{ line_id: string; product_id: string }[]>`
    select m.line_id, m.product_id from line_allowed_molds m join products p on p.id = m.product_id
    join lines l on l.id = m.line_id where l.is_plan_target order by m.line_id, p.code`;
  const downtimes = await sql<{ line_id: string; start_date: string; end_date: string }[]>`
    select line_id, start_date::text, end_date::text from downtimes where start_date <= ${plan.period_end} and end_date >= ${plan.period_start}`;
  const [defaultRow] = await sql<{ value: unknown }[]>`select value from settings where key = 'default_changeover_type'`;
  const current = await sql<{ line_id: string; date: string; product_id: string | null }[]>`
    select line_id, date::text, product_id from plan_cells where revision_id = ${drafts[0].id}`;

  const allowedByLine = new Map<string, string[]>();
  for (const a of allowedRows) allowedByLine.set(a.line_id, [...(allowedByLine.get(a.line_id) ?? []), a.product_id]);
  const dt = downtimes.map((d) => ({ lineId: d.line_id, startDate: d.start_date, endDate: d.end_date }));
  const dates = dateRange(plan.period_start, 15).filter((d) => d <= plan.period_end);
  const cells = buildDemoPlanCells({ lines, allowedByLine, dates, downtimes: dt });

  const payload: DemoPayload = {
    version: 1,
    planId: plan.id,
    revisionId: drafts[0].id,
    periodStart: plan.period_start,
    periodEnd: plan.period_end,
    cells: cells.map((c) => ({ lineId: c.lineId, date: c.date, productId: c.productId!, changeoverType: c.changeoverType })),
  };
  return {
    payload,
    lines,
    downtimes: dt,
    defaultType: (defaultRow?.value === "FULL" ? "FULL" : "BM") as ChangeoverKind,
    current,
    allowedPairs: new Set(allowedRows.map((a) => `${a.line_id}|${a.product_id}`)),
  };
}

function printSummary(title: string, b: Awaited<ReturnType<typeof build>>, previewId: string) {
  const { payload, lines, downtimes, current } = b;
  const code = new Map(lines.map((l) => [l.id, l.code]));
  const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  const onDowntimeNow = current.filter((c) => c.product_id && isDowntimeDate(downtimes, c.line_id, c.date)).length;
  const onDowntimeNew = payload.cells.filter((c) => isDowntimeDate(downtimes, c.lineId, c.date)).length;

  console.log(`\n=== ${title} ${previewId} ===`);
  console.log(`계획 ${payload.periodStart} ~ ${payload.periodEnd} (${FACTORY}·${PROCESS_TAB}) · 초안 1건만 바꿈 · 확정 Rev 없음`);
  console.log(`셀: 지금 ${current.length} → 새로 ${payload.cells.length}`);
  console.log(`다운타임 ${downtimes.length}건 · 다운타임 날짜의 셀: 지금 ${onDowntimeNow} → 새로 ${onDowntimeNew}`);
  for (const d of downtimes) console.log(`  ${code.get(d.lineId) ?? "(계획 대상 아님)"} ${md(d.startDate)}~${md(d.endDate)}`);

  // 화면 배지와 같은 규칙(엔진 resolveChangeover)으로 분류
  const byKey = new Map(payload.cells.map((c) => [`${c.lineId}|${c.date}`, c]));
  const examples: Record<string, string[]> = { "B/M": [], FULL: [], "B/M?": [] };
  const counts: Record<string, number> = { "B/M": 0, FULL: 0, "B/M?": 0 };
  for (const c of payload.cells) {
    const prevDate = new Date(`${c.date}T00:00:00Z`);
    prevDate.setUTCDate(prevDate.getUTCDate() - 1);
    const prev = byKey.get(`${c.lineId}|${prevDate.toISOString().slice(0, 10)}`);
    const r = resolveChangeover(c as PlanCell, prev as PlanCell | undefined, b.defaultType);
    if (r.type === "NONE") continue;
    const kind = r.defaulted ? "B/M?" : r.type === "FULL" ? "FULL" : "B/M";
    counts[kind]++;
    examples[kind].push(`${code.get(c.lineId)} ${md(c.date)}`);
  }
  console.log(`교체 배지: B/M ${counts["B/M"]} · FULL ${counts.FULL} · B/M?(미입력) ${counts["B/M?"]}`);
  for (const k of Object.keys(examples)) console.log(`  ${k.padEnd(5)} 예: ${examples[k].join(", ") || "-"}`);
  console.log(`쓰는 테이블: plan_cells (해당 초안 1건) 뿐 · 기준정보·다른 계획·확정 Rev 는 그대로`);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) fail("DATABASE_URL 이 .env.local 에 없습니다.");
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const applyPath = arg("--apply");
    if (!applyPath) {
      const b = await build(sql, arg("--period"));
      const previewId = previewIdOf(b.payload);
      mkdirSync(PREVIEW_DIR, { recursive: true });
      const out = join(PREVIEW_DIR, `demo-${previewId}.json`);
      writeFileSync(out, JSON.stringify({ previewId, ...b.payload } satisfies DemoFile, null, 2), "utf8");
      printSummary("데모 계획 미리보기 (DB 쓰기 없음)", b, previewId);
      console.log(`\n미리보기 저장: ${out}`);
      console.log(`승인 후 쓰기: npm run demo-plan:regenerate -- --apply ${join("data", "samples", "import-preview", `demo-${previewId}.json`)}`);
      return;
    }

    const file = JSON.parse(readFileSync(resolve(applyPath), "utf8")) as DemoFile;
    const { previewId, ...payload } = file;
    if (previewIdOf(payload) !== previewId) fail("미리보기 파일 내용이 바뀌었습니다 (previewId 불일치). 미리보기를 다시 만드세요.");
    // 지금 DB 로 다시 만들어 미리보기와 같은지 확인 (그 사이 계획·초안·허용 금형·다운타임이 바뀌었으면 멈춤)
    const now = await build(sql, payload.periodStart);
    if (previewIdOf(now.payload) !== previewId) fail("미리보기 이후 DB 상태(계획·초안·허용 금형·다운타임)가 바뀌었습니다. 미리보기를 다시 만드세요.");
    const notAllowed = payload.cells.filter((c) => !now.allowedPairs.has(`${c.lineId}|${c.productId}`)).length;
    if (notAllowed > 0) fail(`허용 금형에 없는 셀 ${notAllowed}건이 있어 멈춥니다.`);
    printSummary("데모 계획 쓰기 · 아래 내용을 DB 에 씁니다", now, previewId);

    await sql.begin(async (tx) => {
      const [rev] = await tx<{ status: string }[]>`select status::text from plan_revisions where id = ${payload.revisionId} for update`;
      if (rev?.status !== "draft") throw new Error("초안 Rev 가 아니어서 멈춥니다.");
      await tx`delete from plan_cells where revision_id = ${payload.revisionId}`;
      const rows = payload.cells.map((c) => ({
        revision_id: payload.revisionId,
        line_id: c.lineId,
        date: c.date,
        product_id: c.productId,
        qty: null,
        changeover_type: c.changeoverType,
      }));
      if (rows.length) await tx`insert into plan_cells ${tx(rows, "revision_id", "line_id", "date", "product_id", "qty", "changeover_type")}`;
    });
    console.log(`\n쓰기 완료: 셀 ${payload.cells.length}건 (${previewId})`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
