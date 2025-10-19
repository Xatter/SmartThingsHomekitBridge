import * as cron from 'node-cron';
import { promises as fs } from 'fs';
import * as path from 'path';
import { SmartThingsAPI } from '@/api/SmartThingsAPI';
import { SmartThingsHAPServer } from '@/hap/HAPServer';
import { CoordinatorState, DeviceState, UnifiedDevice } from '@/types';
import { HAPThermostatEvent } from '@/hap/HAPServer';
import { logger } from '@/utils/logger';
import { PluginManager } from '@/plugins';
import { DeviceInclusionManager } from '@/config/DeviceInclusionManager';
import { isThermostatLikeDevice } from '@/utils/deviceUtils';

/**
 * Coordinates device state between SmartThings API, HomeKit bridge, and plugins.
 * Manages device synchronization and polling.
 *
 * This is a refactored version that delegates device-specific logic to plugins.
 */
export class Coordinator {
  private readonly api: SmartThingsAPI;
  private readonly hapServer: SmartThingsHAPServer;
  private readonly pluginManager: PluginManager;
  private readonly inclusionManager: DeviceInclusionManager;
  private readonly stateFilePath: string;
  private state: CoordinatorState;
  private pollTask: cron.ScheduledTask | null = null;
  private readonly pollInterval: string;
  private deviceMetadata: Map<string, UnifiedDevice> = new Map();

