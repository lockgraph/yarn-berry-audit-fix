import { createHash } from 'node:crypto';
import { copyFile, open, readFile, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';

/** Keep the original inode beside its working copy until Yarn has finished. */
export async function withManifestBackups<T>(paths: Iterable<string>, action: () => Promise<T>): Promise<T> {
  const backups: { path: string; backup: string }[] = [];
  let result!: T;
  let failed = false;
  let failure: unknown;
  try {
    for (const path of new Set(paths)) {
      const hash = createHash('sha256').update(await readFile(path)).digest('hex');
      const backup = `${path}-${hash}.backup`;
      // Reserve the name so an earlier backup is never overwritten.
      const reservation = await open(backup, 'wx', 0o600);
      await reservation.close();
      try {
        await rename(path, backup);
      } catch (error) {
        await rm(backup);
        throw error;
      }
      backups.push({ path, backup });
      await copyFile(backup, path, constants.COPYFILE_EXCL);
    }
    result = await action();
  } catch (error) {
    failed = true;
    failure = error;
  }

  const errors: unknown[] = [];
  const retained: string[] = [];
  for (const { path, backup } of backups.reverse()) {
    try {
      await rename(backup, path);
    } catch (error) {
      errors.push(error);
      retained.push(backup);
    }
  }
  if (errors.length) {
    throw new AggregateError(failed ? [failure, ...errors] : errors,
      `Could not restore manifests; original files retained at: ${retained.join(', ')}`);
  }
  if (failed) throw failure;
  return result;
}
