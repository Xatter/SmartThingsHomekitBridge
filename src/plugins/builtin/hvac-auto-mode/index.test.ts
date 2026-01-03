import { UnifiedDevice } from '@/types';
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
  });

  afterEach(async () => {
    await plugin.stop();
  });

  describe('detectAndCorrectAutoMode', () => {
    it('should not take action when no devices are in auto mode', async () => {
      const devices: UnifiedDevice[] = [
        createMockDevice({ deviceId: 'device-1', label: 'Living Room', mode: 'cool' }),
        createMockDevice({ deviceId: 'device-2', label: 'Bedroom', mode: 'heat' }),
      ];

      await plugin.onPollCycle!(devices);

      expect(mockContext.setSmartThingsState).not.toHaveBeenCalled();
    });

    it('should correct a device in auto mode using another device\'s heat mode', async () => {
      const devices: UnifiedDevice[] = [
        createMockDevice({ deviceId: 'device-1', label: 'Living Room', mode: 'auto' }),
        createMockDevice({ deviceId: 'device-2', label: 'Bedroom', mode: 'heat' }),
      ];

      await plugin.onPollCycle!(devices);

      expect(mockContext.setSmartThingsState).toHaveBeenCalledWith('device-1', {
        thermostatMode: 'heat',
      });
    });

    it('should correct a device in auto mode using another device\'s cool mode', async () => {
      const devices: UnifiedDevice[] = [
        createMockDevice({ deviceId: 'device-1', label: 'Living Room', mode: 'auto' }),
        createMockDevice({ deviceId: 'device-2', label: 'Bedroom', mode: 'cool' }),
      ];

      await plugin.onPollCycle!(devices);

      expect(mockContext.setSmartThingsState).toHaveBeenCalledWith('device-1', {
        thermostatMode: 'cool',
      });
    });

    it('should correct multiple devices in auto mode to match the active mode', async () => {
      const devices: UnifiedDevice[] = [
        createMockDevice({ deviceId: 'device-1', label: 'Living Room', mode: 'auto' }),
        createMockDevice({ deviceId: 'device-2', label: 'Bedroom', mode: 'auto' }),
        createMockDevice({ deviceId: 'device-3', label: 'Kitchen', mode: 'heat' }),
      ];

      await plugin.onPollCycle!(devices);

      expect(mockContext.setSmartThingsState).toHaveBeenCalledWith('device-1', {
        thermostatMode: 'heat',
      });
      expect(mockContext.setSmartThingsState).toHaveBeenCalledWith('device-2', {
        thermostatMode: 'heat',
      });
      expect(mockContext.setSmartThingsState).toHaveBeenCalledTimes(2);
    });

    it('should use temp vs setpoint heuristic when no other device is on (temp < setpoint = heat)', async () => {
      const devices: UnifiedDevice[] = [
        createMockDevice({
          deviceId: 'device-1',
          label: 'Living Room',
          mode: 'auto',
          currentTemperature: 65,
          coolingSetpoint: 72,
        }),
        createMockDevice({ deviceId: 'device-2', label: 'Bedroom', mode: 'off' }),
      ];

      await plugin.onPollCycle!(devices);

      expect(mockContext.setSmartThingsState).toHaveBeenCalledWith('device-1', {
        thermostatMode: 'heat',
      });
    });

    it('should use temp vs setpoint heuristic when no other device is on (temp > setpoint = cool)', async () => {
      const devices: UnifiedDevice[] = [
        createMockDevice({
          deviceId: 'device-1',
          label: 'Living Room',
          mode: 'auto',
          currentTemperature: 78,
          coolingSetpoint: 72,
        }),
        createMockDevice({ deviceId: 'device-2', label: 'Bedroom', mode: 'off' }),
      ];

      await plugin.onPollCycle!(devices);

      expect(mockContext.setSmartThingsState).toHaveBeenCalledWith('device-1', {
        thermostatMode: 'cool',
      });
    });

    it('should use heatingSetpoint if coolingSetpoint is not available', async () => {
      const devices: UnifiedDevice[] = [
        createMockDevice({
          deviceId: 'device-1',
          label: 'Living Room',
          mode: 'auto',
          currentTemperature: 65,
          heatingSetpoint: 70,
          coolingSetpoint: undefined,
        }),
      ];

      await plugin.onPollCycle!(devices);

      // temp (65) < setpoint (70) => heat
      expect(mockContext.setSmartThingsState).toHaveBeenCalledWith('device-1', {
        thermostatMode: 'heat',
      });
    });

    it('should not correct when temperature and setpoint data are missing', async () => {
      const devices: UnifiedDevice[] = [
        createMockDevice({
          deviceId: 'device-1',
          label: 'Living Room',
          mode: 'auto',
          currentTemperature: undefined,
          coolingSetpoint: undefined,
          heatingSetpoint: undefined,
        }),
      ];

      await plugin.onPollCycle!(devices);

      expect(mockContext.setSmartThingsState).not.toHaveBeenCalled();
      expect(mockContext.logger.warn).toHaveBeenCalled();
    });

    it('should handle errors when correcting individual devices', async () => {
      const devices: UnifiedDevice[] = [
        createMockDevice({ deviceId: 'device-1', label: 'Living Room', mode: 'auto' }),
        createMockDevice({ deviceId: 'device-2', label: 'Bedroom', mode: 'auto' }),
        createMockDevice({ deviceId: 'device-3', label: 'Kitchen', mode: 'heat' }),
      ];

      // First call fails, second succeeds
      mockContext.setSmartThingsState
        .mockRejectedValueOnce(new Error('API Error'))
        .mockResolvedValueOnce({});

      await plugin.onPollCycle!(devices);

      // Should have tried both devices
      expect(mockContext.setSmartThingsState).toHaveBeenCalledTimes(2);
      expect(mockContext.logger.error).toHaveBeenCalled();
    });

    it('should ignore devices that are not thermostat-like', async () => {
      const thermostatDevice = createMockDevice({
        deviceId: 'device-1',
        label: 'AC Unit',
        mode: 'auto',
        currentTemperature: 65,
        coolingSetpoint: 72,
      });

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

      const devices = [thermostatDevice, lightDevice];

      await plugin.onPollCycle!(devices);

      // Should only try to correct the thermostat device
      expect(mockContext.setSmartThingsState).toHaveBeenCalledWith('device-1', {
        thermostatMode: 'heat',
      });
      expect(mockContext.setSmartThingsState).toHaveBeenCalledTimes(1);
    });

    it('should prefer heat/cool mode over off when determining correct mode', async () => {
      const devices: UnifiedDevice[] = [
        createMockDevice({ deviceId: 'device-1', label: 'Living Room', mode: 'auto' }),
        createMockDevice({ deviceId: 'device-2', label: 'Bedroom', mode: 'off' }),
        createMockDevice({ deviceId: 'device-3', label: 'Kitchen', mode: 'cool' }),
      ];

      await plugin.onPollCycle!(devices);

      // Should use 'cool' from device-3, not 'off' from device-2
      expect(mockContext.setSmartThingsState).toHaveBeenCalledWith('device-1', {
        thermostatMode: 'cool',
      });
    });

    it('should handle all devices being in auto mode with heuristic', async () => {
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

      // Both are above setpoint, should cool
      expect(mockContext.setSmartThingsState).toHaveBeenCalledWith('device-1', {
        thermostatMode: 'cool',
      });
      expect(mockContext.setSmartThingsState).toHaveBeenCalledWith('device-2', {
        thermostatMode: 'cool',
      });
    });
  });
});