  constructor(
    api: SmartThingsAPI,
    hapServer: SmartThingsHAPServer,
    pluginManager: PluginManager,
    inclusionManager: DeviceInclusionManager,
    stateFilePath: string,
    pollIntervalSeconds: number = 300
  ) {
    this.api = api;
    this.hapServer = hapServer;
    this.pluginManager = pluginManager;
    this.inclusionManager = inclusionManager;
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

  async initialize(): Promise<void> {
    await this.loadState();

    // Reload devices if we have auth to sync with current inclusion settings
    // This ensures excluded devices are removed from HomeKit on startup
    if (this.api.hasAuth()) {
      // Defer device loading to avoid blocking pairing process
      setTimeout(async () => {
        logger.info('🔄 Syncing devices with inclusion settings and HomeKit...');
        await this.reloadDevices();
      }, 2000);
    } else {
      logger.info('⏸️  Skipping device sync - no authentication available');
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

      await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });
      await fs.writeFile(this.stateFilePath, JSON.stringify(stateToSave, null, 2));
    } catch (error) {
      logger.error({ err: error }, 'Error saving coordinator state');
    }
  }

  /**
   * Reloads all devices from SmartThings and syncs them to HomeKit.
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
      const allDevices = await this.api.getDevices([]);

      // Filter devices based on inclusion settings
      const includedDevices = allDevices.filter(device => {
        const isIncluded = this.inclusionManager.isIncluded(device.deviceId);
        if (!isIncluded) {
          logger.debug({ deviceId: device.deviceId, name: device.name }, 'Device excluded from HomeKit');
        }
        return isIncluded;
      });

      const excludedCount = allDevices.length - includedDevices.length;
      const deviceIds = includedDevices.map(device => device.deviceId);

      logger.info({
        total: allDevices.length,
        included: includedDevices.length,
        excluded: excludedCount
      }, '📱 Found devices');

      logger.debug('🏠 Included devices:');
      includedDevices.forEach(device => {
        logger.debug({
          deviceId: device.deviceId,
          name: device.name,
          capabilities: device.capabilities.map(cap => cap.id)
        }, `  - Device: ${device.name}`);
      });

      // Filter for HVAC devices that should be added to HomeKit
      const hvacDevices = includedDevices.filter(device => {
        const isHVAC = isThermostatLikeDevice(device);

        if (!isHVAC) {
          logger.info({ deviceId: device.deviceId, name: device.name },
            '⏭️  Skipping non-HVAC device for HomeKit (device visible in web UI only)');
        }

        return isHVAC;
      });

      logger.info({
        total: includedDevices.length,
        hvac: hvacDevices.length,
        nonHvac: includedDevices.length - hvacDevices.length
      }, '🌡️  Filtering HVAC devices for HomeKit');

      // Store device metadata for all included devices (needed for capability checks)
      this.deviceMetadata.clear();
      for (const device of includedDevices) {
        this.deviceMetadata.set(device.deviceId, device);
      }

      // Determine which devices should be removed from HomeKit
      const currentDeviceIds = new Set(this.state.pairedDevices);
      const newDeviceIds = new Set(hvacDevices.map(d => d.deviceId));
      const devicesToRemove = Array.from(currentDeviceIds).filter(id => !newDeviceIds.has(id));

      // Remove devices that are no longer included or no longer HVAC
      for (const deviceId of devicesToRemove) {
        try {
          await this.hapServer.removeDevice(deviceId);
          logger.info({ deviceId }, '🗑️  Removed device from HomeKit');
        } catch (error) {
          logger.error({ deviceId, err: error }, '❌ Failed to remove device from HomeKit');
        }
      }

      // Add or update HVAC devices in HAP server
      for (const device of hvacDevices) {
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

      // Update pairedDevices to only track HVAC devices actually in HomeKit
      this.state.pairedDevices = hvacDevices.map(d => d.deviceId);

      logger.info({
        added: hvacDevices.length,
        removed: devicesToRemove.length
      }, '✅ Reloaded devices: synchronized');

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
          const device = this.buildUnifiedDevice(deviceId, deviceState);

          // Allow plugins to modify state before applying to HomeKit
          let stateForHomeKit = await this.pluginManager.beforeSetHomeKitState(device, deviceState);

          if (stateForHomeKit === null) {
            logger.debug({ deviceId }, 'HomeKit state update cancelled by plugin');
            return;
          }

          // Store the state
          this.state.deviceStates.set(deviceId, stateForHomeKit);

          // Update HAP if state changed
          if (previousState) {
            const tempDiff = Math.abs((previousState.currentTemperature || 0) - (deviceState.currentTemperature || 0));
            const setpointDiff = Math.abs((previousState.temperatureSetpoint || 0) - (deviceState.temperatureSetpoint || 0));
            const modeChanged = previousState.mode !== stateForHomeKit.mode;

            const stateChanged = modeChanged || setpointDiff > 0.5 || tempDiff > 0.5;

            if (stateChanged) {
              logger.info({
                deviceName: deviceState.name,
                tempDiff: tempDiff.toFixed(1),
                setpointDiff: setpointDiff.toFixed(1),
                modeChange: modeChanged ? `${previousState.mode} -> ${stateForHomeKit.mode}` : 'unchanged',
              }, '📈 State change detected');
              await this.hapServer.updateDeviceState(deviceId, stateForHomeKit);

              // Notify plugins of state change
              await this.pluginManager.afterDeviceUpdate(device, stateForHomeKit, previousState);
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
  }

  private buildUnifiedDevice(deviceId: string, deviceState: DeviceState): UnifiedDevice {
    // Try to get stored device metadata first
    const metadata = this.deviceMetadata.get(deviceId);

    if (metadata) {
      // Return metadata with updated state
      return {
        ...metadata,
        currentState: deviceState,
        isPaired: true,
        // Update convenience properties from currentState
        currentTemperature: deviceState.currentTemperature,
        heatingSetpoint: deviceState.heatingSetpoint,
        coolingSetpoint: deviceState.coolingSetpoint,
        mode: deviceState.mode,
        temperatureSetpoint: deviceState.temperatureSetpoint,
      };
    }

    // Fallback: build minimal device if metadata not available
    logger.warn({ deviceId }, 'Building device without metadata - capabilities unknown');
    return {
      deviceId,
      label: deviceState.name,
      name: deviceState.name,
      manufacturerName: '',
      presentationId: '',
      deviceTypeName: '',
      capabilities: [],
      components: [],
      thermostatCapabilities: {},
      currentState: deviceState,
      isPaired: true,
      // Convenience properties from currentState
      currentTemperature: deviceState.currentTemperature,
      heatingSetpoint: deviceState.heatingSetpoint,
      coolingSetpoint: deviceState.coolingSetpoint,
      mode: deviceState.mode,
      temperatureSetpoint: deviceState.temperatureSetpoint,
    };
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

    await this.updateDeviceStates();

    // Build unified device array for plugins
    const devices: UnifiedDevice[] = [];
    for (const [deviceId, deviceState] of this.state.deviceStates.entries()) {
      devices.push(this.buildUnifiedDevice(deviceId, deviceState));
    }

    // Let plugins run their poll cycle logic
    await this.pluginManager.onPollCycle(devices);

    await this.saveState();
    logger.debug('✅ Coordinator: Polling complete');
  }

  /**
   * Get a device state by device info (used during initial loading)
   */
  private async getDeviceStateByDevice(device: any): Promise<DeviceState | null> {
    try {
      const status = await this.api.getDeviceStatus(device.deviceId);
      return status;
    } catch (error) {
      logger.error({ err: error, deviceId: device.deviceId }, 'Error getting device state');
      return null;
    }
  }

  /**
   * Handle HomeKit thermostat events (mode/temperature changes)
   */
  async handleThermostatEvent(event: HAPThermostatEvent): Promise<void> {
    try {
      logger.info({ event }, '🎛️  Received HAP thermostat event');

      const currentState = this.state.deviceStates.get(event.deviceId);
      if (!currentState) {
        logger.error({ deviceId: event.deviceId }, 'No state found for device');
        return;
      }

      const device = this.buildUnifiedDevice(event.deviceId, currentState);
      const proposedState = {
        thermostatMode: event.mode,
        heatingSetpoint: event.heatingSetpoint,
        coolingSetpoint: event.coolingSetpoint,
      };

      // Let plugins intercept the state change
      const finalState = await this.pluginManager.beforeSetSmartThingsState(device, proposedState);

      if (finalState === null) {
        logger.info({ deviceId: event.deviceId }, 'State change cancelled by plugin');
        return;
      }

      // Apply state changes to SmartThings
      const commands: any[] = [];

      if (finalState.thermostatMode !== undefined) {
        // Check if device uses airConditionerMode or thermostatMode
        const caps = device.thermostatCapabilities;
        const usesAirConditionerMode = caps.airConditionerMode && !caps.thermostatMode;

        logger.debug({
          deviceId: event.deviceId,
          deviceName: device.label,
          thermostatCapabilities: caps,
          usesAirConditionerMode,
          mode: finalState.thermostatMode
        }, 'Determining which mode capability to use');

        if (usesAirConditionerMode) {
          // Samsung air conditioner - use airConditionerMode capability
          logger.info({ deviceId: event.deviceId, mode: finalState.thermostatMode },
            '🌡️  Using airConditionerMode for Samsung AC');
          commands.push({
            component: 'main',
            capability: 'airConditionerMode',
            command: 'setAirConditionerMode',
            arguments: [finalState.thermostatMode],
          });
        } else {
          // Traditional thermostat - use thermostatMode capability
          logger.info({ deviceId: event.deviceId, mode: finalState.thermostatMode },
            '🌡️  Using thermostatMode for traditional thermostat');
          commands.push({
            component: 'main',
            capability: 'thermostatMode',
            command: 'setThermostatMode',
            arguments: [finalState.thermostatMode],
          });
        }
      }

      if (finalState.heatingSetpoint !== undefined) {
        commands.push({
          component: 'main',
          capability: 'thermostatHeatingSetpoint',
          command: 'setHeatingSetpoint',
          arguments: [finalState.heatingSetpoint],
        });
      }

      if (finalState.coolingSetpoint !== undefined) {
        commands.push({
          component: 'main',
          capability: 'thermostatCoolingSetpoint',
          command: 'setCoolingSetpoint',
          arguments: [finalState.coolingSetpoint],
        });
      }

      if (commands.length > 0) {
        await this.api.executeCommands(event.deviceId, commands);
        logger.info({ deviceId: event.deviceId, commands }, '✅ Commands sent to SmartThings');

        // Update local state
        currentState.mode = finalState.thermostatMode || currentState.mode;
        if (finalState.heatingSetpoint !== undefined) {
          currentState.heatingSetpoint = finalState.heatingSetpoint;
        }
        if (finalState.coolingSetpoint !== undefined) {
          currentState.coolingSetpoint = finalState.coolingSetpoint;
        }
        currentState.lastUpdated = new Date();
        this.state.deviceStates.set(event.deviceId, currentState);
        await this.saveState();
      }
    } catch (error) {
      logger.error({ err: error, deviceId: event.deviceId }, 'Error handling thermostat event');
    }
  }

  /**
   * Returns a copy of all device states.
   */
  getDeviceStates(): Map<string, DeviceState> {
    return new Map(this.state.deviceStates);
  }

  /**
   * Returns a copy of the complete coordinator state.
   */
  getState(): CoordinatorState {
    return {
      ...this.state,
      deviceStates: new Map(this.state.deviceStates),
    };
  }

  /**
   * Get a specific device state
   */
  getDeviceState(deviceId: string): DeviceState | undefined {
    return this.state.deviceStates.get(deviceId);
  }

  /**
   * Expose device getter for plugin context
   */
  getDevice(deviceId: string): UnifiedDevice | undefined {
    const state = this.state.deviceStates.get(deviceId);
    if (!state) return undefined;
    return this.buildUnifiedDevice(deviceId, state);
  }

  /**
   * Get all devices as UnifiedDevice array
   */
  getDevices(): UnifiedDevice[] {
    const devices: UnifiedDevice[] = [];
    for (const [deviceId, deviceState] of this.state.deviceStates.entries()) {
      devices.push(this.buildUnifiedDevice(deviceId, deviceState));
    }
    return devices;
  }

  /**
   * Get array of paired device IDs
   */
  getPairedDeviceIds(): string[] {
    return [...this.state.pairedDevices];
  }

  /**
   * Stop the coordinator
   */
  stop(): void {
    if (this.pollTask) {
      this.pollTask.stop();
      this.pollTask = null;
    }
  }
}
