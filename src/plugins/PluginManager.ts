import * as path from 'path';
import { promises as fs } from 'fs';
import { Logger } from 'pino';
import { Plugin, LoadedPlugin, PluginContext, PluginWebRoute } from './types';
import { PluginContextImpl } from './PluginContext';
import { PluginConfigManager } from './PluginConfigManager';
import { UnifiedDevice } from '@/types';
import { SmartThingsAPI } from '@/api/SmartThingsAPI';
import { SmartThingsHAPServer } from '@/hap/HAPServer';

/**
 * Manages plugin lifecycle and coordination.
 *
 * All builtin plugins are always loaded and initialized into `plugins`.
 * The `runningPlugins` Set tracks which have been start()ed.
 * The `enabled` config flag only controls whether start() is called.
 */
export class PluginManager {
  private readonly logger: Logger;
  private readonly plugins: Map<string, LoadedPlugin> = new Map();
  private readonly runningPlugins: Set<string> = new Set();
  private readonly contexts: Map<string, PluginContext> = new Map();
  private readonly config: any;
  private readonly api: SmartThingsAPI;
  private readonly hapServer: SmartThingsHAPServer;
  private readonly getDevicesImpl: () => UnifiedDevice[];
  private readonly getDeviceImpl: (deviceId: string) => UnifiedDevice | undefined;
  private readonly persistPath: string;
  private readonly dataPath: string;
  private readonly pluginConfigManager: PluginConfigManager;

  constructor(
    logger: Logger,
    config: any,
    api: SmartThingsAPI,
    hapServer: SmartThingsHAPServer,
    getDevicesImpl: () => UnifiedDevice[],
    getDeviceImpl: (deviceId: string) => UnifiedDevice | undefined,
    persistPath: string,
    dataPath?: string
  ) {
    this.logger = logger.child({ component: 'PluginManager' });
    this.config = config;
    this.api = api;
    this.hapServer = hapServer;
    this.getDevicesImpl = getDevicesImpl;
    this.getDeviceImpl = getDeviceImpl;
    this.persistPath = persistPath;
    this.dataPath = dataPath || './data';
    this.pluginConfigManager = new PluginConfigManager(this.dataPath, logger);
  }

  /**
   * Load all configured plugins
   */
  async loadPlugins(): Promise<void> {
    this.logger.info('Loading plugins...');

    // Load plugin configuration first
    await this.pluginConfigManager.load();

    // Load built-in plugins
    await this.loadBuiltinPlugins();

    // TODO: Load npm plugins
    // TODO: Load local plugins

    this.logger.info({ count: this.plugins.size }, 'Plugins loaded');
  }

  /**
   * Load ALL built-in plugins from src/plugins/builtin/ regardless of enabled state
   */
  private async loadBuiltinPlugins(): Promise<void> {
    const builtinPath = path.join(__dirname, 'builtin');

    try {
      const entries = await fs.readdir(builtinPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const pluginDir = path.join(builtinPath, entry.name);

        // Try both .js (compiled) and .ts (development) extensions
        let indexPath = path.join(pluginDir, 'index.js');
        try {
          await fs.access(indexPath);
        } catch {
          // Try .ts if .js doesn't exist (development mode)
          indexPath = path.join(pluginDir, 'index.ts');
        }

        try {
          // Check if index file exists
          await fs.access(indexPath);

          // Dynamically import the plugin
          const pluginModule = await import(indexPath);

          // Handle ES6 module / CommonJS interop - check for double default wrapping
          const plugin: Plugin = pluginModule.default?.default || pluginModule.default || pluginModule;

          const pluginConfig = this.config.plugins?.[plugin.name];

          // Create plugin context
          const context = new PluginContextImpl(
            plugin.name,
            this.logger.child({ plugin: plugin.name }),
            pluginConfig?.config || {},
            this.getDevicesImpl,
            this.getDeviceImpl,
            this.api,
            this.hapServer,
            this.dataPath
          );

          this.contexts.set(plugin.name, context);

          // Store loaded plugin (ALL plugins, regardless of enabled state)
          this.plugins.set(plugin.name, {
            plugin,
            metadata: {
              name: plugin.name,
              version: plugin.version,
              description: plugin.description,
              source: 'builtin',
              path: pluginDir,
            },
          });

          this.logger.info(
            { name: plugin.name, version: plugin.version },
            'Built-in plugin loaded'
          );
        } catch (error: any) {
          if (error.code !== 'ENOENT') {
            this.logger.error(
              { err: error, plugin: entry.name },
              'Failed to load built-in plugin'
            );
          }
        }
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        this.logger.debug('No built-in plugins directory found');
      } else {
        this.logger.error({ err: error }, 'Error scanning built-in plugins');
      }
    }
  }

