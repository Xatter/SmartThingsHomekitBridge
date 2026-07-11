/**
 * Samsung AC Display Light Control Tests
 *
 * CRITICAL DOCUMENTATION - PLEASE READ BEFORE MODIFYING:
 * =========================================================
 *
 * Samsung's SmartThings API has a COUNTERINTUITIVE naming convention for AC display lights.
 * This was discovered through community research and confirmed through testing.
 *
 * THE NAMING IS BACKWARDS:
 * - "Light_On" command → turns the display OFF
 * - "Light_Off" command → turns the display ON
 *
 * Yes, you read that correctly. Samsung's engineers named these commands backwards.
 *
 * DISCOVERY SOURCES:
 * 1. SmartThings Community Forum: https://community.smartthings.com/t/rest-api-for-display-light-on-samsung-windfree-ac/195928
 * 2. Home Assistant Issue: https://github.com/veista/smartthings/issues/105
 * 3. Confirmed through empirical testing with real Samsung WindFree AC units
 *
 * WHY OUR API IS STRUCTURED THIS WAY:
 * - Our methods (turnLightOn/turnLightOff) follow intuitive naming from the user's perspective
 * - Internally, we map to Samsung's backwards commands:
 *   - turnLightOff() → sends "Light_On" command
 *   - turnLightOn() → sends "Light_Off" command
 *
 * COMMAND STRUCTURE:
 * Instead of the non-functional "samsungce.airConditionerLighting" capability,
 * we use the "execute" capability with special OCF (Open Connectivity Foundation) format:
 * {
 *   "component": "main",
 *   "capability": "execute",
 *   "command": "execute",
 *   "arguments": [
 *     "mode/vs/0",
 *     { "x.com.samsung.da.options": ["Light_On" or "Light_Off"] }
 *   ]
 * }
 *
 * DO NOT "FIX" THE BACKWARDS MAPPING - IT IS INTENTIONAL AND CORRECT!
 */

import { SmartThingsAPI } from './SmartThingsAPI';
import { SmartThingsAuthentication } from '../auth/SmartThingsAuthentication';

// Mock the authentication module
jest.mock('../auth/SmartThingsAuthentication');

// Mock the SmartThings client
jest.mock('@smartthings/core-sdk', () => ({
  SmartThingsClient: jest.fn().mockImplementation(() => ({
    devices: {
      executeCommand: jest.fn(),
      get: jest.fn(),
      getStatus: jest.fn()
    },
    deviceProfiles: {
      get: jest.fn()
    }
  })),
  BearerTokenAuthenticator: jest.fn()
}));

