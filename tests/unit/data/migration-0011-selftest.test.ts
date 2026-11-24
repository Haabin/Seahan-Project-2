/**
 * 0011 마이그레이션과 시험 스크립트(scripts/sql/0011_selftest.sql)가 어긋나지 않는지, 권한 문구가 들어 있는지.
 * SQL 자체는 여기서 실행하지 않는다 (시험 스크립트를 Supabase SQL Editor 에서 돌린다).
 */
import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("supabase/migrations/0011_plan_draft_version.sql", "utf8").replace(/\r\n/g, "\n");
const selftest = readFileSync("scripts/sql/0011_selftest.sql", "utf8").replace(/\r\n/g, "\n");

describe("0011 시험 스크립트", () => {
  it("시험 스크립트 안의 0011 본문이 마이그레이션 파일과 똑같다", () => {
    const body = selftest.split("-- >>> 0011 시작")[1]?.split("-- <<< 0011 끝")[0];
    expect(body).toBeDefined();
    const inner = body!.slice(body!.indexOf("\n") + 1).trimEnd();
    expect(inner).toBe(migration.trimEnd());
  });

  it("begin 으로 시작해 rollback 으로 끝나고, 마이그레이션 폴더 밖에 있다", () => {
    const sqlLines = selftest.split("\n").filter((l) => l.trim() && !l.trim().startsWith("--"));
    expect(sqlLines[0].trim()).toBe("begin;");
    expect(sqlLines[sqlLines.length - 1].trim()).toBe("rollback;");
    expect(selftest).toContain("마이그레이션 아님");
    expect(existsSync("supabase/migrations/0011_selftest.sql")).toBe(false);
    expect(selftest).not.toMatch(/^\s*commit\s*;/im);
  });
});

describe("0011 마이그레이션", () => {
  it("실행 권한: save_plan_draft · app_display_name 은 authenticated·service_role 에 주고 anon 은 막는다", () => {
    for (const fn of ["save_plan_draft(uuid, int, uuid, jsonb)", "app_display_name(uuid)"]) {
      expect(migration).toContain(`revoke all on function ${fn} from public, anon;`);
      expect(migration).toContain(`grant execute on function ${fn} to authenticated, service_role;`);
    }
  });

  it("다시 실행해도 되게 쓰였고, 확정 Rev 는 version 을 올리지 않는다", () => {
    expect(migration).toMatch(/add column if not exists version int not null default 0/);
    expect(migration).toMatch(/where id = any\(ids\) and status = 'draft'/);
    const code = migration
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(code.match(/drop trigger if exists plan_cells_bump_/g)?.length).toBe(3);
    expect(migration).not.toMatch(/^\s*(begin|commit|rollback)\s*;/im);
  });

  it("반환 열은 out_ 으로 시작한다 (plan_revisions 열 이름과 겹치지 않게)", () => {
    const returns = migration.split("returns table(")[1].split(")\nlanguage")[0];
    const cols = returns.split(",").map((c) => c.trim().split(/\s+/)[0]).filter(Boolean);
    expect(cols).toEqual(["out_status", "out_version", "out_updated_at", "out_updated_by", "out_updated_by_name", "out_rev_no"]);
  });
});