  /**
   * Initialize all loaded plugins
   */
  async initializePlugins(): Promise<void> {
    this.logger.info('Initializing plugins...');

    for (const [name, loaded] of this.plugins) {
      const context = this.contexts.get(name)!;
      try {
        await loaded.plugin.init(context);
        this.logger.info({ plugin: name }, 'Plugin initialized');
      } catch (error) {
        this.logger.error({ err: error, plugin: name }, 'Failed to initialize plugin');
      }
    }
  }

  /**
   * Start plugins that are enabled in config
   */
  async startPlugins(): Promise<void> {
    this.logger.info('Starting plugins...');

    for (const [name, loaded] of this.plugins) {
      if (!this.pluginConfigManager.isEnabled(name)) {
        this.logger.info({ plugin: name }, 'Plugin disabled, not starting');
        continue;
      }

      try {
        await loaded.plugin.start();
        this.runningPlugins.add(name);
        this.logger.info({ plugin: name }, 'Plugin started');
      } catch (error) {
        this.logger.error({ err: error, plugin: name }, 'Failed to start plugin');
      }
    }
  }

  /**
   * Stop all running plugins
   */
  async stopPlugins(): Promise<void> {
    this.logger.info('Stopping plugins...');

    for (const name of this.runningPlugins) {
      const loaded = this.plugins.get(name);
      if (!loaded) continue;

      try {
        await loaded.plugin.stop();
        this.logger.info({ plugin: name }, 'Plugin stopped');
      } catch (error) {
        this.logger.error({ err: error, plugin: name }, 'Failed to stop plugin');
      }
    }

    this.runningPlugins.clear();
  }

  /**
   * Get plugins that should handle a specific device (only running plugins)
   */
  getPluginsForDevice(device: UnifiedDevice): Plugin[] {
    const plugins: Plugin[] = [];

    for (const loaded of this.plugins.values()) {
      if (!this.runningPlugins.has(loaded.plugin.name)) continue;

      if (loaded.plugin.shouldHandleDevice) {
        try {
          if (loaded.plugin.shouldHandleDevice(device)) {
            plugins.push(loaded.plugin);
          }
        } catch (error) {
          this.logger.error(
            { err: error, plugin: loaded.plugin.name, deviceId: device.deviceId },
            'Error in shouldHandleDevice'
          );
        }
      }
    }

    return plugins;
  }

  /**
   * Call beforeSetSmartThingsState hooks for running plugins handling this device
   */
  async beforeSetSmartThingsState(device: UnifiedDevice, state: any): Promise<any | null> {
    let currentState = state;

    const plugins = this.getPluginsForDevice(device);
    for (const plugin of plugins) {
      if (plugin.beforeSetSmartThingsState) {
        try {
          const result = await plugin.beforeSetSmartThingsState(device, currentState);
          if (result === null) {
            this.logger.info(
              { plugin: plugin.name, deviceId: device.deviceId },
              'Plugin cancelled SmartThings state update'
            );
            return null;
          }
          currentState = result;
        } catch (error) {
          this.logger.error(
            { err: error, plugin: plugin.name, deviceId: device.deviceId },
            'Error in beforeSetSmartThingsState'
          );
        }
      }
    }

    return currentState;
  }

  /**
   * Call beforeSetHomeKitState hooks for running plugins handling this device
   */
  async beforeSetHomeKitState(device: UnifiedDevice, state: any): Promise<any | null> {
    let currentState = state;

    const plugins = this.getPluginsForDevice(device);
    for (const plugin of plugins) {
      if (plugin.beforeSetHomeKitState) {
        try {
          const result = await plugin.beforeSetHomeKitState(device, currentState);
          if (result === null) {
            this.logger.info(
              { plugin: plugin.name, deviceId: device.deviceId },
              'Plugin cancelled HomeKit state update'
            );
            return null;
          }
          currentState = result;
        } catch (error) {
          this.logger.error(
            { err: error, plugin: plugin.name, deviceId: device.deviceId },
            'Error in beforeSetHomeKitState'
          );
        }
      }
    }

    return currentState;
  }

