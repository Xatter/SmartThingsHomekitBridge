import { promises as fs } from 'fs';
import * as path from 'path';
import { Logger } from 'pino';

/**
 * Bridge configuration structure
 */
export interface BridgeConfig {
  bridge: {
    name: string;
    port: number;
    pincode: string;
    username: string;
    persistPath: string;
  };
  web: {
    port: number;
  };
  smartthings: {
    clientId: string;
    clientSecret: string;
    redirectUri?: string;
    tokenPath: string;
  };
  polling: {
    devicePollInterval: number; // seconds
    lightingCheckInterval: number; // seconds
  };
  devices: {
    include: string[]; // Device IDs to include, or ['*'] for all
    exclude: string[]; // Device IDs to exclude
  };
  plugins: {
    [pluginName: string]: {
      enabled: boolean;
      config?: any;
    };
  };
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: BridgeConfig = {
  bridge: {
    name: 'SmartThings Bridge',
    port: 51826,
    pincode: '942-37-286',
    username: 'CC:22:3D:E3:CE:F6',
    persistPath: './persist',
  },
  web: {
    port: 3000,
  },
  smartthings: {
    clientId: '',
    clientSecret: '',
    tokenPath: './data/smartthings_token.json',
  },
  polling: {
    devicePollInterval: 300,
    lightingCheckInterval: 60,
  },
  devices: {
    include: ['*'],
    exclude: [],
  },
  plugins: {
    'core-devices': {
      enabled: true,
    },
    'hvac-auto-mode': {
      enabled: true,
      config: {
        minOnTime: 600,      // 10 minutes
        minOffTime: 300,     // 5 minutes
        minLockTime: 1800,   // 30 minutes
      },
    },
  },
};

/**
 * Configuration loader
 */
export class ConfigLoader {
  private readonly logger: Logger;
  private config: BridgeConfig;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: 'ConfigLoader' });
    this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)); // Deep copy
  }

  /**
   * Load configuration from file and environment variables
   */
  async load(configPath?: string): Promise<BridgeConfig> {
    // Load from file if provided
    if (configPath) {
      await this.loadFromFile(configPath);
    }

    // Override with environment variables
    this.loadFromEnv();

    // Validate required fields
    this.validate();

    return this.config;
  }

  /**
   * Load configuration from JSON file
   */
  private async loadFromFile(configPath: string): Promise<void> {
    try {
      const data = await fs.readFile(configPath, 'utf-8');
      const fileConfig = JSON.parse(data);

      // Deep merge with default config
      this.config = this.deepMerge(this.config, fileConfig);

      this.logger.info({ configPath }, 'Configuration loaded from file');
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        this.logger.warn({ configPath }, 'Config file not found, using defaults');
      } else if (error instanceof SyntaxError) {
        this.logger.error({ err: error, configPath }, 'Invalid JSON in config file');
        throw new Error(`Invalid JSON in config file: ${configPath}`);
      } else {
        throw error;
      }
    }
  }

  /**
   * Load/override configuration from environment variables
   */
  private loadFromEnv(): void {
    const env = process.env;

    // Bridge settings
    if (env.HAP_PORT) {
      this.config.bridge.port = parseInt(env.HAP_PORT);
    }
    if (env.HAP_PINCODE) {
      this.config.bridge.pincode = env.HAP_PINCODE;
    }
    if (env.HAP_BRIDGE_USERNAME) {
      this.config.bridge.username = env.HAP_BRIDGE_USERNAME;
    }
    if (env.HAP_PERSIST_PATH) {
      this.config.bridge.persistPath = env.HAP_PERSIST_PATH;
    }

    // Web server
    if (env.WEB_PORT) {
      this.config.web.port = parseInt(env.WEB_PORT);
    }

    // SmartThings
    if (env.SMARTTHINGS_CLIENT_ID) {
      this.config.smartthings.clientId = env.SMARTTHINGS_CLIENT_ID;
    }
    if (env.SMARTTHINGS_CLIENT_SECRET) {
      this.config.smartthings.clientSecret = env.SMARTTHINGS_CLIENT_SECRET;
    }
    if (env.SMARTTHINGS_REDIRECT_URI) {
      this.config.smartthings.redirectUri = env.SMARTTHINGS_REDIRECT_URI;
    }
    if (env.AUTH_TOKEN_PATH) {
      this.config.smartthings.tokenPath = env.AUTH_TOKEN_PATH;
    }

    // Polling
    if (env.DEVICE_POLL_INTERVAL) {
      this.config.polling.devicePollInterval = parseInt(env.DEVICE_POLL_INTERVAL);
    }
    if (env.LIGHTING_CHECK_INTERVAL) {
      this.config.polling.lightingCheckInterval = parseInt(env.LIGHTING_CHECK_INTERVAL);
    }

    this.logger.debug('Configuration overrides applied from environment variables');
  }

  /**
   * Validate required configuration fields
   */
  private validate(): void {
    const errors: string[] = [];

    if (!this.config.smartthings.clientId) {
      errors.push('SMARTTHINGS_CLIENT_ID is required');
    }
    if (!this.config.smartthings.clientSecret) {
      errors.push('SMARTTHINGS_CLIENT_SECRET is required');
    }

    if (errors.length > 0) {
      this.logger.error({ errors }, 'Configuration validation failed');
      throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
    }
  }

  /**
   * Deep merge two objects
   */
  private deepMerge(target: any, source: any): any {
    const result = { ...target };

    for (const key in source) {
      if (source[key] instanceof Object && !Array.isArray(source[key])) {
        result[key] = this.deepMerge(result[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }

    return result;
  }

  /**
   * Get current configuration
   */
  getConfig(): BridgeConfig {
    return this.config;
  }

  /**
   * Save configuration to file
   */
  async save(configPath: string): Promise<void> {
    const dir = path.dirname(configPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    this.logger.info({ configPath }, 'Configuration saved to file');
  }
}
