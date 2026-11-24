/**
 * setup:real-data 순서 (lib/setup/run-setup.ts) · DB 없이 가짜 deps 로 검사
 */
import { describe, expect, it, vi } from "vitest";
import { runSetup, type SetupDeps } from "@/lib/setup/run-setup";
import { isProjectRefConfirmed, projectRefFromEnv } from "@/lib/setup/project-ref";
import type { CoefficientChange } from "@/lib/setup/changeover-defaults";

const REF = "abcdefghijklmnopqrst"; // 가상 프로젝트 ID

const change = (changed: boolean): CoefficientChange => ({
  processType: "PET1_1STAGE",
  changeoverType: "BM",
  current: { hours: changed ? 3 : 2, factor: changed ? 0.87 : 0.91, nextDayStart: false },
  target: { hours: 2, factor: 0.91, nextDayStart: false },
  changed,
});

function deps(over: Partial<SetupDeps> & { answers?: string[] } = {}) {
  const answers = [...(over.answers ?? [REF, "yes", "yes"])];
  const logs: string[] = [];
  const d: SetupDeps = {
    log: (m) => logs.push(m),
    prompt: vi.fn(async () => answers.shift() ?? ""),
    missingFiles: () => [],
    projectRef: REF,
    migrate: vi.fn(async () => {}),
    importCheck: vi.fn(async () => ({ differences: [], problems: [], confirmedRevs: 0, confirmedGuide: "" })),
    importApply: vi.fn(async () => {}),
    coefficientPlan: vi.fn(async () => [change(false)]),
    coefficientApply: vi.fn(async () => {}),
    summary: vi.fn(async () => ["요약"]),
    ...over,
  };
  return { d, logs };
}

/** DB 에 쓰는 함수가 하나도 불리지 않았는지 */
function expectNoWrites(d: SetupDeps) {
  expect(d.migrate).not.toHaveBeenCalled();
  expect(d.importApply).not.toHaveBeenCalled();
  expect(d.coefficientApply).not.toHaveBeenCalled();
}

