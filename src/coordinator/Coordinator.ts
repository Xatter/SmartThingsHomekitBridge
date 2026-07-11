import * as cron from 'node-cron';
import { promises as fs } from 'fs';
import { SmartThingsAPI } from '@/api/SmartThingsAPI';
import { SmartThingsHAPServer } from '@/hap/HAPServer';
import { CoordinatorState, DeviceState, UnifiedDevice } from '@/types';
import { HAPThermostatEvent } from '@/hap/HAPServer';
import { logger } from '@/utils/logger';
import { PluginManager } from '@/plugins';
import { DeviceInclusionManager } from '@/config/DeviceInclusionManager';
import { isThermostatLikeDevice } from '@/utils/deviceUtils';
import { atomicWriteJson } from '@/utils/atomicWrite';
import { AsyncMutex, singleFlight } from '@/utils/singleFlight';

/** How long to suppress a stale poll's setpoint/mode from overwriting a HomeKit-initiated
 * command. Must comfortably exceed the time it takes SmartThings to apply a command and
 * for the next poll cycle to observe the new value. */
const ECHO_SUPPRESS_MS = 90_000;

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

  // --- Concurrency control (see class-level notes in reloadDevices/pollDevices) ---
  private readonly mutex = new AsyncMutex();
  /** True while a poll or reload body is actually executing (not merely queued). Used only
   * to decide whether a poll cycle should be skipped - it is not itself a lock. */
  private isBusy = false;
  /** Set by stop(); checked at the top of pollDevices and inside the startup timer
   * callback so neither fires after the coordinator has been stopped. */
  private stopped = false;
  private startupTimer: NodeJS.Timeout | null = null;
  /** deviceId -> epoch ms until which a HomeKit-initiated command's setpoint/mode must not
   * be overwritten by a poll (echo suppression, see updateDeviceStates). */
  private readonly pendingEcho = new Map<string, number>();

  /**
   * All concurrent callers of reloadDevices() coalesce onto a single in-flight run
   * (singleFlight), and that run always executes under `mutex` so it can never interleave
   * with a poll cycle. NOTE: this function itself must never be awaited while `mutex` is
   * already held by the caller - handleThermostatEvent's self-heal path relies on being
   * able to call reloadDevices() without holding the mutex.
   */
  private readonly reloadDevicesCoalesced = singleFlight(() =>
    this.mutex.runExclusive(async () => {
      this.isBusy = true;
      try {
        await this.reloadDevicesInternal();
      } finally {
        this.isBusy = false;
      }
    })
  );

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
    // Node-cron does not support seconds granularity by default.
    // If a sub-minute interval is requested, log a warning and use every minute.
    logger.warn(
      { requestedInterval: seconds },
      'Coordinator: Sub-minute polling intervals are not supported; using every minute instead.'
    );
    return `* * * * *`; // Every minute
  }

  async initialize(): Promise<void> {
    await this.loadState();

    // Reload devices if we have auth to sync with current inclusion settings
    // This ensures excluded devices are removed from HomeKit on startup
    if (this.api.hasAuth()) {
      // Defer device loading to avoid blocking pairing process
      this.startupTimer = setTimeout(async () => {
        this.startupTimer = null;
        if (this.stopped) {
          return;
        }
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

      await atomicWriteJson(this.stateFilePath, stateToSave);
    } catch (error) {
      logger.error({ err: error }, 'Error saving coordinator state');
    }
  }

  /**
   * Reloads all devices from SmartThings and syncs them to HomeKit.
   * Does not remove existing devices - preserves HomeKit stability.
   *
   * Safe to call concurrently: all callers coalesce onto a single in-flight run, and that
   * run is serialized against poll cycles via the same mutex (see reloadDevicesCoalesced).
   */
  async reloadDevices(): Promise<void> {
    await this.reloadDevicesCoalesced();
  }

  private async reloadDevicesInternal(): Promise<void> {
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

      // Store device metadata for all included devices (needed for capability checks).
      // Build the replacement map fully before swapping it in as a single assignment -
      // clearing the existing map in place would leave a window where buildUnifiedDevice
      // falls back to empty capabilities and every plugin hook silently no-ops.
      const newDeviceMetadata = new Map<string, UnifiedDevice>();
      for (const device of includedDevices) {
        newDeviceMetadata.set(device.deviceId, device);
      }
      this.deviceMetadata = newDeviceMetadata;

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

    // Drop expired echo-suppression windows up front.
    const now = Date.now();
    for (const [deviceId, suppressUntil] of this.pendingEcho.entries()) {
      if (now >= suppressUntil) {
        this.pendingEcho.delete(deviceId);
      }
    }

    const promises = this.state.pairedDevices.map(async (deviceId) => {
      try {
        const deviceState = await this.api.getDeviceStatus(deviceId);
        if (deviceState) {
          const previousState = this.state.deviceStates.get(deviceId);
          const device = this.buildUnifiedDevice(deviceId, deviceState);

          // Allow plugins to modify state before applying to HomeKit. This is a
          // DISPLAY-ONLY masked view (e.g. hvac-auto-mode's beforeSetHomeKitState may
          // return { ...state, mode: 'auto' }) - it must never be persisted as the
          // internal device state used for command routing (see fix 7 below).
          let stateForHomeKit = await this.pluginManager.beforeSetHomeKitState(device, deviceState);

          if (stateForHomeKit === null) {
            logger.debug({ deviceId }, 'HomeKit state update cancelled by plugin');
            return;
          }

          // Echo suppression: a poll that read SmartThings before a HomeKit-initiated
          // command has taken effect would otherwise see the stale setpoint/mode and
          // push it back to HomeKit, visually reverting the change the user just made.
          const suppressUntil = this.pendingEcho.get(deviceId);
          if (suppressUntil !== undefined && Date.now() < suppressUntil) {
            const suppressedState: DeviceState = previousState
              ? { ...previousState, currentTemperature: deviceState.currentTemperature, lastUpdated: deviceState.lastUpdated }
              : deviceState;
            this.state.deviceStates.set(deviceId, suppressedState);
            logger.debug({ deviceId }, 'echo-suppressed');
            return;
          }

          // Store the RAW SmartThings state - masked display values (like mode: 'auto')
          // must never corrupt internal state used for command routing.
          this.state.deviceStates.set(deviceId, deviceState);

          // Update HAP if state changed
          if (previousState) {
            // Skip temperature diff calculations if values are undefined (0 is a valid temperature!)
            const tempDiff = (previousState.currentTemperature !== undefined && deviceState.currentTemperature !== undefined)
              ? Math.abs(previousState.currentTemperature - deviceState.currentTemperature)
              : Infinity; // Force update if temperature becomes defined/undefined
            const setpointDiff = (previousState.temperatureSetpoint !== undefined && deviceState.temperatureSetpoint !== undefined)
              ? Math.abs(previousState.temperatureSetpoint - deviceState.temperatureSetpoint)
              : Infinity; // Force update if setpoint becomes defined/undefined
            const modeChanged = previousState.mode !== deviceState.mode;

            const stateChanged = modeChanged || setpointDiff > 0.5 || tempDiff > 0.5;

            if (stateChanged) {
              logger.info({
                deviceName: deviceState.name,
                tempDiff: tempDiff.toFixed(1),
                setpointDiff: setpointDiff.toFixed(1),
                modeChange: modeChanged ? `${previousState.mode} -> ${deviceState.mode}` : 'unchanged',
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

  /**
   * node-cron does not await this callback, so cycles can overlap if a previous cycle (or
   * an in-flight reloadDevices()) is still running. Rather than queueing behind it - which
   * would pile up stale work - an overlapping cycle is skipped entirely. The actual poll
   * body still runs under `mutex` so it can never interleave with a reloadDevices() run.
   */
  private async pollDevices(): Promise<void> {
    if (this.stopped) {
      return;
    }

    if (!this.api.hasAuth()) {
      logger.warn('Coordinator polling: No SmartThings authentication');
      return;
    }

    if (this.isBusy) {
      logger.info('⏭️  Skipping poll cycle - a poll or reload is already running');
      return;
    }

    this.isBusy = true;
    try {
      await this.mutex.runExclusive(() => this.pollDevicesInternal());
    } finally {
      this.isBusy = false;
    }
  }

  private async pollDevicesInternal(): Promise<void> {
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

      let device = this.buildUnifiedDevice(event.deviceId, currentState);

      // Device capability metadata is cached in-memory and can go stale (e.g. it's only
      // populated by reloadDevices(), which normally only runs once at startup). Sending a
      // mode-change command with unknown capabilities defaults to the wrong SmartThings
      // capability (e.g. thermostatMode instead of airConditionerMode for Samsung ACs) and
      // SmartThings rejects it outright. Self-heal by refreshing the cache before giving up.
      if (Object.keys(device.thermostatCapabilities).length === 0) {
        logger.warn({ deviceId: event.deviceId },
          '⚠️  Device capabilities unknown - refreshing device metadata before sending command');
        await this.reloadDevices();
        device = this.buildUnifiedDevice(event.deviceId, this.state.deviceStates.get(event.deviceId) || currentState);

        if (Object.keys(device.thermostatCapabilities).length === 0) {
          logger.error({ deviceId: event.deviceId },
            '❌ Device capabilities still unknown after refresh - refusing to guess, aborting command');
          return;
        }
      }

      // Map generic temperature to appropriate setpoint based on current mode
      // HAPServer sends 'temperature' for single setpoint changes, which we need to
      // convert to heatingSetpoint or coolingSetpoint based on the device's current mode
      let heatingSetpoint = event.heatingSetpoint;
      let coolingSetpoint = event.coolingSetpoint;

      if (event.temperature !== undefined && heatingSetpoint === undefined && coolingSetpoint === undefined) {
        const currentMode = event.mode || currentState.mode;
        if (currentMode === 'heat') {
          heatingSetpoint = event.temperature;
          logger.debug({ deviceId: event.deviceId, temperature: event.temperature },
            'Mapping temperature to heatingSetpoint (device in heat mode)');
        } else {
          // For cool, auto, or off modes, use cooling setpoint
          coolingSetpoint = event.temperature;
          logger.debug({ deviceId: event.deviceId, temperature: event.temperature },
            'Mapping temperature to coolingSetpoint (device in cool/auto/off mode)');
        }
      }

      const proposedState = {
        thermostatMode: event.mode,
        heatingSetpoint,
        coolingSetpoint,
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
          // Samsung air conditioner - uses switch for on/off, airConditionerMode for heat/cool/etc.
          if (finalState.thermostatMode === 'off') {
            // Turn off using switch capability (Samsung ACs don't have "off" as a mode)
            logger.info({ deviceId: event.deviceId },
              '🔌 Turning off Samsung AC via switch');
            commands.push({
              component: 'main',
              capability: 'switch',
              command: 'off',
              arguments: [],
            });
          } else {
            // First turn on the AC if it's off, then set the mode
            if (currentState.switchState === 'off' || currentState.switchState === undefined) {
              logger.info({ deviceId: event.deviceId },
                '🔌 Turning on Samsung AC via switch');
              commands.push({
                component: 'main',
                capability: 'switch',
                command: 'on',
                arguments: [],
              });
            }
            logger.info({ deviceId: event.deviceId, mode: finalState.thermostatMode },
              '🌡️  Setting airConditionerMode for Samsung AC');
            commands.push({
              component: 'main',
              capability: 'airConditionerMode',
              command: 'setAirConditionerMode',
              arguments: [finalState.thermostatMode],
            });
          }
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
        const caps = device.thermostatCapabilities;
        // Samsung ACs don't have thermostatHeatingSetpoint - use coolingSetpoint for all temps
        if (caps.thermostatHeatingSetpoint) {
          commands.push({
            component: 'main',
            capability: 'thermostatHeatingSetpoint',
            command: 'setHeatingSetpoint',
            arguments: [finalState.heatingSetpoint],
          });
        } else if (caps.thermostatCoolingSetpoint) {
          // Fallback: use cooling setpoint (Samsung ACs use this for all modes)
          logger.info({ deviceId: event.deviceId, setpoint: finalState.heatingSetpoint },
            '🌡️  Using coolingSetpoint for heating (Samsung AC)');
          commands.push({
            component: 'main',
            capability: 'thermostatCoolingSetpoint',
            command: 'setCoolingSetpoint',
            arguments: [finalState.heatingSetpoint],
          });
        }
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

        // Echo suppression: a poll that reads SmartThings before this command has taken
        // effect would otherwise see the stale setpoint/mode and push it right back to
        // HomeKit, visually reverting the change the user just made.
        this.pendingEcho.set(event.deviceId, Date.now() + ECHO_SUPPRESS_MS);

        // Copy-on-write: never mutate the DeviceState object that's stored in the map -
        // updateDeviceStates() may be concurrently reading or replacing it.
        const updatedState: DeviceState = { ...currentState };
        updatedState.mode = finalState.thermostatMode || updatedState.mode;
        if (finalState.heatingSetpoint !== undefined) {
          updatedState.heatingSetpoint = finalState.heatingSetpoint;
          // Update temperatureSetpoint if in heat mode
          if (updatedState.mode === 'heat') {
            updatedState.temperatureSetpoint = finalState.heatingSetpoint;
          }
        }
        if (finalState.coolingSetpoint !== undefined) {
          updatedState.coolingSetpoint = finalState.coolingSetpoint;
          // Update temperatureSetpoint if in cool/auto/off mode
          if (updatedState.mode !== 'heat') {
            updatedState.temperatureSetpoint = finalState.coolingSetpoint;
          }
        }
        updatedState.lastUpdated = new Date();
        this.state.deviceStates.set(event.deviceId, updatedState);
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
    this.stopped = true;

    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }

    if (this.pollTask) {
      this.pollTask.stop();
      this.pollTask = null;
    }
  }
}
