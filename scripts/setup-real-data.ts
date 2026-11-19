/**
 * 실제 데이터 세팅을 명령 하나로 (개발 DB 전용).
 *   npm run setup:real-data -- data/samples/제품배치운용안.xlsx [--sheet <시트명>] [--rules <설비규칙.json>]
 *
 * 순서는 lib/setup/run-setup.ts: 파일 확인 → 프로젝트 ID 직접 입력 확인 → db:migrate → 운용안 가져오기(yes) → 교체 계수(yes) → 요약.
 * 같은 명령을 다시 실행하면 이미 같은 부분은 "변경 없음"으로 건너뛰고, 예전 버전으로 세팅한 DB 는 최신 상태로 맞춘다.
 * 기존 명령(import:operation-plan, demo-plan:*)은 그대로이며, 이 명령은 그 함수들을 순서대로 부른다.
 * 확정 Rev 삭제가 필요하면 자동으로 하지 않고 --allow-delete-confirmed 사용법을 안내하고 멈춘다.
 * 출력에는 키·비밀번호·접속 주소를 쓰지 않는다(프로젝트 ID 만).
 */
import { config } from "dotenv";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import postgres from "postgres";
import { parseFactorTable } from "../lib/engine/changeover";
import type { ChangeoverCoefficient } from "../lib/engine/types";
import { parseChangeoverDefaults, planCoefficientChanges, type CoefficientChange } from "../lib/setup/changeover-defaults";
import { projectRefFromEnv } from "../lib/setup/project-ref";
import { runSetup } from "../lib/setup/run-setup";
import {
  applyPreviewFile,
  buildPreviewFile,
  confirmedRevGuide,
  DEFAULT_RULES_PATH,
  diffAgainstDb,
  inspectDb,
  printSummary,
  type PreviewFile,
} from "./import-operation-plan";

config({ path: ".env.local", override: false });

