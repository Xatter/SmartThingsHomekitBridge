import * as cron from 'node-cron';
import { promises as fs } from 'fs';
import * as path from 'path';
import { SmartThingsAPI } from '@/api/SmartThingsAPI';
import { LightingMonitor } from '@/monitoring/LightingMonitor';
import { SmartThingsHAPServer } from '@/hap/HAPServer';
import { CoordinatorState, DeviceState, UnifiedDevice } from '@/types';
import { HAPThermostatEvent } from '@/hap/HAPServer';
import { logger } from '@/utils/logger';
import { AutoModeController, AutoModeDevice } from '@/controller/AutoModeController';

/**
 * Coordinates device state between SmartThings API, HomeKit bridge, and lighting monitor.
 * Manages device synchronization, temperature control, and polling.
 */
export class Coordinator {
  private readonly api: SmartThingsAPI;
  private readonly lightingMonitor: LightingMonitor;
  private readonly hapServer: SmartThingsHAPServer;
  private readonly stateFilePath: string;
  private readonly autoModeController: AutoModeController;
  private state: CoordinatorState;
  private pollTask: cron.ScheduledTask | null = null;
  private readonly pollInterval: string;

  /**
   * Creates a new Coordinator instance.
   * @param api - SmartThings API client
   * @param lightingMonitor - Lighting monitor for AC light control
   * @param hapServer - HomeKit bridge server
   * @param stateFilePath - Path to persist coordinator state
   * @param pollIntervalSeconds - Device polling interval in seconds (default: 300)
   */
  constructor(
    api: SmartThingsAPI,
    lightingMonitor: LightingMonitor,
    hapServer: SmartThingsHAPServer,
    stateFilePath: string,
    pollIntervalSeconds: number = 300
  ) {
    this.api = api;
    this.lightingMonitor = lightingMonitor;
    this.hapServer = hapServer;
    this.stateFilePath = stateFilePath;
    this.pollInterval = this.convertSecondsToInterval(pollIntervalSeconds);

    // Initialize auto-mode controller with state file in same directory as coordinator state
    const stateDir = path.dirname(stateFilePath);
    const autoModeStatePath = path.join(stateDir, 'auto_mode_state.json');
    this.autoModeController = new AutoModeController(autoModeStatePath);

    this.state = {
      pairedDevices: [],
      averageTemperature: 70,
      currentMode: 'off',
      deviceStates: new Map(),
    };
  }

  private convertSecondsToInterval(seconds: number): string {
    if (seconds >= 60 && seconds % 60 === 0) {
      const minutes = seconds / 60;
      return `*/${minutes} * * * *`;
    }
    return `*/${seconds} * * * * *`;
  }

  /**
   * Initializes the coordinator by loading state and starting polling.
   * Defers device reloading by 2 seconds to avoid blocking pairing process.
   */
  async initialize(): Promise<void> {
    await this.loadState();
    await this.autoModeController.load();
    // Only reload devices if we have auth and existing devices to restore
    if (this.api.hasAuth() && this.state.pairedDevices.length > 0) {
      // Defer device loading to avoid blocking pairing process
      setTimeout(async () => {
        await this.reloadDevices();
      }, 2000);
    }
    this.startPolling();
  }

