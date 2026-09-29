import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Read the installed manifest, including version changes made after compilation by the release job. */
export async function packageVersion(moduleUrl = import.meta.url): Promise<string> {
  let directory = dirname(fileURLToPath(moduleUrl));
  for (;;) {
    try {
      const manifest: unknown = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (!manifest || typeof manifest !== 'object' || !('version' in manifest) || typeof manifest.version !== 'string') {
        throw new Error('Package manifest has no version');
      }
      return manifest.version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(directory) === directory) throw error;
      directory = dirname(directory);
    }
  }
}
