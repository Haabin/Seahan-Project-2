/**
 * DB 마이그레이션·시드 실행기.
 *   npm run db:migrate   supabase/migrations/*.sql 을 파일명 순으로 적용(적용 이력은 _migrations 테이블)
 *   npm run db:seed      supabase/seed.sql 적용 (가상 데이터, 재실행 가능)
 *   npm run db:reset     public 스키마 초기화 후 migrate + seed  (주의: 데이터 전부 삭제)
 * 접속 정보는 .env.local 의 DATABASE_URL 만 사용한다. Supabase CLI 로그인이 필요 없다.
 */
import "dotenv/config";
import { config } from "dotenv";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

config({ path: ".env.local", override: false });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL 이 .env.local 에 없습니다. .env.example 을 참고하세요.");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
const root = join(process.cwd(), "supabase");

async function migrate() {
  await sql`create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())`;
  const applied = new Set((await sql<{ name: string }[]>`select name from _migrations`).map((r) => r.name));
  const files = readdirSync(join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (applied.has(f)) {
      console.log(`skip  ${f}`);
      continue;
    }
    const body = readFileSync(join(root, "migrations", f), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into _migrations (name) values (${f})`;
    });
    console.log(`apply ${f}`);
  }
}

async function seed() {
  const p = join(root, "seed.sql");
  if (!existsSync(p)) {
    console.error("supabase/seed.sql 이 없습니다. 먼저 npm run fake-data 를 실행하세요.");
    process.exit(1);
  }
  const body = readFileSync(p, "utf8");
  await sql.begin(async (tx) => {
    await tx.unsafe(body);
  });
  console.log("seed applied");
}

async function reset() {
  await sql.unsafe(`
    drop schema public cascade;
    create schema public;
    grant usage on schema public to postgres, anon, authenticated, service_role;
    grant all on schema public to postgres, service_role;
    alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to postgres, anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;
  `);
  console.log("public schema reset");
  await migrate();
  await seed();
}

const cmd = process.argv[2];
(async () => {
  try {
    if (cmd === "migrate") await migrate();
    else if (cmd === "seed") await seed();
    else if (cmd === "reset") await reset();
    else {
      console.error("usage: tsx scripts/db.ts <migrate|seed|reset>");
      process.exit(1);
    }
  } catch (e) {
    console.error(e);
    process.exit(1);
  } finally {
    await sql.end();
  }
})();
