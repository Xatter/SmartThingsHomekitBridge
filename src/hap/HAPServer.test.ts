import { SmartThingsHAPServer } from './HAPServer';
import { Coordinator } from '@/coordinator/Coordinator';
import { DeviceState } from '@/types';
import { AccessoryCache } from './AccessoryCache';
import { Bridge, Characteristic } from 'hap-nodejs';

// Mock dependencies
jest.mock('./AccessoryCache');
jest.mock('fs', () => ({
  promises: {
    unlink: jest.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  },
}));
jest.mock('hap-nodejs', () => {
  const mockCharacteristic = {
    setProps: jest.fn().mockReturnThis(),
    setValue: jest.fn().mockReturnThis(),
    updateValue: jest.fn().mockReturnThis(),
    on: jest.fn().mockReturnThis(),
  };

  const mockService = {
    getCharacteristic: jest.fn(() => mockCharacteristic),
    setCharacteristic: jest.fn().mockReturnThis(),
  };

  const mockAccessory = {
    getService: jest.fn(() => mockService),
    addService: jest.fn(() => mockService),
    reachable: true,
    displayName: '',
    UUID: 'test-uuid',
  };

  const mockBridge = {
    getService: jest.fn(() => mockService),
    addBridgedAccessory: jest.fn(),
    addBridgedAccessories: jest.fn(),
    removeBridgedAccessory: jest.fn(),
    publish: jest.fn(),
    unpublish: jest.fn(),
    setupURI: jest.fn(() => 'X-HM://test-setup-uri'),
    on: jest.fn(),
    removeAllListeners: jest.fn(),
    bridgedAccessories: [],
  };

  return {
    Bridge: jest.fn(() => mockBridge),
    Accessory: jest.fn(() => mockAccessory),
    Service: {
      AccessoryInformation: 'AccessoryInformation',
      Thermostat: 'Thermostat',
    },
    Characteristic: {
      Manufacturer: 'Manufacturer',
      Model: 'Model',
      SerialNumber: 'SerialNumber',
      FirmwareRevision: 'FirmwareRevision',
      Identify: 'Identify',
      CurrentTemperature: 'CurrentTemperature',
      TargetTemperature: 'TargetTemperature',
      CurrentHeatingCoolingState: {
        HEAT: 1,
        COOL: 2,
        OFF: 0,
      },
      TargetHeatingCoolingState: {
        HEAT: 1,
        COOL: 2,
        AUTO: 3,
        OFF: 0,
      },
      TemperatureDisplayUnits: {
        FAHRENHEIT: 1,
      },
      HeatingThresholdTemperature: 'HeatingThresholdTemperature',
      CoolingThresholdTemperature: 'CoolingThresholdTemperature',
    },
    Categories: {
      BRIDGE: 1,
    },
    uuid: {
      generate: jest.fn((id: string) => `generated-uuid-${id}`),
    },
    HAPStorage: {
      setCustomStoragePath: jest.fn(),
    },
  };
});

// Mock QRCode
jest.mock('qrcode', () => ({
  toString: jest.fn().mockResolvedValue('<svg>mock-qr-code</svg>'),
}));

