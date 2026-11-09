import { test, expect } from "@playwright/test";

/**
 * NFR-02 로그인 오류 메시지 원인별 구분.
 * (a) 틀린 비밀번호 → 불일치 메시지, (b) Supabase 요청 차단(route.abort) → 연결 실패 메시지.
 * 실제 Supabase 프로젝트가 필요하므로 E2E_EMAIL 이 있을 때만 (a)를 실행한다. (b)는 네트워크를 막으므로 계정이 없어도 된다.
 */
const email = process.env.E2E_EMAIL;

test("(b) Supabase 인증 서버 요청이 차단되면 연결 실패 메시지가 나온다", async ({ page }) => {
  await page.route(/supabase\.co\/auth\/v1\//, (route) => route.abort("failed"));
  await page.goto("/login");
  await page.getByLabel("이메일").fill(email ?? "someone@saehan.test");
  await page.getByLabel("비밀번호").fill("whatever-password");
  const submit = page.getByTestId("login-submit");
  await submit.click();
  // 차단은 즉시 실패하므로 "로그인 중…" 상태는 (b-2)에서 검증한다
  const err = page.getByTestId("login-error");
  await expect(err).toBeVisible({ timeout: 20_000 });
  await expect(err).toHaveAttribute("data-kind", "network");
  await expect(err).toContainText("서버에 연결할 수 없습니다");
  await expect(submit).toBeEnabled();
});

test("(a) 틀린 비밀번호는 불일치 메시지가 나온다", async ({ page }) => {
  test.skip(!email, "E2E_EMAIL 이 없어 건너뜀");
  await page.goto("/login");
  await page.getByLabel("이메일").fill(email!);
  await page.getByLabel("비밀번호").fill("definitely-wrong-password-123");
  await page.getByTestId("login-submit").click();
  const err = page.getByTestId("login-error");
  await expect(err).toBeVisible({ timeout: 20_000 });
  await expect(err).toHaveAttribute("data-kind", "invalid_credentials");
  await expect(err).toHaveText("이메일 또는 비밀번호가 올바르지 않습니다.");
  await expect(page.getByTestId("login-submit")).toBeEnabled();
});

test("(b-2) 응답이 15초 넘게 없으면 연결 실패로 처리한다", async ({ page }) => {
  test.setTimeout(60_000);
  // 요청을 영원히 보류한다(응답하지 않음)
  await page.route(/supabase\.co\/auth\/v1\//, () => new Promise<void>(() => {}));
  await page.goto("/login");
  await page.getByLabel("이메일").fill(email ?? "someone@saehan.test");
  await page.getByLabel("비밀번호").fill("whatever-password");
  const submit = page.getByTestId("login-submit");
  await submit.click();
  // 요청 중에는 버튼이 비활성화되고 "로그인 중…"을 표시한다
  await expect(submit).toBeDisabled();
  await expect(submit).toHaveText("로그인 중…");
  const err = page.getByTestId("login-error");
  await expect(err).toBeVisible({ timeout: 25_000 });
  await expect(err).toHaveAttribute("data-kind", "network");
  await expect(submit).toBeEnabled();
});