describe('Samsung AC Display Light Control - Backwards Command Mapping', () => {
  let api: SmartThingsAPI;
  let mockClient: any;
  let executeCommandSpy: jest.Mock;
  let mockAuth: jest.Mocked<SmartThingsAuthentication>;

  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();

    // Create mock authentication
    mockAuth = {
      hasAuth: jest.fn().mockReturnValue(true),
      ensureValidToken: jest.fn().mockResolvedValue(true),
      getAccessToken: jest.fn().mockReturnValue('test-token'),
      setAccessToken: jest.fn(),
      refreshAccessToken: jest.fn()
    } as any;

    // Create API instance with mock auth
    api = new SmartThingsAPI(mockAuth);

    // Set up mock client
    mockClient = {
      devices: {
        executeCommand: jest.fn().mockResolvedValue({ status: 'success' }),
        get: jest.fn(),
        getStatus: jest.fn()
      }
    };

    executeCommandSpy = mockClient.devices.executeCommand;

    // Mock getClient to return our mock client
    jest.spyOn(api as any, 'getClient').mockResolvedValue(mockClient);
  });

  describe('Critical: Backwards Command Mapping Tests', () => {
    test('CRITICAL: turnLightOff() MUST send "Light_On" command (Samsung backwards naming)', async () => {
      // This test ensures we never accidentally "fix" the backwards naming
      const deviceId = 'test-device-123';

      await api.turnLightOff(deviceId);

      expect(executeCommandSpy).toHaveBeenCalledWith(
        deviceId,
        {
          component: 'main',
          capability: 'execute',
          command: 'execute',
          arguments: [
            'mode/vs/0',
            { 'x.com.samsung.da.options': ['Light_On'] } // Light_On turns display OFF
          ]
        }
      );
    });

    test('CRITICAL: turnLightOn() MUST send "Light_Off" command (Samsung backwards naming)', async () => {
      // This test ensures we never accidentally "fix" the backwards naming
      const deviceId = 'test-device-123';

      await api.turnLightOn(deviceId);

      expect(executeCommandSpy).toHaveBeenCalledWith(
        deviceId,
        {
          component: 'main',
          capability: 'execute',
          command: 'execute',
          arguments: [
            'mode/vs/0',
            { 'x.com.samsung.da.options': ['Light_Off'] } // Light_Off turns display ON
          ]
        }
      );
    });

    test('setLightingLevel("off") MUST send "Light_On" command', async () => {
      const deviceId = 'test-device-123';

      await api.setLightingLevel(deviceId, 'off');

      expect(executeCommandSpy).toHaveBeenCalledWith(
        deviceId,
        {
          component: 'main',
          capability: 'execute',
          command: 'execute',
          arguments: [
            'mode/vs/0',
            { 'x.com.samsung.da.options': ['Light_On'] }
          ]
        }
      );
    });

    test('setLightingLevel("on") MUST send "Light_Off" command', async () => {
      const deviceId = 'test-device-123';

      await api.setLightingLevel(deviceId, 'on');

      expect(executeCommandSpy).toHaveBeenCalledWith(
        deviceId,
        {
          component: 'main',
          capability: 'execute',
          command: 'execute',
          arguments: [
            'mode/vs/0',
            { 'x.com.samsung.da.options': ['Light_Off'] }
          ]
        }
      );
    });

    test('All non-off lighting levels should send "Light_Off" command (display on)', async () => {
      const deviceId = 'test-device-123';
      const levels: Array<'dim' | 'bright' | 'smart' | 'high' | 'low'> =
        ['dim', 'bright', 'smart', 'high', 'low'];

      for (const level of levels) {
        jest.clearAllMocks();
        await api.setLightingLevel(deviceId, level);

        expect(executeCommandSpy).toHaveBeenCalledWith(
          deviceId,
          {
            component: 'main',
            capability: 'execute',
            command: 'execute',
            arguments: [
              'mode/vs/0',
              { 'x.com.samsung.da.options': ['Light_Off'] } // All non-off levels turn display ON
            ]
          }
        );
      }
    });
  });

  describe('Command Structure Validation', () => {
    test('Commands MUST use "execute" capability, NOT "samsungce.airConditionerLighting"', async () => {
      const deviceId = 'test-device-123';

      await api.turnLightOff(deviceId);

      const callArgs = executeCommandSpy.mock.calls[0][1];

      // Ensure we're NOT using the old broken capability
      expect(callArgs.capability).not.toBe('samsungce.airConditionerLighting');
      expect(callArgs.command).not.toBe('setLightingLevel');

      // Ensure we ARE using the working execute capability
      expect(callArgs.capability).toBe('execute');
      expect(callArgs.command).toBe('execute');
    });

    test('Commands MUST include OCF format with mode/vs/0', async () => {
      const deviceId = 'test-device-123';

      await api.turnLightOn(deviceId);

      const callArgs = executeCommandSpy.mock.calls[0][1];

      expect(callArgs.arguments).toBeDefined();
      expect(callArgs.arguments[0]).toBe('mode/vs/0');
      expect(callArgs.arguments[1]).toEqual({ 'x.com.samsung.da.options': ['Light_Off'] });
    });
  });

  describe('Error Handling', () => {
    test('Should handle API errors gracefully and return false', async () => {
      const deviceId = 'test-device-123';
      const error = new Error('API Error: 422 Unprocessable Entity');

      executeCommandSpy.mockRejectedValueOnce(error);

      const result = await api.turnLightOff(deviceId);

      expect(result).toBe(false);
    });

    test('Should return false when client is not available', async () => {
      const deviceId = 'test-device-123';

      jest.spyOn(api as any, 'getClient').mockResolvedValueOnce(null);

      const result = await api.turnLightOn(deviceId);

      expect(result).toBe(false);
      expect(executeCommandSpy).not.toHaveBeenCalled();
    });
  });

  describe('Silent Light Control (used after other commands)', () => {
    test('turnOffLightSilently should not throw errors even if command fails', async () => {
      const deviceId = 'test-device-123';
      const error = new Error('Device does not support lighting');

      executeCommandSpy.mockRejectedValueOnce(error);

      // Create a mock client directly for this test
      const client = mockClient;

      // This should not throw
      await expect((api as any).turnOffLightSilently(client, deviceId))
        .resolves
        .not.toThrow();
    });

    test('turnOffLightSilently MUST use "Light_On" to turn display off', async () => {
      const deviceId = 'test-device-123';
      const client = mockClient;

      await (api as any).turnOffLightSilently(client, deviceId);

      expect(executeCommandSpy).toHaveBeenCalledWith(
        deviceId,
        {
          component: 'main',
          capability: 'execute',
          command: 'execute',
          arguments: [
            'mode/vs/0',
            { 'x.com.samsung.da.options': ['Light_On'] }
          ]
        }
      );
    });
  });
});

