import { test, expect } from "../fixtures"
import { promptSelector } from "../selectors"

test("smoke $mention opens skill popover", async ({ page, gotoSession }) => {
  await gotoSession()

  await page.locator(promptSelector).click()
  await page.keyboard.type("$")

  const popover = page.locator('[data-component="prompt-popover"]')
  await expect(popover).toBeVisible()
})
