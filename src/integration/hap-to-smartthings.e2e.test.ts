/**
 * HAP to SmartThings End-to-End Integration Test
 *
 * Tests the full command flow from HomeKit (HAP) through to SmartThings,
 * using the SmartThings API to verify changes actually propagated.
 *
 * Flow tested:
 * HAP Characteristic Set → HAPServer → Coordinator → SmartThingsAPI → SmartThings Cloud
 * Then verify via: SmartThingsAPI.getDeviceStatus()
 *
 * REQUIREMENTS:
 * - Valid SmartThings credentials in data/smartthings_token.json
 * - Network access to SmartThings API
 * - A real Samsung Room AC device to test against
 *
 * RUN WITH:
 *   npx jest src/integration/hap-to-smartthings.e2e.test.ts --testTimeout=60000
 */

import { SmartThingsAuthentication } from '@/auth/SmartThingsAuthentication';
import { SmartThingsAPI } from '@/api/SmartThingsAPI';
import { Coordinator } from '@/coordinator/Coordinator';
import { SmartThingsHAPServer } from '@/hap/HAPServer';
import { PluginManager } from '@/plugins';
import { DeviceInclusionManager } from '@/config/DeviceInclusionManager';
import { DeviceState } from '@/types';

// Test configuration - use a real Samsung AC device
const TEST_DEVICE_ID = process.env.TEST_DEVICE_ID || '4ce5dd8c-0401-b4a2-abe3-54f1b79de771';
const TOKEN_PATH = process.env.TOKEN_PATH || './data/smartthings_token.json';

/**
 * Wait for a condition to be true with polling.
 */
async function waitFor(
  condition: () => Promise<boolean> | boolean,
  timeoutMs: number = 15000,
  intervalMs: number = 2000
): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return false;
}

