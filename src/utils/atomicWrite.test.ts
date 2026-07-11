import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { atomicWriteJson } from './atomicWrite';
import { logger } from './logger';

// Mock the logger to avoid console output during tests
jest.mock('./logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('atomicWriteJson', () => {
  let tempDir: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-write-test-'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('creates parent directories that do not exist', async () => {
    const targetPath = path.join(tempDir, 'nested', 'deeper', 'data.json');

    await atomicWriteJson(targetPath, { hello: 'world' });

    const stat = await fs.stat(targetPath);
    expect(stat.isFile()).toBe(true);
  });

  it('writes valid JSON that matches the input data', async () => {
    const targetPath = path.join(tempDir, 'data.json');
    const data = { a: 1, b: ['x', 'y'], nested: { c: true } };

    await atomicWriteJson(targetPath, data);

    const contents = await fs.readFile(targetPath, 'utf-8');
    expect(JSON.parse(contents)).toEqual(data);
    expect(contents).toBe(JSON.stringify(data, null, 2));
  });

  it('leaves no .tmp files behind after a successful write', async () => {
    const targetPath = path.join(tempDir, 'data.json');

    await atomicWriteJson(targetPath, { ok: true });

    const entries = await fs.readdir(tempDir);
    expect(entries).toEqual(['data.json']);
    expect(entries.some((entry) => entry.endsWith('.tmp'))).toBe(false);
  });

  it('writes the temp file in the same directory as the target with a unique name', async () => {
    const targetPath = path.join(tempDir, 'data.json');
    const writeFileSpy = jest.spyOn(fs, 'writeFile');

    await atomicWriteJson(targetPath, { ok: true });

    expect(writeFileSpy).toHaveBeenCalledTimes(1);
    const tempFilePathArg = writeFileSpy.mock.calls[0][0] as string;
    expect(path.dirname(tempFilePathArg)).toBe(tempDir);
    // Format: <basename>.<pid>.<12 hex chars>.<counter>.tmp
    expect(tempFilePathArg).toMatch(new RegExp(`data\\.json\\.${process.pid}\\.[0-9a-f]{12}\\.\\d+\\.tmp$`));
  });

  it('generates a distinct temp file per call, even for the same target', async () => {
    const targetPath = path.join(tempDir, 'data.json');
    const writeFileSpy = jest.spyOn(fs, 'writeFile');

    // Kick off both writes concurrently so pid + timestamp would collide.
    await Promise.all([
      atomicWriteJson(targetPath, { call: 1 }),
      atomicWriteJson(targetPath, { call: 2 }),
    ]);

    expect(writeFileSpy).toHaveBeenCalledTimes(2);
    const tempPaths = writeFileSpy.mock.calls.map((call) => call[0] as string);
    expect(tempPaths[0]).not.toBe(tempPaths[1]);
  });

  it('handles concurrent writes to the same target: both resolve, valid JSON, no leftovers', async () => {
    const targetPath = path.join(tempDir, 'data.json');
    const dataA = { writer: 'a', payload: 'x'.repeat(10000) };
    const dataB = { writer: 'b', payload: 'y'.repeat(10000) };

    // Both must resolve (no ENOENT from a shared temp file being renamed away).
    await expect(
      Promise.all([
        atomicWriteJson(targetPath, dataA),
        atomicWriteJson(targetPath, dataB),
      ])
    ).resolves.toBeDefined();

    // Final contents must be valid JSON equal to exactly one of the inputs
    // (no byte interleaving from a shared temp file).
    const contents = await fs.readFile(targetPath, 'utf-8');
    const parsed = JSON.parse(contents);
    expect([dataA, dataB]).toContainEqual(parsed);

    // No leftover temp files.
    const entries = await fs.readdir(tempDir);
    expect(entries).toEqual(['data.json']);
  });

  it('survives many concurrent writes to the same target within the same millisecond', async () => {
    const targetPath = path.join(tempDir, 'data.json');
    const inputs = Array.from({ length: 8 }, (_, i) => ({ writer: i }));

    await expect(
      Promise.all(inputs.map((input) => atomicWriteJson(targetPath, input)))
    ).resolves.toBeDefined();

    const parsed = JSON.parse(await fs.readFile(targetPath, 'utf-8'));
    expect(inputs).toContainEqual(parsed);

    const entries = await fs.readdir(tempDir);
    expect(entries).toEqual(['data.json']);
  });

  it('cleans up the temp file and rethrows when rename fails', async () => {
    const targetPath = path.join(tempDir, 'data.json');
    const renameError = new Error('rename failed');
    const renameSpy = jest.spyOn(fs, 'rename').mockRejectedValueOnce(renameError);

    await expect(atomicWriteJson(targetPath, { ok: true })).rejects.toThrow('rename failed');

    renameSpy.mockRestore();

    // Target should never have been created since rename never completed.
    await expect(fs.stat(targetPath)).rejects.toThrow();

    // The temp file written before the failed rename should be cleaned up.
    const entries = await fs.readdir(tempDir);
    expect(entries.some((entry) => entry.endsWith('.tmp'))).toBe(false);
    expect(logger.error).toHaveBeenCalled();
  });

  it('rethrows and cleans up a partially-written temp file when writeFile fails', async () => {
    const targetPath = path.join(tempDir, 'data.json');
    const writeError = new Error('write failed');
    const realWriteFile = fs.writeFile;

    // Simulate a partial write: the temp file IS created on disk, then the
    // write fails (e.g. ENOSPC mid-write). Cleanup must remove it.
    const writeSpy = jest.spyOn(fs, 'writeFile').mockImplementationOnce(async (file, _data) => {
      await realWriteFile(file as string, 'partial garbage', 'utf-8');
      throw writeError;
    });

    await expect(atomicWriteJson(targetPath, { ok: true })).rejects.toThrow('write failed');

    writeSpy.mockRestore();

    // Target must not exist and the partial temp file must be cleaned up.
    await expect(fs.stat(targetPath)).rejects.toThrow();
    const entries = await fs.readdir(tempDir);
    expect(entries.some((entry) => entry.endsWith('.tmp'))).toBe(false);
    expect(logger.error).toHaveBeenCalled();
  });

  it('overwrites an existing file atomically, leaving only the final contents', async () => {
    const targetPath = path.join(tempDir, 'data.json');

    await atomicWriteJson(targetPath, { version: 1 });
    await atomicWriteJson(targetPath, { version: 2 });

    const contents = await fs.readFile(targetPath, 'utf-8');
    expect(JSON.parse(contents)).toEqual({ version: 2 });

    const entries = await fs.readdir(tempDir);
    expect(entries).toEqual(['data.json']);
  });
});
