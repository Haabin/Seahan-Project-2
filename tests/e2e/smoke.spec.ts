import { test, expect } from "@playwright/test";

/**
 * 스모크 테스트. E2E_EMAIL / E2E_PASSWORD 환경변수(작성 권한 계정)가 있을 때만 로그인 이후를 검증한다.
 */
const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;

test("NFR-02 미로그인 사용자는 /login 으로 이동한다", async ({ page }) => {
  await page.goto("/plan");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByTestId("login-form")).toBeVisible();
});

test.describe("로그인 이후", () => {
  test.skip(!email || !password, "E2E_EMAIL / E2E_PASSWORD 가 없어 건너뜀");

  test("FR-10 로그인 → 생산계획표 → 셀 편집창에서 바꾸고 Esc 로 닫으면 계획표·경고가 그대로다", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("이메일").fill(email!);
    await page.getByLabel("비밀번호").fill(password!);
    await page.getByRole("button", { name: "로그인" }).click();
    await expect(page).toHaveURL(/\/plan/, { timeout: 30_000 });
    await expect(page.getByTestId("gantt-grid")).toBeVisible({ timeout: 60_000 });

    const warnings = page.getByTestId("warning-count");
    const before = await warnings.textContent();

    // 첫 번째 편집 가능한 셀을 열어 금형을 바꾼 뒤 Esc 로 취소한다 (DB 에 쓰지 않는 경로)
    const cell = page.getByTestId("gantt-cell").first();
    const cellBefore = await cell.textContent();
    await cell.click();
    const popover = page.getByTestId("cell-editor");
    await expect(popover).toBeVisible();
    const select = popover.getByTestId("product-select");
    const options = await select.locator("option").allTextContents();
    if (options.length > 2) {
      await select.selectOption({ index: options.length - 1 });
      // "완료" 전에는 계획표 칸·경고 수가 바뀌지 않는다
      expect(await cell.textContent()).toBe(cellBefore);
      expect(await warnings.textContent()).toBe(before);
      await page.keyboard.press("Escape");
      await expect(popover).toBeHidden();
      expect(await cell.textContent()).toBe(cellBefore);
      expect(await warnings.textContent()).toBe(before);
    }
  });

  test("FR-04 사유 없이 변경 저장은 거부된다", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("이메일").fill(email!);
    await page.getByLabel("비밀번호").fill(password!);
    await page.getByRole("button", { name: "로그인" }).click();
    await expect(page).toHaveURL(/\/plan/, { timeout: 30_000 });
    await expect(page.getByTestId("gantt-grid")).toBeVisible({ timeout: 60_000 });
    const saveBtn = page.getByTestId("save-revision");
    if (await saveBtn.isVisible()) {
      await saveBtn.click();
      const dialog = page.getByTestId("revision-dialog");
      await expect(dialog).toBeVisible();
      const confirm = dialog.getByTestId("revision-confirm");
      const isFirst = (await dialog.getAttribute("data-first-confirm")) === "true";
      if (!isFirst) {
        await expect(confirm).toBeDisabled();
      }
    }
  });
});