describe('HAP → SmartThings E2E Tests (API Verification)', () => {
  let auth: SmartThingsAuthentication;
  let api: SmartThingsAPI;
  let coordinator: Coordinator;
  let hapServer: SmartThingsHAPServer;
  let pluginManager: PluginManager;
  let inclusionManager: DeviceInclusionManager;

  let originalStatus: DeviceState | null;
  let hasCredentials = false;

  beforeAll(async () => {
    // Skip if no credentials available
    try {
      auth = new SmartThingsAuthentication(TOKEN_PATH);
      await auth.load();

      if (!auth.hasAuth()) {
        console.warn('⚠️  No SmartThings credentials found, skipping integration tests');
        return;
      }
      hasCredentials = true;
    } catch (error) {
      console.warn('⚠️  Failed to load SmartThings credentials, skipping integration tests');
      return;
    }

    // Initialize API
    api = new SmartThingsAPI(auth);

    // Capture original device status for restoration using SmartThings API
    originalStatus = await api.getDeviceStatus(TEST_DEVICE_ID);
    console.log('Original device status (via API):', originalStatus);

    if (!originalStatus) {
      console.error('❌ Could not get device status - device may not exist or be unreachable');
      hasCredentials = false;
      return;
    }

    // Initialize HAP server (use different port for testing)
    hapServer = new SmartThingsHAPServer(51998, '222-22-222');

    // Create minimal mocks for plugin manager
    const mockLogger: any = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    };
    // PluginManager calls logger.child() - make it return itself
    mockLogger.child = jest.fn().mockReturnValue(mockLogger);

    const mockConfig = {
      plugins: { enabled: [] },
      smartthings: {},
      bridge: {},
      web: {},
      polling: {},
    } as any;

    pluginManager = new PluginManager(
      mockLogger,
      mockConfig,
      api,
      hapServer,
      () => coordinator?.getDevices() || [],
      (deviceId: string) => coordinator?.getDevice(deviceId),
      './persist',
      './data'
    );

    inclusionManager = new DeviceInclusionManager('./data', mockLogger);
    await inclusionManager.load();

    // Create coordinator with real API
    coordinator = new Coordinator(
      api,
      hapServer,
      pluginManager,
      inclusionManager,
      './data/test_hap_e2e_state.json',
      300
    );

    // Initialize HAP server with coordinator
    await hapServer.initialize(coordinator);
  }, 30000);

  afterAll(async () => {
    // Restore original device state if we changed it
    if (originalStatus && hasCredentials) {
      console.log('Restoring original device status...');
      try {
        // Restore mode first
        if (originalStatus.mode === 'off' || originalStatus.switchState === 'off') {
          await api.setMode(TEST_DEVICE_ID, 'off');
        } else {
          await api.setMode(TEST_DEVICE_ID, originalStatus.mode);
          // Restore temperature setpoint
          const targetMode = originalStatus.mode === 'heat' ? 'heat' : 'cool';
          await api.setTemperature(TEST_DEVICE_ID, originalStatus.temperatureSetpoint, targetMode);
        }
        console.log('✅ Device state restored');
      } catch (error) {
        console.error('Failed to restore device status:', error);
      }
    }

    // Cleanup
    coordinator?.stop();
    await hapServer?.stop();
  });

  /**
   * Helper to set up device state in coordinator for a test.
   * This simulates the device being known to the bridge.
   */
  function setupDeviceInCoordinator(currentState: DeviceState): void {
    // Access private state to set up the device
    (coordinator as any).state.deviceStates.set(TEST_DEVICE_ID, { ...currentState });

    // Set up device metadata with Samsung AC capabilities
    (coordinator as any).deviceMetadata.set(TEST_DEVICE_ID, {
      deviceId: TEST_DEVICE_ID,
      name: currentState.name,
      label: currentState.name,
      thermostatCapabilities: {
        airConditionerMode: true,
        thermostatMode: false,
        thermostatCoolingSetpoint: true,
        thermostatHeatingSetpoint: false,
        temperatureMeasurement: true,
        switch: true,
      },
      isPaired: true,
    });
  }

  describe('Temperature Change Flow', () => {
    test('Setting temperature via HAP should update SmartThings (verified via API)', async () => {
      if (!hasCredentials) {
        console.warn('⚠️  Skipping - no credentials');
        return;
      }

      // ARRANGE: Get current status via SmartThings API
      const beforeStatus = await api.getDeviceStatus(TEST_DEVICE_ID);
      console.log('Before status (via API):', beforeStatus);
      expect(beforeStatus).not.toBeNull();

      // Ensure device is on first
      if (beforeStatus!.switchState === 'off') {
        console.log('Turning device on...');
        await api.setMode(TEST_DEVICE_ID, 'cool');
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      // Refresh status after turning on
      const currentStatus = await api.getDeviceStatus(TEST_DEVICE_ID);
      console.log('Current status after ensuring on:', currentStatus);

      // Set up coordinator with current device state
      setupDeviceInCoordinator({
        id: TEST_DEVICE_ID,
        name: 'Test AC',
        currentTemperature: currentStatus!.currentTemperature,
        temperatureSetpoint: currentStatus!.temperatureSetpoint,
        mode: currentStatus!.mode,
        lightOn: false,
        lastUpdated: new Date(),
        switchState: 'on',
        coolingSetpoint: currentStatus!.coolingSetpoint,
      });

      // Choose a target temperature different from current (±2°F)
      const currentSetpoint = currentStatus!.temperatureSetpoint || currentStatus!.coolingSetpoint || 72;
      const targetTemp = currentSetpoint >= 74 ? currentSetpoint - 2 : currentSetpoint + 2;
      console.log(`Changing temperature from ${currentSetpoint}°F to ${targetTemp}°F`);

      // ACT: Send temperature change via coordinator (simulating HomeKit HAP characteristic set)
      await coordinator.handleThermostatEvent({
        deviceId: TEST_DEVICE_ID,
        type: 'temperature',
        temperature: targetTemp,
      });

      // ASSERT: Wait for SmartThings to update and verify via API
      console.log('Waiting for SmartThings to update...');
      const tempUpdated = await waitFor(
        async () => {
          const status = await api.getDeviceStatus(TEST_DEVICE_ID);
          console.log('Polling status (via API):', {
            coolingSetpoint: status?.coolingSetpoint,
            temperatureSetpoint: status?.temperatureSetpoint,
            targetTemp,
          });
          // Check either coolingSetpoint or temperatureSetpoint
          return status?.coolingSetpoint === targetTemp || status?.temperatureSetpoint === targetTemp;
        },
        20000,
        2500
      );

      const afterStatus = await api.getDeviceStatus(TEST_DEVICE_ID);
      console.log('After status (via API):', afterStatus);

      expect(tempUpdated).toBe(true);
      expect(
        afterStatus?.coolingSetpoint === targetTemp || afterStatus?.temperatureSetpoint === targetTemp
      ).toBe(true);
    }, 45000);
  });

  describe('Device Off Flow', () => {
    test('Sending OFF mode via HAP should turn off device (verified via API)', async () => {
      if (!hasCredentials) {
        console.warn('⚠️  Skipping - no credentials');
        return;
      }

      // ARRANGE: Ensure device is on first
      console.log('Ensuring device is on...');
      await api.setMode(TEST_DEVICE_ID, 'cool');
      await new Promise(resolve => setTimeout(resolve, 3000));

      const beforeStatus = await api.getDeviceStatus(TEST_DEVICE_ID);
      console.log('Before status (via API):', beforeStatus);
      expect(beforeStatus?.switchState).toBe('on');

      // Set up coordinator with current device state (device is ON)
      setupDeviceInCoordinator({
        id: TEST_DEVICE_ID,
        name: 'Test AC',
        currentTemperature: beforeStatus!.currentTemperature,
        temperatureSetpoint: beforeStatus!.temperatureSetpoint,
        mode: beforeStatus!.mode,
        lightOn: false,
        lastUpdated: new Date(),
        switchState: 'on',
        coolingSetpoint: beforeStatus!.coolingSetpoint,
      });

      // ACT: Send OFF mode via coordinator (simulating HomeKit HAP characteristic set)
      console.log('Sending OFF mode command via HAP...');
      await coordinator.handleThermostatEvent({
        deviceId: TEST_DEVICE_ID,
        type: 'mode',
        mode: 'off',
      });

      // ASSERT: Wait for SmartThings to update and verify via API
      console.log('Waiting for SmartThings to update...');
      const switchedOff = await waitFor(
        async () => {
          const status = await api.getDeviceStatus(TEST_DEVICE_ID);
          console.log('Polling status (via API):', { switchState: status?.switchState, mode: status?.mode });
          return status?.switchState === 'off' || status?.mode === 'off';
        },
        20000,
        2500
      );

      const afterStatus = await api.getDeviceStatus(TEST_DEVICE_ID);
      console.log('After status (via API):', afterStatus);

      expect(switchedOff).toBe(true);
      // Samsung ACs use switch capability for on/off
      expect(afterStatus?.switchState === 'off' || afterStatus?.mode === 'off').toBe(true);
    }, 45000);
  });

  describe('Mode Change Flow', () => {
    test('Changing mode via HAP should update SmartThings (verified via API)', async () => {
      if (!hasCredentials) {
        console.warn('⚠️  Skipping - no credentials');
        return;
      }

      // ARRANGE: Wait a bit after previous test (SmartThings needs time to settle)
      console.log('Waiting for SmartThings to settle after previous test...');
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Get current status
      const beforeStatus = await api.getDeviceStatus(TEST_DEVICE_ID);
      console.log('Before status (via API):', beforeStatus);
      expect(beforeStatus).not.toBeNull();

      // Ensure device is on - always turn it on fresh to have a known state
      console.log('Ensuring device is on with cool mode...');
      await api.setMode(TEST_DEVICE_ID, 'cool');

      // Wait for SmartThings to actually show 'cool' mode
      console.log('Waiting for device to report cool mode...');
      const deviceIsInCoolMode = await waitFor(
        async () => {
          const status = await api.getDeviceStatus(TEST_DEVICE_ID);
          console.log('Waiting for cool mode, current:', { mode: status?.mode, switchState: status?.switchState });
          return status?.mode === 'cool' && status?.switchState === 'on';
        },
        15000,
        2000
      );

      if (!deviceIsInCoolMode) {
        console.warn('⚠️  Device did not enter cool mode in time, test may fail');
      }

      const currentStatus = await api.getDeviceStatus(TEST_DEVICE_ID);
      console.log('Current status:', currentStatus);
      expect(currentStatus?.mode).toBe('cool'); // Verify we're in cool mode

      // Set up coordinator
      setupDeviceInCoordinator({
        id: TEST_DEVICE_ID,
        name: 'Test AC',
        currentTemperature: currentStatus!.currentTemperature,
        temperatureSetpoint: currentStatus!.temperatureSetpoint,
        mode: currentStatus!.mode,
        lightOn: false,
        lastUpdated: new Date(),
        switchState: 'on',
        coolingSetpoint: currentStatus!.coolingSetpoint,
      });

      // Choose target mode different from current
      const currentMode = currentStatus!.mode;
      const targetMode = currentMode === 'cool' ? 'heat' : 'cool';
      console.log(`Changing mode from ${currentMode} to ${targetMode}`);

      // ACT: Send mode change via coordinator (simulating HomeKit HAP characteristic set)
      await coordinator.handleThermostatEvent({
        deviceId: TEST_DEVICE_ID,
        type: 'mode',
        mode: targetMode,
      });

      // ASSERT: Wait for SmartThings to update and verify via API
      console.log('Waiting for SmartThings to update...');
      const modeUpdated = await waitFor(
        async () => {
          const status = await api.getDeviceStatus(TEST_DEVICE_ID);
          console.log('Polling status (via API):', { mode: status?.mode, targetMode });
          return status?.mode === targetMode;
        },
        30000,  // Longer timeout for mode changes
        3000
      );

      const afterStatus = await api.getDeviceStatus(TEST_DEVICE_ID);
      console.log('After status (via API):', afterStatus);

      expect(modeUpdated).toBe(true);
      expect(afterStatus?.mode).toBe(targetMode);
    }, 60000);
  });
});