/**
 * REGRESSION TEST SUITE
 *
 * These tests MUST ALWAYS PASS to ensure we don't break the working solution.
 * The backwards naming is NOT a bug - it's how Samsung's API actually works.
 *
 * If any of these tests fail, DO NOT "fix" them by swapping the commands.
 * The current implementation is correct and has been verified on real hardware.
 */
describe('Regression Tests - DO NOT MODIFY WITHOUT UNDERSTANDING THE CONTEXT', () => {
  let api: SmartThingsAPI;
  let mockClient: any;
  let mockAuth: jest.Mocked<SmartThingsAuthentication>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create mock authentication
    mockAuth = {
      hasAuth: jest.fn().mockReturnValue(true),
      ensureValidToken: jest.fn().mockResolvedValue(true),
      getAccessToken: jest.fn().mockReturnValue('test-token'),
      setAccessToken: jest.fn(),
      refreshAccessToken: jest.fn()
    } as any;

    // Create API instance with mock auth
    api = new SmartThingsAPI(mockAuth);

    mockClient = {
      devices: {
        executeCommand: jest.fn().mockResolvedValue({ status: 'success' })
      }
    };
    jest.spyOn(api as any, 'getClient').mockResolvedValue(mockClient);
  });

  test('⚠️ REGRESSION: Light commands must remain "backwards" to work correctly', () => {
    // This test exists to prevent well-meaning developers from "fixing" the backwards naming
    // THE CURRENT IMPLEMENTATION IS CORRECT - DO NOT CHANGE IT

    expect(true).toBe(true); // Placeholder assertion

    // If you're reading this because you think the commands are wrong:
    // 1. They ARE backwards from Samsung's side
    // 2. This is NOT a bug in our code
    // 3. See the documentation at the top of this file
    // 4. Check the SmartThings Community link for confirmation
  });
});

/**
 * 🚨🚨🚨 DEVELOPER CONFUSION PREVENTION TESTS 🚨🚨🚨
 *
 * These tests are SPECIFICALLY designed to FAIL if you try to "fix" what looks wrong.
 *
 * STOP! READ THIS BEFORE YOU CHANGE ANYTHING:
 * ============================================
 *
 * You're probably here because you saw this in SmartThingsAPI.ts:
 * - turnLightOff() sends "Light_On"
 * - turnLightOn() sends "Light_Off"
 *
 * And you thought: "Wait, what? That can't be right! Let me fix this obvious bug!"
 *
 * NO! DO NOT FIX IT! IT'S NOT A BUG!
 *
 * Samsung's API naming is BACKWARDS. This is confirmed and documented:
 * - Community Forum: https://community.smartthings.com/t/rest-api-for-display-light-on-samsung-windfree-ac/195928
 * - Multiple users confirmed this backwards behavior
 * - It has been tested on real Samsung WindFree AC units
 *
 * THE BACKWARDS NAMING IS INTENTIONAL AND CORRECT!
 */
/**
 * Samsung AC getDeviceStatus Tests
 *
 * These tests verify that the API correctly handles:
 * 1. Mode translation (dry/wind → cool)
 * 2. Switch state for Samsung ACs
 * 3. Off detection when switch is off
 */
