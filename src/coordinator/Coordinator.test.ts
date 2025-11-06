import { Coordinator } from './Coordinator';
import { SmartThingsAPI } from '@/api/SmartThingsAPI';
import { LightingMonitor } from '@/monitoring/LightingMonitor';
import { SmartThingsHAPServer } from '@/hap/HAPServer';
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
jest.mock('@/monitoring/LightingMonitor');
jest.mock('@/hap/HAPServer');

describe('Coordinator', () => {
  let coordinator: Coordinator;
  let mockApi: jest.Mocked<SmartThingsAPI>;
  let mockLightingMonitor: jest.Mocked<LightingMonitor>;
  let mockHapServer: jest.Mocked<SmartThingsHAPServer>;
  const mockStateFilePath = '/test/data/coordinator-state.json';

  const createMockDevice = (overrides: Partial<UnifiedDevice> = {}): UnifiedDevice => ({
    deviceId: 'device-123',
    name: 'Test Thermostat',
    label: 'Test Thermostat',
    manufacturerName: 'SmartThings',
    presentationId: 'test-presentation',
    deviceTypeName: 'Thermostat',
    capabilities: [],
    components: [],
    thermostatCapabilities: {
      thermostatMode: true,
      thermostat: true,
      temperatureMeasurement: true,
      thermostatHeatingSetpoint: false,
      thermostatCoolingSetpoint: false,
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
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Create mock API
    mockApi = {
      hasAuth: jest.fn().mockReturnValue(true),
      getDevices: jest.fn().mockResolvedValue([]),
      getDeviceStatus: jest.fn().mockResolvedValue(null),
      setTemperature: jest.fn().mockResolvedValue(true),
      setMode: jest.fn().mockResolvedValue(true),
    } as any;

    // Create mock lighting monitor
    mockLightingMonitor = {
      setDevices: jest.fn(),
      start: jest.fn(),
      stop: jest.fn(),
    } as any;

    // Create mock HAP server
    mockHapServer = {
      addDevice: jest.fn().mockResolvedValue(undefined),
      updateDeviceState: jest.fn().mockResolvedValue(undefined),
      removeDevice: jest.fn().mockResolvedValue(undefined),
    } as any;

    // Mock fs operations by default
    (fs.readFile as jest.Mock).mockRejectedValue({ code: 'ENOENT' });
    (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
    (fs.mkdir as jest.Mock).mockResolvedValue(undefined);

    coordinator = new Coordinator(
      mockApi,
      mockLightingMonitor,
      mockHapServer,
      mockStateFilePath,
      300 // 5 minute poll interval
    );
  });

  describe('convertSecondsToInterval', () => {
    test('given 60 seconds, should convert to minute cron format', () => {
      const coord = new Coordinator(mockApi, mockLightingMonitor, mockHapServer, mockStateFilePath, 60);
      const interval = coord['pollInterval'];

      expect(interval).toBe('*/1 * * * *');
    });

    test('given 300 seconds, should convert to 5 minute cron format', () => {
      const coord = new Coordinator(mockApi, mockLightingMonitor, mockHapServer, mockStateFilePath, 300);
      const interval = coord['pollInterval'];

      expect(interval).toBe('*/5 * * * *');
    });

    test('given 45 seconds, should use second-based cron format', () => {
      const coord = new Coordinator(mockApi, mockLightingMonitor, mockHapServer, mockStateFilePath, 45);
      const interval = coord['pollInterval'];

      expect(interval).toBe('*/45 * * * * *');
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

    test('given devices from API, should add to HAP server', async () => {
      const device = createMockDevice({ deviceId: 'device-1', name: 'Thermostat 1' });
      const deviceState = createMockDeviceState({ id: 'device-1', name: 'Thermostat 1' });

      mockApi.getDevices.mockResolvedValue([device]);
      mockApi.getDeviceStatus.mockResolvedValue(deviceState);

      await coordinator.reloadDevices();

      expect(mockApi.getDevices).toHaveBeenCalled();
      expect(mockHapServer.addDevice).toHaveBeenCalledWith('device-1', expect.objectContaining({
        name: 'Thermostat 1',
      }));
      expect(mockLightingMonitor.setDevices).toHaveBeenCalledWith(['device-1']);
    });

    test('given multiple devices, should add all to HAP server', async () => {
      const devices = [
        createMockDevice({ deviceId: 'device-1', name: 'Thermostat 1' }),
        createMockDevice({ deviceId: 'device-2', name: 'Thermostat 2' }),
      ];

      mockApi.getDevices.mockResolvedValue(devices);
      mockApi.getDeviceStatus.mockResolvedValue(createMockDeviceState());

      await coordinator.reloadDevices();

      expect(mockHapServer.addDevice).toHaveBeenCalledTimes(2);
    });

    test('given API failure, should handle gracefully', async () => {
      mockApi.getDevices.mockRejectedValue(new Error('API error'));

      await expect(coordinator.reloadDevices()).resolves.not.toThrow();
    });
  });

  describe('calculateAverageTemperature', () => {
    test('given multiple devices, should calculate average setpoint', () => {
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ temperatureSetpoint: 70 }));
      coordinator['state'].deviceStates.set('device-2', createMockDeviceState({ temperatureSetpoint: 72 }));
      coordinator['state'].deviceStates.set('device-3', createMockDeviceState({ temperatureSetpoint: 74 }));

      coordinator['calculateAverageTemperature']();

      expect(coordinator['state'].averageTemperature).toBe(72);
    });

    test('given no devices, should not change average', () => {
      coordinator['state'].averageTemperature = 70;

      coordinator['calculateAverageTemperature']();

      expect(coordinator['state'].averageTemperature).toBe(70);
    });

    test('given zero setpoints, should filter them out', () => {
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ temperatureSetpoint: 70 }));
      coordinator['state'].deviceStates.set('device-2', createMockDeviceState({ temperatureSetpoint: 0 }));

      coordinator['calculateAverageTemperature']();

      expect(coordinator['state'].averageTemperature).toBe(70);
    });
  });

  describe('determineCurrentMode', () => {
    test('given all devices off, should set mode to off', () => {
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ mode: 'off' }));
      coordinator['state'].deviceStates.set('device-2', createMockDeviceState({ mode: 'off' }));

      coordinator['determineCurrentMode']();

      expect(coordinator['state'].currentMode).toBe('off');
    });

    test('given multiple cooling devices, should set mode to cool', () => {
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ mode: 'cool' }));
      coordinator['state'].deviceStates.set('device-2', createMockDeviceState({ mode: 'cool' }));
      coordinator['state'].deviceStates.set('device-3', createMockDeviceState({ mode: 'heat' }));

      coordinator['determineCurrentMode']();

      expect(coordinator['state'].currentMode).toBe('cool');
    });

    test('given mixed modes with heat majority, should set mode to heat', () => {
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ mode: 'heat' }));
      coordinator['state'].deviceStates.set('device-2', createMockDeviceState({ mode: 'heat' }));
      coordinator['state'].deviceStates.set('device-3', createMockDeviceState({ mode: 'cool' }));

      coordinator['determineCurrentMode']();

      expect(coordinator['state'].currentMode).toBe('heat');
    });

    test('given only off devices, should ignore them in mode determination', () => {
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ mode: 'heat' }));
      coordinator['state'].deviceStates.set('device-2', createMockDeviceState({ mode: 'off' }));
      coordinator['state'].deviceStates.set('device-3', createMockDeviceState({ mode: 'off' }));

      coordinator['determineCurrentMode']();

      expect(coordinator['state'].currentMode).toBe('heat');
    });
  });

  describe('changeTemperature', () => {
    test('given valid device and temperature, should call API', async () => {
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ mode: 'cool' }));

      const success = await coordinator.changeTemperature('device-1', 68);

      expect(mockApi.setTemperature).toHaveBeenCalledWith('device-1', 68, 'cool');
      expect(success).toBe(true);
    });

    test('given successful change, should update local state', async () => {
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ mode: 'cool', temperatureSetpoint: 70 }));

      await coordinator.changeTemperature('device-1', 68);

      const state = coordinator['state'].deviceStates.get('device-1');
      expect(state?.temperatureSetpoint).toBe(68);
    });

    test('given device in off mode, should return false', async () => {
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ mode: 'off' }));

      const success = await coordinator.changeTemperature('device-1', 68);

      expect(mockApi.setTemperature).not.toHaveBeenCalled();
      expect(success).toBe(false);
    });

    test('given auto mode, should convert to cool', async () => {
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ mode: 'auto' }));

      await coordinator.changeTemperature('device-1', 68);

      expect(mockApi.setTemperature).toHaveBeenCalledWith('device-1', 68, 'cool');
    });

    test('given non-existent device, should return false', async () => {
      const success = await coordinator.changeTemperature('non-existent', 68);

      expect(success).toBe(false);
    });
  });

  describe('changeMode', () => {
    test('given valid device and mode, should call API', async () => {
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ mode: 'cool' }));

      const success = await coordinator.changeMode('device-1', 'heat');

      expect(mockApi.setMode).toHaveBeenCalledWith('device-1', 'heat');
      expect(success).toBe(true);
    });

    test('given successful change, should update local state', async () => {
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ mode: 'cool' }));

      await coordinator.changeMode('device-1', 'heat');

      const state = coordinator['state'].deviceStates.get('device-1');
      expect(state?.mode).toBe('heat');
    });

    test('given heat or cool mode, should synchronize other devices', async () => {
      coordinator['state'].pairedDevices = ['device-1', 'device-2'];
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ mode: 'cool' }));
      coordinator['state'].deviceStates.set('device-2', createMockDeviceState({ mode: 'cool' }));

      await coordinator.changeMode('device-1', 'heat');

      // Should update both device-1 and device-2
      expect(mockApi.setMode).toHaveBeenCalledWith('device-1', 'heat');
      expect(mockApi.setMode).toHaveBeenCalledWith('device-2', 'heat');
    });

    test('given off or auto mode, should not synchronize other devices', async () => {
      coordinator['state'].pairedDevices = ['device-1', 'device-2'];
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ mode: 'heat' }));
      coordinator['state'].deviceStates.set('device-2', createMockDeviceState({ mode: 'heat' }));

      await coordinator.changeMode('device-1', 'off');

      // Should only call once for device-1
      expect(mockApi.setMode).toHaveBeenCalledTimes(1);
      expect(mockApi.setMode).toHaveBeenCalledWith('device-1', 'off');
    });
  });

  describe('synchronizeTemperatures', () => {
    test('given off mode, should not synchronize', async () => {
      coordinator['state'].currentMode = 'off';
      coordinator['state'].averageTemperature = 72;

      await coordinator['synchronizeTemperatures']();

      expect(mockApi.setTemperature).not.toHaveBeenCalled();
    });

    test('given auto mode, should not synchronize', async () => {
      coordinator['state'].currentMode = 'auto';
      coordinator['state'].averageTemperature = 72;

      await coordinator['synchronizeTemperatures']();

      expect(mockApi.setTemperature).not.toHaveBeenCalled();
    });

    test('given cool mode and temperature difference, should synchronize all devices', async () => {
      coordinator['state'].currentMode = 'cool';
      coordinator['state'].averageTemperature = 72;
      coordinator['state'].pairedDevices = ['device-1', 'device-2'];
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ temperatureSetpoint: 70, mode: 'cool' }));
      coordinator['state'].deviceStates.set('device-2', createMockDeviceState({ temperatureSetpoint: 68, mode: 'cool' }));

      await coordinator['synchronizeTemperatures']();

      expect(mockApi.setTemperature).toHaveBeenCalledWith('device-1', 72, 'cool');
      expect(mockApi.setTemperature).toHaveBeenCalledWith('device-2', 72, 'cool');
    });

    test('given small temperature difference, should not synchronize', async () => {
      coordinator['state'].currentMode = 'cool';
      coordinator['state'].averageTemperature = 72;
      coordinator['state'].pairedDevices = ['device-1'];
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ temperatureSetpoint: 72.3, mode: 'cool' }));

      await coordinator['synchronizeTemperatures']();

      expect(mockApi.setTemperature).not.toHaveBeenCalled();
    });
  });

  describe('handleHAPThermostatEvent', () => {
    test('given temperature event, should change temperature', async () => {
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ mode: 'cool' }));

      await coordinator.handleHAPThermostatEvent({
        deviceId: 'device-1',
        type: 'temperature',
        temperature: 68,
      });

      expect(mockApi.setTemperature).toHaveBeenCalledWith('device-1', 68, 'cool');
    });

    test('given mode event, should change mode', async () => {
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ mode: 'cool' }));

      await coordinator.handleHAPThermostatEvent({
        deviceId: 'device-1',
        type: 'mode',
        mode: 'heat',
      });

      expect(mockApi.setMode).toHaveBeenCalledWith('device-1', 'heat');
    });

    test('given both event, should change both temperature and mode', async () => {
      coordinator['state'].deviceStates.set('device-1', createMockDeviceState({ mode: 'cool' }));

      await coordinator.handleHAPThermostatEvent({
        deviceId: 'device-1',
        type: 'both',
        temperature: 68,
        mode: 'heat',
      });

      expect(mockApi.setTemperature).toHaveBeenCalled();
      expect(mockApi.setMode).toHaveBeenCalledWith('device-1', 'heat');
    });

    test('given non-existent device, should handle gracefully', async () => {
      await expect(
        coordinator.handleHAPThermostatEvent({
          deviceId: 'non-existent',
          type: 'temperature',
          temperature: 68,
        })
      ).resolves.not.toThrow();
    });
  });

  describe('getDevices', () => {
    test('given no auth, should return empty array', async () => {
      mockApi.hasAuth.mockReturnValue(false);

      const devices = await coordinator.getDevices();

      expect(devices).toEqual([]);
    });

    test('given API returns devices, should return them', async () => {
      const mockDevices = [createMockDevice()];
      mockApi.getDevices.mockResolvedValue(mockDevices);

      const devices = await coordinator.getDevices();

      expect(devices).toEqual(mockDevices);
    });

    test('given API error, should return empty array', async () => {
      mockApi.getDevices.mockRejectedValue(new Error('API error'));

      const devices = await coordinator.getDevices();

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