  /**
   * Call afterDeviceUpdate hooks for running plugins handling this device
   */
  async afterDeviceUpdate(device: UnifiedDevice, newState: any, oldState: any): Promise<void> {
    const plugins = this.getPluginsForDevice(device);
    for (const plugin of plugins) {
      if (plugin.afterDeviceUpdate) {
        try {
          await plugin.afterDeviceUpdate(device, newState, oldState);
        } catch (error) {
          this.logger.error(
            { err: error, plugin: plugin.name, deviceId: device.deviceId },
            'Error in afterDeviceUpdate'
          );
        }
      }
    }
  }

  /**
   * Call onPollCycle hooks for running plugins only
   */
  async onPollCycle(devices: UnifiedDevice[]): Promise<void> {
    for (const loaded of this.plugins.values()) {
      if (!this.runningPlugins.has(loaded.plugin.name)) continue;

      if (loaded.plugin.onPollCycle) {
        try {
          await loaded.plugin.onPollCycle(devices);
        } catch (error) {
          this.logger.error(
            { err: error, plugin: loaded.plugin.name },
            'Error in onPollCycle'
          );
        }
      }
    }
  }

  /**
   * Get all web routes provided by ALL loaded plugins (not just running)
   */
  getAllWebRoutes(): Map<string, PluginWebRoute[]> {
    const routes = new Map<string, PluginWebRoute[]>();

    for (const loaded of this.plugins.values()) {
      if (loaded.plugin.getWebRoutes) {
        try {
          const pluginRoutes = loaded.plugin.getWebRoutes();
          routes.set(loaded.plugin.name, pluginRoutes);
        } catch (error) {
          this.logger.error(
            { err: error, plugin: loaded.plugin.name },
            'Error getting web routes'
          );
        }
      }
    }

    return routes;
  }

  /**
   * Get all loaded plugins
   */
  getPlugins(): LoadedPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Get a specific plugin by name
   */
  getPlugin(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * Check if a plugin is enabled in config
   */
  isPluginEnabled(name: string): boolean {
    return this.pluginConfigManager.isEnabled(name);
  }

  /**
   * Check if a plugin is currently running
   */
  isPluginRunning(name: string): boolean {
    return this.runningPlugins.has(name);
  }

  /**
   * Enable a plugin: save config + start at runtime
   */
  async enablePlugin(name: string): Promise<void> {
    await this.pluginConfigManager.setEnabled(name, true);

    const loaded = this.plugins.get(name);
    if (loaded && !this.runningPlugins.has(name)) {
      try {
        await loaded.plugin.start();
        this.runningPlugins.add(name);
        this.logger.info({ plugin: name }, 'Plugin enabled and started at runtime');
      } catch (error) {
        this.logger.error({ err: error, plugin: name }, 'Failed to start plugin at runtime');
      }
    }
  }

  /**
   * Disable a plugin: save config + stop at runtime
   */
  async disablePlugin(name: string): Promise<void> {
    await this.pluginConfigManager.setEnabled(name, false);

    const loaded = this.plugins.get(name);
    if (loaded && this.runningPlugins.has(name)) {
      try {
        await loaded.plugin.stop();
        this.runningPlugins.delete(name);
        this.logger.info({ plugin: name }, 'Plugin disabled and stopped at runtime');
      } catch (error) {
        this.logger.error({ err: error, plugin: name }, 'Failed to stop plugin at runtime');
      }
    }
  }

  /**
   * Get plugins with their enabled and running status
   */
  getPluginsWithStatus(): Array<LoadedPlugin & { enabled: boolean; running: boolean }> {
    const loaded = this.getPlugins();
    return loaded.map(plugin => ({
      ...plugin,
      enabled: this.isPluginEnabled(plugin.plugin.name),
      running: this.isPluginRunning(plugin.plugin.name),
    }));
  }
}
