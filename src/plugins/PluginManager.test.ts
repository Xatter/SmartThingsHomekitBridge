import { PluginManager } from './PluginManager';
import { Plugin, PluginContext } from './types';
import { SmartThingsAPI } from '@/api/SmartThingsAPI';
import { SmartThingsHAPServer } from '@/hap/HAPServer';
import { UnifiedDevice } from '@/types';
import { Logger } from 'pino';

// Mock dependencies
jest.mock('@/api/SmartThingsAPI');
jest.mock('@/hap/HAPServer');
jest.mock('./PluginConfigManager');

// Mock fs for the builtin plugin loading
jest.mock('fs', () => ({
  promises: {
    readdir: jest.fn(),
    access: jest.fn(),
    readFile: jest.fn(),
    writeFile: jest.fn(),
    mkdir: jest.fn(),
  },
}));

import { promises as fs } from 'fs';
import { PluginConfigManager } from './PluginConfigManager';

const mockFs = fs as jest.Mocked<typeof fs>;

function createMockPlugin(name: string, overrides: Partial<Plugin> = {}): Plugin {
  return {
    name,
    version: '1.0.0',
    description: `Mock ${name} plugin`,
    init: jest.fn().mockResolvedValue(undefined),
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockDevice(overrides: Partial<UnifiedDevice> = {}): UnifiedDevice {
  return {
    deviceId: 'device-1',
    name: 'Test Device',
    label: 'Test Device',
    manufacturerName: 'Samsung',
    presentationId: 'test',
    deviceTypeName: 'Air Conditioner',
    capabilities: [{ id: 'thermostatMode', version: 1 }],
    components: [{ id: 'main', capabilities: [{ id: 'thermostatMode', version: 1 }] }],
    thermostatCapabilities: {
      thermostatMode: true,
      temperatureMeasurement: true,
      thermostatCoolingSetpoint: true,
      thermostatHeatingSetpoint: true,
      airConditionerMode: false,
    },
    isPaired: true,
    ...overrides,
  } as UnifiedDevice;
}

describe('PluginManager', () => {
  let pluginManager: PluginManager;
  let mockLogger: jest.Mocked<Logger>;
  let mockApi: jest.Mocked<SmartThingsAPI>;
  let mockHapServer: jest.Mocked<SmartThingsHAPServer>;
  let mockConfigManager: jest.Mocked<PluginConfigManager>;

  // Store plugins we'll inject via dynamic import mock
  let pluginA: Plugin;
  let pluginB: Plugin;

  beforeEach(() => {
    jest.clearAllMocks();

    mockLogger = {
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      child: jest.fn().mockReturnThis(),
    } as any;

    mockApi = {
      executeCommands: jest.fn(),
      getDeviceStatus: jest.fn(),
    } as any;

    mockHapServer = {
      updateDeviceState: jest.fn(),
    } as any;

    pluginA = createMockPlugin('plugin-a');
    pluginB = createMockPlugin('plugin-b');

    // Mock fs.readdir to return two fake plugin directories
    mockFs.readdir.mockResolvedValue([
      { name: 'plugin-a', isDirectory: () => true },
      { name: 'plugin-b', isDirectory: () => true },
    ] as any);

    // Mock fs.access to succeed (files exist)
    mockFs.access.mockResolvedValue(undefined);

    // Mock PluginConfigManager
    mockConfigManager = {
      load: jest.fn().mockResolvedValue(undefined),
      isEnabled: jest.fn().mockReturnValue(true),
      setEnabled: jest.fn().mockResolvedValue(undefined),
    } as any;

    (PluginConfigManager as jest.MockedClass<typeof PluginConfigManager>).mockImplementation(
      () => mockConfigManager as any
    );

    pluginManager = new PluginManager(
      mockLogger,
      {},
      mockApi,
      mockHapServer,
      () => [],
      () => undefined,
      './persist',
      './data'
    );
  });

  // Helper to load plugins with mocked dynamic imports
  async function loadPluginsWithMocks() {
    // We need to mock the dynamic import. Since PluginManager uses `import(indexPath)`,
    // we'll mock the module resolution by mocking the require/import at the module level.
    // For testing, we'll directly test via the public API after manipulating internals.

    // The actual loadBuiltinPlugins uses dynamic import which is hard to mock cleanly.
    // Instead, we'll test behavior through the public interface by creating a testable subclass.
    // But the simplest approach: mock the entire loadBuiltinPlugins flow and test the behaviors.

    // For this test suite, we'll directly access the private fields to set up state,
    // then test the public method behaviors.
    const plugins = (pluginManager as any).plugins as Map<string, any>;
    const contexts = (pluginManager as any).contexts as Map<string, any>;

    const mockContext = {
      getDevices: jest.fn().mockReturnValue([]),
      getDevice: jest.fn(),
      logger: mockLogger,
      config: {},
      pluginName: '',
    };

    plugins.set('plugin-a', {
      plugin: pluginA,
      metadata: { name: 'plugin-a', version: '1.0.0', source: 'builtin' },
    });
    plugins.set('plugin-b', {
      plugin: pluginB,
      metadata: { name: 'plugin-b', version: '1.0.0', source: 'builtin' },
    });

    contexts.set('plugin-a', { ...mockContext, pluginName: 'plugin-a' });
    contexts.set('plugin-b', { ...mockContext, pluginName: 'plugin-b' });
  }

  describe('initializePlugins', () => {
    it('calls init() on all loaded plugins', async () => {
      await loadPluginsWithMocks();
      await pluginManager.initializePlugins();

      expect(pluginA.init).toHaveBeenCalled();
      expect(pluginB.init).toHaveBeenCalled();
    });
  });

  describe('startPlugins', () => {
    it('only starts plugins where isEnabled() returns true', async () => {
      await loadPluginsWithMocks();

      // plugin-a enabled, plugin-b disabled
      mockConfigManager.isEnabled.mockImplementation((name: string) => name === 'plugin-a');

      await pluginManager.startPlugins();

      expect(pluginA.start).toHaveBeenCalled();
      expect(pluginB.start).not.toHaveBeenCalled();
    });

    it('tracks started plugins as running', async () => {
      await loadPluginsWithMocks();
      mockConfigManager.isEnabled.mockReturnValue(true);

      await pluginManager.startPlugins();

      expect(pluginManager.isPluginRunning('plugin-a')).toBe(true);
      expect(pluginManager.isPluginRunning('plugin-b')).toBe(true);
    });

    it('does not track disabled plugins as running', async () => {
      await loadPluginsWithMocks();
      mockConfigManager.isEnabled.mockImplementation((name: string) => name === 'plugin-a');

      await pluginManager.startPlugins();

      expect(pluginManager.isPluginRunning('plugin-a')).toBe(true);
      expect(pluginManager.isPluginRunning('plugin-b')).toBe(false);
    });
  });

  describe('stopPlugins', () => {
    it('only stops running plugins', async () => {
      await loadPluginsWithMocks();
      mockConfigManager.isEnabled.mockImplementation((name: string) => name === 'plugin-a');
      await pluginManager.startPlugins();

      await pluginManager.stopPlugins();

      expect(pluginA.stop).toHaveBeenCalled();
      expect(pluginB.stop).not.toHaveBeenCalled();
    });
  });

  describe('enablePlugin', () => {
    it('calls init() then start() at runtime and adds to running plugins', async () => {
      await loadPluginsWithMocks();
      // plugin-b is not running
      mockConfigManager.isEnabled.mockImplementation((name: string) => name === 'plugin-a');
      await pluginManager.startPlugins();
      expect(pluginManager.isPluginRunning('plugin-b')).toBe(false);

      await pluginManager.enablePlugin('plugin-b');

      expect(mockConfigManager.setEnabled).toHaveBeenCalledWith('plugin-b', true);
      expect(pluginB.init).toHaveBeenCalled();
      expect(pluginB.start).toHaveBeenCalled();
      expect(pluginManager.isPluginRunning('plugin-b')).toBe(true);
    });

    it('calls init() before start() in correct order', async () => {
      await loadPluginsWithMocks();
      mockConfigManager.isEnabled.mockImplementation((name: string) => name === 'plugin-a');
      await pluginManager.startPlugins();

      const callOrder: string[] = [];
      (pluginB.init as jest.Mock).mockImplementation(async () => { callOrder.push('init'); });
      (pluginB.start as jest.Mock).mockImplementation(async () => { callOrder.push('start'); });

      await pluginManager.enablePlugin('plugin-b');

      expect(callOrder).toEqual(['init', 'start']);
    });
  });

  describe('disablePlugin', () => {
    it('calls stop() at runtime and removes from running plugins', async () => {
      await loadPluginsWithMocks();
      mockConfigManager.isEnabled.mockReturnValue(true);
      await pluginManager.startPlugins();
      expect(pluginManager.isPluginRunning('plugin-a')).toBe(true);

      await pluginManager.disablePlugin('plugin-a');

      expect(mockConfigManager.setEnabled).toHaveBeenCalledWith('plugin-a', false);
      expect(pluginA.stop).toHaveBeenCalled();
      expect(pluginManager.isPluginRunning('plugin-a')).toBe(false);
    });
  });

  describe('hook methods only iterate running plugins', () => {
    it('getPluginsForDevice only returns running plugins', async () => {
      const device = createMockDevice();
      pluginA.shouldHandleDevice = jest.fn().mockReturnValue(true);
      pluginB.shouldHandleDevice = jest.fn().mockReturnValue(true);

      await loadPluginsWithMocks();
      mockConfigManager.isEnabled.mockImplementation((name: string) => name === 'plugin-a');
      await pluginManager.startPlugins();

      const result = pluginManager.getPluginsForDevice(device);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('plugin-a');
      // plugin-b's shouldHandleDevice should NOT be called since it's not running
      expect(pluginB.shouldHandleDevice).not.toHaveBeenCalled();
    });

    it('onPollCycle only calls running plugins', async () => {
      const devices = [createMockDevice()];
      pluginA.onPollCycle = jest.fn().mockResolvedValue(undefined);
      pluginB.onPollCycle = jest.fn().mockResolvedValue(undefined);

      await loadPluginsWithMocks();
      mockConfigManager.isEnabled.mockImplementation((name: string) => name === 'plugin-a');
      await pluginManager.startPlugins();

      await pluginManager.onPollCycle(devices);

      expect(pluginA.onPollCycle).toHaveBeenCalledWith(devices);
      expect(pluginB.onPollCycle).not.toHaveBeenCalled();
    });
  });

  describe('getAllWebRoutes', () => {
    it('returns routes for ALL loaded plugins (not just running)', async () => {
      const routeA = [{ path: '/status', method: 'get' as const, handler: jest.fn() }];
      const routeB = [{ path: '/config', method: 'get' as const, handler: jest.fn() }];
      pluginA.getWebRoutes = jest.fn().mockReturnValue(routeA);
      pluginB.getWebRoutes = jest.fn().mockReturnValue(routeB);

      await loadPluginsWithMocks();
      // Only plugin-a is running
      mockConfigManager.isEnabled.mockImplementation((name: string) => name === 'plugin-a');
      await pluginManager.startPlugins();

      const routes = pluginManager.getAllWebRoutes();

      // Both plugins should have routes registered
      expect(routes.size).toBe(2);
      expect(routes.has('plugin-a')).toBe(true);
      expect(routes.has('plugin-b')).toBe(true);
    });
  });

  describe('getPluginsWithStatus', () => {
    it('includes running field in status', async () => {
      await loadPluginsWithMocks();
      mockConfigManager.isEnabled.mockImplementation((name: string) => name === 'plugin-a');
      await pluginManager.startPlugins();

      const status = pluginManager.getPluginsWithStatus();

      const pluginAStatus = status.find(p => p.plugin.name === 'plugin-a');
      const pluginBStatus = status.find(p => p.plugin.name === 'plugin-b');

      expect(pluginAStatus?.running).toBe(true);
      expect(pluginAStatus?.enabled).toBe(true);
      expect(pluginBStatus?.running).toBe(false);
      expect(pluginBStatus?.enabled).toBe(false);
    });
  });

  describe('beforeSetSmartThingsState hook chaining', () => {
    it('chains state through multiple running plugins', async () => {
      const device = createMockDevice();
      pluginA.shouldHandleDevice = jest.fn().mockReturnValue(true);
      pluginB.shouldHandleDevice = jest.fn().mockReturnValue(true);
      pluginA.beforeSetSmartThingsState = jest.fn().mockResolvedValue({ thermostatMode: 'cool', modified: 'by-a' });
      pluginB.beforeSetSmartThingsState = jest.fn().mockResolvedValue({ thermostatMode: 'cool', modified: 'by-b' });

      await loadPluginsWithMocks();
      mockConfigManager.isEnabled.mockReturnValue(true);
      await pluginManager.startPlugins();

      const result = await pluginManager.beforeSetSmartThingsState(device, { thermostatMode: 'heat' });

      // Plugin A receives original state
      expect(pluginA.beforeSetSmartThingsState).toHaveBeenCalledWith(device, { thermostatMode: 'heat' });
      // Plugin B receives Plugin A's output
      expect(pluginB.beforeSetSmartThingsState).toHaveBeenCalledWith(device, { thermostatMode: 'cool', modified: 'by-a' });
      // Final result is Plugin B's output
      expect(result).toEqual({ thermostatMode: 'cool', modified: 'by-b' });
    });
  });

  describe('disable/re-enable lifecycle', () => {
    it('restores plugin to working state after disable then re-enable', async () => {
      await loadPluginsWithMocks();
      mockConfigManager.isEnabled.mockReturnValue(true);
      await pluginManager.initializePlugins();
      await pluginManager.startPlugins();

      // Disable plugin-a
      await pluginManager.disablePlugin('plugin-a');
      expect(pluginA.stop).toHaveBeenCalled();
      expect(pluginManager.isPluginRunning('plugin-a')).toBe(false);

      // Re-enable plugin-a
      await pluginManager.enablePlugin('plugin-a');

      // Should have called init again (re-initialization) then start
      expect(pluginA.init).toHaveBeenCalledTimes(2); // once in initializePlugins, once in enablePlugin
      expect(pluginA.start).toHaveBeenCalledTimes(2); // once in startPlugins, once in enablePlugin
      expect(pluginManager.isPluginRunning('plugin-a')).toBe(true);
    });
  });

  describe('getPlugins returns all loaded plugins', () => {
    it('returns all plugins regardless of running state', async () => {
      await loadPluginsWithMocks();
      mockConfigManager.isEnabled.mockImplementation((name: string) => name === 'plugin-a');
      await pluginManager.startPlugins();

      const plugins = pluginManager.getPlugins();

      expect(plugins).toHaveLength(2);
      expect(plugins.map(p => p.plugin.name)).toContain('plugin-a');
      expect(plugins.map(p => p.plugin.name)).toContain('plugin-b');
    });
  });
});