const ROOT = process.cwd();
const DEFAULTS_PATH = join(ROOT, "config", "changeover-defaults.json");
const OWNER = "설비현황·금형교체 담당자";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function main(): Promise<number> {
  const positional = process.argv.slice(2).find((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1].startsWith("--")));
  if (!positional) {
    console.error("usage: npm run setup:real-data -- <운용안.xlsx> [--sheet <시트명>] [--rules <설비규칙.json>]");
    console.error(`예: npm run setup:real-data -- data/samples/제품배치운용안.xlsx`);
    return 1;
  }
  const xlsx = resolve(positional);
  const rulesPath = resolve(arg("--rules") ?? DEFAULT_RULES_PATH);
  const url = process.env.DATABASE_URL;

  // DB 연결은 파일·ID 확인을 통과한 뒤에만 만든다
  let sql: ReturnType<typeof postgres> | null = null;
  const db = () => (sql ??= postgres(url!, { max: 1, prepare: false, onnotice: () => {} }));
  let preview: { file: PreviewFile; path: string } | null = null;

  try {
    const result = await runSetup({
      log: (m) => console.log(m),
      prompt,
      missingFiles: () => {
        const out: string[] = [];
        if (!existsSync(xlsx))
          out.push(`운용안 파일이 없습니다: ${relative(ROOT, xlsx)}\n    → ${OWNER}에게 「제품배치운용안.xlsx」를 받아 data/samples/ 에 두세요 (실제 자료, git 에 올리지 않음).`);
        if (!existsSync(rulesPath))
          out.push(`설비 규칙 파일이 없습니다: ${relative(ROOT, rulesPath)}\n    → ${OWNER}에게 「equipment-rules.json」을 받아 data/samples/ 에 두세요 (git 에 올리지 않음).`);
        if (!existsSync(DEFAULTS_PATH)) out.push(`교체 계수 설정 파일이 없습니다: config/changeover-defaults.json → 최신 코드를 받으세요 (git pull / merge).`);
        if (!url) out.push(`.env.local 에 DATABASE_URL 이 없습니다 → .env.example 을 참고해 내 개발 Supabase 접속 정보를 넣으세요.`);
        return out;
      },
      projectRef: projectRefFromEnv({ DATABASE_URL: process.env.DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL }),

      migrate: async () => {
        const r = spawnSync("npm", ["run", "db:migrate"], { stdio: "inherit", shell: true });
        if (r.status !== 0) throw new Error("db:migrate 가 실패했습니다. 위 오류를 확인하세요.");
      },

      importCheck: async () => {
        const built = await buildPreviewFile(xlsx, { sheet: arg("--sheet"), rulesPath });
        if (!built.ok) return { differences: [], problems: [built.error], confirmedRevs: 0, confirmedGuide: "" };
        const previewPath = relative(ROOT, built.outPath);
        preview = { file: built.preview, path: previewPath };
        const differences = await diffAgainstDb(db(), built.preview);
        const info = await inspectDb(db(), built.preview);
        const confirmedRevs = info.plans.reduce((n, p) => n + p.confirmed, 0);
        // 다른 점이 있을 때만 미리보기 요약을 보여 준다 (같으면 "변경 없음" 한 줄)
        const problems = differences.length ? printSummary(built.preview, info) : [];
        if (differences.length) console.log(`\n      미리보기 저장: ${previewPath}`);
        return { differences, problems, confirmedRevs, confirmedGuide: confirmedRevGuide(confirmedRevs, previewPath) };
      },

      importApply: async () => {
        if (!preview) throw new Error("미리보기가 없습니다.");
        const r = await applyPreviewFile(db(), preview.file, { allowDeleteConfirmed: false, previewPath: preview.path });
        if (!r.ok) throw new Error(r.message);
      },

      coefficientPlan: async () => {
        const defaults = parseChangeoverDefaults(JSON.parse(readFileSync(DEFAULTS_PATH, "utf8")));
        const [table] = await db()<{ value: unknown }[]>`select value from settings where key = 'changeover_factor_table'`;
        const rows = await db()<{ process_type: string; changeover_type: string; hours: string; factor: string; next_day_start: boolean }[]>`
          select process_type::text, changeover_type::text, hours::text, factor::text, next_day_start from changeover_coefficients`;
        const current: ChangeoverCoefficient[] = rows.map((r) => ({
          processType: r.process_type as ChangeoverCoefficient["processType"],
          changeoverType: r.changeover_type as ChangeoverCoefficient["changeoverType"],
          hours: Number(r.hours),
          factor: Number(r.factor),
          nextDayStart: r.next_day_start,
        }));
        return planCoefficientChanges(current, defaults, parseFactorTable(table?.value));
      },

      coefficientApply: async (changes: CoefficientChange[]) => {
        await db().begin(async (tx) => {
          for (const c of changes) {
            await tx`
              insert into changeover_coefficients (process_type, changeover_type, hours, factor, next_day_start)
              values (${c.processType}, ${c.changeoverType}, ${c.target.hours}, ${c.target.factor}, ${c.target.nextDayStart})
              on conflict (process_type, changeover_type) do update set
                hours = excluded.hours, factor = excluded.factor, next_day_start = excluded.next_day_start, updated_at = now()`;
          }
        });
        console.log(`      교체 계수 ${changes.length}건 적용`);
      },

      summary: async () => {
        const [m] = await db()<{ lines: number; products: number }[]>`
          select count(distinct m.line_id)::int lines, count(distinct m.product_id)::int products
          from line_allowed_molds m join lines l on l.id = m.line_id where l.is_plan_target`;
        const coefs = await db()<{ changeover_type: string; hours: string; factor: string; next_day_start: boolean }[]>`
          select changeover_type::text, hours::text, factor::text, next_day_start from changeover_coefficients
          where process_type = 'PET1_1STAGE' order by changeover_type`;
        const [mig] = await db()<{ name: string }[]>`select name from _migrations order by name desc limit 1`;
        const [src] = await db()<{ value: unknown }[]>`select value from settings where key = 'master_source'`;
        return [
          `계획 대상 호기 ${m.lines}개 · 허용 금형 제품 ${m.products}개 · 기준정보 출처 ${JSON.stringify(src?.value ?? null)}`,
          `PET1 교체 계수: ${coefs.map((c) => `${c.changeover_type} ${Number(c.hours)}h · ${Number(c.factor).toFixed(2)}${c.next_day_start ? " · 익일가동" : ""}`).join(" / ")}`,
          `마이그레이션 최신: ${mig?.name ?? "(없음)"}`,
        ];
      },
    });
    return result.status === "done" ? 0 : 1;
  } finally {
    const s = sql as ReturnType<typeof postgres> | null;
    if (s) await s.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`\n✖ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
