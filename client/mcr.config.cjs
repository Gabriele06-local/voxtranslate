// monocart-coverage-reports config — maps Playwright V8 coverage back to the
// TypeScript sources and reports only our client modules (src/scripts/*).
module.exports = {
  name: 'VoxTranslate client coverage',
  outputDir: './coverage',
  reports: [['v8'], ['console-details'], ['json-summary']],
  // Only the app bundle entries (skip Astro/vendor runtime).
  entryFilter: (entry) => entry.url.includes('/_astro/'),
  // Keep only our own TypeScript sources in the final report.
  sourceFilter: (sourcePath) => sourcePath.includes('src/scripts/'),
  lcov: false,
};
