import { existsSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";

/**
 * 재고현황 스모크: 업로드 → 미리보기 → 반영 → 다운로드.
 * E2E_EMAIL / E2E_PASSWORD(작성 권한 계정)와 가상 수불표(npm run fake-data)가 있을 때만 돈다.
 * 가상 수불표의 월(2026-11) 데이터를 교체하므로 시연용 DB 에서만 돌린다.
 */
const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;
const fakeLedger = join(process.cwd(), "data", "fake", "가상_제품수불표_2026-11.xlsx");

test.describe("재고현황", () => {
  test.skip(!email || !password, "E2E_EMAIL / E2E_PASSWORD 가 없어 건너뜀");
  test.skip(!existsSync(fakeLedger), "data/fake 가상 수불표가 없어 건너뜀 (npm run fake-data)");

  test("수불표 업로드 → 미리보기 → 반영 → 엑셀 다운로드", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("이메일").fill(email!);
    await page.getByLabel("비밀번호").fill(password!);
    await page.getByRole("button", { name: "로그인" }).click();
    await expect(page).toHaveURL(/\/plan/, { timeout: 30_000 });

    await page.getByRole("link", { name: "재고현황" }).click();
    await expect(page).toHaveURL(/\/inventory/);

    await page.getByRole("button", { name: "엑셀 업로드" }).click();
    const dialog = page.getByRole("dialog", { name: "제품수불표 업로드" });
    await dialog.getByLabel("제품수불표 파일").setInputFiles(fakeLedger);
    const preview = dialog.getByTestId("stock-upload-preview");
    await expect(preview).toBeVisible({ timeout: 30_000 });
    await expect(preview).toContainText("반영될 품목");
    await expect(dialog.getByLabel("월", { exact: true })).toHaveValue("11");

    await dialog.getByLabel("연도").fill("2026");
    await dialog.getByRole("button", { name: /반영/ }).click();
    await expect(page).toHaveURL(/ym=2026-11/, { timeout: 60_000 });
    await expect(page.getByTestId("inventory-table")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("status")).toContainText("반영했습니다");

    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "엑셀 다운로드" }).click()]);
    expect(download.suggestedFilename()).toContain("2026-11");
  });
});
