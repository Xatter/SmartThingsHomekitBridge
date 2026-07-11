import { promises as fs } from 'fs';
import * as path from 'path';
import { logger } from '@/utils/logger';
import { atomicWriteJson } from '@/utils/atomicWrite';
import { AsyncMutex } from '@/utils/singleFlight';

export interface CachedAccessory {
  deviceId: string;
  name: string;
  uuid: string;
  manufacturer: string;
  model: string;
  serialNumber: string;
  firmwareRevision: string;
}

export class AccessoryCache {
  private cacheFile: string;
  private accessories: CachedAccessory[] = [];
  // Serializes save()/addOrUpdate()/remove() so concurrent callers (e.g.
  // overlapping reloadDevices() runs) can't interleave read-modify-write
  // cycles and corrupt cached_accessories.json.
  private readonly mutex = new AsyncMutex();

  constructor(persistPath: string) {
    this.cacheFile = path.join(persistPath, 'cached_accessories.json');
  }

  async load(): Promise<CachedAccessory[]> {
    try {
      const data = await fs.readFile(this.cacheFile, 'utf-8');
      try {
        this.accessories = JSON.parse(data);
      } catch (parseError) {
        logger.error(
          { err: parseError, file: this.cacheFile },
          '🚨 ERROR: Corrupt accessory cache file detected - quarantining and starting fresh'
        );
        const corruptPath = `${this.cacheFile}.corrupt`;
        try {
          await fs.rename(this.cacheFile, corruptPath);
          logger.error({ corruptPath }, '🚨 Corrupt cache file moved aside for inspection');
        } catch (renameError) {
          logger.error({ err: renameError, file: this.cacheFile }, 'Failed to quarantine corrupt cache file');
        }
        this.accessories = [];
        return [];
      }
      logger.info({ count: this.accessories.length }, '📥 Loaded cached accessories');
      return this.accessories;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ err: error }, 'Error loading cached accessories');
      }
      return [];
    }
  }

  async save(accessories: CachedAccessory[]): Promise<void> {
    return this.mutex.runExclusive(() => this.writeToDisk(accessories));
  }

  async addOrUpdate(accessory: CachedAccessory): Promise<void> {
    return this.mutex.runExclusive(async () => {
      const updated = [...this.accessories];
      const index = updated.findIndex(a => a.deviceId === accessory.deviceId);
      if (index >= 0) {
        updated[index] = accessory;
      } else {
        updated.push(accessory);
      }
      await this.writeToDisk(updated);
    });
  }

  async remove(deviceId: string): Promise<void> {
    return this.mutex.runExclusive(async () => {
      const updated = this.accessories.filter(a => a.deviceId !== deviceId);
      await this.writeToDisk(updated);
    });
  }

  // Internal, lock-free write used by save()/addOrUpdate()/remove() - callers
  // must already hold `mutex`.
  private async writeToDisk(accessories: CachedAccessory[]): Promise<void> {
    try {
      this.accessories = accessories;
      await atomicWriteJson(this.cacheFile, accessories);
      logger.info({ count: accessories.length }, '💾 Saved accessories to cache');
    } catch (error) {
      logger.error({ err: error }, 'Error saving cached accessories');
    }
  }

  getAll(): CachedAccessory[] {
    return this.accessories;
  }

  has(deviceId: string): boolean {
    return this.accessories.some(a => a.deviceId === deviceId);
  }
}