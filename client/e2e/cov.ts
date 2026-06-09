// Playwright V8 coverage collection → monocart (mapped back to src/scripts/*.ts).
import type { Page } from '@playwright/test';
import { CoverageReport } from 'monocart-coverage-reports';
import options from '../mcr.config.cjs';

const canCover = (page: Page) =>
  // Chromium-only API.
  typeof (page as unknown as { coverage?: { startJSCoverage?: unknown } }).coverage?.startJSCoverage ===
  'function';

export async function startCoverage(page: Page): Promise<void> {
  if (canCover(page)) await page.coverage.startJSCoverage({ resetOnNavigation: false });
}

export async function collectCoverage(page: Page): Promise<void> {
  if (!canCover(page)) return;
  const list = await page.coverage.stopJSCoverage();
  const report = new CoverageReport(options);
  await report.add(list);
}
