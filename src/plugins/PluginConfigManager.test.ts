import { PluginConfigManager } from './PluginConfigManager';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Logger } from 'pino';

// Mock fs (atomicWriteJson writes to a temp file, then renames it into place)
jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
    mkdir: jest.fn(),
    rename: jest.fn(),
    unlink: jest.fn(),
  },
}));

const mockFs = fs as jest.Mocked<typeof fs>;

describe('PluginConfigManager', () => {
  let manager: PluginConfigManager;
  let mockLogger: jest.Mocked<Logger>;
  const dataPath = '/tmp/test-data';

  beforeEach(() => {
    jest.clearAllMocks();

    mockLogger = {
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      child: jest.fn().mockReturnThis(),
    } as any;

    manager = new PluginConfigManager(dataPath, mockLogger);
  });

  describe('isEnabled', () => {
    it('returns true when no config entry exists (all plugins enabled by default)', async () => {
      // No config loaded = empty config
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });
      await manager.load();

      expect(manager.isEnabled('some-new-plugin')).toBe(true);
      expect(manager.isEnabled('core-devices')).toBe(true);
      expect(manager.isEnabled('hvac-auto-mode')).toBe(true);
      expect(manager.isEnabled('auto-mode-monitor')).toBe(true);
    });

    it('returns false when config says enabled: false', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({
        'hvac-auto-mode': { enabled: false },
      }));
      await manager.load();

      expect(manager.isEnabled('hvac-auto-mode')).toBe(false);
    });

    it('returns true when config says enabled: true', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({
        'hvac-auto-mode': { enabled: true },
      }));
      await manager.load();

      expect(manager.isEnabled('hvac-auto-mode')).toBe(true);
    });
  });

  describe('setEnabled', () => {
    it('persists and is reflected in subsequent isEnabled() calls', async () => {
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.rename.mockResolvedValue(undefined);
      await manager.load();

      // Initially enabled by default
      expect(manager.isEnabled('hvac-auto-mode')).toBe(true);

      // Disable it
      await manager.setEnabled('hvac-auto-mode', false);
      expect(manager.isEnabled('hvac-auto-mode')).toBe(false);

      // Verify it was persisted atomically: written to a temp file alongside the
      // target, then renamed into place at the real config path.
      const finalPath = path.join(dataPath, 'plugin_config.json');
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(`${finalPath}.`),
        expect.stringContaining('"enabled": false'),
        'utf-8'
      );
      expect(mockFs.rename).toHaveBeenCalledWith(
        expect.stringContaining(`${finalPath}.`),
        finalPath
      );

      // Re-enable it
      await manager.setEnabled('hvac-auto-mode', true);
      expect(manager.isEnabled('hvac-auto-mode')).toBe(true);
    });
  });

  describe('save', () => {
    it('produces a valid JSON file matching the in-memory config', async () => {
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.rename.mockResolvedValue(undefined);
      await manager.load();

      await manager.setPluginConfig('hvac-auto-mode', { threshold: 5 });
      await manager.setEnabled('core-devices', false);

      const lastWriteCall = mockFs.writeFile.mock.calls[mockFs.writeFile.mock.calls.length - 1];
      const writtenContent = lastWriteCall[1] as string;

      // Content written to disk must be valid, parseable JSON...
      const parsed = JSON.parse(writtenContent);
      // ...and must match what getAllConfigs() reports as current state.
      expect(parsed).toEqual(manager.getAllConfigs());
      expect(parsed['hvac-auto-mode'].config).toEqual({ threshold: 5 });
      expect(parsed['core-devices'].enabled).toBe(false);
    });
  });
});
