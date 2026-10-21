const fs = require('node:fs').promises;
const path = require('node:path');
const { deleteContents } = require('../src/delete-engine');

(async () => {
  // Benchmark only disposable fixtures on the project drive.
  const root = await fs.mkdtemp(path.join(process.cwd(), 'benchmark-'));
  try {
    for (const parallel of [1, 16]) {
      const cache = path.join(root, String(parallel));
      await fs.mkdir(cache);
      for (let d = 0; d < 20; d++) {
        const dir = path.join(cache, String(d));
        await fs.mkdir(dir);
        await Promise.all(Array.from({ length: 100 }, (_, i) => fs.writeFile(path.join(dir, `${i}.tmp`), Buffer.alloc(1024))));
      }
      const result = { cleanedFiles: 0, cleanedBytes: 0, skippedFiles: 0, errors: [] };
      const started = performance.now();
      await deleteContents(cache, result, { concurrency: parallel });
      console.log(JSON.stringify({ concurrency: parallel, files: result.cleanedFiles, elapsedMs: Math.round(performance.now() - started), errors: result.errors.length }));
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