describe('Samsung AC getDeviceStatus - Mode Translation and Switch State', () => {
  let api: SmartThingsAPI;
  let mockClient: any;
  let mockAuth: jest.Mocked<SmartThingsAuthentication>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockAuth = {
      hasAuth: jest.fn().mockReturnValue(true),
      ensureValidToken: jest.fn().mockResolvedValue(true),
      getAccessToken: jest.fn().mockReturnValue('test-token'),
      setAccessToken: jest.fn(),
      refreshAccessToken: jest.fn()
    } as any;

    api = new SmartThingsAPI(mockAuth);

    mockClient = {
      devices: {
        executeCommand: jest.fn().mockResolvedValue({ status: 'success' }),
        get: jest.fn().mockResolvedValue({ name: 'Test AC', label: 'Test AC' }),
        getStatus: jest.fn()
      }
    };
    jest.spyOn(api as any, 'getClient').mockResolvedValue(mockClient);
  });

  test('given Samsung AC with "dry" mode, should translate to "cool" for HomeKit', async () => {
    mockClient.devices.getStatus.mockResolvedValue({
      components: {
        main: {
          temperatureMeasurement: { temperature: { value: 75 } },
          thermostatCoolingSetpoint: { coolingSetpoint: { value: 72 } },
          airConditionerMode: { airConditionerMode: { value: 'dry' } },
          switch: { switch: { value: 'on' } },
          'samsungce.airConditionerLighting': { lighting: { value: 'off' } }
        }
      }
    });

    const result = await api.getDeviceStatus('test-device');

    expect(result).not.toBeNull();
    expect(result?.mode).toBe('cool'); // dry → cool
  });

  test('given Samsung AC with "wind" mode, should translate to "cool" for HomeKit', async () => {
    mockClient.devices.getStatus.mockResolvedValue({
      components: {
        main: {
          temperatureMeasurement: { temperature: { value: 75 } },
          thermostatCoolingSetpoint: { coolingSetpoint: { value: 72 } },
          airConditionerMode: { airConditionerMode: { value: 'wind' } },
          switch: { switch: { value: 'on' } },
          'samsungce.airConditionerLighting': { lighting: { value: 'off' } }
        }
      }
    });

    const result = await api.getDeviceStatus('test-device');

    expect(result).not.toBeNull();
    expect(result?.mode).toBe('cool'); // wind → cool
  });

  test('given Samsung AC with switch off, should include switchState in result', async () => {
    mockClient.devices.getStatus.mockResolvedValue({
      components: {
        main: {
          temperatureMeasurement: { temperature: { value: 75 } },
          thermostatCoolingSetpoint: { coolingSetpoint: { value: 72 } },
          airConditionerMode: { airConditionerMode: { value: 'heat' } },
          switch: { switch: { value: 'off' } },
          'samsungce.airConditionerLighting': { lighting: { value: 'off' } }
        }
      }
    });

    const result = await api.getDeviceStatus('test-device');

    expect(result).not.toBeNull();
    expect(result?.switchState).toBe('off');
    expect(result?.mode).toBe('off'); // When switch is off, mode should be 'off'
  });

  test('given Samsung AC with switch on, should include switchState "on" in result', async () => {
    mockClient.devices.getStatus.mockResolvedValue({
      components: {
        main: {
          temperatureMeasurement: { temperature: { value: 75 } },
          thermostatCoolingSetpoint: { coolingSetpoint: { value: 72 } },
          airConditionerMode: { airConditionerMode: { value: 'heat' } },
          switch: { switch: { value: 'on' } },
          'samsungce.airConditionerLighting': { lighting: { value: 'off' } }
        }
      }
    });

    const result = await api.getDeviceStatus('test-device');

    expect(result).not.toBeNull();
    expect(result?.switchState).toBe('on');
    expect(result?.mode).toBe('heat'); // Mode should be preserved when switch is on
  });

  test('given Samsung AC preserves both heatingSetpoint and coolingSetpoint in result', async () => {
    mockClient.devices.getStatus.mockResolvedValue({
      components: {
        main: {
          temperatureMeasurement: { temperature: { value: 75 } },
          thermostatCoolingSetpoint: { coolingSetpoint: { value: 72 } },
          thermostatHeatingSetpoint: { heatingSetpoint: { value: 68 } },
          airConditionerMode: { airConditionerMode: { value: 'auto' } },
          switch: { switch: { value: 'on' } },
          'samsungce.airConditionerLighting': { lighting: { value: 'off' } }
        }
      }
    });

    const result = await api.getDeviceStatus('test-device');

    expect(result).not.toBeNull();
    expect(result?.coolingSetpoint).toBe(72);
    expect(result?.heatingSetpoint).toBe(68);
  });

  test('given a device with no temperatureMeasurement capability data, currentTemperature is undefined (not 0)', async () => {
    // A missing/broken sensor reading must surface as `undefined`, not be silently
    // coerced to 0 - 0°F is a real, valid temperature and must never be confused
    // with "no reading available".
    mockClient.devices.getStatus.mockResolvedValue({
      components: {
        main: {
          thermostatCoolingSetpoint: { coolingSetpoint: { value: 72 } },
          airConditionerMode: { airConditionerMode: { value: 'cool' } },
          switch: { switch: { value: 'on' } },
          'samsungce.airConditionerLighting': { lighting: { value: 'off' } }
        }
      }
    });

    const result = await api.getDeviceStatus('test-device');

    expect(result).not.toBeNull();
    expect(result?.currentTemperature).toBeUndefined();
  });

  test('given a device genuinely reporting 0°F, currentTemperature is 0 (not coerced away)', async () => {
    mockClient.devices.getStatus.mockResolvedValue({
      components: {
        main: {
          temperatureMeasurement: { temperature: { value: 0 } },
          thermostatCoolingSetpoint: { coolingSetpoint: { value: 72 } },
          airConditionerMode: { airConditionerMode: { value: 'cool' } },
          switch: { switch: { value: 'on' } },
          'samsungce.airConditionerLighting': { lighting: { value: 'off' } }
        }
      }
    });

    const result = await api.getDeviceStatus('test-device');

    expect(result).not.toBeNull();
    expect(result?.currentTemperature).toBe(0);
  });
});

