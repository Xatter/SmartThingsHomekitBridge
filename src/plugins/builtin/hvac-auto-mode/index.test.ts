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
import { AutoModeController } from './AutoModeController';

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

  describe('beforeSetHomeKitState - AUTO display', () => {
    it('marks enrolled devices with mode "auto" for HomeKit display (fix: key must be .mode, not .thermostatMode)', async () => {
      await internals().controller.enrollDevice('device-1');
      const device = createMockDevice({ deviceId: 'device-1' });

      const result = await plugin.beforeSetHomeKitState!(device, { mode: 'heat', someOtherField: 1 });

      expect(result).toMatchObject({ mode: 'auto', someOtherField: 1 });
      expect(result.thermostatMode).toBeUndefined();
    });

    it('leaves state unchanged for devices that are not enrolled', async () => {
      const device = createMockDevice({ deviceId: 'device-99' });
      const result = await plugin.beforeSetHomeKitState!(device, { mode: 'heat' });
      expect(result).toEqual({ mode: 'heat' });
    });
  });

  describe('getWebRoutes - /decision error handling', () => {
    it('returns 500 with an error body when computing the decision throws', async () => {
      await internals().controller.enrollDevice('device-1');
      mockContext.getDevices.mockImplementation(() => {
        throw new Error('boom');
      });

      const routes = plugin.getWebRoutes!();
      const decisionRoute = routes.find(r => r.path === '/decision')!;

      const res: any = {
        statusCode: 200,
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        json: jest.fn(),
      };

      await (decisionRoute.handler as any)({}, res);

      expect(res.statusCode).toBe(500);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
    });
  });

  describe('stop() - state persistence', () => {
    it('persists the full internal state including timing locks (no lossy recompute)', async () => {
      Object.assign(internals().controller.state, {
        currentMode: 'cool',
        lastSwitchTime: 12345,
        lastOnTime: 6789,
        lastOffTime: 4321,
        enrolledDeviceIds: ['device-1'],
      });

      mockContext.saveState.mockClear();
      await plugin.stop();

      expect(mockContext.saveState).toHaveBeenCalledWith('state', {
        currentMode: 'cool',
        lastSwitchTime: 12345,
        lastOnTime: 6789,
        lastOffTime: 4321,
        enrolledDeviceIds: ['device-1'],
      });
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
        driveAttempts: 0,
      });

      // Controller mode must NOT have been committed yet — that happens only after off-cycle completes
      expect(internals().controller.getCurrentMode()).toBe('heat');
    });

    it('persists the pendingFlip BEFORE sending the first OFF command (crash-window safety)', async () => {
      primeControllerMode('heat');
      await enrollDevices(['device-1']);

      mockContext.saveState.mockClear();

      const devices = [
        enrolledDevice({ deviceId: 'device-1', currentTemperature: 80, coolingSetpoint: 70, switchState: 'on' }),
      ];

      await plugin.onPollCycle!(devices);

      const saveStateMock = mockContext.saveState as jest.Mock;
      const flipSaveIndex = saveStateMock.mock.calls.findIndex(
        ([key, value]) => key === 'pendingFlip' && value !== null
      );
      expect(flipSaveIndex).toBeGreaterThanOrEqual(0);

      const offSendMock = mockContext.setSmartThingsState as jest.Mock;
      expect(offSendMock).toHaveBeenCalled();

      // If the process dies between the OFF sends and the persist, devices
      // are off with no on-disk record of the flip — nothing would ever turn
      // them back on. The persist must therefore come first.
      const flipSaveOrder = saveStateMock.mock.invocationCallOrder[flipSaveIndex];
      const firstOffOrder = offSendMock.mock.invocationCallOrder[0];
      expect(flipSaveOrder).toBeLessThan(firstOffOrder);
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
        driveAttempts: 0,
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
        driveAttempts: 0,
      };

      const devices = [
        enrolledDevice({ deviceId: 'device-1', switchState: 'off' }),
        enrolledDevice({ deviceId: 'device-2', switchState: 'on' }),
      ];

      await plugin.onPollCycle!(devices);

      expect(internals().pendingFlip.phase).toBe('awaiting_off');
      expect(internals().pendingFlip.allOffAt).toBeUndefined();
      expect(internals().pendingFlip.driveAttempts).toBe(1);
      expect(mockContext.setSmartThingsState).not.toHaveBeenCalled();
    });

    it('aborts the flip after 3 stalled awaiting_off drives and restores the pre-flip mode', async () => {
      primeControllerMode('heat');
      await enrollDevices(['device-1']);

      // Two stalled drives already happened; this poll is the 3rd -> should abort.
      internals().pendingFlip = {
        targetMode: 'cool',
        phase: 'awaiting_off',
        startedAt: Date.now(),
        deviceIds: ['device-1'],
        driveAttempts: 2,
      };

      const devices = [enrolledDevice({ deviceId: 'device-1', switchState: 'on' })];

      await plugin.onPollCycle!(devices);

      expect(internals().pendingFlip).toBeNull();
      expect(internals().controller.getCurrentMode()).toBe('heat');

      // Restore: the pre-flip mode ('heat') must be re-sent to the still-enrolled device.
      const calls = mockContext.setSmartThingsState.mock.calls;
      expect(calls.length).toBe(1);
      expect(calls[0]).toEqual(['device-1', { thermostatMode: 'heat' }]);

      const warnCalls = (mockContext.logger.warn as jest.Mock).mock.calls;
      expect(warnCalls.some(args => typeof args[1] === 'string' && /abort/i.test(args[1]))).toBe(true);

      // The clear must be persisted as null.
      expect(mockContext.saveState).toHaveBeenCalledWith('pendingFlip', null);
    });

    it('restores pre-flip mode only to devices still enrolled when aborting', async () => {
      primeControllerMode('heat');
      await enrollDevices(['device-1', 'device-2']);

      internals().pendingFlip = {
        targetMode: 'cool',
        phase: 'awaiting_off',
        startedAt: Date.now(),
        deviceIds: ['device-1', 'device-2'],
        driveAttempts: 2,
      };

      // device-2 was unenrolled since the flip started (e.g. manual HomeKit mode change).
      await internals().controller.unenrollDevice('device-2');

      const devices = [
        enrolledDevice({ deviceId: 'device-1', switchState: 'on' }),
        enrolledDevice({ deviceId: 'device-2', switchState: 'on' }),
      ];

      await plugin.onPollCycle!(devices);

      expect(internals().pendingFlip).toBeNull();
      const calls = mockContext.setSmartThingsState.mock.calls;
      expect(calls.length).toBe(1);
      expect(calls[0]).toEqual(['device-1', { thermostatMode: 'heat' }]);
    });

    it('does not send any restore command when aborting from pre-flip mode "off"', async () => {
      primeControllerMode('off');
      await enrollDevices(['device-1']);

      internals().pendingFlip = {
        targetMode: 'cool',
        phase: 'awaiting_off',
        startedAt: Date.now(),
        deviceIds: ['device-1'],
        driveAttempts: 2,
      };

      const devices = [enrolledDevice({ deviceId: 'device-1', switchState: 'on' })];
      await plugin.onPollCycle!(devices);

      expect(internals().pendingFlip).toBeNull();
      expect(mockContext.setSmartThingsState).not.toHaveBeenCalled();
    });

    it('clears the flip without sending commands when no flip devices remain enrolled', async () => {
      primeControllerMode('heat');
      await enrollDevices(['device-1']);

      internals().pendingFlip = {
        targetMode: 'cool',
        phase: 'awaiting_off',
        startedAt: Date.now(),
        deviceIds: ['device-1'],
        driveAttempts: 0,
      };

      await internals().controller.unenrollDevice('device-1');

      const devices = [enrolledDevice({ deviceId: 'device-1', switchState: 'on' })];
      await plugin.onPollCycle!(devices);

      expect(internals().pendingFlip).toBeNull();
      expect(mockContext.setSmartThingsState).not.toHaveBeenCalled();
      expect(mockContext.saveState).toHaveBeenCalledWith('pendingFlip', null);
    });

    it('does not command a device that was unenrolled before the new mode is applied', async () => {
      primeControllerMode('heat');
      await enrollDevices(['device-1', 'device-2']);

      const minOffMs = internals().controller.getConfig().minOffTime * 1000;
      internals().pendingFlip = {
        targetMode: 'cool',
        phase: 'awaiting_min_off_time',
        startedAt: Date.now() - minOffMs - 60_000,
        allOffAt: Date.now() - minOffMs - 1_000,
        deviceIds: ['device-1', 'device-2'],
        driveAttempts: 0,
      };

      // device-2 was unenrolled while waiting on min-off-time.
      await internals().controller.unenrollDevice('device-2');

      const devices = [
        enrolledDevice({ deviceId: 'device-1', switchState: 'off' }),
        enrolledDevice({ deviceId: 'device-2', switchState: 'off' }),
      ];

      await plugin.onPollCycle!(devices);

      const calls = mockContext.setSmartThingsState.mock.calls;
      expect(calls.length).toBe(1);
      expect(calls[0]).toEqual(['device-1', { thermostatMode: 'cool' }]);
      expect(internals().pendingFlip).toBeNull();
      expect(internals().controller.getCurrentMode()).toBe('cool');
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
        driveAttempts: 0,
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
      expect(mockContext.saveState).toHaveBeenCalledWith('pendingFlip', null);
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
        driveAttempts: 0,
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

    describe('pendingFlip persistence', () => {
      it('persists pendingFlip via saveState on create, phase-advance, and clear', async () => {
        primeControllerMode('heat');
        await enrollDevices(['device-1']);

        mockContext.saveState.mockClear();

        // 1. create — flip starts because cool demand dominates
        const offDevices = [
          enrolledDevice({ deviceId: 'device-1', currentTemperature: 80, coolingSetpoint: 70, switchState: 'on' }),
        ];
        await plugin.onPollCycle!(offDevices);

        expect(mockContext.saveState).toHaveBeenCalledWith(
          'pendingFlip',
          expect.objectContaining({ targetMode: 'cool', phase: 'awaiting_off' })
        );

        // 2. phase-advance — all devices now report off
        mockContext.saveState.mockClear();
        const allOffDevices = [enrolledDevice({ deviceId: 'device-1', switchState: 'off' })];
        await plugin.onPollCycle!(allOffDevices);

        expect(mockContext.saveState).toHaveBeenCalledWith(
          'pendingFlip',
          expect.objectContaining({ phase: 'awaiting_min_off_time' })
        );

        // 3. clear — min-off-time elapses
        internals().pendingFlip.allOffAt = Date.now() - internals().controller.getConfig().minOffTime * 1000 - 1_000;
        mockContext.saveState.mockClear();
        await plugin.onPollCycle!(allOffDevices);

        expect(mockContext.saveState).toHaveBeenCalledWith('pendingFlip', null);
      });

      it('restores a fresh (non-stale) pendingFlip from context.loadState on init', async () => {
        const freshFlip = {
          targetMode: 'cool' as const,
          phase: 'awaiting_off' as const,
          startedAt: Date.now(),
          deviceIds: ['device-1'],
          driveAttempts: 1,
        };
        mockContext.loadState.mockImplementation(async (key: string) => {
          if (key === 'pendingFlip') return freshFlip;
          return undefined;
        });

        await plugin.init(mockContext);

        expect(internals().pendingFlip).toMatchObject({ targetMode: 'cool', phase: 'awaiting_off', driveAttempts: 1 });
        expect(internals().pendingFlip.stale).not.toBe(true);
      });

      it('aborts-with-restore on the first poll when the restored flip is stale (>30 min old)', async () => {
        const staleFlip = {
          targetMode: 'cool' as const,
          phase: 'awaiting_off' as const,
          startedAt: Date.now() - 31 * 60 * 1000,
          deviceIds: ['device-1'],
          driveAttempts: 0,
        };
        mockContext.loadState.mockImplementation(async (key: string) => {
          if (key === 'pendingFlip') return staleFlip;
          if (key === 'state') {
            return {
              currentMode: 'heat',
              lastSwitchTime: 0,
              lastOnTime: 0,
              lastOffTime: 0,
              enrolledDeviceIds: ['device-1'],
            };
          }
          return undefined;
        });

        await plugin.init(mockContext);
        expect(internals().pendingFlip.stale).toBe(true);

        const devices = [enrolledDevice({ deviceId: 'device-1', switchState: 'on' })];
        await plugin.onPollCycle!(devices);

        expect(internals().pendingFlip).toBeNull();
        expect(mockContext.setSmartThingsState).toHaveBeenCalledWith('device-1', { thermostatMode: 'heat' });
      });

      it('treats a restored awaiting_min_off_time flip without allOffAt as stale and aborts-with-restore', async () => {
        // Without this guard, elapsedSinceOff = now - (allOffAt ?? now) is
        // always 0, so the flip would hold forever with the units off.
        const inconsistentFlip = {
          targetMode: 'cool' as const,
          phase: 'awaiting_min_off_time' as const,
          startedAt: Date.now() - 60_000, // fresh — NOT stale by age
          deviceIds: ['device-1'],
          driveAttempts: 0,
          // allOffAt missing
        };
        mockContext.loadState.mockImplementation(async (key: string) => {
          if (key === 'pendingFlip') return inconsistentFlip;
          if (key === 'state') {
            return {
              currentMode: 'heat',
              lastSwitchTime: 0,
              lastOnTime: 0,
              lastOffTime: 0,
              enrolledDeviceIds: ['device-1'],
            };
          }
          return undefined;
        });

        await plugin.init(mockContext);
        expect(internals().pendingFlip.stale).toBe(true);

        const devices = [enrolledDevice({ deviceId: 'device-1', switchState: 'off' })];
        await plugin.onPollCycle!(devices);

        expect(internals().pendingFlip).toBeNull();
        expect(mockContext.setSmartThingsState).toHaveBeenCalledWith('device-1', { thermostatMode: 'heat' });
        expect(mockContext.saveState).toHaveBeenCalledWith('pendingFlip', null);
      });

      it('marks a restored flip with wrong-typed fields as stale and falls back to enrolled IDs for restore', async () => {
        const junkFlip = {
          targetMode: 'sideways',
          phase: 'awaiting_off',
          startedAt: 'not-a-number',
          deviceIds: 'not-an-array',
          driveAttempts: 0,
        };
        mockContext.loadState.mockImplementation(async (key: string) => {
          if (key === 'pendingFlip') return junkFlip;
          if (key === 'state') {
            return {
              currentMode: 'heat',
              lastSwitchTime: 0,
              lastOnTime: 0,
              lastOffTime: 0,
              enrolledDeviceIds: ['device-1'],
            };
          }
          return undefined;
        });

        await plugin.init(mockContext);
        expect(internals().pendingFlip.stale).toBe(true);
        // Unusable deviceIds fall back to the enrolled set so the abort can
        // still restore the units that were sent OFF.
        expect(internals().pendingFlip.deviceIds).toEqual(['device-1']);

        const devices = [enrolledDevice({ deviceId: 'device-1', switchState: 'on' })];
        await plugin.onPollCycle!(devices);

        expect(internals().pendingFlip).toBeNull();
        expect(mockContext.setSmartThingsState).toHaveBeenCalledWith('device-1', { thermostatMode: 'heat' });
      });
    });
  });
});