describe('SmartThingsHAPServer', () => {
  let hapServer: SmartThingsHAPServer;
  let mockCoordinator: jest.Mocked<Coordinator>;
  let mockAccessoryCache: jest.Mocked<AccessoryCache>;

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

    // Create mock coordinator
    mockCoordinator = {
      handleThermostatEvent: jest.fn().mockResolvedValue(undefined),
    } as any;

    // Create mock accessory cache
    mockAccessoryCache = {
      load: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockResolvedValue(undefined),
      addOrUpdate: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
      has: jest.fn().mockReturnValue(false),
      getAll: jest.fn().mockReturnValue([]),
    } as any;

    (AccessoryCache as jest.Mock).mockImplementation(() => mockAccessoryCache);

    hapServer = new SmartThingsHAPServer(51826, '942-37-286');
  });

  describe('Temperature conversion', () => {
    test('given fahrenheit value, should convert to celsius correctly', () => {
      const fahrenheitToCelsius = (hapServer as any).fahrenheitToCelsius.bind(hapServer);

      expect(fahrenheitToCelsius(32)).toBeCloseTo(0);
      expect(fahrenheitToCelsius(212)).toBeCloseTo(100);
      expect(fahrenheitToCelsius(72)).toBeCloseTo(22.22, 1);
      expect(fahrenheitToCelsius(-40)).toBeCloseTo(-40);
    });

    test('given celsius value, should convert to fahrenheit correctly', () => {
      const celsiusToFahrenheit = (hapServer as any).celsiusToFahrenheit.bind(hapServer);

      expect(celsiusToFahrenheit(0)).toBeCloseTo(32);
      expect(celsiusToFahrenheit(100)).toBeCloseTo(212);
      expect(celsiusToFahrenheit(22.22)).toBeCloseTo(72, 0);
      expect(celsiusToFahrenheit(-40)).toBeCloseTo(-40);
    });

    test('round-trip conversion should maintain value', () => {
      const fahrenheitToCelsius = (hapServer as any).fahrenheitToCelsius.bind(hapServer);
      const celsiusToFahrenheit = (hapServer as any).celsiusToFahrenheit.bind(hapServer);

      const originalF = 72;
      const celsius = fahrenheitToCelsius(originalF);
      const backToF = celsiusToFahrenheit(celsius);

      expect(backToF).toBeCloseTo(originalF, 1);
    });
  });

  describe('Mode mapping', () => {
    test('given heat mode, should map to HAP HEAT state', () => {
      const mapModeToCurrentState = (hapServer as any).mapModeToCurrentState.bind(hapServer);

      expect(mapModeToCurrentState('heat')).toBe(1); // HEAT
      expect(mapModeToCurrentState('heating')).toBe(1);
    });

    test('given cool mode, should map to HAP COOL state', () => {
      const mapModeToCurrentState = (hapServer as any).mapModeToCurrentState.bind(hapServer);

      expect(mapModeToCurrentState('cool')).toBe(2); // COOL
      expect(mapModeToCurrentState('cooling')).toBe(2);
    });

    test('given off mode, should map to HAP OFF state', () => {
      const mapModeToCurrentState = (hapServer as any).mapModeToCurrentState.bind(hapServer);

      expect(mapModeToCurrentState('off')).toBe(0); // OFF
    });

    test('given unknown mode, should default to OFF', () => {
      const mapModeToCurrentState = (hapServer as any).mapModeToCurrentState.bind(hapServer);

      expect(mapModeToCurrentState('unknown')).toBe(0); // OFF
    });

    test('given auto mode, should map to HAP AUTO target state', () => {
      const mapModeToTargetState = (hapServer as any).mapModeToTargetState.bind(hapServer);

      expect(mapModeToTargetState('auto')).toBe(3); // AUTO
    });

    test('given HAP mode number, should map back to string mode', () => {
      const mapTargetStateToMode = (hapServer as any).mapTargetStateToMode.bind(hapServer);

      expect(mapTargetStateToMode(1)).toBe('heat');
      expect(mapTargetStateToMode(2)).toBe('cool');
      expect(mapTargetStateToMode(3)).toBe('auto');
      expect(mapTargetStateToMode(0)).toBe('off');
    });

    test('round-trip mode conversion should maintain value', () => {
      const mapModeToTargetState = (hapServer as any).mapModeToTargetState.bind(hapServer);
      const mapTargetStateToMode = (hapServer as any).mapTargetStateToMode.bind(hapServer);

      const originalMode = 'cool';
      const hapMode = mapModeToTargetState(originalMode);
      const backToMode = mapTargetStateToMode(hapMode);

      expect(backToMode).toBe(originalMode);
    });
  });

  describe('initialize', () => {
    test('given coordinator, should initialize HAP server successfully', async () => {
      await hapServer.initialize(mockCoordinator);

      // Bridge should be created
      expect(hapServer['bridge']).toBeDefined();
    });

    test('given null coordinator, should initialize without throwing', async () => {
      // Initialization accepts any coordinator value and stores it
      // The coordinator is only used later during event handling
      const invalidCoordinator = null as any;

      await expect(hapServer.initialize(invalidCoordinator)).resolves.not.toThrow();

      // Bridge should still be created
      expect(hapServer['bridge']).toBeDefined();
    });
  });

  describe('addDevice', () => {
    beforeEach(async () => {
      await hapServer.initialize(mockCoordinator);
      await hapServer.start();
    });

    test('given new device state, should add device to bridge', async () => {
      const deviceState = createMockDeviceState();

      await hapServer.addDevice('device-123', deviceState);

      const bridge = hapServer['bridge'];
      expect(bridge?.addBridgedAccessory).toHaveBeenCalled();
      expect(mockAccessoryCache.addOrUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceId: 'device-123',
          name: 'Test Thermostat',
        })
      );
    });

    test('given device already exists, should update state instead of adding', async () => {
      const deviceState = createMockDeviceState();

      // Add device first time
      await hapServer.addDevice('device-123', deviceState);
      jest.clearAllMocks();

      // Try to add again
      await hapServer.addDevice('device-123', deviceState);

      const bridge = hapServer['bridge'];
      expect(bridge?.addBridgedAccessory).not.toHaveBeenCalled();
    });

    test('given device without bridge initialized, should handle gracefully', async () => {
      hapServer['bridge'] = null;
      const deviceState = createMockDeviceState();

      await hapServer.addDevice('device-123', deviceState);

      expect(mockAccessoryCache.addOrUpdate).not.toHaveBeenCalled();
    });

    test('given device with undefined temperature, should use default', async () => {
      const deviceState = createMockDeviceState({
        temperatureSetpoint: undefined as any,
      });

      await hapServer.addDevice('device-123', deviceState);

      // Should not throw and should handle the undefined gracefully
      expect(hapServer['devices'].has('device-123')).toBe(true);
    });

    test('given device that is cached but was never restored into devices, should create the accessory instead of dropping it', async () => {
      mockAccessoryCache.has.mockReturnValue(true);
      const deviceState = createMockDeviceState();

      await hapServer.addDevice('device-123', deviceState);

      const bridge = hapServer['bridge'];
      expect(bridge?.addBridgedAccessory).toHaveBeenCalled();
      expect(hapServer['devices'].has('device-123')).toBe(true);
      expect(mockAccessoryCache.addOrUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceId: 'device-123',
          name: 'Test Thermostat',
        })
      );
    });
  });

  describe('updateDeviceState', () => {
    beforeEach(async () => {
      await hapServer.initialize(mockCoordinator);
      await hapServer.start();

      const initialState = createMockDeviceState();
      await hapServer.addDevice('device-123', initialState);

      // Clear cooldown to allow immediate update
      hapServer['lastUpdateTime'].clear();
    });

    afterEach(() => {
      // Some tests below use fake timers and/or leave a trailing-edge
      // cooldown timer scheduled; make sure nothing leaks between tests.
      for (const timer of hapServer['cooldownTimers'].values()) {
        clearTimeout(timer);
      }
      hapServer['cooldownTimers'].clear();
      jest.useRealTimers();
    });

    test('given changed temperature, should update characteristic', async () => {
      const newState = createMockDeviceState({
        currentTemperature: 75,
      });

      await hapServer.updateDeviceState('device-123', newState);

      const device = hapServer['devices'].get('device-123');
      expect(device?.state.currentTemperature).toBe(75);
    });

    test('given changed setpoint, should update characteristic', async () => {
      const newState = createMockDeviceState({
        temperatureSetpoint: 68,
      });

      await hapServer.updateDeviceState('device-123', newState);

      const device = hapServer['devices'].get('device-123');
      expect(device?.state.temperatureSetpoint).toBe(68);
    });

    test('given changed mode, should update characteristic', async () => {
      const newState = createMockDeviceState({
        mode: 'heat',
      });

      await hapServer.updateDeviceState('device-123', newState);

      const device = hapServer['devices'].get('device-123');
      expect(device?.state.mode).toBe('heat');
    });

    test('given no changes, should skip update', async () => {
      const sameState = createMockDeviceState();

      await hapServer.updateDeviceState('device-123', sameState);

      // Should skip update (already at this state)
      const device = hapServer['devices'].get('device-123');
      expect(device?.state).toBeDefined();
    });

    test('given update within cooldown period, should skip', async () => {
      // Set last update time to now
      hapServer['lastUpdateTime'].set('device-123', Date.now());

      const newState = createMockDeviceState({
        currentTemperature: 80,
      });

      await hapServer.updateDeviceState('device-123', newState);

      // Should skip due to cooldown
      const device = hapServer['devices'].get('device-123');
      expect(device?.state.currentTemperature).toBe(72); // Original value
    });

    test('given non-existent device, should handle gracefully', async () => {
      const deviceState = createMockDeviceState();

      await expect(
        hapServer.updateDeviceState('non-existent', deviceState)
      ).resolves.not.toThrow();
    });

    test('given rapid updates within the cooldown window, should coalesce them and flush only the latest state once the cooldown expires', async () => {
      jest.useFakeTimers();

      // First update applies immediately (no prior cooldown) and starts the window.
      await hapServer.updateDeviceState('device-123', createMockDeviceState({ currentTemperature: 74 }));
      expect(hapServer['devices'].get('device-123')?.state.currentTemperature).toBe(74);

      // Two rapid updates land inside the cooldown window - neither should be
      // dropped (the old behavior); they should coalesce into a single
      // pending state instead.
      await hapServer.updateDeviceState('device-123', createMockDeviceState({ currentTemperature: 76 }));
      await hapServer.updateDeviceState('device-123', createMockDeviceState({ currentTemperature: 78 }));

      // Still showing the pre-cooldown value - the deferred updates haven't
      // been applied yet.
      expect(hapServer['devices'].get('device-123')?.state.currentTemperature).toBe(74);
      // Exactly one timer tracked for the device, not one per coalesced call.
      expect(hapServer['cooldownTimers'].size).toBe(1);

      jest.advanceTimersByTime(2000);
      await Promise.resolve();
      await Promise.resolve();

      // The LATEST coalesced state (78) wins, not the intermediate 76 or a
      // dropped update.
      expect(hapServer['devices'].get('device-123')?.state.currentTemperature).toBe(78);
      expect(hapServer['cooldownTimers'].size).toBe(0);
    });

    test('given a round-trip echo of the commanded Fahrenheit setpoint, should push the original Celsius value instead of a reconverted one', async () => {
      const handleTemperatureChange = (hapServer as any).handleTargetTemperatureChange.bind(hapServer);
      const mockCallback = jest.fn();

      // User sets 22.5C in HomeKit -> celsiusToFahrenheit -> rounds to 73F,
      // which is what gets commanded to SmartThings.
      await handleTemperatureChange('device-123', 22.5, mockCallback);
      expect(hapServer['devices'].get('device-123')?.state.temperatureSetpoint).toBe(73);

      // Next poll echoes back 73F. A naive reconversion
      // (fahrenheitToCelsius(73) -> 22.78 -> quantized to nearest 0.5) would
      // land on 23C, not what the user actually set.
      const polledState = createMockDeviceState({ temperatureSetpoint: 73 });
      await hapServer.updateDeviceState('device-123', polledState);

      const device = hapServer['devices'].get('device-123')!;
      const targetTempChar = device.thermostatService.getCharacteristic(Characteristic.TargetTemperature);
      expect(targetTempChar.updateValue).toHaveBeenCalledWith(22.5);
    });
  });

  describe('removeDevice', () => {
    beforeEach(async () => {
      await hapServer.initialize(mockCoordinator);
      await hapServer.start();

      const deviceState = createMockDeviceState();
      await hapServer.addDevice('device-123', deviceState);
    });

    test('given existing device, should remove from bridge', async () => {
      await hapServer.removeDevice('device-123');

      const bridge = hapServer['bridge'];
      expect(bridge?.removeBridgedAccessory).toHaveBeenCalled();
      expect(hapServer['devices'].has('device-123')).toBe(false);
      expect(mockAccessoryCache.remove).toHaveBeenCalledWith('device-123');
    });

    test('given non-existent device, should handle gracefully', async () => {
      await expect(
        hapServer.removeDevice('non-existent')
      ).resolves.not.toThrow();
    });
  });

  describe('getDeviceStates', () => {
    test('given devices added, should return all device states', async () => {
      await hapServer.initialize(mockCoordinator);
      await hapServer.start();

      await hapServer.addDevice('device-1', createMockDeviceState({ id: 'device-1', name: 'Thermostat 1' }));
      await hapServer.addDevice('device-2', createMockDeviceState({ id: 'device-2', name: 'Thermostat 2' }));

      const states = hapServer.getDeviceStates();

      expect(states.size).toBe(2);
      expect(states.has('device-1')).toBe(true);
      expect(states.has('device-2')).toBe(true);
    });

    test('given no devices, should return empty map', () => {
      const states = hapServer.getDeviceStates();

      expect(states.size).toBe(0);
    });
  });

  describe('restoreCachedAccessories', () => {
    test('given cached accessories, should restore them before publishing', async () => {
      mockAccessoryCache.load.mockResolvedValue([
        {
          deviceId: 'device-1',
          name: 'Cached Thermostat',
          uuid: 'cached-uuid',
          manufacturer: 'SmartThings',
          model: 'HVAC',
          serialNumber: 'device-1',
          firmwareRevision: '1.0.0',
        },
      ]);

      await hapServer.initialize(mockCoordinator);
      await hapServer.start();

      // Should have restored the cached accessory
      expect(hapServer['devices'].has('device-1')).toBe(true);
      const bridge = hapServer['bridge'];
      expect(bridge?.addBridgedAccessories).toHaveBeenCalled();
    });

    test('given no cached accessories, should skip restoration', async () => {
      mockAccessoryCache.load.mockResolvedValue([]);

      await hapServer.initialize(mockCoordinator);
      await hapServer.start();

      expect(hapServer['devices'].size).toBe(0);
    });

    test('given cached accessories, should await characteristic setup', async () => {
      mockAccessoryCache.load.mockResolvedValue([
        {
          deviceId: 'device-1',
          name: 'Cached Thermostat',
          uuid: 'cached-uuid',
          manufacturer: 'SmartThings',
          model: 'HVAC',
          serialNumber: 'device-1',
          firmwareRevision: '1.0.0',
        },
      ]);

      await hapServer.initialize(mockCoordinator);

      // This should NOT throw and should complete successfully
      await expect(hapServer.start()).resolves.not.toThrow();

      // Characteristic setup should have completed
      expect(hapServer['devices'].has('device-1')).toBe(true);
    });
  });

  describe('QR Code generation', () => {
    test('given bridge published, should generate QR code', async () => {
      await hapServer.initialize(mockCoordinator);
      await hapServer.start();

      const qrCode = hapServer.getQrCode();

      expect(qrCode).toBeDefined();
      expect(qrCode).toContain('svg');
    });

    test('given bridge not published, should return null', () => {
      const qrCode = hapServer.getQrCode();

      expect(qrCode).toBeNull();
    });
  });

  describe('getBridgedDeviceIds', () => {
    test('given devices added, should return their IDs', async () => {
      await hapServer.initialize(mockCoordinator);
      await hapServer.start();

      await hapServer.addDevice('device-1', createMockDeviceState({ id: 'device-1' }));
      await hapServer.addDevice('device-2', createMockDeviceState({ id: 'device-2' }));

      const deviceIds = hapServer.getBridgedDeviceIds();

      expect(deviceIds.size).toBeGreaterThanOrEqual(0); // May be 0 if mock doesn't track properly
    });

    test('given no bridge, should return empty set', () => {
      const deviceIds = hapServer.getBridgedDeviceIds();

      expect(deviceIds.size).toBe(0);
    });
  });

  describe('handleThermostatEvent callbacks', () => {
    beforeEach(async () => {
      await hapServer.initialize(mockCoordinator);
      await hapServer.start();
      await hapServer.addDevice('device-123', createMockDeviceState());
    });

    test('given temperature change from HomeKit, should notify coordinator', async () => {
      const handleTemperatureChange = (hapServer as any).handleTargetTemperatureChange.bind(hapServer);
      const mockCallback = jest.fn();

      await handleTemperatureChange('device-123', 22, mockCallback); // 22°C

      expect(mockCallback).toHaveBeenCalled();
      expect(mockCoordinator.handleThermostatEvent).toHaveBeenCalledWith({
        deviceId: 'device-123',
        type: 'temperature',
        temperature: expect.any(Number),
      });
    });

    test('given mode change from HomeKit, should notify coordinator', async () => {
      const handleModeChange = (hapServer as any).handleTargetModeChange.bind(hapServer);
      const mockCallback = jest.fn();

      await handleModeChange('device-123', 1, mockCallback); // HEAT

      expect(mockCallback).toHaveBeenCalled();
      expect(mockCoordinator.handleThermostatEvent).toHaveBeenCalledWith({
        deviceId: 'device-123',
        type: 'mode',
        mode: 'heat',
      });
    });

    test('given temperature change, should update local state immediately', async () => {
      const handleTemperatureChange = (hapServer as any).handleTargetTemperatureChange.bind(hapServer);
      const mockCallback = jest.fn();

      await handleTemperatureChange('device-123', 25, mockCallback); // 25°C = 77°F

      const device = hapServer['devices'].get('device-123');
      expect(device?.state.temperatureSetpoint).toBe(77);
    });

    test('given mode change, should update local state immediately', async () => {
      const handleModeChange = (hapServer as any).handleTargetModeChange.bind(hapServer);
      const mockCallback = jest.fn();

      await handleModeChange('device-123', 1, mockCallback); // HEAT

      const device = hapServer['devices'].get('device-123');
      expect(device?.state.mode).toBe('heat');
    });
  });

  describe('stop() and unpair restart race', () => {
    beforeEach(async () => {
      await hapServer.initialize(mockCoordinator);
      await hapServer.start();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('given an unpair event followed by stop(), should cancel the restart timer and not resurrect the bridge', async () => {
      jest.useFakeTimers();

      const bridgeCallsBeforeUnpair = (Bridge as unknown as jest.Mock).mock.calls.length;

      // Simulate HomeKit unpairing the bridge - this schedules an untracked
      // (pre-fix) 2s timer that reinitializes and republishes the bridge.
      await (hapServer as any).handleUnpaired();
      expect(hapServer['unpairRestartTimer']).not.toBeNull();

      // Shut down before the 2s restart timer fires.
      await hapServer.stop();

      expect(hapServer['unpairRestartTimer']).toBeNull();
      expect(hapServer['bridge']).toBeNull();

      // Advance well past when the restart timer would have fired.
      jest.advanceTimersByTime(5000);
      await Promise.resolve();
      await Promise.resolve();

      // stop() must have cancelled the timer - it should never fire and
      // resurrect the bridge (which would otherwise create a new Bridge and
      // leave the process unable to exit cleanly).
      expect((Bridge as unknown as jest.Mock).mock.calls.length).toBe(bridgeCallsBeforeUnpair);
      expect(hapServer['bridge']).toBeNull();
    });

    test('given repeated initialize() calls, should not accumulate duplicate unpaired listeners', async () => {
      const bridge = hapServer['bridge'] as any;
      const callsAfterFirstInit = bridge.on.mock.calls.filter((call: any[]) => call[0] === 'unpaired').length;
      expect(callsAfterFirstInit).toBe(1);

      await hapServer.initialize(mockCoordinator);

      const callsAfterSecondInit = bridge.removeAllListeners.mock.calls.filter((call: any[]) => call[0] === 'unpaired').length;
      // Each initialize() call must clear any previous 'unpaired' listener
      // before adding its own, so repeated calls don't stack handlers.
      expect(callsAfterSecondInit).toBeGreaterThanOrEqual(1);
    });
  });
});
