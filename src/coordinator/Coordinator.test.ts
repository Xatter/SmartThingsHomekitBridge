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
      jest.useFakeTimers();

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

      // Fast-forward 2 seconds
      jest.advanceTimersByTime(2000);
      await Promise.resolve();

      expect(reloadSpy).toHaveBeenCalled();

      jest.useRealTimers();
    });

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

      jest.useFakeTimers();
      jest.advanceTimersByTime(3000);
      await Promise.resolve();
      jest.useRealTimers();

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
    test('given coordinator state, should save to file', async () => {
      await coordinator['saveState']();

      expect(fs.mkdir).toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalledWith(
        mockStateFilePath,
        expect.stringContaining('"pairedDevices"')
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
