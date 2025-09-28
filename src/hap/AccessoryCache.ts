import { promises as fs } from 'fs';
import * as path from 'path';

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
      console.log(`📥 Loaded ${this.accessories.length} cached accessories`);
      return this.accessories;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Error loading cached accessories:', error);
      }
      return [];
    }
  }

  async save(accessories: CachedAccessory[]): Promise<void> {
    try {
      this.accessories = accessories;
      await fs.writeFile(this.cacheFile, JSON.stringify(accessories, null, 2));
      console.log(`💾 Saved ${accessories.length} accessories to cache`);
    } catch (error) {
      console.error('Error saving cached accessories:', error);
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