import * as cron from 'node-cron';
import { promises as fs } from 'fs';
import { SmartThingsAPI } from '@/api/SmartThingsAPI';
import { LightingMonitor } from '@/monitoring/LightingMonitor';
import { SmartThingsHAPServer } from '@/hap/HAPServer';
import { CoordinatorState, DeviceState, UnifiedDevice } from '@/types';
import { HAPThermostatEvent } from '@/hap/HAPServer';
import { logger } from '@/utils/logger';

/**
 * Coordinates device state between SmartThings API, HomeKit bridge, and lighting monitor.
 * Manages device synchronization, temperature control, and polling.
 */
export class Coordinator {
  private readonly api: SmartThingsAPI;
  private readonly lightingMonitor: LightingMonitor;
  private readonly hapServer: SmartThingsHAPServer;
  private readonly stateFilePath: string;
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
          this.state.deviceStates.set(deviceId, deviceState);

          // Update HAP if state changed
          if (previousState) {
            const tempDiff = Math.abs(previousState.currentTemperature - deviceState.currentTemperature);
            const setpointDiff = Math.abs(previousState.temperatureSetpoint - deviceState.temperatureSetpoint);
            const modeChanged = previousState.mode !== deviceState.mode;

            const stateChanged = modeChanged || setpointDiff > 0.5 || tempDiff > 0.5;

            if (stateChanged) {
              logger.info({
                deviceName: deviceState.name,
                tempDiff: tempDiff.toFixed(1),
                setpointDiff: setpointDiff.toFixed(1),
                modeChange: modeChanged ? `${previousState.mode} -> ${deviceState.mode}` : 'unchanged'
              }, '📈 State change detected');
              await this.hapServer.updateDeviceState(deviceId, deviceState);
            } else {
              logger.debug({ deviceName: deviceState.name }, 'No significant changes');
            }
          } else {
            logger.debug({ deviceName: deviceState.name }, 'First state update');
            await this.hapServer.updateDeviceState(deviceId, deviceState);
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
          await this.changeMode(event.deviceId, event.mode);
        }
      }
    } catch (error) {
      logger.error({ err: error, deviceId: event.deviceId }, 'Error handling thermostat event');
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