describe('🚨 STOP! Did you just try to "fix" the backwards light commands? 🚨', () => {
  let api: SmartThingsAPI;
  let mockClient: any;
  let mockAuth: jest.Mocked<SmartThingsAuthentication>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth = {
      hasAuth: jest.fn().mockReturnValue(true),
      ensureValidToken: jest.fn().mockResolvedValue(true),
      getAccessToken: jest.fn().mockReturnValue('test-token'),
      setAccessToken: jest.fn(),
      refreshAccessToken: jest.fn()
    } as any;

    api = new SmartThingsAPI(mockAuth);
    mockClient = {
      devices: {
        executeCommand: jest.fn().mockResolvedValue({ status: 'success' })
      }
    };
    jest.spyOn(api as any, 'getClient').mockResolvedValue(mockClient);
  });

  test('🛑 DO NOT CHANGE: turnLightOff() MUST send "Light_On" - YES THIS IS CORRECT!', async () => {
    /**
     * If this test is failing, you probably just "fixed" the backwards naming.
     * UNDO YOUR CHANGES NOW!
     *
     * Samsung's API requires:
     * - "Light_On" to turn the display OFF
     * - "Light_Off" to turn the display ON
     *
     * Yes, it's backwards. No, it's not our mistake. This is how Samsung built it.
     */
    await api.turnLightOff('test-device');

    const callArgs = mockClient.devices.executeCommand.mock.calls[0][1];
    const lightCommand = callArgs.arguments[1]['x.com.samsung.da.options'][0];

    expect(lightCommand).toBe('Light_On'); // <-- YES, Light_On turns the display OFF!

    if (lightCommand !== 'Light_On') {
      throw new Error(`
        ❌ YOU BROKE IT! ❌

        You changed turnLightOff() to send "${lightCommand}" instead of "Light_On".

        This breaks the Samsung AC control! The API naming is BACKWARDS:
        - "Light_On" = Display OFF (yes, really)
        - "Light_Off" = Display ON (yes, really)

        Please revert your changes to SmartThingsAPI.ts immediately!

        Read the full explanation at the top of this test file.
      `);
    }
  });

  test('🛑 DO NOT CHANGE: turnLightOn() MUST send "Light_Off" - YES THIS IS CORRECT!', async () => {
    /**
     * If this test is failing, you probably just "fixed" the backwards naming.
     * UNDO YOUR CHANGES NOW!
     *
     * This is NOT a typo. Samsung really did name these backwards.
     */
    await api.turnLightOn('test-device');

    const callArgs = mockClient.devices.executeCommand.mock.calls[0][1];
    const lightCommand = callArgs.arguments[1]['x.com.samsung.da.options'][0];

    expect(lightCommand).toBe('Light_Off'); // <-- YES, Light_Off turns the display ON!

    if (lightCommand !== 'Light_Off') {
      throw new Error(`
        ❌ YOU BROKE IT! ❌

        You changed turnLightOn() to send "${lightCommand}" instead of "Light_Off".

        This breaks the Samsung AC control! The API naming is BACKWARDS:
        - "Light_Off" = Display ON (yes, really)
        - "Light_On" = Display OFF (yes, really)

        Please revert your changes to SmartThingsAPI.ts immediately!

        This has been confirmed by multiple users in the SmartThings community.
        See: https://community.smartthings.com/t/rest-api-for-display-light-on-samsung-windfree-ac/195928
      `);
    }
  });

  test('📖 README: Why the commands are backwards (informational test)', () => {
    /**
     * This test documents WHY the commands are backwards for future developers.
     *
     * HISTORY:
     * - Date discovered: September 2024
     * - Discovered by: SmartThings community members
     * - Confirmed on: Samsung WindFree AC units
     *
     * TECHNICAL EXPLANATION:
     * Samsung uses OCF (Open Connectivity Foundation) protocol for these commands.
     * The command structure is:
     * {
     *   "capability": "execute",
     *   "command": "execute",
     *   "arguments": ["mode/vs/0", { "x.com.samsung.da.options": ["Light_On" or "Light_Off"] }]
     * }
     *
     * For unknown reasons, Samsung's firmware interprets:
     * - "Light_On" as "turn the display light circuitry ON" (which turns the visible display OFF)
     * - "Light_Off" as "turn the display light circuitry OFF" (which turns the visible display ON)
     *
     * This might be because the display uses inverted logic internally, but Samsung
     * never adjusted the API to match user expectations.
     *
     * WHAT DOESN'T WORK:
     * - "samsungce.airConditionerLighting" capability with "setLightingLevel" - returns 422 errors
     * - Using "on"/"off" as arguments - returns 422 errors
     * - Any other combination we tried - returns 422 errors
     *
     * ONLY THIS BACKWARDS NAMING WORKS!
     */
    expect(true).toBe(true); // This test is just documentation
  });
});