describe('AutoModeController.restoreState', () => {
  it('copies only known ControllerState fields with valid types, ignoring junk keys', () => {
    const controller = new AutoModeController();
    controller.restoreState({
      currentMode: 'cool',
      lastSwitchTime: 111,
      lastOnTime: 222,
      lastOffTime: 333,
      enrolledDeviceIds: ['a', 'b'],
      junkField: 'should be ignored',
      statePath: '/some/legacy/path', // leftover shape from a previous persisted version
    });

    expect(controller.getCurrentMode()).toBe('cool');
    expect(controller.getEnrolledDeviceIds()).toEqual(['a', 'b']);
    expect(controller.getState()).toEqual({
      currentMode: 'cool',
      lastSwitchTime: 111,
      lastOnTime: 222,
      lastOffTime: 333,
      enrolledDeviceIds: ['a', 'b'],
    });
  });

  it('ignores invalid types for known fields, leaving current values intact', () => {
    const controller = new AutoModeController();
    controller.restoreState({
      currentMode: 'sideways', // not a valid mode
      lastSwitchTime: 'not-a-number',
      lastOnTime: null,
      enrolledDeviceIds: ['ok', 42], // invalid element -> whole array rejected
    });

    expect(controller.getCurrentMode()).toBe('off'); // unchanged default
    expect(controller.getState().lastSwitchTime).toBe(0); // unchanged default
    expect(controller.getState().lastOnTime).toBe(0); // unchanged default
    expect(controller.getEnrolledDeviceIds()).toEqual([]); // unchanged default
  });

  it('does nothing when given non-object input', () => {
    const controller = new AutoModeController();
    controller.restoreState(null);
    controller.restoreState(undefined);
    controller.restoreState('a string');
    controller.restoreState(42);

    expect(controller.getCurrentMode()).toBe('off');
    expect(controller.getEnrolledDeviceIds()).toEqual([]);
  });

  it('save() is a no-op when no persist callback was supplied', async () => {
    const controller = new AutoModeController();
    await expect(controller.save()).resolves.toBeUndefined();
  });

  it('save() invokes the persist callback with the full state', async () => {
    const persist = jest.fn().mockResolvedValue(undefined);
    const controller = new AutoModeController(persist);

    await controller.enrollDevice('device-1');

    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ enrolledDeviceIds: ['device-1'] })
    );
  });
});