describe("setup:real-data 프로젝트 ID 확인", () => {
  it("ID 를 틀리게 입력하면 아무것도 쓰지 않고 멈춘다 (마이그레이션도 안 함)", async () => {
    const { d, logs } = deps({ answers: ["wrongprojectid12345"] });
    expect(await runSetup(d)).toEqual({ status: "stopped", reason: "wrong-project-ref" });
    expectNoWrites(d);
    expect(d.importCheck).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("아무것도 쓰지 않고 멈춥니다");
  });

  it("빈 입력·대소문자 다른 입력도 거부, 앞뒤 공백은 허용", () => {
    expect(isProjectRefConfirmed(REF, "")).toBe(false);
    expect(isProjectRefConfirmed(REF, REF.toUpperCase())).toBe(false);
    expect(isProjectRefConfirmed(REF, `  ${REF} `)).toBe(true);
    expect(isProjectRefConfirmed(null, REF)).toBe(false);
  });

  it("프로젝트 ID 를 찾지 못하면 묻지도 않고 멈춘다", async () => {
    const { d } = deps({ projectRef: null });
    expect(await runSetup(d)).toEqual({ status: "stopped", reason: "no-project-ref" });
    expect(d.prompt).not.toHaveBeenCalled();
    expectNoWrites(d);
  });

  it("접속 주소에서 프로젝트 ID 만 뽑는다 (비밀번호는 돌려주지 않음)", () => {
    expect(projectRefFromEnv({ DATABASE_URL: `postgresql://postgres.${REF}:secret@aws-0-ap.pooler.supabase.com:6543/postgres` })).toBe(REF);
    expect(projectRefFromEnv({ DATABASE_URL: `postgresql://postgres:secret@db.${REF}.supabase.co:5432/postgres` })).toBe(REF);
    expect(projectRefFromEnv({ NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co` })).toBe(REF);
    expect(projectRefFromEnv({ DATABASE_URL: "postgresql://user:secret@localhost:5432/db" })).toBeNull();
  });
});

describe("setup:real-data 파일 확인", () => {
  it("운용안·설비 규칙 파일이 없으면 안내하고 멈춘다 (ID 도 묻지 않음)", async () => {
    const { d, logs } = deps({ missingFiles: () => ["운용안 파일이 없습니다 → 담당자에게 받으세요"] });
    expect(await runSetup(d)).toEqual({ status: "stopped", reason: "missing-files" });
    expect(d.prompt).not.toHaveBeenCalled();
    expectNoWrites(d);
    expect(logs.join("\n")).toContain("담당자에게 받으세요");
  });
});

describe("setup:real-data 다시 실행 (최신 상태로 맞추기)", () => {
  it("이미 같으면 운용안·교체 계수 모두 '변경 없음'으로 건너뛴다", async () => {
    const { d, logs } = deps();
    expect(await runSetup(d)).toEqual({ status: "done", imported: false, coefficientsUpdated: false });
    expect(d.migrate).toHaveBeenCalledOnce(); // 적용 안 된 마이그레이션만 (db:migrate 가 판단)
    expect(d.importApply).not.toHaveBeenCalled();
    expect(d.coefficientApply).not.toHaveBeenCalled();
    expect(d.prompt).toHaveBeenCalledTimes(1); // ID 확인만
    expect(logs.filter((l) => l.includes("변경 없음"))).toHaveLength(2);
  });

  it("예전 버전 DB: 다른 점이 있으면 yes 입력 후 적용, 바뀐 계수만 넘긴다", async () => {
    const changes = [change(true), { ...change(false), changeoverType: "FULL" as const }];
    const { d } = deps({
      importCheck: vi.fn(async () => ({ differences: ["설비 상세 18건 다름"], problems: [], confirmedRevs: 0, confirmedGuide: "" })),
      coefficientPlan: vi.fn(async () => changes),
    });
    expect(await runSetup(d)).toEqual({ status: "done", imported: true, coefficientsUpdated: true });
    expect(d.importApply).toHaveBeenCalledOnce();
    expect(d.coefficientApply).toHaveBeenCalledWith([changes[0]]);
  });

  it("yes 가 아니면 적용하지 않고 멈춘다", async () => {
    const { d } = deps({
      answers: [REF, "y"],
      importCheck: vi.fn(async () => ({ differences: ["제품 1건 없음 또는 다름"], problems: [], confirmedRevs: 0, confirmedGuide: "" })),
    });
    expect(await runSetup(d)).toEqual({ status: "stopped", reason: "declined" });
    expect(d.importApply).not.toHaveBeenCalled();
    expect(d.coefficientApply).not.toHaveBeenCalled();
  });

  it("확정 Rev 삭제가 필요하면 자동으로 하지 않고 --allow-delete-confirmed 사용법을 안내하고 멈춘다", async () => {
    const guide = "확정 Rev 1건 … npm run import:operation-plan -- --apply x.json --allow-delete-confirmed";
    const { d, logs } = deps({
      importCheck: vi.fn(async () => ({ differences: ["허용 금형 82건 다름"], problems: [], confirmedRevs: 1, confirmedGuide: guide })),
    });
    expect(await runSetup(d)).toEqual({ status: "stopped", reason: "confirmed-revs" });
    expect(d.importApply).not.toHaveBeenCalled();
    expect(d.coefficientApply).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("--allow-delete-confirmed");
    expect(d.prompt).toHaveBeenCalledTimes(1);
  });

  it("쓰기를 막는 문제(없는 호기 등)가 있으면 멈춘다", async () => {
    const { d } = deps({ importCheck: vi.fn(async () => ({ differences: ["x"], problems: ["DB 에 없는 호기: PET99"], confirmedRevs: 0, confirmedGuide: "" })) });
    expect(await runSetup(d)).toEqual({ status: "stopped", reason: "import-problems" });
    expect(d.importApply).not.toHaveBeenCalled();
  });
});
