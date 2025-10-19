import { promises as fs } from 'fs';
import * as path from 'path';
import { Logger } from 'pino';

/**
 * Storage structure for device inclusion configuration
 */
interface DeviceInclusionConfig {
  [deviceId: string]: {
    included: boolean;
  };
}

/**
 * Manages device inclusion/exclusion from HomeKit
 * Persists configuration to JSON file
 */
export class DeviceInclusionManager {
  private readonly logger: Logger;
  private readonly configPath: string;
  private config: DeviceInclusionConfig = {};

  constructor(dataPath: string, logger: Logger) {
    this.configPath = path.join(dataPath, 'device_inclusion.json');
    this.logger = logger.child({ component: 'DeviceInclusionManager' });
  }

  /**
   * Load inclusion configuration from disk
   */
  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.configPath, 'utf-8');
      this.config = JSON.parse(data);
      this.logger.info({ count: Object.keys(this.config).length }, 'Loaded device inclusion configuration');
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        this.logger.info('No device inclusion configuration found, starting with defaults (all included)');
        this.config = {};
      } else {
        this.logger.error({ err: error }, 'Failed to load device inclusion configuration');
        throw error;
      }
    }
  }

  /**
   * Save configuration to disk
   */
  private async save(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.configPath), { recursive: true });
      await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
      this.logger.info('Saved device inclusion configuration');
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to save device inclusion configuration');
      throw error;
    }
  }

  /**
   * Check if a device is included in HomeKit
   * Default is true (included) if not explicitly configured
   */
  isIncluded(deviceId: string): boolean {
    return this.config[deviceId]?.included ?? true; // Default to included
  }

  /**
   * Set device inclusion status
   */
  async setIncluded(deviceId: string, included: boolean): Promise<void> {
    if (!this.config[deviceId]) {
      this.config[deviceId] = { included };
    } else {
      this.config[deviceId].included = included;
    }

    this.logger.info({ deviceId, included }, 'Updated device inclusion state');
    await this.save();
  }

  /**
   * Get all device inclusion settings
   */
  getAllSettings(): DeviceInclusionConfig {
    return { ...this.config };
  }

  /**
   * Remove a device from the configuration
   * (useful when a device is removed from SmartThings)
   */
  async removeDevice(deviceId: string): Promise<void> {
    if (this.config[deviceId]) {
      delete this.config[deviceId];
      this.logger.info({ deviceId }, 'Removed device from inclusion configuration');
      await this.save();
    }
  }
}
