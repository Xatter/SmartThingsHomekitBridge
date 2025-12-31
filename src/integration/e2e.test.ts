/**
 * End-to-End Integration Test
 *
 * This test verifies the full command flow:
 * HomeKit (HAP) → HAPServer → Coordinator → SmartThingsAPI → SmartThings Cloud
 *
 * REQUIREMENTS:
 * - Valid SmartThings credentials in data/smartthings_token.json
 * - Network access to SmartThings API
 * - A real Samsung Room AC device to test against
 *
 * RUN WITH:
 *   npx jest src/integration/e2e.test.ts --testTimeout=30000
 */

import { SmartThingsAuthentication } from '@/auth/SmartThingsAuthentication';
import { SmartThingsAPI } from '@/api/SmartThingsAPI';
import { Coordinator } from '@/coordinator/Coordinator';
import { SmartThingsHAPServer } from '@/hap/HAPServer';
import { PluginManager } from '@/plugins';
import { DeviceInclusionManager } from '@/config/DeviceInclusionManager';
import { DeviceState } from '@/types';
import { execSync } from 'child_process';

// Test configuration - use a real Samsung AC device
const TEST_DEVICE_ID = process.env.TEST_DEVICE_ID || '4ce5dd8c-0401-b4a2-abe3-54f1b79de771';
const TOKEN_PATH = process.env.TOKEN_PATH || './data/smartthings_token.json';

// Helper to get device status via SmartThings CLI
function getDeviceStatusViaCLI(deviceId: string): {
  switch: string;
  mode: string;
  coolingSetpoint: number;
  currentTemp: number;
} | null {
  try {
    const output = execSync(
      `smartthings devices:status "${deviceId}" --json 2>/dev/null`,
      { encoding: 'utf-8', timeout: 10000 }
    );
    const status = JSON.parse(output);
    return {
      switch: status.components?.main?.switch?.switch?.value || 'unknown',
      mode: status.components?.main?.airConditionerMode?.airConditionerMode?.value || 'unknown',
      coolingSetpoint: Number(status.components?.main?.thermostatCoolingSetpoint?.coolingSetpoint?.value) || 0,
      currentTemp: Number(status.components?.main?.temperatureMeasurement?.temperature?.value) || 0,
    };
  } catch (error) {
    console.error('Failed to get device status via CLI:', error);
    return null;
  }
}

