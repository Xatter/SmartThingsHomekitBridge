import { UnifiedDevice, DeviceState } from '@/types';
import { PluginContext } from '../../types';

// Mock logger before importing
jest.mock('@/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

// Mock node-cron
jest.mock('node-cron', () => ({
  schedule: jest.fn(() => ({
    start: jest.fn(),
    stop: jest.fn(),
  })),
}));

// Import the plugin after mocks are set up
import plugin from './index';
import * as cron from 'node-cron';

describe('AutoModeMonitorPlugin', () => {
  let mockContext: jest.Mocked<PluginContext>;
  let mockTask: { start: jest.Mock; stop: jest.Mock };

  const createMockDevice = (overrides: Partial<UnifiedDevice>): UnifiedDevice => ({
    deviceId: 'device-1',
    name: 'Test Device',
    label: 'Test Device',
    manufacturerName: 'Samsung',
    presentationId: 'test',
    deviceTypeName: 'Air Conditioner',
    capabilities: [{ id: 'airConditionerMode', version: 1 }],
    components: [{ id: 'main', capabilities: [{ id: 'airConditionerMode', version: 1 }] }],
    thermostatCapabilities: {
      thermostatMode: false,
      temperatureMeasurement: true,
      thermostatCoolingSetpoint: true,
      thermostatHeatingSetpoint: false,
      airConditionerMode: true,
      switch: true,
    },
    isPaired: true,
    ...overrides,
  });

  const createMockDeviceState = (overrides: Partial<DeviceState> = {}): DeviceState => ({
    id: 'device-1',
    name: 'Test Device',
    currentTemperature: 72,
    temperatureSetpoint: 72,
    mode: 'cool',
    lightOn: false,
    lastUpdated: new Date(),
    coolingSetpoint: 72,
    heatingSetpoint: 68,
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    mockTask = {
      start: jest.fn(),
      stop: jest.fn(),
    };
    (cron.schedule as jest.Mock).mockReturnValue(mockTask);

    mockContext = {
      getDevices: jest.fn().mockReturnValue([]),
      getDevice: jest.fn(),
      setSmartThingsState: jest.fn().mockResolvedValue({}),
      setHomeKitState: jest.fn().mockResolvedValue(undefined),
      saveState: jest.fn().mockResolvedValue(undefined),
      loadState: jest.fn().mockResolvedValue(undefined),
      getDeviceStatus: jest.fn().mockResolvedValue({}),
      turnLightOff: jest.fn().mockResolvedValue(true),
      turnLightOn: jest.fn().mockResolvedValue(true),
      logger: {
        info: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        trace: jest.fn(),
        fatal: jest.fn(),
        child: jest.fn().mockReturnThis(),
        level: 'info',
      } as any,
      config: {},
      pluginName: 'auto-mode-monitor',
    };

    // Initialize the plugin fresh for each test
    await plugin.init(mockContext);
  });

  afterEach(async () => {
    await plugin.stop();
  });

  describe('initialization', () => {
    it('should have correct plugin metadata', () => {
      expect(plugin.name).toBe('auto-mode-monitor');
      expect(plugin.version).toBe('1.0.0');
    });

    it('should start cron task on start()', async () => {
      await plugin.start();

      expect(cron.schedule).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Function),
        expect.objectContaining({
          scheduled: true,
          timezone: 'UTC',
        })
      );
    });

    it('should use configurable check interval', async () => {
      // Re-init with custom config
      mockContext.config = { checkInterval: 120 };
      await plugin.init(mockContext);
      await plugin.start();

      expect(cron.schedule).toHaveBeenCalledWith(
        '*/2 * * * *', // 120 seconds = 2 minutes
        expect.any(Function),
        expect.any(Object)
      );
    });
  });

  describe('checkAndCorrectAutoMode', () => {
    beforeEach(async () => {
      await plugin.start();
    });

    it('should not take action when no devices are in auto mode', async () => {
      const device1State = createMockDeviceState({ id: 'device-1', mode: 'cool' });
      const device2State = createMockDeviceState({ id: 'device-2', mode: 'heat' });

      mockContext.getDevices.mockReturnValue([
        createMockDevice({ deviceId: 'device-1', mode: 'cool' }),
        createMockDevice({ deviceId: 'device-2', mode: 'heat' }),
      ]);

      mockContext.getDeviceStatus
        .mockResolvedValueOnce(device1State)
        .mockResolvedValueOnce(device2State);

      // Trigger check via onPollCycle
      await plugin.onPollCycle!([]);

      expect(mockContext.setSmartThingsState).not.toHaveBeenCalled();
    });

    it('should correct device in auto mode to heat when temp < setpoint', async () => {
      const deviceState = createMockDeviceState({
        id: 'device-1',
        mode: 'auto',
        currentTemperature: 65,
        coolingSetpoint: 72,
        heatingSetpoint: 68,
      });

      mockContext.getDevices.mockReturnValue([
        createMockDevice({ deviceId: 'device-1', mode: 'auto' }),
      ]);

      mockContext.getDeviceStatus.mockResolvedValue(deviceState);

      await plugin.onPollCycle!([]);

      expect(mockContext.setSmartThingsState).toHaveBeenCalledWith('device-1', {
        thermostatMode: 'heat',
        heatingSetpoint: 68,
      });
    });

    it('should correct device in auto mode to cool when temp > setpoint', async () => {
      const deviceState = createMockDeviceState({
        id: 'device-1',
        mode: 'auto',
        currentTemperature: 78,
        coolingSetpoint: 72,
        heatingSetpoint: 68,
      });

      mockContext.getDevices.mockReturnValue([
        createMockDevice({ deviceId: 'device-1', mode: 'auto' }),
      ]);

      mockContext.getDeviceStatus.mockResolvedValue(deviceState);

      await plugin.onPollCycle!([]);

      expect(mockContext.setSmartThingsState).toHaveBeenCalledWith('device-1', {
        thermostatMode: 'cool',
        coolingSetpoint: 72,
      });
    });

    it('should use default heat temperature (68°F) when no setpoint available', async () => {
      const deviceState = createMockDeviceState({
        id: 'device-1',
        mode: 'auto',
        currentTemperature: 62,
        coolingSetpoint: undefined,
        heatingSetpoint: undefined,
      });

      mockContext.getDevices.mockReturnValue([
        createMockDevice({ deviceId: 'device-1', mode: 'auto' }),
      ]);

      mockContext.getDeviceStatus.mockResolvedValue(deviceState);

      await plugin.onPollCycle!([]);

      expect(mockContext.setSmartThingsState).toHaveBeenCalledWith('device-1', {
        thermostatMode: 'heat',
        heatingSetpoint: 68,
      });
    });

    it('should use default cool temperature (72°F) when no setpoint available', async () => {
      const deviceState = createMockDeviceState({
        id: 'device-1',
        mode: 'auto',
        currentTemperature: 80,
        coolingSetpoint: undefined,
        heatingSetpoint: undefined,
      });

      mockContext.getDevices.mockReturnValue([
        createMockDevice({ deviceId: 'device-1', mode: 'auto' }),
      ]);

      mockContext.getDeviceStatus.mockResolvedValue(deviceState);

      await plugin.onPollCycle!([]);

      expect(mockContext.setSmartThingsState).toHaveBeenCalledWith('device-1', {
        thermostatMode: 'cool',
        coolingSetpoint: 72,
      });
    });

    it('should use configurable default temperatures', async () => {
      // Re-init with custom defaults
      mockContext.config = {
        defaultHeatTemperature: 70,
        defaultCoolTemperature: 74,
      };
      await plugin.init(mockContext);
      await plugin.start();

      const deviceState = createMockDeviceState({
        id: 'device-1',
        mode: 'auto',
        currentTemperature: 80,
        coolingSetpoint: undefined,
        heatingSetpoint: undefined,
      });

      mockContext.getDevices.mockReturnValue([
        createMockDevice({ deviceId: 'device-1', mode: 'auto' }),
      ]);

      mockContext.getDeviceStatus.mockResolvedValue(deviceState);

      await plugin.onPollCycle!([]);

      expect(mockContext.setSmartThingsState).toHaveBeenCalledWith('device-1', {
        thermostatMode: 'cool',
        coolingSetpoint: 74,
      });
    });

    it('should use mode from another device when available', async () => {
      const device1State = createMockDeviceState({
        id: 'device-1',
        mode: 'auto',
        currentTemperature: 70,
        coolingSetpoint: 72,
      });

      const device2State = createMockDeviceState({
        id: 'device-2',
        mode: 'heat',
        heatingSetpoint: 70,
      });

      mockContext.getDevices.mockReturnValue([
        createMockDevice({ deviceId: 'device-1', mode: 'auto' }),
        createMockDevice({ deviceId: 'device-2', mode: 'heat' }),
      ]);

      mockContext.getDeviceStatus
        .mockResolvedValueOnce(device1State)
        .mockResolvedValueOnce(device2State);

      await plugin.onPollCycle!([]);

      expect(mockContext.setSmartThingsState).toHaveBeenCalledWith('device-1', {
        thermostatMode: 'heat',
        heatingSetpoint: 68, // Uses default since the auto device doesn't have a heating setpoint
      });
    });

    it('should correct multiple devices in auto mode', async () => {
      const device1State = createMockDeviceState({
        id: 'device-1',
        mode: 'auto',
        currentTemperature: 65,
        coolingSetpoint: 72,
      });

      const device2State = createMockDeviceState({
        id: 'device-2',
        mode: 'auto',
        currentTemperature: 64,
        coolingSetpoint: 72,
      });

      mockContext.getDevices.mockReturnValue([
        createMockDevice({ deviceId: 'device-1', mode: 'auto' }),
        createMockDevice({ deviceId: 'device-2', mode: 'auto' }),
      ]);

      mockContext.getDeviceStatus
        .mockResolvedValueOnce(device1State)
        .mockResolvedValueOnce(device2State);

      await plugin.onPollCycle!([]);

      expect(mockContext.setSmartThingsState).toHaveBeenCalledTimes(2);
    });

    it('should handle errors gracefully', async () => {
      const deviceState = createMockDeviceState({
        id: 'device-1',
        mode: 'auto',
        currentTemperature: 65,
        coolingSetpoint: 72,
      });

      mockContext.getDevices.mockReturnValue([
        createMockDevice({ deviceId: 'device-1', mode: 'auto' }),
        createMockDevice({ deviceId: 'device-2', mode: 'auto' }),
      ]);

      mockContext.getDeviceStatus
        .mockResolvedValueOnce(deviceState)
        .mockResolvedValueOnce(deviceState);

      mockContext.setSmartThingsState
        .mockRejectedValueOnce(new Error('API Error'))
        .mockResolvedValueOnce({});

      await plugin.onPollCycle!([]);

      // Should continue processing second device even if first fails
      expect(mockContext.setSmartThingsState).toHaveBeenCalledTimes(2);
      expect(mockContext.logger.error).toHaveBeenCalled();
    });

    it('should ignore non-thermostat devices', async () => {
      const lightDevice: UnifiedDevice = {
        deviceId: 'device-2',
        name: 'Light',
        label: 'Living Room Light',
        manufacturerName: 'Philips',
        presentationId: 'light',
        deviceTypeName: 'Light',
        capabilities: [{ id: 'switch', version: 1 }],
        components: [{ id: 'main', capabilities: [{ id: 'switch', version: 1 }] }],
        thermostatCapabilities: {
          thermostatMode: false,
          temperatureMeasurement: false,
          thermostatCoolingSetpoint: false,
          thermostatHeatingSetpoint: false,
          airConditionerMode: false,
        },
        isPaired: true,
      };

      const deviceState = createMockDeviceState({
        id: 'device-1',
        mode: 'auto',
        currentTemperature: 65,
        coolingSetpoint: 72,
      });

      mockContext.getDevices.mockReturnValue([
        createMockDevice({ deviceId: 'device-1', mode: 'auto' }),
        lightDevice,
      ]);

      mockContext.getDeviceStatus.mockResolvedValue(deviceState);

      await plugin.onPollCycle!([]);

      // Should only call setSmartThingsState for the thermostat device
      expect(mockContext.setSmartThingsState).toHaveBeenCalledTimes(1);
    });
  });

  describe('web routes', () => {
    it('should provide status endpoint', async () => {
      await plugin.start();

      const routes = plugin.getWebRoutes!();

      const statusRoute = routes.find(r => r.path === '/status');
      expect(statusRoute).toBeDefined();
      expect(statusRoute!.method).toBe('get');
    });

    it('should provide check endpoint', async () => {
      await plugin.start();

      const routes = plugin.getWebRoutes!();

      const checkRoute = routes.find(r => r.path === '/check');
      expect(checkRoute).toBeDefined();
      expect(checkRoute!.method).toBe('post');
    });
  });
});
