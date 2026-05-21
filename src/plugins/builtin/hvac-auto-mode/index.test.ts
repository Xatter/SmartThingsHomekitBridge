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

// Import the plugin after mocks are set up
import plugin from './index';

// Helper: reach into the plugin's private controller for test setup.
const internals = () => plugin as any;

describe('HVACAutoModePlugin - Auto Mode Detection', () => {
  let mockContext: jest.Mocked<PluginContext>;

  const createMockDevice = (overrides: Partial<UnifiedDevice>): UnifiedDevice => ({
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
  });

  beforeEach(async () => {
    jest.clearAllMocks();

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
      pluginName: 'hvac-auto-mode',
    };

    // Initialize the plugin fresh for each test
    await plugin.init(mockContext);
    await plugin.start();

    // Stub the controller's disk persistence so tests don't write to cwd.
    internals().controller.save = jest.fn().mockResolvedValue(undefined);

    // The plugin singleton's pendingFlip is not reset by init(); zero it
    // so each test starts from a clean state-machine baseline.
    internals().pendingFlip = null;
  });

  afterEach(async () => {
    await plugin.stop();
  });

  describe('onPollCycle - enrollment coordination only', () => {
    it('should not make API calls when no devices are enrolled', async () => {
      const devices: UnifiedDevice[] = [
        createMockDevice({ deviceId: 'device-1', label: 'Living Room', mode: 'cool' }),
        createMockDevice({ deviceId: 'device-2', label: 'Bedroom', mode: 'heat' }),
      ];

      await plugin.onPollCycle!(devices);

      expect(mockContext.setSmartThingsState).not.toHaveBeenCalled();
    });

    it('should not correct devices in auto mode (auto-mode-monitor handles this)', async () => {
      const devices: UnifiedDevice[] = [
        createMockDevice({ deviceId: 'device-1', label: 'Living Room', mode: 'auto' }),
        createMockDevice({ deviceId: 'device-2', label: 'Bedroom', mode: 'heat' }),
      ];

      // No enrollments - plugin should not attempt to correct auto mode
      await plugin.onPollCycle!(devices);

      expect(mockContext.setSmartThingsState).not.toHaveBeenCalled();
    });

    it('should not make API calls when devices are in auto mode but not enrolled', async () => {
      const devices: UnifiedDevice[] = [
        createMockDevice({
          deviceId: 'device-1',
          label: 'Living Room',
          mode: 'auto',
          currentTemperature: 75,
          coolingSetpoint: 72,
        }),
        createMockDevice({
          deviceId: 'device-2',
          label: 'Bedroom',
          mode: 'auto',
          currentTemperature: 74,
          coolingSetpoint: 72,
        }),
      ];

      await plugin.onPollCycle!(devices);

      // No enrollments means no API calls, even though devices report auto mode
      expect(mockContext.setSmartThingsState).not.toHaveBeenCalled();
    });
  });

  describe('heat<->cool flip protocol', () => {
    // Build a device with the fields the flip logic reads (currentState + setpoints).
    const enrolledDevice = (overrides: Partial<UnifiedDevice> & { switchState?: 'on' | 'off' }): UnifiedDevice => {
      const { switchState, ...rest } = overrides;
      const currentState: DeviceState = {
        id: rest.deviceId ?? 'device-1',
        name: rest.label ?? 'Test',
        temperatureSetpoint: rest.coolingSetpoint ?? 70,
        currentTemperature: rest.currentTemperature ?? 75,
        mode: rest.mode ?? 'heat',
        lightOn: false,
        lastUpdated: new Date(),
        heatingSetpoint: rest.heatingSetpoint,
        coolingSetpoint: rest.coolingSetpoint,
        switchState: switchState ?? 'on',
      };
      return createMockDevice({ currentState, ...rest });
    };

    // Force the controller into a state where canSwitchMode will allow heat<->cool.
    const primeControllerMode = (mode: 'heat' | 'cool' | 'off') => {
      Object.assign(internals().controller.state, {
        currentMode: mode,
        lastSwitchTime: 0,
        lastOnTime: 0,
        lastOffTime: 0,
      });
    };

    const enrollDevices = async (ids: string[]) => {
      for (const id of ids) {
        await internals().controller.enrollDevice(id);
      }
    };

    it('starts a flip by sending OFF to all enrolled devices when demand flips heat->cool', async () => {
      primeControllerMode('heat');
      await enrollDevices(['device-1', 'device-2']);

      // Two rooms well above the cool setpoint -> cool demand, no heat demand
      const devices = [
        enrolledDevice({ deviceId: 'device-1', label: 'Room 1', currentTemperature: 80, coolingSetpoint: 70, switchState: 'on' }),
        enrolledDevice({ deviceId: 'device-2', label: 'Room 2', currentTemperature: 78, coolingSetpoint: 70, switchState: 'on' }),
      ];

      await plugin.onPollCycle!(devices);

      // Should have sent OFF to each enrolled device, NOT the new mode yet
      const calls = mockContext.setSmartThingsState.mock.calls;
      expect(calls.length).toBe(2);
      expect(calls.every(([, state]) => state.thermostatMode === 'off')).toBe(true);

      // Pending flip should be recorded targeting cool, in awaiting_off
      expect(internals().pendingFlip).toMatchObject({
        targetMode: 'cool',
        phase: 'awaiting_off',
        deviceIds: ['device-1', 'device-2'],
      });

      // Controller mode must NOT have been committed yet — that happens only after off-cycle completes
      expect(internals().controller.getCurrentMode()).toBe('heat');
    });

    it('warns when a non-enrolled HVAC unit is on in a conflicting mode', async () => {
      primeControllerMode('heat');
      await enrollDevices(['device-1']);

      const devices = [
        enrolledDevice({ deviceId: 'device-1', currentTemperature: 80, coolingSetpoint: 70, switchState: 'on', mode: 'heat' }),
        // Non-enrolled, still on, mode is heat — conflicts with flip to cool
        enrolledDevice({ deviceId: 'unenrolled-1', label: 'Spare', currentTemperature: 72, coolingSetpoint: 70, switchState: 'on', mode: 'heat' }),
      ];

      await plugin.onPollCycle!(devices);

      const warnCalls = (mockContext.logger.warn as jest.Mock).mock.calls;
      const matched = warnCalls.find(args => typeof args[1] === 'string' && args[1].includes('conflicting mode'));
      expect(matched).toBeDefined();
      expect(matched![0]).toMatchObject({
        targetMode: 'cool',
        conflictingDevices: expect.arrayContaining([
          expect.objectContaining({ deviceId: 'unenrolled-1', mode: 'heat' }),
        ]),
      });
    });

    it('transitions awaiting_off -> awaiting_min_off_time once all enrolled devices report off', async () => {
      primeControllerMode('heat');
      await enrollDevices(['device-1', 'device-2']);

      // Seed the flip directly so we can test just this state-machine edge
      internals().pendingFlip = {
        targetMode: 'cool',
        phase: 'awaiting_off',
        startedAt: Date.now(),
        deviceIds: ['device-1', 'device-2'],
      };

      const devices = [
        enrolledDevice({ deviceId: 'device-1', switchState: 'off' }),
        enrolledDevice({ deviceId: 'device-2', switchState: 'off' }),
      ];

      await plugin.onPollCycle!(devices);

      expect(internals().pendingFlip.phase).toBe('awaiting_min_off_time');
      expect(internals().pendingFlip.allOffAt).toBeDefined();
      // Still must not have sent the new mode yet — we're still waiting min-off-time
      expect(mockContext.setSmartThingsState).not.toHaveBeenCalled();
    });

    it('stays in awaiting_off when at least one device is still on', async () => {
      primeControllerMode('heat');
      await enrollDevices(['device-1', 'device-2']);

      internals().pendingFlip = {
        targetMode: 'cool',
        phase: 'awaiting_off',
        startedAt: Date.now(),
        deviceIds: ['device-1', 'device-2'],
      };

      const devices = [
        enrolledDevice({ deviceId: 'device-1', switchState: 'off' }),
        enrolledDevice({ deviceId: 'device-2', switchState: 'on' }),
      ];

      await plugin.onPollCycle!(devices);

      expect(internals().pendingFlip.phase).toBe('awaiting_off');
      expect(internals().pendingFlip.allOffAt).toBeUndefined();
      expect(mockContext.setSmartThingsState).not.toHaveBeenCalled();
    });

    it('aborts the flip and clears state when off-cycle times out', async () => {
      primeControllerMode('heat');
      await enrollDevices(['device-1']);

      // Pretend the flip started 60s ago (past the 30s timeout) and the device is still on
      internals().pendingFlip = {
        targetMode: 'cool',
        phase: 'awaiting_off',
        startedAt: Date.now() - 60_000,
        deviceIds: ['device-1'],
      };

      const devices = [enrolledDevice({ deviceId: 'device-1', switchState: 'on' })];

      await plugin.onPollCycle!(devices);

      expect(internals().pendingFlip).toBeNull();
      expect(internals().controller.getCurrentMode()).toBe('heat');
      expect(mockContext.setSmartThingsState).not.toHaveBeenCalled();

      const warnCalls = (mockContext.logger.warn as jest.Mock).mock.calls;
      expect(warnCalls.some(args => typeof args[1] === 'string' && args[1].includes('Off-cycle timeout'))).toBe(true);
    });

    it('applies the new mode and commits the controller once min-off-time elapses', async () => {
      primeControllerMode('heat');
      await enrollDevices(['device-1', 'device-2']);

      const minOffMs = internals().controller.getConfig().minOffTime * 1000;

      // Flip is past min-off-time
      internals().pendingFlip = {
        targetMode: 'cool',
        phase: 'awaiting_min_off_time',
        startedAt: Date.now() - minOffMs - 60_000,
        allOffAt: Date.now() - minOffMs - 1_000,
        deviceIds: ['device-1', 'device-2'],
      };

      const devices = [
        enrolledDevice({ deviceId: 'device-1', switchState: 'off' }),
        enrolledDevice({ deviceId: 'device-2', switchState: 'off' }),
      ];

      await plugin.onPollCycle!(devices);

      const calls = mockContext.setSmartThingsState.mock.calls;
      expect(calls.length).toBe(2);
      expect(calls.every(([, state]) => state.thermostatMode === 'cool')).toBe(true);

      expect(internals().pendingFlip).toBeNull();
      expect(internals().controller.getCurrentMode()).toBe('cool');
    });

    it('holds awaiting_min_off_time while min-off-time has not elapsed', async () => {
      primeControllerMode('heat');
      await enrollDevices(['device-1']);

      // allOffAt is very recent — min-off-time has NOT elapsed
      internals().pendingFlip = {
        targetMode: 'cool',
        phase: 'awaiting_min_off_time',
        startedAt: Date.now() - 5_000,
        allOffAt: Date.now() - 1_000,
        deviceIds: ['device-1'],
      };

      const devices = [enrolledDevice({ deviceId: 'device-1', switchState: 'off' })];

      await plugin.onPollCycle!(devices);

      expect(internals().pendingFlip.phase).toBe('awaiting_min_off_time');
      expect(internals().controller.getCurrentMode()).toBe('heat');
      expect(mockContext.setSmartThingsState).not.toHaveBeenCalled();
    });

    it('does NOT trigger the off-cycle for off -> heat (non-flip transition)', async () => {
      primeControllerMode('off');
      await enrollDevices(['device-1']);

      // Cold room -> heat demand
      const devices = [
        enrolledDevice({
          deviceId: 'device-1',
          currentTemperature: 60,
          heatingSetpoint: 68,
          coolingSetpoint: 72,
          switchState: 'on',
        }),
      ];

      await plugin.onPollCycle!(devices);

      // Should go straight to heat, no off-cycle
      const calls = mockContext.setSmartThingsState.mock.calls;
      expect(calls.length).toBe(1);
      expect(calls[0][1].thermostatMode).toBe('heat');
      expect(internals().pendingFlip).toBeNull();
      expect(internals().controller.getCurrentMode()).toBe('heat');
    });
  });
});
