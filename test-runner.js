import { readdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

async function runTests() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const testDir = path.join(__dirname, 'tests');
  const files = await readdir(testDir);
  let passed = 0;
  let failed = 0;

  for (const file of files.filter(f => f.endsWith('.test.js'))) {
    const module = await import(path.join(testDir, file));
    for (const [name, testFn] of Object.entries(module)) {
      if (typeof testFn === 'function') {
        try {
          await testFn();
          console.log(`\u2713 ${name}`);
          passed++;
        } catch (err) {
          console.error(`\u2717 ${name}`);
          console.error(err);
          failed++;
        }
      }
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

runTests();
