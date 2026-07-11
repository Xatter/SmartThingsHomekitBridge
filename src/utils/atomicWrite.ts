import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { logger } from './logger';

/**
 * Module-level monotonic counter. Combined with the random suffix, it
 * guarantees a unique temp filename per call even when two concurrent
 * writes to the same target land in the same millisecond (pid + timestamp
 * alone is NOT unique within a process).
 */
let tempFileCounter = 0;

/**
 * Builds a unique temp file path in the same directory as the target.
 * Uniqueness components: pid (across processes), random bytes (across
 * everything), and a monotonic counter (within this process).
 */
function uniqueTempPath(filePath: string): string {
  const random = crypto.randomBytes(6).toString('hex');
  tempFileCounter = (tempFileCounter + 1) % Number.MAX_SAFE_INTEGER;
  return path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.${process.pid}.${random}.${tempFileCounter}.tmp`
  );
}

/**
 * Atomically writes a JSON-serializable value to disk.
 *
 * The value is serialized with `JSON.stringify(data, null, 2)` and written
 * to a unique temporary file in the same directory as the target, then
 * moved into place with `fs.rename`. On the same filesystem, `rename` is
 * atomic, so readers never observe a partially-written file.
 *
 * Parent directories are created as needed. If writing or renaming fails,
 * the temp file is removed on a best-effort basis and the original error
 * is rethrown.
 *
 * @param filePath - Destination path for the JSON file
 * @param data - Value to serialize and write
 *
 * @example
 * ```typescript
 * await atomicWriteJson('./persist/cached_accessories.json', accessories);
 * ```
 */
export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tempFilePath = uniqueTempPath(filePath);
  const serialized = JSON.stringify(data, null, 2);

  try {
    await fs.writeFile(tempFilePath, serialized, 'utf-8');
    await fs.rename(tempFilePath, filePath);
  } catch (error) {
    try {
      await fs.unlink(tempFilePath);
    } catch (unlinkError) {
      // Best-effort cleanup; ignore errors here (e.g. file was never created)
      logger.debug({ tempFilePath, err: unlinkError }, 'Failed to clean up temp file after atomic write failure');
    }

    logger.error({ filePath, tempFilePath, err: error }, 'Atomic write failed');
    throw error;
  }
}
