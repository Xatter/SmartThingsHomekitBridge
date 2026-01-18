import { PluginContextImpl } from './PluginContext';
import { SmartThingsAPI } from '@/api/SmartThingsAPI';
import { SmartThingsHAPServer } from '@/hap/HAPServer';
import { UnifiedDevice } from '@/types';
import { Logger } from 'pino';

// Mock dependencies
jest.mock('@/api/SmartThingsAPI');
jest.mock('@/hap/HAPServer');

describe('PluginContextImpl', () => {
  let context: PluginContextImpl;
  let mockApi: jest.Mocked<SmartThingsAPI>;
  let mockHapServer: jest.Mocked<SmartThingsHAPServer>;
  let mockLogger: jest.Mocked<Logger>;
  let mockGetDevices: jest.Mock;
  let mockGetDevice: jest.Mock;

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

  beforeEach(() => {
    jest.clearAllMocks();

    mockApi = {
      executeCommands: jest.fn().mockResolvedValue(undefined),
      getDeviceStatus: jest.fn().mockResolvedValue({}),
      turnLightOff: jest.fn().mockResolvedValue(true),
      turnLightOn: jest.fn().mockResolvedValue(true),
    } as any;

    mockHapServer = {
      updateDeviceState: jest.fn().mockResolvedValue(undefined),
    } as any;

    mockLogger = {
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      trace: jest.fn(),
      fatal: jest.fn(),
      child: jest.fn().mockReturnThis(),
      level: 'info',
    } as any;

    mockGetDevices = jest.fn().mockReturnValue([]);
    mockGetDevice = jest.fn();

    context = new PluginContextImpl(
      'test-plugin',
      mockLogger,
      {},
      mockGetDevices,
      mockGetDevice,
      mockApi,
      mockHapServer,
      './data'
    );
  });

  describe('setSmartThingsState - mode commands', () => {
    it('should use thermostatMode for standard thermostats', async () => {
      const device = createMockDevice({
        thermostatCapabilities: {
          thermostatMode: true,
          airConditionerMode: false,
        },
      });
      mockGetDevice.mockReturnValue(device);

      await context.setSmartThingsState('device-1', { thermostatMode: 'cool' });

      expect(mockApi.executeCommands).toHaveBeenCalledWith('device-1', [
        {
          component: 'main',
          capability: 'thermostatMode',
          command: 'setThermostatMode',
          arguments: ['cool'],
        },
      ]);
    });

    it('should use airConditionerMode for Samsung ACs', async () => {
      const device = createMockDevice({
        thermostatCapabilities: {
          thermostatMode: false,
          airConditionerMode: true,
          switch: true,
        },
      });
      mockGetDevice.mockReturnValue(device);

      await context.setSmartThingsState('device-1', { thermostatMode: 'cool' });

      expect(mockApi.executeCommands).toHaveBeenCalledWith('device-1', expect.arrayContaining([
        expect.objectContaining({
          capability: 'switch',
          command: 'on',
        }),
        expect.objectContaining({
          capability: 'airConditionerMode',
          command: 'setAirConditionerMode',
          arguments: ['cool'],
        }),
      ]));
    });

    it('should use switch off for Samsung AC off mode', async () => {
      const device = createMockDevice({
        thermostatCapabilities: {
          thermostatMode: false,
          airConditionerMode: true,
          switch: true,
        },
      });
      mockGetDevice.mockReturnValue(device);

      await context.setSmartThingsState('device-1', { thermostatMode: 'off' });

      expect(mockApi.executeCommands).toHaveBeenCalledWith('device-1', [
        {
          component: 'main',
          capability: 'switch',
          command: 'off',
          arguments: [],
        },
      ]);
    });

    it('should prefer thermostatMode when device has both capabilities', async () => {
      const device = createMockDevice({
        thermostatCapabilities: {
          thermostatMode: true,
          airConditionerMode: true,
        },
      });
      mockGetDevice.mockReturnValue(device);

      await context.setSmartThingsState('device-1', { thermostatMode: 'heat' });

      expect(mockApi.executeCommands).toHaveBeenCalledWith('device-1', [
        {
          component: 'main',
          capability: 'thermostatMode',
          command: 'setThermostatMode',
          arguments: ['heat'],
        },
      ]);
    });
  });

  describe('setSmartThingsState - temperature setpoints', () => {
    it('should set heatingSetpoint for standard thermostats', async () => {
      const device = createMockDevice({
        thermostatCapabilities: {
          thermostatHeatingSetpoint: true,
        },
      });
      mockGetDevice.mockReturnValue(device);

      await context.setSmartThingsState('device-1', { heatingSetpoint: 68 });

      expect(mockApi.executeCommands).toHaveBeenCalledWith('device-1', [
        {
          component: 'main',
          capability: 'thermostatHeatingSetpoint',
          command: 'setHeatingSetpoint',
          arguments: [68],
        },
      ]);
    });

    it('should set coolingSetpoint for standard thermostats', async () => {
      const device = createMockDevice({
        thermostatCapabilities: {
          thermostatCoolingSetpoint: true,
        },
      });
      mockGetDevice.mockReturnValue(device);

      await context.setSmartThingsState('device-1', { coolingSetpoint: 72 });

      expect(mockApi.executeCommands).toHaveBeenCalledWith('device-1', [
        {
          component: 'main',
          capability: 'thermostatCoolingSetpoint',
          command: 'setCoolingSetpoint',
          arguments: [72],
        },
      ]);
    });

    it('should set both mode and temperature in one call', async () => {
      const device = createMockDevice({
        thermostatCapabilities: {
          thermostatMode: true,
          thermostatCoolingSetpoint: true,
        },
      });
      mockGetDevice.mockReturnValue(device);

      await context.setSmartThingsState('device-1', {
        thermostatMode: 'cool',
        coolingSetpoint: 72,
      });

      expect(mockApi.executeCommands).toHaveBeenCalledWith('device-1', [
        {
          component: 'main',
          capability: 'thermostatMode',
          command: 'setThermostatMode',
          arguments: ['cool'],
        },
        {
          component: 'main',
          capability: 'thermostatCoolingSetpoint',
          command: 'setCoolingSetpoint',
          arguments: [72],
        },
      ]);
    });
  });

  describe('setSmartThingsState - Samsung AC temperature handling', () => {
    it('should use coolingSetpoint for Samsung AC heating (they only have cooling)', async () => {
      const device = createMockDevice({
        thermostatCapabilities: {
          thermostatMode: false,
          airConditionerMode: true,
          thermostatHeatingSetpoint: false,
          thermostatCoolingSetpoint: true,
          switch: true,
        },
      });
      mockGetDevice.mockReturnValue(device);

      await context.setSmartThingsState('device-1', {
        thermostatMode: 'heat',
        heatingSetpoint: 68,
      });

      // Should turn on, set mode to heat, and use coolingSetpoint for temperature
      const calls = mockApi.executeCommands.mock.calls[0][1];
      expect(calls).toContainEqual(
        expect.objectContaining({
          capability: 'thermostatCoolingSetpoint',
          command: 'setCoolingSetpoint',
          arguments: [68],
        })
      );
    });
  });

  describe('setSmartThingsState - error handling', () => {
    it('should throw if device not found', async () => {
      mockGetDevice.mockReturnValue(undefined);

      await expect(
        context.setSmartThingsState('device-1', { thermostatMode: 'cool' })
      ).rejects.toThrow('Device device-1 not found');
    });

    it('should not execute commands if no state properties provided', async () => {
      const device = createMockDevice({});
      mockGetDevice.mockReturnValue(device);

      await context.setSmartThingsState('device-1', {});

      expect(mockApi.executeCommands).not.toHaveBeenCalled();
    });
  });
});
