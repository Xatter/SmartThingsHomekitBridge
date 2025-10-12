import { promises as fs } from 'fs';
import { AutoModeController, AutoModeDevice, ControllerConfig } from './AutoModeController';

// Mock logger before importing
jest.mock('@/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

// Mock fs
jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
    mkdir: jest.fn(),
  },
}));

describe('AutoModeController', () => {
  let controller: AutoModeController;
  const testStatePath = '/test/data/auto_mode_state.json';
  const mockFs = fs as jest.Mocked<typeof fs>;

  // Fast timing config for tests
  const fastConfig: Partial<ControllerConfig> = {
    minOnTime: 10,      // 10 seconds
    minOffTime: 5,      // 5 seconds
    minLockTime: 30,    // 30 seconds
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockFs.writeFile.mockResolvedValue();
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.readFile.mockRejectedValue({ code: 'ENOENT' }); // File doesn't exist by default
  });

  describe('Device Enrollment', () => {
    beforeEach(() => {
      controller = new AutoModeController(testStatePath, fastConfig);
    });

    it('should enroll a device', async () => {
      await controller.enrollDevice('device-1');

      const enrolled = controller.getEnrolledDeviceIds();
      expect(enrolled).toContain('device-1');
      expect(mockFs.writeFile).toHaveBeenCalled();
    });

    it('should not duplicate enrolled devices', async () => {
      await controller.enrollDevice('device-1');
      await controller.enrollDevice('device-1');

      const enrolled = controller.getEnrolledDeviceIds();
      expect(enrolled.filter(id => id === 'device-1').length).toBe(1);
    });

    it('should unenroll a device', async () => {
      await controller.enrollDevice('device-1');
      await controller.enrollDevice('device-2');
      await controller.unenrollDevice('device-1');

      const enrolled = controller.getEnrolledDeviceIds();
      expect(enrolled).not.toContain('device-1');
      expect(enrolled).toContain('device-2');
    });
  });

  describe('State Persistence', () => {
    it('should load existing state from disk', async () => {
      const savedState = {
        currentMode: 'heat',
        lastSwitchTime: Date.now(),
        lastOnTime: Date.now(),
        lastOffTime: 0,
        enrolledDeviceIds: ['device-1', 'device-2'],
      };
      mockFs.readFile.mockResolvedValue(JSON.stringify(savedState));

      controller = new AutoModeController(testStatePath, fastConfig);
      await controller.load();

      const enrolled = controller.getEnrolledDeviceIds();
      expect(enrolled).toEqual(['device-1', 'device-2']);
      expect(controller.getCurrentMode()).toBe('heat');
    });

    it('should save state to disk', async () => {
      controller = new AutoModeController(testStatePath, fastConfig);
      await controller.enrollDevice('device-1');

      expect(mockFs.writeFile).toHaveBeenCalled();
      const writeCall = mockFs.writeFile.mock.calls[0];
      expect(writeCall[0]).toBe(testStatePath);

      const savedData = JSON.parse(writeCall[1] as string);
      expect(savedData.enrolledDeviceIds).toContain('device-1');
    });
  });

  describe('Demand Calculation', () => {
    beforeEach(async () => {
      controller = new AutoModeController(testStatePath, fastConfig);
      await controller.enrollDevice('device-1');
    });

    it('should calculate heat demand when below lower bound', () => {
      const devices: AutoModeDevice[] = [{
        id: 'device-1',
        name: 'Living Room',
        currentTemperature: 66,
        lowerBound: 68,
        upperBound: 72,
        weight: 1.0,
      }];

      const decision = controller.evaluate(devices);

      expect(decision.mode).toBe('heat');
      expect(decision.totalHeatDemand).toBeGreaterThan(0);
      expect(decision.totalCoolDemand).toBe(0);
    });

    it('should calculate cool demand when above upper bound', () => {
      const devices: AutoModeDevice[] = [{
        id: 'device-1',
        name: 'Bedroom',
        currentTemperature: 74,
        lowerBound: 68,
        upperBound: 72,
        weight: 1.0,
      }];

      const decision = controller.evaluate(devices);

      expect(decision.mode).toBe('cool');
      expect(decision.totalCoolDemand).toBeGreaterThan(0);
      expect(decision.totalHeatDemand).toBe(0);
    });

    it('should apply device weights correctly', async () => {
      const devices: AutoModeDevice[] = [
        {
          id: 'device-1',
          name: 'Room A',
          currentTemperature: 66,
          lowerBound: 68,
          upperBound: 72,
          weight: 1.0,
        },
        {
          id: 'device-2',
          name: 'Room B',
          currentTemperature: 66,
          lowerBound: 68,
          upperBound: 72,
          weight: 2.0, // Double weight
        },
      ];

      await controller.enrollDevice('device-2');
      const decision = controller.evaluate(devices);

      // Room B should contribute twice as much
      const roomADemand = decision.deviceDemands.find(d => d.deviceId === 'device-1')!.heatDemand;
      const roomBDemand = decision.deviceDemands.find(d => d.deviceId === 'device-2')!.heatDemand;
      expect(roomBDemand).toBeCloseTo(roomADemand * 2, 1);
    });

    it('should return off mode when no demand', () => {
      const devices: AutoModeDevice[] = [{
        id: 'device-1',
        name: 'Comfortable',
        currentTemperature: 70,
        lowerBound: 68,
        upperBound: 72,
        weight: 1.0,
      }];

      const decision = controller.evaluate(devices);

      expect(decision.mode).toBe('off');
      expect(decision.totalHeatDemand).toBe(0);
      expect(decision.totalCoolDemand).toBe(0);
    });
  });

  describe('Conflict Resolution', () => {
    beforeEach(async () => {
      controller = new AutoModeController(testStatePath, fastConfig);
      await controller.enrollDevice('device-1');
      await controller.enrollDevice('device-2');
    });

    it('should choose heat when heat demand dominates', () => {
      const devices: AutoModeDevice[] = [
        {
          id: 'device-1',
          name: 'Cold Room',
          currentTemperature: 64, // 4°F below threshold
          lowerBound: 68,
          upperBound: 72,
          weight: 1.0,
        },
        {
          id: 'device-2',
          name: 'Warm Room',
          currentTemperature: 73, // 1°F above threshold
          lowerBound: 68,
          upperBound: 72,
          weight: 1.0,
        },
      ];

      const decision = controller.evaluate(devices);

      expect(decision.mode).toBe('heat');
      expect(decision.totalHeatDemand).toBeGreaterThan(decision.totalCoolDemand);
    });

    it('should choose cool when cool demand dominates', () => {
      const devices: AutoModeDevice[] = [
        {
          id: 'device-1',
          name: 'Slightly Cold',
          currentTemperature: 67.5, // 0.5°F below
          lowerBound: 68,
          upperBound: 72,
          weight: 1.0,
        },
        {
          id: 'device-2',
          name: 'Very Hot',
          currentTemperature: 76, // 4°F above
          lowerBound: 68,
          upperBound: 72,
          weight: 1.0,
        },
      ];

      const decision = controller.evaluate(devices);

      expect(decision.mode).toBe('cool');
      expect(decision.totalCoolDemand).toBeGreaterThan(decision.totalHeatDemand);
    });

    it('should hold current mode when demands are close', () => {
      // Start in heat mode
      const heatDevices: AutoModeDevice[] = [{
        id: 'device-1',
        name: 'Cold',
        currentTemperature: 65,
        lowerBound: 68,
        upperBound: 72,
        weight: 1.0,
      }];
      const heatDecision = controller.evaluate(heatDevices);
      controller.applyDecision(heatDecision);

      // Now create a near-tie scenario where flip guard suppresses cool demand
      // Room B at 73°F is within flip guard margin (72 + 0.7 + 2.0 = 74.7°F)
      // so its cool demand will be suppressed, leaving only heat demand
      const tieDevices: AutoModeDevice[] = [
        {
          id: 'device-1',
          name: 'Room A',
          currentTemperature: 67, // 1°F below
          lowerBound: 68,
          upperBound: 72,
          weight: 1.0,
        },
        {
          id: 'device-2',
          name: 'Room B',
          currentTemperature: 73, // 1°F above (but within flip guard)
          lowerBound: 68,
          upperBound: 72,
          weight: 1.0,
        },
      ];

      const decision = controller.evaluate(tieDevices);

      // Flip guard suppresses Room B's cool demand, leaving only heat demand
      expect(decision.mode).toBe('heat');
      expect(decision.reason).toContain('Continuing heat');
      expect(decision.totalCoolDemand).toBe(0); // Suppressed by flip guard
    });
  });

  describe('Timing Protections', () => {
    beforeEach(async () => {
      controller = new AutoModeController(testStatePath, fastConfig);
      await controller.enrollDevice('device-1');
    });

    it('should enforce minimum on-time before switching off', async () => {
      // Start heating
      const heatDevices: AutoModeDevice[] = [{
        id: 'device-1',
        name: 'Room',
        currentTemperature: 65,
        lowerBound: 68,
        upperBound: 72,
        weight: 1.0,
      }];

      const heatDecision = controller.evaluate(heatDevices);
      await controller.applyDecision(heatDecision);
      expect(controller.getCurrentMode()).toBe('heat');

      // Immediately try to turn off
      const offDevices: AutoModeDevice[] = [{
        id: 'device-1',
        name: 'Room',
        currentTemperature: 70, // Now comfortable
        lowerBound: 68,
        upperBound: 72,
        weight: 1.0,
      }];

      const offDecision = controller.evaluate(offDevices);

      // Should be suppressed due to min_on_time
      expect(offDecision.switchSuppressed).toBe(true);
      expect(offDecision.mode).toBe('heat'); // Keep current mode
    });

    it('should enforce minimum lock time before flipping modes', async () => {
      // Start heating
      const heatDevices: AutoModeDevice[] = [{
        id: 'device-1',
        name: 'Room',
        currentTemperature: 65,
        lowerBound: 68,
        upperBound: 72,
        weight: 1.0,
      }];

      const heatDecision = controller.evaluate(heatDevices);
      await controller.applyDecision(heatDecision);

      // Immediately try to switch to cool
      const coolDevices: AutoModeDevice[] = [{
        id: 'device-1',
        name: 'Room',
        currentTemperature: 75, // Now too hot
        lowerBound: 68,
        upperBound: 72,
        weight: 1.0,
      }];

      const coolDecision = controller.evaluate(coolDevices);

      // Should be suppressed due to min_lock_time
      expect(coolDecision.switchSuppressed).toBe(true);
      expect(coolDecision.mode).toBe('heat'); // Keep current mode
    });
  });

  describe('Flip Guard', () => {
    beforeEach(async () => {
      controller = new AutoModeController(testStatePath, fastConfig);
      await controller.enrollDevice('device-1');
    });

    it('should suppress heat demand when running cool and near threshold', async () => {
      // Start in cool mode
      const coolDevices: AutoModeDevice[] = [{
        id: 'device-1',
        name: 'Room',
        currentTemperature: 74,
        lowerBound: 68,
        upperBound: 72,
        weight: 1.0,
      }];

      const coolDecision = controller.evaluate(coolDevices);
      await controller.applyDecision(coolDecision);
      expect(controller.getCurrentMode()).toBe('cool');

      // Temperature drops to just below lower bound
      // Without flip guard, this would request heat
      // With flip guard (2°F), it should be suppressed
      const nearThresholdDevices: AutoModeDevice[] = [{
        id: 'device-1',
        name: 'Room',
        currentTemperature: 67.5, // Below 68 but within flip guard
        lowerBound: 68,
        upperBound: 72,
        weight: 1.0,
      }];

      const decision = controller.evaluate(nearThresholdDevices);

      // Heat demand should be suppressed by flip guard
      expect(decision.totalHeatDemand).toBe(0);
      // Should hold cool mode due to min_on_time protection
      expect(decision.mode).toBe('cool');
      expect(decision.switchSuppressed).toBe(true);
    });
  });

  describe('Safety Features', () => {
    beforeEach(async () => {
      controller = new AutoModeController(testStatePath, fastConfig);
      await controller.enrollDevice('device-1');
    });

    it('should force heat mode for freeze protection', () => {
      const devices: AutoModeDevice[] = [{
        id: 'device-1',
        name: 'Freezing Room',
        currentTemperature: 45, // Below 50°F freeze threshold
        lowerBound: 68,
        upperBound: 72,
        weight: 1.0,
      }];

      const decision = controller.evaluate(devices);

      expect(decision.mode).toBe('heat');
      expect(decision.reason).toContain('Freeze protection');
    });

    it('should force cool mode for high temperature protection', () => {
      const devices: AutoModeDevice[] = [{
        id: 'device-1',
        name: 'Overheating Room',
        currentTemperature: 95, // Above 90°F high temp threshold
        lowerBound: 68,
        upperBound: 72,
        weight: 1.0,
      }];

      const decision = controller.evaluate(devices);

      expect(decision.mode).toBe('cool');
      expect(decision.reason).toContain('High temperature protection');
    });
  });

  describe('Status and Diagnostics', () => {
    beforeEach(async () => {
      controller = new AutoModeController(testStatePath, fastConfig);
    });

    it('should provide status summary', async () => {
      await controller.enrollDevice('device-1');
      await controller.enrollDevice('device-2');

      const status = controller.getStatus();

      expect(status.enrolledDeviceCount).toBe(2);
      expect(status.enrolledDeviceIds).toContain('device-1');
      expect(status.enrolledDeviceIds).toContain('device-2');
      expect(status.currentMode).toBe('off');
      expect(status.config).toBeDefined();
    });

    it('should provide detailed decision with per-device demands', async () => {
      await controller.enrollDevice('device-1');
      await controller.enrollDevice('device-2');

      const devices: AutoModeDevice[] = [
        {
          id: 'device-1',
          name: 'Room A',
          currentTemperature: 66,
          lowerBound: 68,
          upperBound: 72,
          weight: 1.0,
        },
        {
          id: 'device-2',
          name: 'Room B',
          currentTemperature: 74,
          lowerBound: 68,
          upperBound: 72,
          weight: 1.0,
        },
      ];

      const decision = controller.evaluate(devices);

      expect(decision.deviceDemands).toHaveLength(2);

      const device1Demand = decision.deviceDemands.find(d => d.deviceId === 'device-1');
      expect(device1Demand?.heatDemand).toBeGreaterThan(0);
      expect(device1Demand?.coolDemand).toBe(0);

      const device2Demand = decision.deviceDemands.find(d => d.deviceId === 'device-2');
      expect(device2Demand?.coolDemand).toBeGreaterThan(0);
      expect(device2Demand?.heatDemand).toBe(0);
    });
  });

  describe('applyDecision', () => {
    beforeEach(async () => {
      controller = new AutoModeController(testStatePath, fastConfig);
      await controller.enrollDevice('device-1');
    });

    it('should return true when mode changes', async () => {
      const devices: AutoModeDevice[] = [{
        id: 'device-1',
        name: 'Room',
        currentTemperature: 65,
        lowerBound: 68,
        upperBound: 72,
        weight: 1.0,
      }];

      const decision = controller.evaluate(devices);
      const changed = await controller.applyDecision(decision);

      expect(changed).toBe(true);
      expect(controller.getCurrentMode()).toBe('heat');
    });

    it('should return false when mode stays the same', async () => {
      const devices: AutoModeDevice[] = [{
        id: 'device-1',
        name: 'Room',
        currentTemperature: 65,
        lowerBound: 68,
        upperBound: 72,
        weight: 1.0,
      }];

      const decision1 = controller.evaluate(devices);
      await controller.applyDecision(decision1);

      const decision2 = controller.evaluate(devices);
      const changed = await controller.applyDecision(decision2);

      expect(changed).toBe(false);
    });
  });
});