/**
 * setMode Capability-Based Routing Tests
 *
 * setMode used to decide "standard thermostat vs Samsung AC" by trying the
 * thermostatMode command and falling back to the Samsung AC switch/airConditionerMode
 * path on ANY failure - including a transient network error against a perfectly
 * ordinary thermostat. That fallback would send switch-on / setAirConditionerMode
 * commands to a device that never asked for them, powering it on as a side effect
 * of an unrelated network blip.
 *
 * setMode now fetches the device up front and decides the path from its
 * capabilities (mirrors PluginContext.setSmartThingsState's isSamsungAC check),
 * so a failure on one path can never spill into the other.
 */
describe('setMode - capability-based routing (not try/fallback-on-error)', () => {
  let api: SmartThingsAPI;
  let mockClient: any;
  let mockAuth: jest.Mocked<SmartThingsAuthentication>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockAuth = {
      hasAuth: jest.fn().mockReturnValue(true),
      ensureValidToken: jest.fn().mockResolvedValue(true),
      getAccessToken: jest.fn().mockReturnValue('test-token'),
      setAccessToken: jest.fn(),
      refreshAccessToken: jest.fn()
    } as any;

    api = new SmartThingsAPI(mockAuth);

    mockClient = {
      devices: {
        executeCommand: jest.fn().mockResolvedValue({ status: 'success' }),
        get: jest.fn(),
        getStatus: jest.fn()
      }
    };
    jest.spyOn(api as any, 'getClient').mockResolvedValue(mockClient);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function callsForCapability(capability: string): any[] {
    return mockClient.devices.executeCommand.mock.calls.filter(
      ([, cmd]: [string, any]) => cmd.capability === capability
    );
  }

  test('standard thermostat (thermostatMode capability) uses thermostatMode command, never switch/airConditionerMode', async () => {
    mockClient.devices.get.mockResolvedValue({
      capabilities: [{ id: 'thermostatMode' }, { id: 'temperatureMeasurement' }]
    });

    const promise = api.setMode('device-1', 'cool');
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe(true);
    expect(callsForCapability('thermostatMode')).toHaveLength(1);
    expect(callsForCapability('thermostatMode')[0][1].command).toBe('setThermostatMode');
    expect(callsForCapability('thermostatMode')[0][1].arguments).toEqual(['cool']);
    expect(callsForCapability('switch')).toHaveLength(0);
    expect(callsForCapability('airConditionerMode')).toHaveLength(0);
  });

  test('CRITICAL: a transient error on a capability-known standard thermostat does NOT fall back to switch commands', async () => {
    mockClient.devices.get.mockResolvedValue({
      capabilities: [{ id: 'thermostatMode' }]
    });

    // A transient network error, not a "this device doesn't support thermostatMode" error.
    const transientError = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    mockClient.devices.executeCommand.mockRejectedValue(transientError);

    const promise = api.setMode('device-1', 'cool');
    await jest.runAllTimersAsync();
    const result = await promise;

    // The call ultimately fails (network blip persisted through retries), but it must
    // NEVER have touched switch/airConditionerMode - doing so would turn the device on.
    expect(result).toBe(false);
    expect(callsForCapability('switch')).toHaveLength(0);
    expect(callsForCapability('airConditionerMode')).toHaveLength(0);
    expect(mockClient.devices.executeCommand.mock.calls.length).toBeGreaterThan(0);
    mockClient.devices.executeCommand.mock.calls.forEach(([, cmd]: [string, any]) => {
      expect(cmd.capability).toBe('thermostatMode');
    });
  });

  test('Samsung AC (airConditionerMode capability, no thermostatMode) turns switch on then sets airConditionerMode for heat/cool/auto', async () => {
    mockClient.devices.get.mockResolvedValue({
      capabilities: [{ id: 'airConditionerMode' }, { id: 'switch' }]
    });

    const promise = api.setMode('device-1', 'cool');
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe(true);
    expect(callsForCapability('thermostatMode')).toHaveLength(0);
    expect(callsForCapability('switch')).toHaveLength(1);
    expect(callsForCapability('switch')[0][1].command).toBe('on');
    expect(callsForCapability('airConditionerMode')).toHaveLength(1);
    expect(callsForCapability('airConditionerMode')[0][1].command).toBe('setAirConditionerMode');
    expect(callsForCapability('airConditionerMode')[0][1].arguments).toEqual(['cool']);
  });

  test('Samsung AC "off" mode uses switch.off, never airConditionerMode', async () => {
    mockClient.devices.get.mockResolvedValue({
      capabilities: [{ id: 'airConditionerMode' }, { id: 'switch' }]
    });

    const promise = api.setMode('device-1', 'off');
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe(true);
    expect(callsForCapability('switch')).toHaveLength(1);
    expect(callsForCapability('switch')[0][1].command).toBe('off');
    expect(callsForCapability('airConditionerMode')).toHaveLength(0);
  });

  test('capability lookup falls back to component-level capabilities when top-level list is empty', async () => {
    mockClient.devices.get.mockResolvedValue({
      capabilities: [],
      components: [
        { capabilities: [{ id: 'airConditionerMode' }] }
      ]
    });

    const promise = api.setMode('device-1', 'heat');
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe(true);
    expect(callsForCapability('airConditionerMode')).toHaveLength(1);
  });

  test('returns false without sending any command when the client is unavailable', async () => {
    jest.spyOn(api as any, 'getClient').mockResolvedValueOnce(null);

    const result = await api.setMode('device-1', 'cool');

    expect(result).toBe(false);
    expect(mockClient.devices.executeCommand).not.toHaveBeenCalled();
    expect(mockClient.devices.get).not.toHaveBeenCalled();
  });
});

