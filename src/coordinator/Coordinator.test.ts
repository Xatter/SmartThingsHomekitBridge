import { Coordinator } from './Coordinator';
import { SmartThingsAPI } from '@/api/SmartThingsAPI';
import { SmartThingsHAPServer } from '@/hap/HAPServer';
import { PluginManager } from '@/plugins';
import { DeviceInclusionManager } from '@/config/DeviceInclusionManager';
import { DeviceState, UnifiedDevice } from '@/types';
import { promises as fs } from 'fs';
import * as cron from 'node-cron';

// Mock dependencies
jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
    mkdir: jest.fn(),
    rename: jest.fn(),
    unlink: jest.fn(),
  },
}));

jest.mock('node-cron', () => ({
  schedule: jest.fn(() => ({
    stop: jest.fn(),
  })),
}));

jest.mock('@/api/SmartThingsAPI');
jest.mock('@/hap/HAPServer');
jest.mock('@/plugins');
jest.mock('@/config/DeviceInclusionManager');

describe('Coordinator', () => {
  let coordinator: Coordinator;
  let mockApi: jest.Mocked<SmartThingsAPI>;
  let mockHapServer: jest.Mocked<SmartThingsHAPServer>;
  let mockPluginManager: jest.Mocked<PluginManager>;
  let mockInclusionManager: jest.Mocked<DeviceInclusionManager>;
  const mockStateFilePath = '/test/data/coordinator-state.json';

  const createMockDevice = (overrides: Partial<UnifiedDevice> = {}): UnifiedDevice => ({
    deviceId: 'device-123',
    name: 'Test Thermostat',
    label: 'Test Thermostat',
    manufacturerName: 'SmartThings',
    presentationId: 'test-presentation',
    deviceTypeName: 'Thermostat',
    capabilities: [{ id: 'thermostatMode', version: 1 }],
    components: [],
    thermostatCapabilities: {
      thermostatMode: true,
      thermostat: true,
      temperatureMeasurement: true,
      thermostatHeatingSetpoint: true,
      thermostatCoolingSetpoint: true,
    },
    isPaired: false,
    ...overrides,
  });

  const createMockDeviceState = (overrides: Partial<DeviceState> = {}): DeviceState => ({
    id: 'device-123',
    name: 'Test Thermostat',
    currentTemperature: 72,
    temperatureSetpoint: 70,
    mode: 'cool',
    lightOn: false,
    lastUpdated: new Date(),
    heatingSetpoint: 68,
    coolingSetpoint: 72,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Create mock API
    mockApi = {
      hasAuth: jest.fn().mockReturnValue(true),
      getDevices: jest.fn().mockResolvedValue([]),
      getDeviceStatus: jest.fn().mockResolvedValue(null),
      executeCommands: jest.fn().mockResolvedValue(undefined),
    } as any;

    // Create mock HAP server
    mockHapServer = {
      addDevice: jest.fn().mockResolvedValue(undefined),
      updateDeviceState: jest.fn().mockResolvedValue(undefined),
      removeDevice: jest.fn().mockResolvedValue(undefined),
    } as any;

    // Create mock plugin manager
    mockPluginManager = {
      beforeSetSmartThingsState: jest.fn().mockImplementation((device, state) => Promise.resolve(state)),
      beforeSetHomeKitState: jest.fn().mockImplementation((device, state) => Promise.resolve(state)),
      afterDeviceUpdate: jest.fn().mockResolvedValue(undefined),
      onPollCycle: jest.fn().mockResolvedValue(undefined),
    } as any;

    // Create mock inclusion manager
    mockInclusionManager = {
      isIncluded: jest.fn().mockReturnValue(true),
    } as any;

    // Mock fs operations by default
    (fs.readFile as jest.Mock).mockRejectedValue({ code: 'ENOENT' });
    (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
    (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
    (fs.rename as jest.Mock).mockResolvedValue(undefined);
    (fs.unlink as jest.Mock).mockResolvedValue(undefined);

    coordinator = new Coordinator(
      mockApi,
      mockHapServer,
      mockPluginManager,
      mockInclusionManager,
      mockStateFilePath,
      300 // 5 minute poll interval
    );
  });

  describe('convertSecondsToInterval', () => {
    test('given 60 seconds, should convert to minute cron format', () => {
      const coord = new Coordinator(mockApi, mockHapServer, mockPluginManager, mockInclusionManager, mockStateFilePath, 60);
      const interval = coord['pollInterval'];

      expect(interval).toBe('*/1 * * * *');
    });

    test('given 300 seconds, should convert to 5 minute cron format', () => {
      const coord = new Coordinator(mockApi, mockHapServer, mockPluginManager, mockInclusionManager, mockStateFilePath, 300);
      const interval = coord['pollInterval'];

      expect(interval).toBe('*/5 * * * *');
    });

    test('given 45 seconds (sub-minute), should fall back to every minute', () => {
      const coord = new Coordinator(mockApi, mockHapServer, mockPluginManager, mockInclusionManager, mockStateFilePath, 45);
      const interval = coord['pollInterval'];

      // Sub-minute intervals fall back to every minute
      expect(interval).toBe('* * * * *');
    });
  });

  describe('initialize', () => {
    test('given no existing state, should initialize successfully', async () => {
      (fs.readFile as jest.Mock).mockRejectedValue({ code: 'ENOENT' });

      await coordinator.initialize();

      expect(cron.schedule).toHaveBeenCalled();
    });

    test('given existing state with devices, should reload devices after delay', async () => {
      // Note: this intentionally avoids jest.useFakeTimers() AND jest.spyOn(global,
      // 'setTimeout') - in this environment (Jest 30 + Node's newer timer internals),
      // touching the global setTimeout binding via either mechanism leaves it permanently
      // unresolvable (ReferenceError) for the rest of the test file, even after
      // useRealTimers()/mockRestore(). A real (short) wait is used instead so the actual
      // global setTimeout is never faked or intercepted.
      const savedState = {
        pairedDevices: ['device-1', 'device-2'],
        averageTemperature: 72,
        currentMode: 'cool',
        deviceStates: [],
      };
      (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(savedState));

      const reloadSpy = jest.spyOn(coordinator as any, 'reloadDevices').mockResolvedValue(undefined);

      await coordinator.initialize();

      // reloadDevices should be scheduled but not called yet
      expect(reloadSpy).not.toHaveBeenCalled();
      expect(coordinator['startupTimer']).not.toBeNull();

      // Wait past the 2-second startup delay.
      await new Promise((resolve) => setTimeout(resolve, 2200));

      expect(reloadSpy).toHaveBeenCalled();
    }, 10000);

    test('given no auth, should not reload devices', async () => {
      mockApi.hasAuth.mockReturnValue(false);
      const savedState = {
        pairedDevices: ['device-1'],
        averageTemperature: 72,
        currentMode: 'cool',
        deviceStates: [],
      };
      (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(savedState));

      const reloadSpy = jest.spyOn(coordinator as any, 'reloadDevices').mockResolvedValue(undefined);

      await coordinator.initialize();

      // No auth means initialize() never schedules the startup timer in the first place.
      expect(reloadSpy).not.toHaveBeenCalled();
    });
  });

  describe('loadState', () => {
    test('given valid state file, should load state correctly', async () => {
      const savedState = {
        pairedDevices: ['device-1', 'device-2'],
        averageTemperature: 72,
        currentMode: 'cool',
        deviceStates: [
          ['device-1', { id: 'device-1', name: 'Device 1', currentTemperature: 72, temperatureSetpoint: 70, mode: 'cool', lightOn: false, lastUpdated: new Date().toISOString() }],
        ],
      };

      (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(savedState));

      await coordinator['loadState']();

      const state = coordinator.getState();
      expect(state.pairedDevices).toEqual(['device-1', 'device-2']);
      expect(state.averageTemperature).toBe(72);
      expect(state.currentMode).toBe('cool');
      expect(state.deviceStates.size).toBe(1);
    });

    test('given missing state file, should use default state', async () => {
      const error: NodeJS.ErrnoException = new Error('File not found');
      error.code = 'ENOENT';
      (fs.readFile as jest.Mock).mockRejectedValue(error);

      await coordinator['loadState']();

      const state = coordinator.getState();
      expect(state.pairedDevices).toEqual([]);
      expect(state.averageTemperature).toBe(70);
      expect(state.currentMode).toBe('off');
    });

    test('given corrupted state file, should use default state', async () => {
      (fs.readFile as jest.Mock).mockResolvedValue('invalid json {');

      await coordinator['loadState']();

      const state = coordinator.getState();
      expect(state.pairedDevices).toEqual([]);
    });
  });

  describe('saveState', () => {
    test('given coordinator state, should save to file atomically (write temp file, then rename)', async () => {
      await coordinator['saveState']();

      expect(fs.mkdir).toHaveBeenCalled();
      // atomicWriteJson writes to a temp file in the same directory first...
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('coordinator-state.json'),
        expect.stringContaining('"pairedDevices"'),
        'utf-8'
      );
      // ...then atomically renames it into place at the real path.
      expect(fs.rename).toHaveBeenCalledWith(
        expect.stringContaining('coordinator-state.json'),
        mockStateFilePath
      );
    });

    test('given device states, should serialize correctly', async () => {
      coordinator['state'].pairedDevices = ['device-1'];
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState());

      await coordinator['saveState']();

      const writeCall = (fs.writeFile as jest.Mock).mock.calls[0];
      const savedData = JSON.parse(writeCall[1]);

      expect(savedData.deviceStates).toBeInstanceOf(Array);
      expect(savedData.deviceStates.length).toBe(1);
    });
  });

  describe('reloadDevices', () => {
    test('given no auth, should not reload', async () => {
      mockApi.hasAuth.mockReturnValue(false);

      await coordinator.reloadDevices();

      expect(mockApi.getDevices).not.toHaveBeenCalled();
    });

    test('given API failure, should handle gracefully', async () => {
      mockApi.getDevices.mockRejectedValue(new Error('API error'));

      await expect(coordinator.reloadDevices()).resolves.not.toThrow();
    });
  });

  describe('handleThermostatEvent', () => {
    test('given temperature event in cool mode, should send cooling setpoint command', async () => {
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ mode: 'cool' }));
      // Need to also set device metadata for buildUnifiedDevice
      coordinator['deviceMetadata'].set('device-1', createMockDevice({ deviceId: 'device-1' }));

      await coordinator.handleThermostatEvent({
        deviceId: 'device-1',
        type: 'temperature',
        temperature: 68,
      });

      expect(mockApi.executeCommands).toHaveBeenCalledWith('device-1', [
        {
          component: 'main',
          capability: 'thermostatCoolingSetpoint',
          command: 'setCoolingSetpoint',
          arguments: [68],
        },
      ]);
    });

    test('given temperature event in heat mode, should send heating setpoint command', async () => {
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ mode: 'heat' }));
      coordinator['deviceMetadata'].set('device-1', createMockDevice({ deviceId: 'device-1' }));

      await coordinator.handleThermostatEvent({
        deviceId: 'device-1',
        type: 'temperature',
        temperature: 68,
      });

      expect(mockApi.executeCommands).toHaveBeenCalledWith('device-1', [
        {
          component: 'main',
          capability: 'thermostatHeatingSetpoint',
          command: 'setHeatingSetpoint',
          arguments: [68],
        },
      ]);
    });

    test('given mode event, should send mode command', async () => {
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ mode: 'cool' }));
      coordinator['deviceMetadata'].set('device-1', createMockDevice({ deviceId: 'device-1' }));

      await coordinator.handleThermostatEvent({
        deviceId: 'device-1',
        type: 'mode',
        mode: 'heat',
      });

      expect(mockApi.executeCommands).toHaveBeenCalledWith('device-1', [
        {
          component: 'main',
          capability: 'thermostatMode',
          command: 'setThermostatMode',
          arguments: ['heat'],
        },
      ]);
    });

    test('given mode event for Samsung AC, should use airConditionerMode', async () => {
      // Set switchState to 'on' so it doesn't need to turn on first
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ mode: 'cool', switchState: 'on' }));
      coordinator['deviceMetadata'].set('device-1', createMockDevice({
        deviceId: 'device-1',
        thermostatCapabilities: {
          airConditionerMode: true,
          thermostatMode: false,
          temperatureMeasurement: true,
        },
      }));

      await coordinator.handleThermostatEvent({
        deviceId: 'device-1',
        type: 'mode',
        mode: 'cool',
      });

      expect(mockApi.executeCommands).toHaveBeenCalledWith('device-1', [
        {
          component: 'main',
          capability: 'airConditionerMode',
          command: 'setAirConditionerMode',
          arguments: ['cool'],
        },
      ]);
    });

    test('given off mode event for Samsung AC, should use switch.off', async () => {
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ mode: 'cool', switchState: 'on' }));
      coordinator['deviceMetadata'].set('device-1', createMockDevice({
        deviceId: 'device-1',
        thermostatCapabilities: {
          airConditionerMode: true,
          thermostatMode: false,
          temperatureMeasurement: true,
          switch: true,
        },
      }));

      await coordinator.handleThermostatEvent({
        deviceId: 'device-1',
        type: 'mode',
        mode: 'off',
      });

      expect(mockApi.executeCommands).toHaveBeenCalledWith('device-1', [
        {
          component: 'main',
          capability: 'switch',
          command: 'off',
          arguments: [],
        },
      ]);
    });

    test('given mode event for Samsung AC when off, should turn on first', async () => {
      // switchState is 'off', so it should turn on before setting mode
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ mode: 'off', switchState: 'off' }));
      coordinator['deviceMetadata'].set('device-1', createMockDevice({
        deviceId: 'device-1',
        thermostatCapabilities: {
          airConditionerMode: true,
          thermostatMode: false,
          temperatureMeasurement: true,
          switch: true,
        },
      }));

      await coordinator.handleThermostatEvent({
        deviceId: 'device-1',
        type: 'mode',
        mode: 'heat',
      });

      expect(mockApi.executeCommands).toHaveBeenCalledWith('device-1', [
        {
          component: 'main',
          capability: 'switch',
          command: 'on',
          arguments: [],
        },
        {
          component: 'main',
          capability: 'airConditionerMode',
          command: 'setAirConditionerMode',
          arguments: ['heat'],
        },
      ]);
    });

    test('given non-existent device, should handle gracefully', async () => {
      await expect(
        coordinator.handleThermostatEvent({
          deviceId: 'non-existent',
          type: 'temperature',
          temperature: 68,
        })
      ).resolves.not.toThrow();

      expect(mockApi.executeCommands).not.toHaveBeenCalled();
    });

    test('given plugin cancels state change, should not send commands', async () => {
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ mode: 'cool' }));
      coordinator['deviceMetadata'].set('device-1', createMockDevice({ deviceId: 'device-1' }));
      mockPluginManager.beforeSetSmartThingsState.mockResolvedValue(null);

      await coordinator.handleThermostatEvent({
        deviceId: 'device-1',
        type: 'temperature',
        temperature: 68,
      });

      expect(mockApi.executeCommands).not.toHaveBeenCalled();
    });

    test('given heatingSetpoint in event, should use it directly', async () => {
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ mode: 'heat' }));
      coordinator['deviceMetadata'].set('device-1', createMockDevice({ deviceId: 'device-1' }));

      await coordinator.handleThermostatEvent({
        deviceId: 'device-1',
        type: 'temperature',
        heatingSetpoint: 65,
      });

      expect(mockApi.executeCommands).toHaveBeenCalledWith('device-1', [
        {
          component: 'main',
          capability: 'thermostatHeatingSetpoint',
          command: 'setHeatingSetpoint',
          arguments: [65],
        },
      ]);
    });

    test('given coolingSetpoint in event, should use it directly', async () => {
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ mode: 'cool' }));
      coordinator['deviceMetadata'].set('device-1', createMockDevice({ deviceId: 'device-1' }));

      await coordinator.handleThermostatEvent({
        deviceId: 'device-1',
        type: 'temperature',
        coolingSetpoint: 75,
      });

      expect(mockApi.executeCommands).toHaveBeenCalledWith('device-1', [
        {
          component: 'main',
          capability: 'thermostatCoolingSetpoint',
          command: 'setCoolingSetpoint',
          arguments: [75],
        },
      ]);
    });

    test('given heatingSetpoint for Samsung AC without thermostatHeatingSetpoint, should fallback to coolingSetpoint', async () => {
      // Samsung ACs do NOT have thermostatHeatingSetpoint capability
      // They use thermostatCoolingSetpoint for ALL temperature changes
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ mode: 'heat', switchState: 'on' }));
      coordinator['deviceMetadata'].set('device-1', createMockDevice({
        deviceId: 'device-1',
        thermostatCapabilities: {
          airConditionerMode: true,
          thermostatMode: false,
          temperatureMeasurement: true,
          thermostatCoolingSetpoint: true,
          thermostatHeatingSetpoint: false, // Samsung AC does NOT have this
        },
      }));

      await coordinator.handleThermostatEvent({
        deviceId: 'device-1',
        type: 'temperature',
        heatingSetpoint: 68,
      });

      // Should fallback to using coolingSetpoint capability since heatingSetpoint is unavailable
      expect(mockApi.executeCommands).toHaveBeenCalledWith('device-1', [
        {
          component: 'main',
          capability: 'thermostatCoolingSetpoint',
          command: 'setCoolingSetpoint',
          arguments: [68],
        },
      ]);
    });

    test('given a successful command, should not mutate the DeviceState object previously stored in the map', async () => {
      const original = createMockDeviceState({ mode: 'cool', coolingSetpoint: 72, temperatureSetpoint: 72 });
      coordinator['state'].deviceStates.set('device-1', original);
      coordinator['deviceMetadata'].set('device-1', createMockDevice({ deviceId: 'device-1' }));

      await coordinator.handleThermostatEvent({
        deviceId: 'device-1',
        type: 'temperature',
        coolingSetpoint: 65,
      });

      // The object that was in the map before the call must be left untouched - it may be
      // concurrently read/replaced by updateDeviceStates().
      expect(original.coolingSetpoint).toBe(72);
      expect(original.temperatureSetpoint).toBe(72);

      // The map now holds a different object with the update applied.
      const updated = coordinator.getDeviceState('device-1');
      expect(updated).not.toBe(original);
      expect(updated?.coolingSetpoint).toBe(65);
    });
  });

  describe('poll/reload concurrency', () => {
    test('given an overlapping poll cycle, should skip it entirely rather than queue it', async () => {
      coordinator['state'].pairedDevices = ['device-1'];
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState());
      coordinator['deviceMetadata'].set('device-1', createMockDevice({ deviceId: 'device-1' }));

      // Fire two poll cycles back-to-back without awaiting the first - this mirrors
      // node-cron, which does not await its callback.
      const first = coordinator['pollDevices']();
      const second = coordinator['pollDevices']();

      await Promise.all([first, second]);

      // Only the first cycle should have actually run the poll body.
      expect(mockApi.getDeviceStatus).toHaveBeenCalledTimes(1);
      expect(mockPluginManager.onPollCycle).toHaveBeenCalledTimes(1);
    });

    test('given concurrent reloadDevices calls, should coalesce onto a single in-flight run', async () => {
      mockApi.getDevices.mockResolvedValue([]);

      await Promise.all([
        coordinator.reloadDevices(),
        coordinator.reloadDevices(),
        coordinator.reloadDevices(),
      ]);

      expect(mockApi.getDevices).toHaveBeenCalledTimes(1);
    });

    test('given stop() called before the startup timer fires, should not run the deferred reload', async () => {
      // Avoids jest.useFakeTimers() and jest.spyOn(global, 'setTimeout'/'clearTimeout') -
      // see note on the "reload devices after delay" test above. A real (short) wait is
      // used instead so the global setTimeout/clearTimeout bindings are never touched.
      const reloadSpy = jest.spyOn(coordinator as any, 'reloadDevices').mockResolvedValue(undefined);

      await coordinator.initialize();
      expect(coordinator['startupTimer']).not.toBeNull();

      coordinator.stop();

      // stop() should clear the tracked handle so the timer can never fire.
      expect(coordinator['startupTimer']).toBeNull();

      // Wait past when the startup delay would have elapsed - the deferred reload must
      // never run.
      await new Promise((resolve) => setTimeout(resolve, 2200));

      expect(reloadSpy).not.toHaveBeenCalled();
    }, 10000);
  });

  describe('echo suppression', () => {
    // Note: this avoids jest.useFakeTimers() - see the note on the "reload devices after
    // delay" test above. The suppress-until value is a plain Date.now()-based epoch ms
    // stored in the private pendingEcho map, so expiry is simulated by writing to that
    // map directly rather than by mocking the clock.
    test('given a HomeKit-initiated change, a stale poll should not overwrite it until the suppression window expires', async () => {
      coordinator['state'].pairedDevices = ['device-1'];
      coordinator['state'].deviceStates.set(
        'device-1',
        createMockDeviceState({ mode: 'cool', coolingSetpoint: 72, temperatureSetpoint: 72, currentTemperature: 72 })
      );
      coordinator['deviceMetadata'].set('device-1', createMockDevice({ deviceId: 'device-1' }));

      // User changes the setpoint via HomeKit.
      await coordinator.handleThermostatEvent({
        deviceId: 'device-1',
        type: 'temperature',
        coolingSetpoint: 65,
      });
      expect(coordinator.getDeviceState('device-1')?.coolingSetpoint).toBe(65);
      expect(coordinator['pendingEcho'].has('device-1')).toBe(true);

      // A poll runs immediately after, but SmartThings hasn't caught up yet and still
      // reports the OLD setpoint (with a fresh current temperature reading).
      mockApi.getDeviceStatus.mockResolvedValue(
        createMockDeviceState({ mode: 'cool', coolingSetpoint: 72, temperatureSetpoint: 72, currentTemperature: 74 })
      );

      await coordinator['updateDeviceStates']();

      const suppressed = coordinator.getDeviceState('device-1');
      // The stale setpoint must NOT snap back...
      expect(suppressed?.coolingSetpoint).toBe(65);
      expect(suppressed?.temperatureSetpoint).toBe(65);
      // ...but currentTemperature is still allowed to update.
      expect(suppressed?.currentTemperature).toBe(74);
      expect(mockHapServer.updateDeviceState).not.toHaveBeenCalled();

      // Simulate the suppression window having expired.
      coordinator['pendingEcho'].set('device-1', Date.now() - 1);

      await coordinator['updateDeviceStates']();

      const afterExpiry = coordinator.getDeviceState('device-1');
      expect(afterExpiry?.coolingSetpoint).toBe(72);
      expect(mockHapServer.updateDeviceState).toHaveBeenCalledWith('device-1', expect.objectContaining({ coolingSetpoint: 72 }));
      // The expired entry should have been cleaned up.
      expect(coordinator['pendingEcho'].has('device-1')).toBe(false);
    });
  });

  describe('raw vs masked state (HomeKit display masking)', () => {
    test('given a plugin that masks mode for display, should store raw state internally but send the masked state to HAP', async () => {
      coordinator['state'].pairedDevices = ['device-1'];
      coordinator['deviceMetadata'].set('device-1', createMockDevice({ deviceId: 'device-1' }));

      const rawState = createMockDeviceState({ mode: 'heat', currentTemperature: 68 });
      mockApi.getDeviceStatus.mockResolvedValue(rawState);

      // Simulates hvac-auto-mode's beforeSetHomeKitState, which returns a display-only
      // masked state ({ ...state, mode: 'auto' }).
      mockPluginManager.beforeSetHomeKitState.mockImplementation((_device, state) =>
        Promise.resolve({ ...state, mode: 'auto' })
      );

      await coordinator['updateDeviceStates']();

      // Internal state used for command routing must stay RAW.
      expect(coordinator.getDeviceState('device-1')?.mode).toBe('heat');

      // HAP receives the masked, display-only state.
      expect(mockHapServer.updateDeviceState).toHaveBeenCalledWith(
        'device-1',
        expect.objectContaining({ mode: 'auto' })
      );
    });
  });

  describe('getDevices', () => {
    test('given device states, should return unified devices', () => {
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState());
      coordinator['deviceMetadata'].set('device-1', createMockDevice({ deviceId: 'device-1' }));

      const devices = coordinator.getDevices();

      expect(devices.length).toBe(1);
      expect(devices[0].deviceId).toBe('device-1');
    });

    test('given no devices, should return empty array', () => {
      const devices = coordinator.getDevices();

      expect(devices).toEqual([]);
    });
  });

  describe('getDeviceStates', () => {
    test('given device states, should return copy', () => {
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState());

      const states = coordinator.getDeviceStates();

      expect(states.size).toBe(1);
      expect(states.get('device-1')).toBeDefined();

      // Should be a copy, not the same reference
      expect(states).not.toBe(coordinator['state'].deviceStates);
    });
  });

  describe('getState', () => {
    test('given coordinator state, should return copy', () => {
      coordinator['state'].pairedDevices = ['device-1'];
      coordinator['state'].averageTemperature = 72;
      coordinator['state'].currentMode = 'cool';

      const state = coordinator.getState();

      expect(state.pairedDevices).toEqual(['device-1']);
      expect(state.averageTemperature).toBe(72);
      expect(state.currentMode).toBe('cool');

      // DeviceStates should be a copy
      expect(state.deviceStates).not.toBe(coordinator['state'].deviceStates);
    });
  });

  describe('getDeviceState', () => {
    test('given existing device, should return state', () => {
      const mockState = createMockDeviceState();
      coordinator['state'].deviceStates.set('device-1', mockState);

      const state = coordinator.getDeviceState('device-1');

      expect(state).toBeDefined();
      expect(state?.id).toBe('device-123');
    });

    test('given non-existent device, should return undefined', () => {
      const state = coordinator.getDeviceState('non-existent');

      expect(state).toBeUndefined();
    });
  });

  describe('getDevice', () => {
    test('given existing device with metadata, should return unified device', () => {
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState());
      coordinator['deviceMetadata'].set('device-1', createMockDevice({ deviceId: 'device-1' }));

      const device = coordinator.getDevice('device-1');

      expect(device).toBeDefined();
      expect(device?.deviceId).toBe('device-1');
    });

    test('given non-existent device, should return undefined', () => {
      const device = coordinator.getDevice('non-existent');

      expect(device).toBeUndefined();
    });
  });

  describe('getPairedDeviceIds', () => {
    test('given paired devices, should return array of IDs', () => {
      coordinator['state'].pairedDevices = ['device-1', 'device-2'];

      const ids = coordinator.getPairedDeviceIds();

      expect(ids).toEqual(['device-1', 'device-2']);
    });

    test('given no paired devices, should return empty array', () => {
      const ids = coordinator.getPairedDeviceIds();

      expect(ids).toEqual([]);
    });
  });

  describe('stop', () => {
    test('given running coordinator, should stop polling', async () => {
      const mockTask = { stop: jest.fn() };
      (cron.schedule as jest.Mock).mockReturnValue(mockTask);

      await coordinator.initialize();
      coordinator.stop();

      expect(mockTask.stop).toHaveBeenCalled();
    });

    test('given no active task, should handle gracefully', () => {
      expect(() => coordinator.stop()).not.toThrow();
    });
  });
});
