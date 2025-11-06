import { LightingMonitor } from './LightingMonitor';
import { SmartThingsAPI } from '@/api/SmartThingsAPI';
import { DeviceState } from '@/types';
import * as cron from 'node-cron';

// Mock dependencies
jest.mock('node-cron', () => ({
  schedule: jest.fn(() => ({
    start: jest.fn(),
    stop: jest.fn(),
  })),
}));

jest.mock('@/api/SmartThingsAPI');

describe('LightingMonitor', () => {
  let monitor: LightingMonitor;
  let mockApi: jest.Mocked<SmartThingsAPI>;
  let mockTask: { start: jest.Mock; stop: jest.Mock };

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

    // Create mock task
    mockTask = {
      start: jest.fn(),
      stop: jest.fn(),
    };

    (cron.schedule as jest.Mock).mockReturnValue(mockTask);

    // Create mock API
    mockApi = {
      hasAuth: jest.fn().mockReturnValue(true),
      getDeviceStatus: jest.fn().mockResolvedValue(null),
      turnLightOff: jest.fn().mockResolvedValue(true),
    } as any;

    monitor = new LightingMonitor(mockApi, 60);
  });

  describe('convertSecondsToInterval', () => {
    test('given 60 seconds, should convert to minute cron format', () => {
      const mon = new LightingMonitor(mockApi, 60);
      const interval = mon['interval'];

      expect(interval).toBe('*/1 * * * *');
    });

    test('given 300 seconds, should convert to 5 minute cron format', () => {
      const mon = new LightingMonitor(mockApi, 300);
      const interval = mon['interval'];

      expect(interval).toBe('*/5 * * * *');
    });

    test('given 45 seconds, should use second-based cron format', () => {
      const mon = new LightingMonitor(mockApi, 45);
      const interval = mon['interval'];

      expect(interval).toBe('*/45 * * * * *');
    });

    test('given 30 seconds, should use second-based cron format', () => {
      const mon = new LightingMonitor(mockApi, 30);
      const interval = mon['interval'];

      expect(interval).toBe('*/30 * * * * *');
    });
  });

  describe('setDevices', () => {
    test('given device IDs, should store them', () => {
      monitor.setDevices(['device-1', 'device-2']);

      const devices = monitor.getMonitoredDevices();

      expect(devices).toEqual(['device-1', 'device-2']);
    });

    test('given devices when not running, should start monitor', () => {
      monitor.setDevices(['device-1']);

      expect(cron.schedule).toHaveBeenCalled();
      expect(mockTask.start).toHaveBeenCalled();
    });

    test('given empty array when running, should stop monitor', () => {
      // Start with devices
      monitor.setDevices(['device-1']);
      jest.clearAllMocks();

      // Set to empty array
      (cron.schedule as jest.Mock).mockReturnValue(mockTask);
      monitor.setDevices([]);

      expect(mockTask.stop).toHaveBeenCalled();
    });

    test('given new devices when already running, should restart monitor', () => {
      // Start with initial devices
      monitor.setDevices(['device-1']);
      jest.clearAllMocks();

      // Update with new devices
      const newTask = { start: jest.fn(), stop: jest.fn() };
      (cron.schedule as jest.Mock).mockReturnValue(newTask);

      monitor.setDevices(['device-2', 'device-3']);

      expect(mockTask.stop).toHaveBeenCalled();
      expect(cron.schedule).toHaveBeenCalled();
      expect(newTask.start).toHaveBeenCalled();
    });

    test('given devices, should create copy not reference', () => {
      const devices = ['device-1', 'device-2'];
      monitor.setDevices(devices);

      devices.push('device-3');
      const monitoredDevices = monitor.getMonitoredDevices();

      expect(monitoredDevices).toHaveLength(2);
    });
  });

  describe('start', () => {
    beforeEach(() => {
      monitor.setDevices(['device-1']);
      jest.clearAllMocks();
    });

    test('given devices set, should create and start cron task', () => {
      monitor.start();

      expect(cron.schedule).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Function),
        expect.objectContaining({
          scheduled: false,
          timezone: 'UTC',
        })
      );
      expect(mockTask.start).toHaveBeenCalled();
    });

    test('given no devices, should not start', () => {
      monitor.setDevices([]);
      jest.clearAllMocks();

      monitor.start();

      expect(cron.schedule).not.toHaveBeenCalled();
    });

    test('given already running, should stop and restart', () => {
      monitor.start();
      expect(mockTask.start).toHaveBeenCalledTimes(1);

      jest.clearAllMocks();
      const newTask = { start: jest.fn(), stop: jest.fn() };
      (cron.schedule as jest.Mock).mockReturnValue(newTask);

      monitor.start();

      expect(mockTask.stop).toHaveBeenCalled();
      expect(newTask.start).toHaveBeenCalled();
    });

    test('given start, should run initial check immediately', async () => {
      const checkSpy = jest.spyOn(monitor as any, 'checkAndTurnOffLights').mockResolvedValue(undefined);

      monitor.start();

      // Allow microtask queue to flush
      await Promise.resolve();

      expect(checkSpy).toHaveBeenCalled();
    });
  });

  describe('stop', () => {
    test('given running monitor, should stop task', () => {
      monitor.setDevices(['device-1']);
      monitor.start();
      jest.clearAllMocks();

      monitor.stop();

      expect(mockTask.stop).toHaveBeenCalled();
      expect(monitor.isRunning()).toBe(false);
    });

    test('given not running, should handle gracefully', () => {
      expect(() => monitor.stop()).not.toThrow();
    });
  });

  describe('checkAndTurnOffLights', () => {
    test('given no auth, should not check devices', async () => {
      mockApi.hasAuth.mockReturnValue(false);
      monitor.setDevices(['device-1']);

      await monitor['checkAndTurnOffLights']();

      expect(mockApi.getDeviceStatus).not.toHaveBeenCalled();
    });

    test('given device with light on, should turn it off', async () => {
      const deviceState = createMockDeviceState({ id: 'device-1', lightOn: true });
      mockApi.getDeviceStatus.mockResolvedValue(deviceState);
      monitor.setDevices(['device-1']);

      await monitor['checkAndTurnOffLights']();

      expect(mockApi.getDeviceStatus).toHaveBeenCalledWith('device-1');
      expect(mockApi.turnLightOff).toHaveBeenCalledWith('device-1');
    });

    test('given device with light off, should not call turn off', async () => {
      const deviceState = createMockDeviceState({ id: 'device-1', lightOn: false });
      mockApi.getDeviceStatus.mockResolvedValue(deviceState);
      monitor.setDevices(['device-1']);

      await monitor['checkAndTurnOffLights']();

      expect(mockApi.getDeviceStatus).toHaveBeenCalledWith('device-1');
      expect(mockApi.turnLightOff).not.toHaveBeenCalled();
    });

    test('given multiple devices, should check all', async () => {
      const device1 = createMockDeviceState({ id: 'device-1', lightOn: true });
      const device2 = createMockDeviceState({ id: 'device-2', lightOn: false });

      monitor.setDevices(['device-1', 'device-2']);

      // Wait for initial check to complete and clear mocks
      await Promise.resolve();
      await Promise.resolve();
      jest.clearAllMocks();

      // Now set up mocks for our actual test
      mockApi.getDeviceStatus
        .mockResolvedValueOnce(device1)
        .mockResolvedValueOnce(device2);

      await monitor['checkAndTurnOffLights']();

      expect(mockApi.getDeviceStatus).toHaveBeenCalledTimes(2);
      expect(mockApi.turnLightOff).toHaveBeenCalledTimes(1);
    });

    test('given API error on status, should handle gracefully', async () => {
      mockApi.getDeviceStatus.mockRejectedValue(new Error('API error'));
      monitor.setDevices(['device-1']);

      await expect(monitor['checkAndTurnOffLights']()).resolves.not.toThrow();
    });

    test('given null device status, should handle gracefully', async () => {
      mockApi.getDeviceStatus.mockResolvedValue(null);
      monitor.setDevices(['device-1']);

      await expect(monitor['checkAndTurnOffLights']()).resolves.not.toThrow();

      expect(mockApi.turnLightOff).not.toHaveBeenCalled();
    });

    test('given turn off fails, should handle gracefully', async () => {
      const deviceState = createMockDeviceState({ id: 'device-1', lightOn: true });
      mockApi.getDeviceStatus.mockResolvedValue(deviceState);
      mockApi.turnLightOff.mockResolvedValue(false);
      monitor.setDevices(['device-1']);

      await expect(monitor['checkAndTurnOffLights']()).resolves.not.toThrow();
    });
  });

  describe('checkDevice', () => {
    test('given device with light on, should turn it off and return true', async () => {
      const deviceState = createMockDeviceState({ id: 'device-1', lightOn: true });
      mockApi.getDeviceStatus.mockResolvedValue(deviceState);

      const result = await monitor.checkDevice('device-1');

      expect(mockApi.turnLightOff).toHaveBeenCalledWith('device-1');
      expect(result).toBe(true);
    });

    test('given device with light off, should return true without turning off', async () => {
      const deviceState = createMockDeviceState({ id: 'device-1', lightOn: false });
      mockApi.getDeviceStatus.mockResolvedValue(deviceState);

      const result = await monitor.checkDevice('device-1');

      expect(mockApi.turnLightOff).not.toHaveBeenCalled();
      expect(result).toBe(true);
    });

    test('given turn off fails, should return false', async () => {
      const deviceState = createMockDeviceState({ id: 'device-1', lightOn: true });
      mockApi.getDeviceStatus.mockResolvedValue(deviceState);
      mockApi.turnLightOff.mockResolvedValue(false);

      const result = await monitor.checkDevice('device-1');

      expect(result).toBe(false);
    });

    test('given null device status, should return false', async () => {
      mockApi.getDeviceStatus.mockResolvedValue(null);

      const result = await monitor.checkDevice('device-1');

      expect(result).toBe(false);
    });

    test('given API error, should return false', async () => {
      mockApi.getDeviceStatus.mockRejectedValue(new Error('API error'));

      const result = await monitor.checkDevice('device-1');

      expect(result).toBe(false);
    });
  });

  describe('getMonitoredDevices', () => {
    test('given devices set, should return copy of array', () => {
      monitor.setDevices(['device-1', 'device-2']);

      const devices = monitor.getMonitoredDevices();

      expect(devices).toEqual(['device-1', 'device-2']);

      // Verify it's a copy
      devices.push('device-3');
      expect(monitor.getMonitoredDevices()).toHaveLength(2);
    });

    test('given no devices, should return empty array', () => {
      const devices = monitor.getMonitoredDevices();

      expect(devices).toEqual([]);
    });
  });

  describe('isRunning', () => {
    test('given started monitor, should return true', () => {
      monitor.setDevices(['device-1']);
      monitor.start();

      expect(monitor.isRunning()).toBe(true);
    });

    test('given stopped monitor, should return false', () => {
      monitor.setDevices(['device-1']);
      monitor.start();
      monitor.stop();

      expect(monitor.isRunning()).toBe(false);
    });

    test('given never started, should return false', () => {
      expect(monitor.isRunning()).toBe(false);
    });
  });

  describe('integration scenarios', () => {
    test('full lifecycle: set devices, start, check, stop', async () => {
      const deviceState = createMockDeviceState({ id: 'device-1', lightOn: true });
      mockApi.getDeviceStatus.mockResolvedValue(deviceState);

      // Set devices (implicitly starts)
      monitor.setDevices(['device-1']);
      expect(monitor.isRunning()).toBe(true);

      // Allow initial check to run
      await Promise.resolve();
      await Promise.resolve();

      expect(mockApi.getDeviceStatus).toHaveBeenCalled();
      expect(mockApi.turnLightOff).toHaveBeenCalled();

      // Stop
      monitor.stop();
      expect(monitor.isRunning()).toBe(false);
    });

    test('device list changes during operation', async () => {
      // Start with one device
      monitor.setDevices(['device-1']);
      expect(monitor.getMonitoredDevices()).toEqual(['device-1']);

      // Update to different devices
      const newTask = { start: jest.fn(), stop: jest.fn() };
      (cron.schedule as jest.Mock).mockReturnValue(newTask);

      monitor.setDevices(['device-2', 'device-3']);

      expect(monitor.getMonitoredDevices()).toEqual(['device-2', 'device-3']);
      expect(mockTask.stop).toHaveBeenCalled();
      expect(newTask.start).toHaveBeenCalled();
    });

    test('no auth scenario', async () => {
      mockApi.hasAuth.mockReturnValue(false);

      monitor.setDevices(['device-1']);

      // Manual check
      const result = await monitor.checkDevice('device-1');

      // Should fail without auth
      expect(result).toBe(false);
    });
  });
});