// Wait for a condition with timeout
async function waitFor(
  condition: () => Promise<boolean> | boolean,
  timeoutMs: number = 10000,
  intervalMs: number = 1000
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

describe('End-to-End Integration Tests', () => {
  let auth: SmartThingsAuthentication;
  let api: SmartThingsAPI;
  let coordinator: Coordinator;
  let hapServer: SmartThingsHAPServer;
  let pluginManager: PluginManager;
  let inclusionManager: DeviceInclusionManager;

  let originalStatus: ReturnType<typeof getDeviceStatusViaCLI>;

  beforeAll(async () => {
    // Skip if no credentials available
    try {
      auth = new SmartThingsAuthentication(TOKEN_PATH);
      await auth.load();

      if (!auth.hasAuth()) {
        console.warn('⚠️  No SmartThings credentials found, skipping integration tests');
        return;
      }
    } catch (error) {
      console.warn('⚠️  Failed to load SmartThings credentials, skipping integration tests');
      return;
    }

    // Capture original device status for restoration
    originalStatus = getDeviceStatusViaCLI(TEST_DEVICE_ID);
    console.log('Original device status:', originalStatus);

    // Initialize components
    api = new SmartThingsAPI(auth);
    hapServer = new SmartThingsHAPServer(51999, '111-11-111'); // Use different port for testing

    // Create minimal mocks for plugin manager
    const mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    } as any;

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
      './data/test_state.json',
      300
    );

    // Initialize HAP server with coordinator
    await hapServer.initialize(coordinator);
  }, 30000);

  afterAll(async () => {
    // Restore original device state if we changed it
    if (originalStatus && auth?.hasAuth()) {
      console.log('Restoring original device status...');
      try {
        if (originalStatus.switch === 'off') {
          execSync(`smartthings devices:commands "${TEST_DEVICE_ID}" switch:off`, { timeout: 10000 });
        } else {
          execSync(`smartthings devices:commands "${TEST_DEVICE_ID}" switch:on`, { timeout: 10000 });
          execSync(
            `smartthings devices:commands "${TEST_DEVICE_ID}" airConditionerMode:setAirConditionerMode:${originalStatus.mode}`,
            { timeout: 10000 }
          );
          execSync(
            `smartthings devices:commands "${TEST_DEVICE_ID}" thermostatCoolingSetpoint:setCoolingSetpoint:${originalStatus.coolingSetpoint}`,
            { timeout: 10000 }
          );
        }
      } catch (error) {
        console.error('Failed to restore device status:', error);
      }
    }

    // Cleanup
    coordinator?.stop();
    await hapServer?.stop();
  });

  describe('Command Flow: Coordinator → SmartThings API', () => {
    beforeEach(() => {
      if (!auth?.hasAuth()) {
        console.warn('Skipping test - no credentials');
      }
    });

    test('handleThermostatEvent with mode change should update SmartThings device', async () => {
      if (!auth?.hasAuth()) {
        console.warn('⚠️  Skipping - no credentials');
        return;
      }

      // Get current status
      const beforeStatus = getDeviceStatusViaCLI(TEST_DEVICE_ID);
      console.log('Before status:', beforeStatus);
      expect(beforeStatus).not.toBeNull();

      // Set up the coordinator with the test device
      const mockDeviceState: DeviceState = {
        id: TEST_DEVICE_ID,
        name: 'Test AC',
        currentTemperature: beforeStatus!.currentTemp,
        temperatureSetpoint: beforeStatus!.coolingSetpoint,
        mode: beforeStatus!.mode as any,
        lightOn: false,
        lastUpdated: new Date(),
        switchState: beforeStatus!.switch as 'on' | 'off',
      };

      // Access private state to set up the device
      (coordinator as any).state.deviceStates.set(TEST_DEVICE_ID, mockDeviceState);

      // Set up device metadata with Samsung AC capabilities
      (coordinator as any).deviceMetadata.set(TEST_DEVICE_ID, {
        deviceId: TEST_DEVICE_ID,
        name: 'Test AC',
        label: 'Test AC',
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

      // Choose a target mode different from current
      const targetMode = beforeStatus!.mode === 'cool' ? 'heat' : 'cool';
      console.log(`Changing mode from ${beforeStatus!.mode} to ${targetMode}`);

      // First ensure device is on
      if (beforeStatus!.switch === 'off') {
        console.log('Device is off, turning on first...');
        await coordinator.handleThermostatEvent({
          deviceId: TEST_DEVICE_ID,
          type: 'mode',
          mode: targetMode,
        });
      } else {
        // Send mode change via coordinator (simulating HomeKit)
        await coordinator.handleThermostatEvent({
          deviceId: TEST_DEVICE_ID,
          type: 'mode',
          mode: targetMode,
        });
      }

      // Wait for SmartThings to update (with polling)
      console.log('Waiting for SmartThings to update...');
      const modeUpdated = await waitFor(
        () => {
          const status = getDeviceStatusViaCLI(TEST_DEVICE_ID);
          console.log('Current status:', status);
          return status?.mode === targetMode;
        },
        15000,
        2000
      );

      const afterStatus = getDeviceStatusViaCLI(TEST_DEVICE_ID);
      console.log('After status:', afterStatus);

      expect(modeUpdated).toBe(true);
      expect(afterStatus?.mode).toBe(targetMode);
    }, 30000);

    test('handleThermostatEvent with temperature change should update SmartThings device', async () => {
      if (!auth?.hasAuth()) {
        console.warn('⚠️  Skipping - no credentials');
        return;
      }

      // Get current status
      const beforeStatus = getDeviceStatusViaCLI(TEST_DEVICE_ID);
      console.log('Before status:', beforeStatus);
      expect(beforeStatus).not.toBeNull();

      // Ensure device is on first
      if (beforeStatus!.switch === 'off') {
        console.log('Turning device on...');
        execSync(`smartthings devices:commands "${TEST_DEVICE_ID}" switch:on`, { timeout: 10000 });
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      // Set up the coordinator with the test device
      const mockDeviceState: DeviceState = {
        id: TEST_DEVICE_ID,
        name: 'Test AC',
        currentTemperature: beforeStatus!.currentTemp,
        temperatureSetpoint: beforeStatus!.coolingSetpoint,
        mode: beforeStatus!.mode as any,
        lightOn: false,
        lastUpdated: new Date(),
        switchState: 'on',
      };

      (coordinator as any).state.deviceStates.set(TEST_DEVICE_ID, mockDeviceState);
      (coordinator as any).deviceMetadata.set(TEST_DEVICE_ID, {
        deviceId: TEST_DEVICE_ID,
        name: 'Test AC',
        label: 'Test AC',
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

      // Choose a target temperature different from current (±2°F)
      const currentSetpoint = beforeStatus!.coolingSetpoint;
      const targetTemp = currentSetpoint >= 74 ? currentSetpoint - 2 : currentSetpoint + 2;
      console.log(`Changing temperature from ${currentSetpoint}°F to ${targetTemp}°F`);

      // Send temperature change via coordinator (simulating HomeKit)
      await coordinator.handleThermostatEvent({
        deviceId: TEST_DEVICE_ID,
        type: 'temperature',
        temperature: targetTemp,
      });

      // Wait for SmartThings to update
      console.log('Waiting for SmartThings to update...');
      const tempUpdated = await waitFor(
        () => {
          const status = getDeviceStatusViaCLI(TEST_DEVICE_ID);
          console.log('Current status:', status);
          return status?.coolingSetpoint === targetTemp;
        },
        15000,
        2000
      );

      const afterStatus = getDeviceStatusViaCLI(TEST_DEVICE_ID);
      console.log('After status:', afterStatus);

      expect(tempUpdated).toBe(true);
      expect(afterStatus?.coolingSetpoint).toBe(targetTemp);
    }, 30000);

    test('handleThermostatEvent with off mode should turn off Samsung AC via switch', async () => {
      if (!auth?.hasAuth()) {
        console.warn('⚠️  Skipping - no credentials');
        return;
      }

      // Ensure device is on first
      console.log('Ensuring device is on...');
      execSync(`smartthings devices:commands "${TEST_DEVICE_ID}" switch:on`, { timeout: 10000 });
      await new Promise(resolve => setTimeout(resolve, 3000));

      const beforeStatus = getDeviceStatusViaCLI(TEST_DEVICE_ID);
      console.log('Before status:', beforeStatus);
      expect(beforeStatus?.switch).toBe('on');

      // Set up the coordinator with the test device
      const mockDeviceState: DeviceState = {
        id: TEST_DEVICE_ID,
        name: 'Test AC',
        currentTemperature: beforeStatus!.currentTemp,
        temperatureSetpoint: beforeStatus!.coolingSetpoint,
        mode: beforeStatus!.mode as any,
        lightOn: false,
        lastUpdated: new Date(),
        switchState: 'on',
      };

      (coordinator as any).state.deviceStates.set(TEST_DEVICE_ID, mockDeviceState);
      (coordinator as any).deviceMetadata.set(TEST_DEVICE_ID, {
        deviceId: TEST_DEVICE_ID,
        name: 'Test AC',
        label: 'Test AC',
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

      // Send off mode via coordinator
      console.log('Sending OFF mode command...');
      await coordinator.handleThermostatEvent({
        deviceId: TEST_DEVICE_ID,
        type: 'mode',
        mode: 'off',
      });

      // Wait for SmartThings to update
      console.log('Waiting for SmartThings to update...');
      const switchedOff = await waitFor(
        () => {
          const status = getDeviceStatusViaCLI(TEST_DEVICE_ID);
          console.log('Current status:', status);
          return status?.switch === 'off';
        },
        15000,
        2000
      );

      const afterStatus = getDeviceStatusViaCLI(TEST_DEVICE_ID);
      console.log('After status:', afterStatus);

      expect(switchedOff).toBe(true);
      expect(afterStatus?.switch).toBe('off');
    }, 30000);
  });

  describe('Debug: Direct API call test', () => {
    test('SmartThingsAPI.executeCommands should send commands to cloud', async () => {
      if (!auth?.hasAuth()) {
        console.warn('⚠️  Skipping - no credentials');
        return;
      }

      const beforeStatus = getDeviceStatusViaCLI(TEST_DEVICE_ID);
      console.log('Before status:', beforeStatus);

      // Test direct API call
      const targetTemp = (beforeStatus?.coolingSetpoint || 72) + 1;
      console.log(`Sending direct API command to set temperature to ${targetTemp}°F`);

      await api.executeCommands(TEST_DEVICE_ID, [
        {
          component: 'main',
          capability: 'thermostatCoolingSetpoint',
          command: 'setCoolingSetpoint',
          arguments: [targetTemp],
        },
      ]);

      // Wait and verify
      await new Promise(resolve => setTimeout(resolve, 3000));
      const afterStatus = getDeviceStatusViaCLI(TEST_DEVICE_ID);
      console.log('After status:', afterStatus);

      expect(afterStatus?.coolingSetpoint).toBe(targetTemp);
    }, 20000);
  });
});
