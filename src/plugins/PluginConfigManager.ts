import { promises as fs } from 'fs';
import * as path from 'path';
import { Logger } from 'pino';

export interface PluginConfig {
  enabled: boolean;
  config?: any;
}

export interface PluginConfigStore {
  [pluginName: string]: PluginConfig;
}

/**
 * Manages plugin configuration persistence
 */
export class PluginConfigManager {
  private readonly logger: Logger;
  private readonly configPath: string;
  private config: PluginConfigStore = {};

  constructor(dataPath: string, logger: Logger) {
    this.configPath = path.join(dataPath, 'plugin_config.json');
    this.logger = logger.child({ component: 'PluginConfigManager' });
  }

  /**
   * Load plugin configuration from disk
   */
  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.configPath, 'utf-8');
      this.config = JSON.parse(data);
      this.logger.info({ count: Object.keys(this.config).length }, 'Loaded plugin configuration');
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        this.logger.info('No plugin configuration file found, starting with defaults');
        this.config = {};
      } else {
        this.logger.error({ err: error }, 'Failed to load plugin configuration');
        throw error;
      }
    }
  }

  /**
   * Save plugin configuration to disk
   */
  async save(): Promise<void> {
    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(this.configPath), { recursive: true });

      await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
      this.logger.info({ count: Object.keys(this.config).length }, 'Saved plugin configuration');
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to save plugin configuration');
      throw error;
    }
  }

  /**
   * Check if a plugin is enabled
   */
  isEnabled(pluginName: string): boolean {
    // If explicitly configured, use that value
    if (this.config[pluginName]?.enabled !== undefined) {
      return this.config[pluginName].enabled;
    }

    // Default enabled/disabled based on plugin type
    // Only 'core-devices' is enabled by default as it provides essential device bridging.
    // Optional plugins like 'hvac-auto-mode' and 'lighting-monitor' are disabled by default
    // to prevent unexpected behavior and allow users to opt-in to features they want.
    // This approach ensures the bridge works reliably out-of-the-box while giving users
    // control over additional functionality through explicit configuration.
    const defaultEnabledPlugins = ['core-devices'];
    return defaultEnabledPlugins.includes(pluginName);
  }

  /**
   * Set plugin enabled state
   */
  async setEnabled(pluginName: string, enabled: boolean): Promise<void> {
    if (!this.config[pluginName]) {
      this.config[pluginName] = { enabled };
    } else {
      this.config[pluginName].enabled = enabled;
    }

    await this.save();
    this.logger.info({ plugin: pluginName, enabled }, 'Updated plugin enabled state');
  }

  /**
   * Get plugin configuration
   */
  getPluginConfig(pluginName: string): any {
    return this.config[pluginName]?.config || {};
  }

  /**
   * Set plugin configuration
   */
  async setPluginConfig(pluginName: string, config: any): Promise<void> {
    if (!this.config[pluginName]) {
      this.config[pluginName] = { enabled: true, config };
    } else {
      this.config[pluginName].config = config;
    }

    await this.save();
    this.logger.info({ plugin: pluginName }, 'Updated plugin configuration');
  }

  /**
   * Get all plugin configurations
   */
  getAllConfigs(): PluginConfigStore {
    return { ...this.config };
  }
}
