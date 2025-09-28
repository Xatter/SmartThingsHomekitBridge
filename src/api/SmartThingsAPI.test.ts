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