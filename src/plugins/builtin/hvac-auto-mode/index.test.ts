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
});
