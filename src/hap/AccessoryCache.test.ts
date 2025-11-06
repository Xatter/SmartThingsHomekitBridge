import { AccessoryCache, CachedAccessory } from './AccessoryCache';
import { promises as fs } from 'fs';
import * as path from 'path';

// Mock fs module
jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
  },
}));

describe('AccessoryCache', () => {
  let cache: AccessoryCache;
  const mockPersistPath = '/test/persist';
  const mockCacheFile = path.join(mockPersistPath, 'cached_accessories.json');

  const createMockAccessory = (overrides: Partial<CachedAccessory> = {}): CachedAccessory => ({
    deviceId: 'device-123',
    name: 'Test Thermostat',
    uuid: 'uuid-123',
    manufacturer: 'SmartThings',
    model: 'HVAC Thermostat',
    serialNumber: 'device-123',
    firmwareRevision: '1.0.0',
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    cache = new AccessoryCache(mockPersistPath);
  });

  describe('load', () => {
    test('given cache file exists, should load and return accessories', async () => {
      const mockAccessories: CachedAccessory[] = [
        createMockAccessory({ deviceId: 'device-1', name: 'Thermostat 1' }),
        createMockAccessory({ deviceId: 'device-2', name: 'Thermostat 2' }),
      ];

      (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(mockAccessories));

      const actual = await cache.load();
      const expected = mockAccessories;

      expect(actual).toEqual(expected);
      expect(fs.readFile).toHaveBeenCalledWith(mockCacheFile, 'utf-8');
    });

    test('given cache file does not exist, should return empty array', async () => {
      const error: NodeJS.ErrnoException = new Error('File not found');
      error.code = 'ENOENT';
      (fs.readFile as jest.Mock).mockRejectedValue(error);

      const actual = await cache.load();
      const expected: CachedAccessory[] = [];

      expect(actual).toEqual(expected);
    });

    test('given cache file is corrupted, should return empty array', async () => {
      (fs.readFile as jest.Mock).mockResolvedValue('invalid json {');

      const actual = await cache.load();
      const expected: CachedAccessory[] = [];

      expect(actual).toEqual(expected);
    });

    test('given other file read error, should return empty array and log error', async () => {
      const error = new Error('Permission denied');
      (fs.readFile as jest.Mock).mockRejectedValue(error);

      const actual = await cache.load();
      const expected: CachedAccessory[] = [];

      expect(actual).toEqual(expected);
    });
  });

  describe('save', () => {
    test('given accessories array, should save to cache file with formatting', async () => {
      const mockAccessories: CachedAccessory[] = [
        createMockAccessory({ deviceId: 'device-1' }),
      ];

      await cache.save(mockAccessories);

      expect(fs.writeFile).toHaveBeenCalledWith(
        mockCacheFile,
        JSON.stringify(mockAccessories, null, 2)
      );
    });

    test('given empty array, should save empty cache', async () => {
      const mockAccessories: CachedAccessory[] = [];

      await cache.save(mockAccessories);

      expect(fs.writeFile).toHaveBeenCalledWith(
        mockCacheFile,
        JSON.stringify([], null, 2)
      );
    });

    test('given write error, should handle gracefully', async () => {
      const error = new Error('Disk full');
      (fs.writeFile as jest.Mock).mockRejectedValue(error);

      const mockAccessories: CachedAccessory[] = [createMockAccessory()];

      // Should not throw
      await expect(cache.save(mockAccessories)).resolves.not.toThrow();
    });
  });

  describe('addOrUpdate', () => {
    beforeEach(async () => {
      // Pre-populate cache with existing accessories
      const existingAccessories: CachedAccessory[] = [
        createMockAccessory({ deviceId: 'device-1', name: 'Existing 1' }),
        createMockAccessory({ deviceId: 'device-2', name: 'Existing 2' }),
      ];
      (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(existingAccessories));
      await cache.load();
    });

    test('given new accessory, should add to cache', async () => {
      const newAccessory = createMockAccessory({
        deviceId: 'device-3',
        name: 'New Thermostat'
      });

      await cache.addOrUpdate(newAccessory);

      const savedData = (fs.writeFile as jest.Mock).mock.calls[0][1];
      const savedAccessories: CachedAccessory[] = JSON.parse(savedData);

      expect(savedAccessories).toHaveLength(3);
      expect(savedAccessories[2]).toEqual(newAccessory);
    });

    test('given existing deviceId, should update accessory', async () => {
      const updatedAccessory = createMockAccessory({
        deviceId: 'device-1',
        name: 'Updated Thermostat',
        firmwareRevision: '2.0.0'
      });

      await cache.addOrUpdate(updatedAccessory);

      const savedData = (fs.writeFile as jest.Mock).mock.calls[0][1];
      const savedAccessories: CachedAccessory[] = JSON.parse(savedData);

      expect(savedAccessories).toHaveLength(2);
      expect(savedAccessories[0]).toEqual(updatedAccessory);
      expect(savedAccessories[0].name).toBe('Updated Thermostat');
      expect(savedAccessories[0].firmwareRevision).toBe('2.0.0');
    });

    test('given update to middle item, should preserve other items', async () => {
      const updatedAccessory = createMockAccessory({
        deviceId: 'device-1',
        name: 'Updated Middle'
      });

      await cache.addOrUpdate(updatedAccessory);

      const savedData = (fs.writeFile as jest.Mock).mock.calls[0][1];
      const savedAccessories: CachedAccessory[] = JSON.parse(savedData);

      expect(savedAccessories[0].deviceId).toBe('device-1');
      expect(savedAccessories[0].name).toBe('Updated Middle');
      expect(savedAccessories[1].deviceId).toBe('device-2');
      expect(savedAccessories[1].name).toBe('Existing 2');
    });
  });

  describe('remove', () => {
    beforeEach(async () => {
      const existingAccessories: CachedAccessory[] = [
        createMockAccessory({ deviceId: 'device-1', name: 'Thermostat 1' }),
        createMockAccessory({ deviceId: 'device-2', name: 'Thermostat 2' }),
        createMockAccessory({ deviceId: 'device-3', name: 'Thermostat 3' }),
      ];
      (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(existingAccessories));
      await cache.load();
    });

    test('given existing deviceId, should remove accessory', async () => {
      await cache.remove('device-2');

      const savedData = (fs.writeFile as jest.Mock).mock.calls[0][1];
      const savedAccessories: CachedAccessory[] = JSON.parse(savedData);

      expect(savedAccessories).toHaveLength(2);
      expect(savedAccessories[0].deviceId).toBe('device-1');
      expect(savedAccessories[1].deviceId).toBe('device-3');
    });

    test('given non-existent deviceId, should not change cache', async () => {
      await cache.remove('device-999');

      const savedData = (fs.writeFile as jest.Mock).mock.calls[0][1];
      const savedAccessories: CachedAccessory[] = JSON.parse(savedData);

      expect(savedAccessories).toHaveLength(3);
    });

    test('given last remaining device, should result in empty cache', async () => {
      await cache.remove('device-1');
      await cache.remove('device-2');
      await cache.remove('device-3');

      const savedData = (fs.writeFile as jest.Mock).mock.calls[2][1];
      const savedAccessories: CachedAccessory[] = JSON.parse(savedData);

      expect(savedAccessories).toHaveLength(0);
    });
  });

  describe('getAll', () => {
    test('given loaded accessories, should return all accessories', async () => {
      const mockAccessories: CachedAccessory[] = [
        createMockAccessory({ deviceId: 'device-1' }),
        createMockAccessory({ deviceId: 'device-2' }),
      ];
      (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(mockAccessories));
      await cache.load();

      const actual = cache.getAll();
      const expected = mockAccessories;

      expect(actual).toEqual(expected);
    });

    test('given empty cache, should return empty array', () => {
      const actual = cache.getAll();
      const expected: CachedAccessory[] = [];

      expect(actual).toEqual(expected);
    });
  });

  describe('has', () => {
    beforeEach(async () => {
      const existingAccessories: CachedAccessory[] = [
        createMockAccessory({ deviceId: 'device-1' }),
        createMockAccessory({ deviceId: 'device-2' }),
      ];
      (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(existingAccessories));
      await cache.load();
    });

    test('given existing deviceId, should return true', () => {
      const actual = cache.has('device-1');
      const expected = true;

      expect(actual).toBe(expected);
    });

    test('given non-existent deviceId, should return false', () => {
      const actual = cache.has('device-999');
      const expected = false;

      expect(actual).toBe(expected);
    });

    test('given empty cache, should return false', () => {
      cache = new AccessoryCache(mockPersistPath);

      const actual = cache.has('device-1');
      const expected = false;

      expect(actual).toBe(expected);
    });
  });

  describe('integration: load-modify-save cycle', () => {
    test('full cycle: load, add, update, remove, save', async () => {
      // Initial load
      const initialAccessories: CachedAccessory[] = [
        createMockAccessory({ deviceId: 'device-1', name: 'Initial' }),
      ];
      (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(initialAccessories));
      await cache.load();

      // Add new device
      await cache.addOrUpdate(createMockAccessory({
        deviceId: 'device-2',
        name: 'Added'
      }));

      // Update existing device
      await cache.addOrUpdate(createMockAccessory({
        deviceId: 'device-1',
        name: 'Updated'
      }));

      // Remove a device
      await cache.remove('device-2');

      // Verify final state
      const finalAccessories = cache.getAll();
      expect(finalAccessories).toHaveLength(1);
      expect(finalAccessories[0].deviceId).toBe('device-1');
      expect(finalAccessories[0].name).toBe('Updated');
    });

    test('given persistence across instances, should maintain state', async () => {
      // First instance: save data
      const accessories1: CachedAccessory[] = [
        createMockAccessory({ deviceId: 'device-1' }),
      ];
      await cache.save(accessories1);

      // Second instance: load data
      const cache2 = new AccessoryCache(mockPersistPath);
      (fs.readFile as jest.Mock).mockResolvedValue(
        (fs.writeFile as jest.Mock).mock.calls[0][1]
      );
      const loaded = await cache2.load();

      expect(loaded).toEqual(accessories1);
    });
  });
});
