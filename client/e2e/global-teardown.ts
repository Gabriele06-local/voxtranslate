import { CoverageReport } from 'monocart-coverage-reports';
import options from '../mcr.config.cjs';

// Merge all collected raw coverage into the final report.
export default async function globalTeardown(): Promise<void> {
  const mcr = new CoverageReport(options);
  const results = await mcr.generate();
  const pct = results?.summary?.lines?.pct;
  if (pct != null) {
    // eslint-disable-next-line no-console
    console.log(`\n📊 client script coverage: ${pct}% lines`);
  }
}
