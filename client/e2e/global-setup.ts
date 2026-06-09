import { CoverageReport } from 'monocart-coverage-reports';
import options from '../mcr.config.cjs';

// Clear any stale raw coverage before the run.
export default async function globalSetup(): Promise<void> {
  const mcr = new CoverageReport(options);
  await mcr.cleanCache();
}
