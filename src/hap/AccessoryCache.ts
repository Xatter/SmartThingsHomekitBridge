import { promises as fs } from 'fs';
import * as path from 'path';
import { logger } from '@/utils/logger';

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

  constructor(persistPath: string) {
    this.cacheFile = path.join(persistPath, 'cached_accessories.json');
  }

  async load(): Promise<CachedAccessory[]> {
    try {
      const data = await fs.readFile(this.cacheFile, 'utf-8');
      this.accessories = JSON.parse(data);
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
    try {
      this.accessories = accessories;
      await fs.writeFile(this.cacheFile, JSON.stringify(accessories, null, 2));
      logger.info({ count: accessories.length }, '💾 Saved accessories to cache');
    } catch (error) {
      logger.error({ err: error }, 'Error saving cached accessories');
    }
  }

  async addOrUpdate(accessory: CachedAccessory): Promise<void> {
    const index = this.accessories.findIndex(a => a.deviceId === accessory.deviceId);
    if (index >= 0) {
      this.accessories[index] = accessory;
    } else {
      this.accessories.push(accessory);
    }
    await this.save(this.accessories);
  }

  async remove(deviceId: string): Promise<void> {
    this.accessories = this.accessories.filter(a => a.deviceId !== deviceId);
    await this.save(this.accessories);
  }

  getAll(): CachedAccessory[] {
    return this.accessories;
  }

  has(deviceId: string): boolean {
    return this.accessories.some(a => a.deviceId === deviceId);
  }
}