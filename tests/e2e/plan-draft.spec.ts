import { existsSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";

/**
 * 생산계획 스모크 (v0.4):
 *   ① 생산배대 업로드 → 미리보기 → 확정 저장
 *   ② 주문 입력 → 초안 자동 생성 → 셀 수정 표시 → 확정
 * E2E_EMAIL / E2E_PASSWORD(작성 권한 계정)와 가상 생산배대(npm run fake-data)가 있을 때만 돈다. 시연용 DB 에서만 돌린다.
 */
const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;
const fakeBaedae = join(process.cwd(), "data", "fake", "가상_생산배대_2610_4주 (Rev. 1).xlsx");

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("이메일").fill(email!);
  await page.getByLabel("비밀번호").fill(password!);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/plan/, { timeout: 30_000 });
}

test.describe.serial("생산계획 초안", () => {
  test.skip(!email || !password, "E2E_EMAIL / E2E_PASSWORD 가 없어 건너뜀");
  test.skip(!existsSync(fakeBaedae), "data/fake 가상 생산배대가 없어 건너뜀 (npm run fake-data)");

  test("생산배대 업로드 → 미리보기(네모·화살표) → 확정 Rev 저장", async ({ page }) => {
    await login(page);
    await expect(page.getByTestId("gantt-grid")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "엑셀 가져오기" }).click();
    const dialog = page.getByTestId("import-dialog");
    await dialog.locator('input[type="file"]').setInputFiles(fakeBaedae);
    await dialog.getByRole("button", { name: "가져오기" }).click();

    const preview = dialog.getByTestId("baedae-preview");
    await expect(preview).toBeVisible({ timeout: 30_000 });
    await expect(preview).toContainText("생산배대 형식");
    await expect(preview).toContainText("2026-10-22");
    await expect(preview.getByTestId("baedae-gantt").getByRole("img", { name: "Full set 교체" }).first()).toBeVisible();
    await expect(preview.getByLabel("Rev 번호")).toHaveValue("1");

    await preview.getByRole("button", { name: "확정 Rev로 저장" }).click();
    await expect(page).toHaveURL(/period=2026-10-22/, { timeout: 60_000 });
    await expect(page.getByTestId("gantt-grid")).toBeVisible({ timeout: 60_000 });
  });

  test("주문 입력 → 초안 자동 생성 → 셀 수정 표시 → 확정", async ({ page }) => {
    test.setTimeout(180_000); // 개발 서버는 화면을 처음 열 때 컴파일 시간이 든다
    await login(page);

    // 주문 입력
    await page.goto("/orders");
    const product = page.getByLabel("품명", { exact: true });
    await product.selectOption({ index: 1 });
    await page.getByLabel("수량").fill("150000");
    await page.getByLabel("납기일").fill("2026-11-20");
    await page.getByRole("button", { name: "주문 추가" }).click();
    await expect(page.getByRole("status")).toContainText("주문을 추가했습니다", { timeout: 30_000 });
    await expect(page.getByTestId("orders-table")).toBeVisible();

    // 초안 자동 생성
    await page.goto("/plan?period=2026-11-12");
    await expect(page.getByTestId("gantt-grid")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("draft-open").click();
    const dlg = page.getByTestId("draft-dialog");
    await expect(dlg).toContainText("진행 중 주문");
    await dlg.getByText("전체 다시 만들기").click();
    page.once("dialog", (d) => d.accept());
    await dlg.getByTestId("draft-run").click();
    await expect(page.getByTestId("draft-result")).toContainText("초안 셀", { timeout: 10_000 });
    const auto = page.locator('[data-origin="auto"]');
    await expect(auto.first()).toBeVisible();

    // 셀 수정 → "사람이 수정" 으로 표시가 바뀐다
    const before = await auto.count();
    await auto.first().click();
    const editor = page.getByTestId("cell-editor");
    await expect(editor.getByTestId("cell-basis")).toContainText("자동 생성");
    await expect(editor.getByTestId("mold-select")).toBeVisible();
    await editor.locator('input[type="number"]').fill("12345");
    await expect(editor.getByTestId("cell-basis")).toContainText("사람이 입력");
    await editor.getByRole("button", { name: "완료" }).click();
    await expect(auto).toHaveCount(before - 1);
    await expect(page.getByTestId("save-state")).toContainText("저장됨", { timeout: 15_000 });

    // 확정은 사람이: 기존 확정 흐름
    await page.getByTestId("save-revision").click();
    const rev = page.getByTestId("revision-dialog");
    await expect(rev).toBeVisible();
    if ((await rev.getAttribute("data-first-confirm")) !== "true") {
      await rev.getByRole("button", { name: "급발주" }).click();
      await rev.locator("textarea").fill("E2E: 초안 자동 생성 확인");
    }
    await rev.getByTestId("revision-confirm").click();
    await expect(rev).toBeHidden({ timeout: 30_000 });
  });
});
