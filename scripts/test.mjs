/**
 * Run the suite on any supported Node, on any OS.
 *
 * WHY THIS EXISTS. `node --test test/` is not portable: on Node 22 the runner treats a directory argument as a
 * MODULE and fails with `Cannot find module '.../test'`, while newer Node versions accept a directory and Windows
 * shells do not expand `test/*.test.ts` for npm scripts. That combination means the obvious command passes on the
 * maintainer's machine and fails in CI — which is exactly what it did, on the first run of this repository's
 * workflow, for both Node versions in the matrix. So the file list is resolved here, in Node, and passed
 * explicitly: one command that behaves the same everywhere.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = fileURLToPath(new URL('../test/', import.meta.url));
const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => path.join(testDir, name));

if (files.length === 0) {
  // A runner that silently passes when it found nothing is worse than no runner at all.
  console.error(`[test] no *.test.ts files found in ${testDir}`);
  process.exit(2);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
