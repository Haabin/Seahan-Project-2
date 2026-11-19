/**
 * 데모 계획(F1·1STAGE, 초안만 있는 계획)을 통째로 지운다 (미리보기 → 승인 → 쓰기).
 * 팀장님이 생산계획표에서 처음부터 계획을 만들 수 있게 하려는 용도다. 기준정보는 읽지도 쓰지도 않는다.
 *
 *   미리보기 (DB 읽기만, 쓰기 없음):
 *     npm run demo-plan:clear -- --period YYYY-MM-DD
 *     → data/samples/import-preview/clear-<previewId>.json 저장
 *
 *   쓰기:
 *     npm run demo-plan:clear -- --apply data/samples/import-preview/clear-<previewId>.json
 *     → 미리보기 이후 계획·Rev·셀 수가 그대로일 때만. 한 트랜잭션.
 *
 * 지우는 것: 해당 plans 1행 (plan_revisions·plan_cells 는 on delete cascade).
 * 멈추는 경우: 확정 Rev 가 있는 계획(NFR-09 이력 보호, 트리거도 끄지 않는다), 기간을 주지 않은 경우.
 */
import { config } from "dotenv";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import postgres from "postgres";

config({ path: ".env.local", override: false });

const PREVIEW_DIR = join(process.cwd(), "data", "samples", "import-preview");
const FACTORY = "F1";
const PROCESS_TAB = "1STAGE";

interface ClearPayload {
  version: 1;
  planId: string;
  periodStart: string;
  periodEnd: string;
  revisionIds: string[];
  cellCount: number;
}
interface ClearFile extends ClearPayload {
  previewId: string;
}

const previewIdOf = (p: ClearPayload) => createHash("sha256").update(JSON.stringify(p)).digest("hex").slice(0, 12);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(msg: string): never {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

type Sql = ReturnType<typeof postgres>;

async function inspect(sql: Sql, period: string) {
  const [plan] = await sql<{ id: string; period_start: string; period_end: string }[]>`
    select p.id, p.period_start::text, p.period_end::text from plans p join factories f on f.id = p.factory_id
    where f.code = ${FACTORY} and p.process_tab = ${PROCESS_TAB} and p.period_start = ${period}`;
  if (!plan) fail(`${period} 시작 ${FACTORY}·${PROCESS_TAB} 계획이 없습니다.`);
  const revs = await sql<{ id: string; status: string }[]>`select id, status::text from plan_revisions where plan_id = ${plan.id} order by created_at, id`;
  const confirmed = revs.filter((r) => r.status === "confirmed").length;
  if (confirmed > 0) fail(`이 계획에는 확정 Rev ${confirmed}건이 있어 지우지 않습니다 (확정 이력 보호).`);
  const [cells] = await sql<{ n: number }[]>`
    select count(*)::int n from plan_cells c join plan_revisions r on r.id = c.revision_id where r.plan_id = ${plan.id}`;
  const others = await sql<{ period_start: string }[]>`
    select p.period_start::text from plans p join factories f on f.id = p.factory_id
    where f.code = ${FACTORY} and p.process_tab = ${PROCESS_TAB} and p.id <> ${plan.id} order by p.period_start`;
  const payload: ClearPayload = {
    version: 1,
    planId: plan.id,
    periodStart: plan.period_start,
    periodEnd: plan.period_end,
    revisionIds: revs.map((r) => r.id),
    cellCount: cells.n,
  };
  return { payload, others: others.map((o) => o.period_start) };
}

function printSummary(title: string, previewId: string, s: Awaited<ReturnType<typeof inspect>>) {
  const { payload, others } = s;
  console.log(`\n=== ${title} ${previewId} ===`);
  console.log(`지울 계획: ${payload.periodStart} ~ ${payload.periodEnd} (${FACTORY}·${PROCESS_TAB})`);
  console.log(`  초안 Rev ${payload.revisionIds.length}건 · 셀 ${payload.cellCount}건 · 확정 Rev 0건`);
  console.log(`남는 ${FACTORY}·${PROCESS_TAB} 계획: ${others.length ? others.join(", ") : "없음 → 생산계획표에 '15일 계획 만들기'가 나온다"}`);
  console.log(`쓰는 테이블: plans 1행 삭제 (plan_revisions·plan_cells 는 함께 삭제) 뿐 · 기준정보·다운타임·다른 계획은 그대로`);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) fail("DATABASE_URL 이 .env.local 에 없습니다.");
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const applyPath = arg("--apply");
    if (!applyPath) {
      const period = arg("--period");
      if (!period || !/^\d{4}-\d{2}-\d{2}$/.test(period)) fail("지울 계획의 시작일을 --period YYYY-MM-DD 로 주세요.");
      const s = await inspect(sql, period);
      const previewId = previewIdOf(s.payload);
      mkdirSync(PREVIEW_DIR, { recursive: true });
      const out = join(PREVIEW_DIR, `clear-${previewId}.json`);
      writeFileSync(out, JSON.stringify({ previewId, ...s.payload } satisfies ClearFile, null, 2), "utf8");
      printSummary("데모 계획 삭제 미리보기 (DB 쓰기 없음)", previewId, s);
      console.log(`\n미리보기 저장: ${out}`);
      console.log(`승인 후 쓰기: npm run demo-plan:clear -- --apply ${join("data", "samples", "import-preview", `clear-${previewId}.json`)}`);
      return;
    }

    const file = JSON.parse(readFileSync(resolve(applyPath), "utf8")) as ClearFile;
    const { previewId, ...payload } = file;
    if (previewIdOf(payload) !== previewId) fail("미리보기 파일 내용이 바뀌었습니다 (previewId 불일치). 미리보기를 다시 만드세요.");
    const now = await inspect(sql, payload.periodStart);
    if (previewIdOf(now.payload) !== previewId) fail("미리보기 이후 계획·Rev·셀 수가 바뀌었습니다. 미리보기를 다시 만드세요.");
    printSummary("데모 계획 삭제 · 아래 계획을 DB 에서 지웁니다", previewId, now);

    await sql.begin(async (tx) => {
      const [c] = await tx<{ n: number }[]>`
        select count(*)::int n from plan_revisions where plan_id = ${payload.planId} and status = 'confirmed'`;
      if (c.n > 0) throw new Error("확정 Rev 가 생겨 멈춥니다.");
      const del = await tx`delete from plans where id = ${payload.planId}`;
      if (del.count !== 1) throw new Error(`삭제된 계획이 ${del.count}건이라 되돌립니다.`);
    });
    console.log(`\n삭제 완료 (${previewId})`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
