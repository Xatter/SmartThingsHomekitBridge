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

/**
 * Flush all pending microtasks (including ones scheduled by other
 * microtasks, e.g. chained `await`s inside a `finally` block). Node drains
 * the entire microtask queue before running a macrotask callback like
 * setImmediate, so awaiting this guarantees any fire-and-forget async work
 * kicked off synchronously (e.g. plugin.start()'s initial check) has fully
 * settled — including releasing the isChecking latch — before the test
 * continues.
 */
const flushMicrotasks = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

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
    // These tests drive the shared check-and-correct logic through
    // manualCheck() rather than onPollCycle(). onPollCycle is now a no-op
    // (the cron task started below is the single trigger for real checks);
    // manualCheck() and the cron task both run the exact same core logic
    // (see runCheck / runCheckWithLatch in index.ts), so exercising it via
    // manualCheck() is equivalent and avoids re-implementing the trigger
    // plumbing in every test.
    beforeEach(async () => {
      await plugin.start();
      // plugin.start() fires an initial check in the background (fire-and-
      // forget). Flush pending microtasks so that check fully settles -
      // including releasing the isChecking latch - before each test drives
      // its own check via manualCheck().
      await flushMicrotasks();
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

      // Trigger check via manualCheck (see describe-level comment above)
      await plugin.manualCheck();

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

      await plugin.manualCheck();

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

      await plugin.manualCheck();

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

      await plugin.manualCheck();

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

      await plugin.manualCheck();

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
      await flushMicrotasks();

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

      await plugin.manualCheck();

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

      await plugin.manualCheck();

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

      await plugin.manualCheck();

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

      await plugin.manualCheck();

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

      await plugin.manualCheck();

      // Should only call setSmartThingsState for the thermostat device
      expect(mockContext.setSmartThingsState).toHaveBeenCalledTimes(1);
    });

    it('should not correct a device when currentTemperature is 0 (missing sensor reading)', async () => {
      // SmartThingsAPI.getDeviceStatus coerces a missing/broken temperature
      // reading to 0 via `Number(...) || 0`. A naive "0 < midpoint" check
      // would force such a device to heat; it should instead be treated as
      // missing data and skipped.
      const deviceState = createMockDeviceState({
        id: 'device-1',
        mode: 'auto',
        currentTemperature: 0,
        coolingSetpoint: 72,
        heatingSetpoint: 68,
      });

      mockContext.getDevices.mockReturnValue([
        createMockDevice({ deviceId: 'device-1', mode: 'auto' }),
      ]);

      mockContext.getDeviceStatus.mockResolvedValue(deviceState);

      const result = await plugin.manualCheck();

      expect(mockContext.setSmartThingsState).not.toHaveBeenCalled();
      expect(result.corrected).toEqual([]);
      expect(mockContext.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ temp: 0 }),
        expect.stringContaining('missing temperature data')
      );
    });

    it('should run the check when the cron task fires (cron is the single trigger)', async () => {
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

      // The describe-level beforeEach already called plugin.start(), which
      // registered the cron callback via the mocked cron.schedule. Invoke
      // that captured callback directly to simulate the cron firing.
      const cronCallback = (cron.schedule as jest.Mock).mock.calls[0][1] as () => Promise<void>;
      await cronCallback();

      expect(mockContext.setSmartThingsState).toHaveBeenCalledWith('device-1', {
        thermostatMode: 'heat',
        heatingSetpoint: 68,
      });
    });

    it('should skip an overlapping check while one is already in progress (reentrancy latch)', async () => {
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

      // Hold getDeviceStatus pending so the first check is still in flight
      // (and isChecking is still true) when the second check starts.
      let resolveStatus!: (state: DeviceState) => void;
      const pendingStatus = new Promise<DeviceState>(resolve => {
        resolveStatus = resolve;
      });
      mockContext.getDeviceStatus.mockReturnValue(pendingStatus);

      const firstCheck = plugin.manualCheck();
      const secondCheck = plugin.manualCheck();

      resolveStatus(deviceState);

      const [firstResult, secondResult] = await Promise.all([firstCheck, secondCheck]);

      expect(secondResult).toEqual({ checked: 0, corrected: [], errors: [], skipped: true });
      expect(firstResult.corrected).toEqual(['device-1']);
      // Only the first (non-skipped) check should have issued a correction.
      expect(mockContext.setSmartThingsState).toHaveBeenCalledTimes(1);
      expect(mockContext.logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: 'manual' }),
        expect.stringContaining('already in progress')
      );
    });

    it('should perform no device fetches or commands on onPollCycle', async () => {
      // onPollCycle is now an intentional no-op: the cron task is the
      // single trigger for auto-mode checks. Clear the mocks first since
      // the describe-level beforeEach's plugin.start() already triggered an
      // (empty, no-op) initial check.
      mockContext.getDevices.mockReturnValue([
        createMockDevice({ deviceId: 'device-1', mode: 'auto' }),
      ]);
      mockContext.getDeviceStatus.mockResolvedValue(
        createMockDeviceState({ id: 'device-1', mode: 'auto', currentTemperature: 65 })
      );
      mockContext.getDevices.mockClear();
      mockContext.getDeviceStatus.mockClear();
      mockContext.setSmartThingsState.mockClear();

      await plugin.onPollCycle!([]);

      expect(mockContext.getDevices).not.toHaveBeenCalled();
      expect(mockContext.getDeviceStatus).not.toHaveBeenCalled();
      expect(mockContext.setSmartThingsState).not.toHaveBeenCalled();
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
