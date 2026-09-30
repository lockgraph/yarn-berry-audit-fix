import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Change } from './plan.js';

interface Descriptor { descriptorHash: string }
interface Project {
  cwd: string;
  storedDescriptors: Map<string, Descriptor>;
  resolutionAliases: Map<string, string>;
}
interface Core {
  structUtils: {
    parseDescriptor(value: string, strict: boolean): Descriptor;
    makeDescriptor(from: Descriptor, range: string): Descriptor;
  };
}

/** Serialized into a temporary plugin; keep this factory independent of module imports. */
function resolutionPlugin(require: (name: string) => unknown, cwd: string, changes: Pick<Change, 'descriptor' | 'to'>[]) {
  const { structUtils } = require('@yarnpkg/core') as Core;
  const { npath } = require('@yarnpkg/fslib') as { npath: { fromPortablePath(path: string): string } };
  const { realpathSync } = require('fs') as typeof import('node:fs');
  return {
    hooks: {
      validateProject(project: Project) {
        // Nested Yarn processes may inherit YARN_PLUGINS while preparing a Git dependency.
        if (realpathSync(npath.fromPortablePath(project.cwd)) !== cwd) return;
        for (const change of changes) {
          const from = structUtils.parseDescriptor(change.descriptor, true);
          const to = structUtils.makeDescriptor(from, `npm:${change.to}`);
          project.storedDescriptors.set(from.descriptorHash, from);
          project.storedDescriptors.set(to.descriptorHash, to);
          project.resolutionAliases.set(from.descriptorHash, to.descriptorHash);
        }
      },
    },
  };
}

/** Load a batch into the project's own Yarn without persisting a plugin or editing its configuration. */
export async function withResolutionAliases<T>(cwd: string, changes: Change[], action: (pluginPath: string) => Promise<T>): Promise<T> {
  const projectPath = await realpath(cwd);
  const directory = await mkdtemp(join(tmpdir(), 'ybaf-plugin-'));
  try {
    const pluginPath = join(directory, 'plugin.cjs');
    const plan = changes.map(({ descriptor, to }) => ({ descriptor, to }));
    const name = `@yarnpkg/${basename(directory)}`;
    const source = `module.exports = { name: ${JSON.stringify(name)}, factory: require => (${resolutionPlugin.toString()})(require, ${JSON.stringify(projectPath)}, ${JSON.stringify(plan)}) };\n`;
    await writeFile(pluginPath, source, { mode: 0o600 });
    return await action(pluginPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