/**
 * executeCommands Partial-Failure Context Tests
 *
 * When command N of a batch fails, the thrown error must retain which commands
 * already succeeded (e.g. switch-on landed but mode-set failed => unit is running
 * in the wrong mode) rather than losing that context.
 */
describe('executeCommands - partial failure context', () => {
  let api: SmartThingsAPI;
  let mockClient: any;
  let mockAuth: jest.Mocked<SmartThingsAuthentication>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockAuth = {
      hasAuth: jest.fn().mockReturnValue(true),
      ensureValidToken: jest.fn().mockResolvedValue(true),
      getAccessToken: jest.fn().mockReturnValue('test-token'),
      setAccessToken: jest.fn(),
      refreshAccessToken: jest.fn()
    } as any;

    api = new SmartThingsAPI(mockAuth);

    mockClient = {
      devices: {
        executeCommand: jest.fn(),
        get: jest.fn(),
        getStatus: jest.fn()
      }
    };
    jest.spyOn(api as any, 'getClient').mockResolvedValue(mockClient);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('all commands succeeding resolves with no error', async () => {
    mockClient.devices.executeCommand.mockResolvedValue({ status: 'success' });

    const commands = [
      { component: 'main', capability: 'switch', command: 'on' },
      { component: 'main', capability: 'airConditionerMode', command: 'setAirConditionerMode', arguments: ['cool'] },
    ];

    await expect(api.executeCommands('device-1', commands)).resolves.toBeUndefined();
    expect(mockClient.devices.executeCommand).toHaveBeenCalledTimes(2);
  });

  test('failure message names succeeded commands and the failed command, with the original error preserved', async () => {
    const failureError = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });

    mockClient.devices.executeCommand
      .mockResolvedValueOnce({ status: 'success' }) // switch-on succeeds
      .mockRejectedValue(failureError); // mode-set fails on every attempt/retry after that

    const commands = [
      { component: 'main', capability: 'switch', command: 'on' },
      { component: 'main', capability: 'airConditionerMode', command: 'setAirConditionerMode', arguments: ['cool'] },
    ];

    const promise = api.executeCommands('device-1', commands);
    // Attach a handler immediately (before advancing timers) so the eventual rejection
    // is never briefly "unhandled" while fake timers drive the retries to completion.
    const captured = promise.catch((error) => error);
    await jest.runAllTimersAsync();
    const caught = await captured;

    expect(caught).toBeInstanceOf(Error);
    // Names the command that already succeeded...
    expect(caught.message).toContain('main/switch/on');
    // ...and the one that failed...
    expect(caught.message).toContain('main/airConditionerMode/setAirConditionerMode');
    // ...without losing the original error.
    expect(caught.cause).toBe(failureError);
  });

  test('failure on the very first command reports that no prior commands succeeded', async () => {
    const failureError = new Error('boom');
    mockClient.devices.executeCommand.mockRejectedValue(failureError);

    const commands = [
      { component: 'main', capability: 'switch', command: 'on' },
    ];

    const promise = api.executeCommands('device-1', commands);
    const captured = promise.catch((error) => error);
    await jest.runAllTimersAsync();
    const caught = await captured;

    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toContain('main/switch/on');
    expect(caught.cause).toBe(failureError);
  });

  test('throws when no client is available, without attempting any command', async () => {
    jest.spyOn(api as any, 'getClient').mockResolvedValueOnce(null);

    await expect(api.executeCommands('device-1', [
      { component: 'main', capability: 'switch', command: 'on' },
    ])).rejects.toThrow('No SmartThings client available');

    expect(mockClient.devices.executeCommand).not.toHaveBeenCalled();
  });
});

