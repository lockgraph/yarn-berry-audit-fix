import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lookupVersions } from '../../main/ts/metadata.js';
import { startRegistry } from './registry.js';
import { projectRunner, writeYarnConfig } from './project.js';
import { managers } from './pm.js';

const require = createRequire(import.meta.url);
let registry: Awaited<ReturnType<typeof startRegistry>>;
beforeAll(async () => { registry = await startRegistry(); });
afterAll(async () => { await registry?.close(); });

it.each(managers)('reads multiple packages through one native Yarn $version process', async ({ alias }) => {
  const cwd = await mkdtemp(join(tmpdir(), 'berry-metadata-'));
  try {
    await writeFile(join(cwd, 'package.json'), '{"name":"metadata-fixture","private":true}\n');
    await writeFile(join(cwd, 'yarn.lock'), '');
    await writeYarnConfig(cwd, registry.url);
    const { run } = projectRunner(cwd, require.resolve(`${alias}/bin/yarn.js`));
    const observed = vi.fn(run);
    const offset = registry.requests.length;
    const versions = await lookupVersions(['brace-expansion', 'semver', 'brace-expansion'], observed);
    expect(observed).toHaveBeenCalledTimes(1);
    expect(versions['brace-expansion']).toContain('1.1.18');
    expect(versions.semver).toContain('7.8.5');
    expect(registry.requests.slice(offset).sort()).toEqual(['/brace-expansion', '/semver']);
    await expect(lookupVersions(['semver', 'missing-package'], run)).rejects.toThrow(/Package metadata failed|No published versions returned for missing-package/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
