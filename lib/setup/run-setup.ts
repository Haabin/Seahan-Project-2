/**
 * npm run setup:real-data 의 순서 (DB·입력은 deps 로 받는다 → 테스트에서 가짜로 바꿔 끼운다).
 *   0) 필요한 파일 확인        → 없으면 무엇을 누구에게 받을지 안내하고 멈춤
 *   1) Supabase 프로젝트 ID 확인 → 직접 입력한 ID 가 다르면 아무것도 쓰지 않고 멈춤
 *   2) 마이그레이션              → 적용 안 된 것만
 *   3) 운용안 가져오기           → 이미 같으면 "변경 없음", 확정 Rev 삭제가 필요하면 안내하고 멈춤, 아니면 yes 일 때 적용
 *   4) 교체 계수 설정 파일       → 이미 같으면 "변경 없음", 아니면 표 출력 후 yes 일 때 적용
 *   5) 결과 요약
 */
import type { CoefficientChange } from "./changeover-defaults";
import { isProjectRefConfirmed } from "./project-ref";

export interface ImportCheck {
  /** 미리보기 요약 출력은 deps 가 직접 한다. 여기서는 판단에 쓰는 값만 */
  differences: string[];
  problems: string[];
  confirmedRevs: number;
  /** 확정 Rev 삭제가 필요할 때 보여 줄 안내 (--allow-delete-confirmed 사용법) */
  confirmedGuide: string;
}

export interface SetupDeps {
  log: (msg: string) => void;
  prompt: (question: string) => Promise<string>;
  /** 없는 파일마다 안내 문장. 빈 배열이면 모두 있음 */
  missingFiles: () => string[];
  projectRef: string | null;
  migrate: () => Promise<void>;
  importCheck: () => Promise<ImportCheck>;
  importApply: () => Promise<void>;
  coefficientPlan: () => Promise<CoefficientChange[]>;
  coefficientApply: (changes: CoefficientChange[]) => Promise<void>;
  summary: () => Promise<string[]>;
}

export type SetupResult =
  | { status: "done"; imported: boolean; coefficientsUpdated: boolean }
  | { status: "stopped"; reason: "missing-files" | "no-project-ref" | "wrong-project-ref" | "import-problems" | "confirmed-revs" | "declined" };

const yes = (a: string) => a.trim().toLowerCase() === "yes";

export function formatCoefficientTable(changes: CoefficientChange[]): string[] {
  const f = (c: CoefficientChange["current"]) => (c ? `${c.hours}h · ${c.factor.toFixed(2)} · 익일가동 ${c.nextDayStart ? "켬" : "끔"}` : "(행 없음)");
  return [
    "  공정·교체유형          현재 값                         →  바꿀 값",
    ...changes.map((c) => `  ${`${c.processType} ${c.changeoverType}`.padEnd(22)} ${f(c.current).padEnd(30)} →  ${f(c.target)}${c.changed ? "" : "  (같음)"}`),
  ];
}

export async function runSetup(d: SetupDeps): Promise<SetupResult> {
  // 0) 파일
  const missing = d.missingFiles();
  if (missing.length) {
    d.log("✖ 필요한 파일이 없어 멈춥니다. 아무것도 쓰지 않았습니다.");
    for (const m of missing) d.log(`  - ${m}`);
    return { status: "stopped", reason: "missing-files" };
  }

  // 1) 프로젝트 ID
  if (!d.projectRef) {
    d.log("✖ .env.local 의 DATABASE_URL·NEXT_PUBLIC_SUPABASE_URL 에서 Supabase 프로젝트 ID 를 찾지 못했습니다. 아무것도 쓰지 않았습니다.");
    return { status: "stopped", reason: "no-project-ref" };
  }
  d.log(`[1/5] 연결된 Supabase 프로젝트 ID: ${d.projectRef}`);
  d.log("      운영 DB 가 아닌 내 개발 DB 가 맞는지 확인하세요.");
  const typed = await d.prompt("      확인을 위해 위 프로젝트 ID 를 그대로 입력하세요: ");
  if (!isProjectRefConfirmed(d.projectRef, typed)) {
    d.log("✖ 입력한 ID 가 다릅니다. 아무것도 쓰지 않고 멈춥니다.");
    return { status: "stopped", reason: "wrong-project-ref" };
  }

  // 2) 마이그레이션
  d.log("\n[2/5] 마이그레이션 (적용 안 된 것만)");
  await d.migrate();

  // 3) 운용안
  d.log("\n[3/5] 운용안 가져오기");
  const check = await d.importCheck();
  let imported = false;
  if (check.problems.length) {
    d.log("✖ 쓰기를 막는 문제가 있어 멈춥니다.");
    for (const p of check.problems) d.log(`  - ${p}`);
    return { status: "stopped", reason: "import-problems" };
  }
  if (check.differences.length === 0) {
    d.log("      변경 없음: 이미 같은 운용안이 들어가 있습니다. 건너뜁니다.");
  } else {
    d.log(`      DB 와 다른 항목: ${check.differences.join(", ")}`);
    if (check.confirmedRevs > 0) {
      d.log(`✖ ${check.confirmedGuide}`);
      d.log("  위 명령을 실행한 뒤 npm run setup:real-data 를 다시 실행하면 이어서 진행됩니다.");
      return { status: "stopped", reason: "confirmed-revs" };
    }
    if (!yes(await d.prompt('      위 내용으로 적용할까요? ("yes" 입력 시 적용): '))) {
      d.log("      적용하지 않고 멈춥니다.");
      return { status: "stopped", reason: "declined" };
    }
    await d.importApply();
    imported = true;
  }

  // 4) 교체 계수
  d.log("\n[4/5] 교체 계수 (config/changeover-defaults.json)");
  const changes = await d.coefficientPlan();
  for (const line of formatCoefficientTable(changes)) d.log(line);
  let coefficientsUpdated = false;
  if (!changes.some((c) => c.changed)) {
    d.log("      변경 없음: 이미 같은 값입니다. 건너뜁니다.");
  } else {
    if (!yes(await d.prompt('      위 값으로 바꿀까요? ("yes" 입력 시 적용): '))) {
      d.log("      적용하지 않고 멈춥니다.");
      return { status: "stopped", reason: "declined" };
    }
    await d.coefficientApply(changes.filter((c) => c.changed));
    coefficientsUpdated = true;
  }

  // 5) 요약
  d.log("\n[5/5] 결과 요약");
  for (const line of await d.summary()) d.log(`      ${line}`);
  return { status: "done", imported, coefficientsUpdated };
}