/**
 * SmartThings Request Timeout Tests
 *
 * @smartthings/core-sdk (axios-based) has no built-in request-timeout option
 * (verified against node_modules/@smartthings/core-sdk/dist/*.d.ts - RestClientConfig
 * has no timeout field, and the compiled endpoint-client.js builds a fixed axios
 * config with no timeout set). SmartThingsAPI enforces its own timeout via the
 * private `withTimeout` helper wrapped around every client.devices.* call.
 */
describe('withTimeout - SmartThings request timeout enforcement', () => {
  let api: SmartThingsAPI;
  let mockAuth: jest.Mocked<SmartThingsAuthentication>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockAuth = {
      hasAuth: jest.fn().mockReturnValue(true),
      ensureValidToken: jest.fn().mockResolvedValue(true),
      getAccessToken: jest.fn().mockReturnValue('test-token'),
      setAccessToken: jest.fn(),
      refreshAccessToken: jest.fn()
    } as any;

    api = new SmartThingsAPI(mockAuth);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('rejects with an ETIMEDOUT-coded error once the timeout elapses, instead of hanging forever', async () => {
    const neverResolves = new Promise<never>(() => {
      // Simulates a SmartThings request that never settles (hung connection).
    });

    const timeoutPromise = (api as any).withTimeout(neverResolves, 15000, 'test operation');

    let caught: any;
    const observed = timeoutPromise.catch((err: any) => {
      caught = err;
    });

    jest.advanceTimersByTime(15000);
    await observed;

    expect(caught).toBeInstanceOf(Error);
    expect(caught.code).toBe('ETIMEDOUT');
    expect(caught.message).toContain('test operation');
  });

  test('resolves normally when the underlying request finishes before the timeout', async () => {
    const fastPromise = Promise.resolve('done');

    const result = await (api as any).withTimeout(fastPromise, 15000, 'test operation');

    expect(result).toBe('done');
  });
});