  private async loadState(): Promise<void> {
    try {
      const stateData = await fs.readFile(this.stateFilePath, 'utf-8');
      const parsedState = JSON.parse(stateData);

      // Convert deviceStates and ensure lastUpdated is a Date object
      const deviceStates = new Map();
      if (parsedState.deviceStates) {
        for (const [deviceId, deviceState] of parsedState.deviceStates) {
          deviceStates.set(deviceId, {
            ...deviceState,
            lastUpdated: new Date(deviceState.lastUpdated),
          });
        }
      }

      this.state = {
        pairedDevices: parsedState.pairedDevices || [],
        averageTemperature: parsedState.averageTemperature || 70,
        currentMode: parsedState.currentMode || 'off',
        deviceStates,
      };

      logger.info({ count: this.state.pairedDevices.length }, 'Loaded coordinator state');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ err: error }, 'Error loading coordinator state');
      } else {
        logger.info('No existing coordinator state found, starting fresh');
      }
    }
  }

  private async saveState(): Promise<void> {
    try {
      const stateToSave = {
        pairedDevices: this.state.pairedDevices,
        averageTemperature: this.state.averageTemperature,
        currentMode: this.state.currentMode,
        deviceStates: Array.from(this.state.deviceStates.entries()),
      };

      await fs.mkdir(require('path').dirname(this.stateFilePath), { recursive: true });
      await fs.writeFile(this.stateFilePath, JSON.stringify(stateToSave, null, 2));
    } catch (error) {
      logger.error({ err: error }, 'Error saving coordinator state');
    }
  }

  /**
   * Reloads all HVAC devices from SmartThings and syncs them to HomeKit.
   * Does not remove existing devices - preserves HomeKit stability.
   */
  async reloadDevices(): Promise<void> {
    if (!this.api.hasAuth()) {
      logger.warn('Cannot reload devices: No SmartThings authentication');
      return;
    }

    logger.info('⏳ Reloading devices - this may take a moment...');

    try {
      logger.info('🔍 Reloading devices from SmartThings');
      const filteredDevices = await this.api.getDevices([]);
      const deviceIds = filteredDevices.map(device => device.deviceId);

      logger.info({ count: filteredDevices.length }, '📱 Found HVAC devices');
      logger.debug('🏠 HVAC devices found:');
      filteredDevices.forEach(device => {
        logger.debug({ deviceId: device.deviceId, name: device.name, capabilities: device.capabilities.map(cap => cap.id) }, `  - Device: ${device.name}`);
      });

      // Don't remove devices during reload - this preserves HomeKit stability
      // Devices should only be removed explicitly by user action

      this.state.pairedDevices = deviceIds;
      this.lightingMonitor.setDevices(deviceIds);

      // Add or update devices in HAP server
      for (const device of filteredDevices) {
        const deviceState = await this.getDeviceStateByDevice(device);
        if (deviceState) {
          try {
            // addDevice will check if device was already bridged and skip if so
            await this.hapServer.addDevice(device.deviceId, deviceState);
          } catch (error) {
            logger.error({ err: error, deviceName: device.name }, '❌ Failed to add device to HomeKit bridge');
          }
        }
      }

      logger.info({ count: deviceIds.length }, '✅ Reloaded devices: HVAC devices synchronized');

      await this.updateDeviceStates();
      await this.saveState();
    } catch (error) {
      logger.error({ err: error }, '❌ Error reloading devices');
    }
  }

  private async updateDeviceStates(): Promise<void> {
    logger.debug('📊 Coordinator: Updating device states');

    const promises = this.state.pairedDevices.map(async (deviceId) => {
      try {
        const deviceState = await this.api.getDeviceStatus(deviceId);
        if (deviceState) {
          const previousState = this.state.deviceStates.get(deviceId);

          // Check if device is enrolled in auto mode
          const isAutoMode = this.autoModeController.getEnrolledDeviceIds().includes(deviceId);

          // If in auto mode, preserve the 'auto' mode for HomeKit
          // (SmartThings reports the actual mode, but we want to show 'auto' in HomeKit)
          const stateForHomeKit = isAutoMode
            ? { ...deviceState, mode: 'auto' as const }
            : deviceState;

          // Store the state with preserved mode
          this.state.deviceStates.set(deviceId, stateForHomeKit);

          // Update HAP if state changed
          if (previousState) {
            const tempDiff = Math.abs(previousState.currentTemperature - deviceState.currentTemperature);
            const setpointDiff = Math.abs(previousState.temperatureSetpoint - deviceState.temperatureSetpoint);
            const modeChanged = previousState.mode !== stateForHomeKit.mode;

            const stateChanged = modeChanged || setpointDiff > 0.5 || tempDiff > 0.5;

            if (stateChanged) {
              logger.info({
                deviceName: deviceState.name,
                tempDiff: tempDiff.toFixed(1),
                setpointDiff: setpointDiff.toFixed(1),
                modeChange: modeChanged ? `${previousState.mode} -> ${stateForHomeKit.mode}` : 'unchanged',
                autoMode: isAutoMode
              }, '📈 State change detected');
              await this.hapServer.updateDeviceState(deviceId, stateForHomeKit);
            } else {
              logger.debug({ deviceName: deviceState.name }, 'No significant changes');
            }
          } else {
            logger.debug({ deviceName: deviceState.name }, 'First state update');
            await this.hapServer.updateDeviceState(deviceId, stateForHomeKit);
          }
        }
      } catch (error) {
        logger.error({ err: error, deviceId }, 'Error updating state for device');
      }
    });

    await Promise.allSettled(promises);
    this.calculateAverageTemperature();
    this.determineCurrentMode();
  }

  private calculateAverageTemperature(): void {
    const temperatures = Array.from(this.state.deviceStates.values())
      .map(state => state.temperatureSetpoint)
      .filter(temp => temp > 0);

    if (temperatures.length > 0) {
      this.state.averageTemperature = temperatures.reduce((sum, temp) => sum + temp, 0) / temperatures.length;
    }
  }

  private determineCurrentMode(): void {
    // Only consider devices that are ON (mode !== 'off') for determining the active mode
    const onDeviceModes = Array.from(this.state.deviceStates.values())
      .filter(state => state.mode !== 'off')
      .map(state => state.mode);

    if (onDeviceModes.length === 0) {
      // All devices are off
      this.state.currentMode = 'off';
      return;
    }

    const modeCount = onDeviceModes.reduce((acc, mode) => {
      acc[mode] = (acc[mode] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    let mostCommonMode = 'off';
    let maxCount = 0;

    for (const [mode, count] of Object.entries(modeCount)) {
      if (count > maxCount) {
        maxCount = count;
        mostCommonMode = mode;
      }
    }

    this.state.currentMode = mostCommonMode as 'heat' | 'cool' | 'auto' | 'off';
  }

  private startPolling(): void {
    if (this.pollTask) {
      this.pollTask.stop();
    }

    logger.info({ interval: this.pollInterval }, 'Starting coordinator polling');

    this.pollTask = cron.schedule(this.pollInterval, async () => {
      await this.pollDevices();
    }, {
      scheduled: true,
      timezone: 'UTC'
    });
  }

  private async pollDevices(): Promise<void> {
    if (!this.api.hasAuth()) {
      logger.warn('Coordinator polling: No SmartThings authentication');
      return;
    }

    logger.debug('⏰ Coordinator: Polling devices');

    const previousAverageTemp = this.state.averageTemperature;
    await this.updateDeviceStates();

    // Clean up stale enrolled devices
    await this.cleanupStaleEnrolledDevices();

    // Evaluate and apply auto-mode if devices are enrolled
    await this.evaluateAndApplyAutoMode();

    if (Math.abs(this.state.averageTemperature - previousAverageTemp) > 0.5) {
      logger.info({
        previousTemp: previousAverageTemp,
        newTemp: this.state.averageTemperature
      }, 'Temperature change detected');
      await this.synchronizeTemperatures();
    }

    await this.saveState();
    logger.debug('✅ Coordinator: Polling complete');
  }

  private async synchronizeTemperatures(): Promise<void> {
    const targetTemp = this.state.averageTemperature;
    const currentMode = this.state.currentMode;

    if (currentMode === 'off' || currentMode === 'auto') {
      return;
    }

    logger.info({ targetTemp, mode: currentMode }, 'Synchronizing all devices to temperature');

    const promises = this.state.pairedDevices.map(async (deviceId) => {
      try {
        const currentState = this.state.deviceStates.get(deviceId);
        if (currentState && Math.abs(currentState.temperatureSetpoint - targetTemp) > 0.5) {
          await this.changeTemperature(deviceId, targetTemp);
        }
      } catch (error) {
        logger.error({ err: error, deviceId }, 'Error synchronizing temperature for device');
      }
    });

    await Promise.allSettled(promises);
  }

  /**
   * Changes the temperature setpoint for a specific device.
   * Converts auto mode to cool. Does not work in off mode.
   * @param deviceId - Device to update
   * @param temperature - Target temperature in Fahrenheit
   * @returns true if successful, false otherwise
   */
  async changeTemperature(deviceId: string, temperature: number): Promise<boolean> {
    const currentState = this.state.deviceStates.get(deviceId);
    if (!currentState) {
      logger.error({ deviceId }, 'Cannot change temperature: No state found for device');
      return false;
    }

    const mode = currentState.mode === 'auto' ? 'cool' : currentState.mode;
    if (mode === 'off') {
      logger.warn({ deviceId }, 'Cannot set temperature for device: mode is off');
      return false;
    }

    const success = await this.api.setTemperature(deviceId, temperature, mode as 'heat' | 'cool');

    if (success) {
      currentState.temperatureSetpoint = temperature;
      currentState.lastUpdated = new Date();
      this.state.deviceStates.set(deviceId, currentState);
      await this.saveState();
    }

    return success;
  }

  /**
   * Changes the operating mode for a specific device.
   * If mode is heat/cool, synchronizes all other ON devices to the same mode.
   * @param deviceId - Device to update
   * @param mode - Target mode (heat, cool, auto, or off)
   * @returns true if successful, false otherwise
   */
  async changeMode(deviceId: string, mode: 'heat' | 'cool' | 'auto' | 'off'): Promise<boolean> {
    const success = await this.api.setMode(deviceId, mode);

    if (success) {
      const currentState = this.state.deviceStates.get(deviceId);
      if (currentState) {
        currentState.mode = mode;
        currentState.lastUpdated = new Date();
        this.state.deviceStates.set(deviceId, currentState);
      }

      await this.synchronizeModesAcrossDevices(mode);
      await this.saveState();
    }

    return success;
  }

  private async synchronizeModesAcrossDevices(newMode: 'heat' | 'cool' | 'auto' | 'off'): Promise<void> {
    if (newMode === 'auto' || newMode === 'off') {
      return;
    }

    logger.info({ mode: newMode }, 'Synchronizing all ON devices to mode');

    const promises = this.state.pairedDevices.map(async (deviceId) => {
      try {
        const currentState = this.state.deviceStates.get(deviceId);
        // Only synchronize devices that are already ON (mode !== 'off')
        if (currentState && currentState.mode !== 'off' && currentState.mode !== newMode) {
          await this.api.setMode(deviceId, newMode);
          currentState.mode = newMode;
          currentState.lastUpdated = new Date();
          this.state.deviceStates.set(deviceId, currentState);

          // Update HAP server with the new state
          await this.hapServer.updateDeviceState(deviceId, currentState);
        }
      } catch (error) {
        logger.error({ err: error, deviceId }, 'Error synchronizing mode for device');
      }
    });

    await Promise.allSettled(promises);
    this.state.currentMode = newMode;
  }

  /**
   * Returns a copy of all device states.
   * @returns Map of device IDs to their current states
   */
  getDeviceStates(): Map<string, DeviceState> {
    return new Map(this.state.deviceStates);
  }

  /**
   * Returns a copy of the complete coordinator state.
   * @returns Coordinator state including paired devices, average temp, mode, and device states
   */
  getState(): CoordinatorState {
    return {
      ...this.state,
      deviceStates: new Map(this.state.deviceStates),
    };
  }

  /**
   * Returns the auto-mode controller instance.
   * @returns AutoModeController instance
   */
  getAutoModeController(): AutoModeController {
    return this.autoModeController;
  }

  /**
   * Retrieves all devices from SmartThings API.
   * @returns Array of unified devices, or empty array if no auth or error
   */
  async getDevices(): Promise<UnifiedDevice[]> {
    if (!this.api.hasAuth()) {
      logger.warn('Cannot get devices: No SmartThings authentication');
      return [];
    }

    try {
      return await this.api.getDevices(this.state.pairedDevices);
    } catch (error) {
      logger.error({ err: error }, 'Error getting unified devices');
      return [];
    }
  }

  /**
   * Handles thermostat events from HomeKit and updates SmartThings.
   * Called when user changes temperature or mode in Home app.
   * @param event - Thermostat event containing device ID, type, and values
   */
  async handleHAPThermostatEvent(event: HAPThermostatEvent): Promise<void> {
    logger.info({ deviceId: event.deviceId, eventType: event.type }, 'Handling HAP thermostat event');

    const currentState = this.state.deviceStates.get(event.deviceId);
    if (!currentState) {
      logger.error({ deviceId: event.deviceId }, 'No state found for device');
      return;
    }

    try {
      if (event.type === 'temperature' || event.type === 'both') {
        if (event.temperature !== undefined) {
          await this.changeTemperature(event.deviceId, event.temperature);
        }
      }

      if (event.type === 'mode' || event.type === 'both') {
        if (event.mode !== undefined) {
          // Special handling for 'auto' mode
          if (event.mode === 'auto') {
            logger.info({ deviceId: event.deviceId }, '🤖 Device switching to AUTO mode - enrolling in AutoModeController');
            await this.autoModeController.enrollDevice(event.deviceId);

            // Update local state to auto (don't send to SmartThings)
            currentState.mode = 'auto';
            currentState.lastUpdated = new Date();
            this.state.deviceStates.set(event.deviceId, currentState);
            await this.saveState();

            // Immediately run auto-mode evaluation
            await this.evaluateAndApplyAutoMode();
          } else {
            // Switching out of auto mode - unenroll from controller
            const wasEnrolled = this.autoModeController.getEnrolledDeviceIds().includes(event.deviceId);
            if (wasEnrolled) {
              logger.info({ deviceId: event.deviceId }, '🔓 Device leaving AUTO mode - unenrolling from AutoModeController');
              await this.autoModeController.unenrollDevice(event.deviceId);
            }

            // Normal mode change (heat/cool/off) - send to SmartThings
            await this.changeMode(event.deviceId, event.mode);
          }
        }
      }
    } catch (error) {
      logger.error({ err: error, deviceId: event.deviceId }, 'Error handling thermostat event');
    }
  }

  /**
   * Validates that a temperature value is reasonable
   */
  private isValidTemperature(temp: number | undefined | null): boolean {
    if (temp === undefined || temp === null || isNaN(temp)) {
      return false;
    }
    // Reasonable range: 32°F (freezing) to 120°F (very hot)
    return temp >= 32 && temp <= 120;
  }

  /**
   * Cleans up enrolled devices that no longer exist in the paired devices list
   */
  private async cleanupStaleEnrolledDevices(): Promise<void> {
    const enrolledIds = this.autoModeController.getEnrolledDeviceIds();
    const staleDevices: string[] = [];

    for (const enrolledId of enrolledIds) {
      // Check if device still exists in paired devices
      if (!this.state.pairedDevices.includes(enrolledId)) {
        staleDevices.push(enrolledId);
      }
    }

    if (staleDevices.length > 0) {
      logger.info({ count: staleDevices.length }, '🧹 Cleaning up stale enrolled device(s) that no longer exist');
      for (const deviceId of staleDevices) {
        await this.autoModeController.unenrollDevice(deviceId);
        logger.debug({ deviceId }, '   Unenrolled device');
      }
    }
  }

  /**
   * Evaluates all auto-mode enrolled devices and applies the controller's decision
   */
  private async evaluateAndApplyAutoMode(): Promise<void> {
    const enrolledIds = this.autoModeController.getEnrolledDeviceIds();
    if (enrolledIds.length === 0) {
      logger.debug('⏩ No devices enrolled in auto mode, skipping evaluation');
      return;
    }

    logger.info({ count: enrolledIds.length }, '🤖 Evaluating auto mode for enrolled devices');

    // Gather device information for evaluation
    const autoModeDevices: AutoModeDevice[] = [];
    const invalidDeviceIds: string[] = [];

    for (const deviceId of enrolledIds) {
      const state = this.state.deviceStates.get(deviceId);
      if (!state) {
        logger.warn({ deviceId }, '⚠️  Enrolled device has no state, skipping');
        invalidDeviceIds.push(deviceId);
        continue;
      }

      // Validate temperature values
      if (!this.isValidTemperature(state.currentTemperature)) {
        logger.warn({ deviceName: state.name, deviceId, currentTemp: state.currentTemperature }, '⚠️  Device has invalid current temperature, skipping');
        invalidDeviceIds.push(deviceId);
        continue;
      }

      if (!this.isValidTemperature(state.temperatureSetpoint)) {
        logger.warn({ deviceName: state.name, deviceId, setpoint: state.temperatureSetpoint }, '⚠️  Device has invalid temperature setpoint, skipping');
        invalidDeviceIds.push(deviceId);
        continue;
      }

      // Use heating/cooling setpoints as thresholds
      // If not available, use temperatureSetpoint ± 2°F as fallback
      const lowerBound = state.heatingSetpoint || (state.temperatureSetpoint - 2);
      const upperBound = state.coolingSetpoint || (state.temperatureSetpoint + 2);

      // Validate bounds are reasonable
      if (!this.isValidTemperature(lowerBound) || !this.isValidTemperature(upperBound)) {
        logger.warn({ deviceName: state.name, deviceId, lowerBound, upperBound }, '⚠️  Device has invalid temperature bounds, skipping');
        invalidDeviceIds.push(deviceId);
        continue;
      }

      if (lowerBound >= upperBound) {
        logger.warn({ deviceName: state.name, deviceId, lowerBound, upperBound }, '⚠️  Device has invalid bounds (lower >= upper), skipping');
        invalidDeviceIds.push(deviceId);
        continue;
      }

      autoModeDevices.push({
        id: deviceId,
        name: state.name,
        currentTemperature: state.currentTemperature,
        lowerBound: lowerBound,
        upperBound: upperBound,
        weight: 1.0, // Equal weight for all devices
      });
    }

    // Clean up devices that have been invalid for too long or no longer exist
    if (invalidDeviceIds.length > 0) {
      logger.warn({ count: invalidDeviceIds.length }, '⚠️  Enrolled device(s) have invalid state');
    }

    if (autoModeDevices.length === 0) {
      logger.debug('⏩ No valid device states for auto mode evaluation');
      return;
    }

    // Evaluate and get controller decision
    const decision = this.autoModeController.evaluate(autoModeDevices);
    logger.info({ mode: decision.mode }, '🎯 Auto mode decision');
    logger.debug({ heatDemand: decision.totalHeatDemand.toFixed(1), coolDemand: decision.totalCoolDemand.toFixed(1) }, '   Demands calculated');
    logger.debug({ reason: decision.reason }, '   Decision reason');

    if (decision.switchSuppressed) {
      logger.debug({ secondsRemaining: decision.secondsUntilSwitchAllowed }, '   ⏸️  Mode switch suppressed');
    }

    // Apply decision to all enrolled devices
    const modeChanged = await this.autoModeController.applyDecision(decision);
    if (modeChanged) {
      logger.info({ mode: decision.mode }, '🔄 Applying mode to all enrolled devices');

      // Set all enrolled devices to the determined mode
      const promises = enrolledIds.map(async (deviceId) => {
        try {
          const currentState = this.state.deviceStates.get(deviceId);
          if (!currentState) {
            logger.warn({ deviceId }, '   ⚠️  Device has no state, skipping mode application');
            return { deviceId, success: false, reason: 'No state' };
          }

          // Update SmartThings device
          const success = await this.api.setMode(deviceId, decision.mode as 'heat' | 'cool' | 'off');

          if (!success) {
            logger.error({ deviceName: currentState.name }, '   ✗ Failed to set mode (API returned false)');
            return { deviceId, success: false, reason: 'API failed' };
          }

          // Update local state (keep mode as 'auto' in our state, actual mode is tracked by controller)
          currentState.lastUpdated = new Date();
          this.state.deviceStates.set(deviceId, currentState);

          logger.debug({ deviceName: currentState.name, mode: decision.mode }, '   ✓ Set device mode');
          return { deviceId, success: true };
        } catch (error) {
          logger.error({ err: error, deviceId }, '   ✗ Failed to set mode for device');
          return { deviceId, success: false, reason: 'Exception', error };
        }
      });

      const results = await Promise.allSettled(promises);
      const successCount = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
      const failureCount = results.length - successCount;

      if (failureCount > 0) {
        logger.warn({ failureCount, successCount }, '⚠️  Auto mode application completed with failures');
      } else {
        logger.info({ successCount }, '✅ Auto mode application complete');
      }

      await this.saveState();
    } else {
      logger.debug({ mode: decision.mode }, '   No mode change needed');
    }
  }

  private async getDeviceStateByDevice(device: UnifiedDevice): Promise<DeviceState | null> {
    try {
      const status = await this.api.getDeviceStatus(device.deviceId);
      if (!status) {
        logger.error({ deviceName: device.name }, 'No status returned for device');
        return null;
      }

      return {
        id: device.deviceId,
        name: device.name,
        currentTemperature: status.currentTemperature || 70,
        temperatureSetpoint: status.temperatureSetpoint || 72,
        mode: status.mode,
        lightOn: false, // Air conditioners don't have lights
        lastUpdated: new Date(),
        heatingSetpoint: status.heatingSetpoint,
        coolingSetpoint: status.coolingSetpoint,
      };
    } catch (error) {
      logger.error({ err: error, deviceName: device.name }, 'Failed to get device state');
      return null;
    }
  }

  /**
   * Stops the coordinator polling task.
   * Call this when shutting down the application.
   */
  stop(): void {
    if (this.pollTask) {
      this.pollTask.stop();
      this.pollTask = null;
      logger.info('Coordinator polling stopped');
    }
  }
}