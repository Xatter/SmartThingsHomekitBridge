import { RequestHandler } from 'express';
import { Logger } from 'pino';
import { UnifiedDevice } from '@/types';

/**
 * Context provided to plugins for interacting with the bridge
 */
export interface PluginContext {
  /**
   * Get all devices managed by the bridge
   */
  getDevices(): UnifiedDevice[];

  /**
   * Get a specific device by ID
   */
  getDevice(deviceId: string): UnifiedDevice | undefined;

  /**
   * Update a device's state in SmartThings
   * Returns the updated state from SmartThings
   */
  setSmartThingsState(deviceId: string, state: any): Promise<any>;

  /**
   * Update a device's state in HomeKit
   */
  setHomeKitState(deviceId: string, state: any): Promise<void>;

  /**
   * Save plugin-specific state to disk
   * State is persisted in persist/<plugin-name>/<key>.json
   */
  saveState(key: string, data: any): Promise<void>;

  /**
   * Load plugin-specific state from disk
   * Returns undefined if state doesn't exist
   */
  loadState<T = any>(key: string): Promise<T | undefined>;

  /**
   * Logger instance for this plugin
   */
  logger: Logger;

  /**
   * Plugin-specific configuration from config file
   */
  config: any;

  /**
   * Plugin name (for logging/state persistence)
   */
  pluginName: string;

  /**
   * Get current device status from SmartThings
   * Returns fresh state directly from the API
   */
  getDeviceStatus(deviceId: string): Promise<any>;

  /**
   * Turn off device light (for AC display lights)
   */
  turnLightOff(deviceId: string): Promise<boolean>;

  /**
   * Turn on device light (for AC display lights)
   */
  turnLightOn(deviceId: string): Promise<boolean>;
}

/**
 * Web route definition for plugin-provided routes
 */
export interface PluginWebRoute {
  path: string;
  method: 'get' | 'post' | 'put' | 'delete' | 'patch';
  handler: RequestHandler;
}

/**
 * Plugin lifecycle and hook interface
 */
export interface Plugin {
  /**
   * Plugin name (must be unique)
   */
  name: string;

  /**
   * Plugin version (semver)
   */
  version: string;

  /**
   * Plugin description
   */
  description?: string;

  /**
   * Initialize the plugin
   * Called once when the plugin is loaded, before start()
   */
  init(context: PluginContext): Promise<void>;

  /**
   * Start the plugin
   * Called after all plugins are initialized
   */
  start(): Promise<void>;

  /**
   * Stop the plugin
   * Called during graceful shutdown
   */
  stop(): Promise<void>;

  /**
   * Determine if this plugin should handle a specific device
   * Return true to receive lifecycle hooks for this device
   */
  shouldHandleDevice?(device: UnifiedDevice): boolean;

  /**
   * Called before a HomeKit state change is applied to SmartThings
   * Return modified state to change what's sent, or null to cancel the update
   */
  beforeSetSmartThingsState?(device: UnifiedDevice, state: any): Promise<any | null>;

  /**
   * Called before a SmartThings state change is applied to HomeKit
   * Return modified state to change what's sent, or null to cancel the update
   */
  beforeSetHomeKitState?(device: UnifiedDevice, state: any): Promise<any | null>;

  /**
   * Called after a device's state is updated from SmartThings
   */
  afterDeviceUpdate?(device: UnifiedDevice, newState: any, oldState: any): Promise<void>;

  /**
   * Called on each polling cycle with all devices
   * Use this for coordination logic across multiple devices
   */
  onPollCycle?(devices: UnifiedDevice[]): Promise<void>;

  /**
   * Provide custom web routes for this plugin
   * Routes will be mounted under /api/plugins/<plugin-name>/
   */
  getWebRoutes?(): PluginWebRoute[];
}

/**
 * Plugin package.json metadata (for npm-based plugins)
 */
export interface PluginPackageMetadata {
  name: string;
  version: string;
  description?: string;
  author?: string;
  keywords?: string[];

  // Custom field for plugin configuration
  smartthingsHomekitPlugin?: {
    // Entry point to the plugin (defaults to main)
    pluginEntry?: string;
  };
}

/**
 * Plugin loader result
 */
export interface LoadedPlugin {
  plugin: Plugin;
  metadata: {
    name: string;
    version: string;
    description?: string;
    source: 'builtin' | 'npm' | 'local';
    path?: string;
  };
}
