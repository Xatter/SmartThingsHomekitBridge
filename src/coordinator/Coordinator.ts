import * as cron from 'node-cron';
import { promises as fs } from 'fs';
import * as path from 'path';
import { SmartThingsAPI } from '@/api/SmartThingsAPI';
import { LightingMonitor } from '@/monitoring/LightingMonitor';
import { SmartThingsHAPServer } from '@/hap/HAPServer';
import { CoordinatorState, DeviceState, UnifiedDevice } from '@/types';
import { HAPThermostatEvent } from '@/hap/HAPServer';
import { AutoModeController, AutoModeDevice } from '@/controller/AutoModeController';

export class Coordinator {
  private readonly api: SmartThingsAPI;
  private readonly lightingMonitor: LightingMonitor;
  private readonly hapServer: SmartThingsHAPServer;
  private readonly stateFilePath: string;
  private readonly autoModeController: AutoModeController;
  private state: CoordinatorState;
  private pollTask: cron.ScheduledTask | null = null;
  private readonly pollInterval: string;

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

      console.log(`Loaded coordinator state: ${this.state.pairedDevices.length} paired devices`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Error loading coordinator state:', error);
      } else {
        console.log('No existing coordinator state found, starting fresh');
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
      console.error('Error saving coordinator state:', error);
    }
  }

  async reloadDevices(): Promise<void> {
    if (!this.api.hasAuth()) {
      console.warn('Cannot reload devices: No SmartThings authentication');
      return;
    }

    console.log('⏳ Reloading devices - this may take a moment...');

    try {
      console.log('🔍 Reloading devices from SmartThings...');
      const filteredDevices = await this.api.getDevices([]);
      const deviceIds = filteredDevices.map(device => device.deviceId);

      console.log(`📱 Found ${filteredDevices.length} HVAC devices`);
      console.log('🏠 HVAC devices found:');
      filteredDevices.forEach(device => {
        console.log(`  - ${device.name} (${device.deviceId})`);
        console.log(`    Capabilities: ${device.capabilities.map(cap => cap.id).join(', ')}`);
        console.log(`    Thermostat capabilities: ${Object.entries(device.thermostatCapabilities).filter(([_, value]) => value).map(([key, _]) => key).join(', ')}`);
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
            console.error(`❌ Failed to add ${device.name} to HomeKit bridge:`, error);
          }
        }
      }

      console.log(`✅ Reloaded devices: ${deviceIds.length} HVAC devices synchronized`);

      await this.updateDeviceStates();
      await this.saveState();
    } catch (error) {
      console.error('❌ Error reloading devices:', error);
    }
  }

  private async updateDeviceStates(): Promise<void> {
    console.log(`📊 Coordinator: Updating device states at ${new Date().toISOString()}`);

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
              console.log(`📈 State change detected for ${deviceState.name}:`);
              console.log(`   Temp: ${tempDiff.toFixed(1)}°F diff, Setpoint: ${setpointDiff.toFixed(1)}°F diff, Mode: ${modeChanged ? `${previousState.mode} -> ${deviceState.mode}` : 'unchanged'}`);
              await this.hapServer.updateDeviceState(deviceId, deviceState);
            } else {
              console.log(`   No significant changes for ${deviceState.name}`);
            }
          } else {
            console.log(`   First state update for ${deviceState.name}`);
            await this.hapServer.updateDeviceState(deviceId, deviceState);
          }
        }
      } catch (error) {
        console.error(`Error updating state for device ${deviceId}:`, error);
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

    console.log(`Starting coordinator polling with interval: ${this.pollInterval}`);

    this.pollTask = cron.schedule(this.pollInterval, async () => {
      await this.pollDevices();
    }, {
      scheduled: true,
      timezone: 'UTC'
    });
  }

  private async pollDevices(): Promise<void> {
    if (!this.api.hasAuth()) {
      console.warn('Coordinator polling: No SmartThings authentication');
      return;
    }

    console.log(`⏰ Coordinator: Polling devices at ${new Date().toISOString()}`);

    const previousAverageTemp = this.state.averageTemperature;
    await this.updateDeviceStates();

    // Clean up stale enrolled devices
    await this.cleanupStaleEnrolledDevices();

    // Evaluate and apply auto-mode if devices are enrolled
    await this.evaluateAndApplyAutoMode();

    if (Math.abs(this.state.averageTemperature - previousAverageTemp) > 0.5) {
      console.log(`Temperature change detected: ${previousAverageTemp}°F -> ${this.state.averageTemperature}°F`);
      await this.synchronizeTemperatures();
    }

    await this.saveState();
    console.log(`✅ Coordinator: Polling complete at ${new Date().toISOString()}`);
  }

  private async synchronizeTemperatures(): Promise<void> {
    const targetTemp = this.state.averageTemperature;
    const currentMode = this.state.currentMode;

    if (currentMode === 'off' || currentMode === 'auto') {
      return;
    }

    console.log(`Synchronizing all devices to ${targetTemp}°F in ${currentMode} mode`);

    const promises = this.state.pairedDevices.map(async (deviceId) => {
      try {
        const currentState = this.state.deviceStates.get(deviceId);
        if (currentState && Math.abs(currentState.temperatureSetpoint - targetTemp) > 0.5) {
          await this.changeTemperature(deviceId, targetTemp);
        }
      } catch (error) {
        console.error(`Error synchronizing temperature for device ${deviceId}:`, error);
      }
    });

    await Promise.allSettled(promises);
  }

  async changeTemperature(deviceId: string, temperature: number): Promise<boolean> {
    const currentState = this.state.deviceStates.get(deviceId);
    if (!currentState) {
      console.error(`Cannot change temperature: No state found for device ${deviceId}`);
      return false;
    }

    const mode = currentState.mode === 'auto' ? 'cool' : currentState.mode;
    if (mode === 'off') {
      console.warn(`Cannot set temperature for device ${deviceId}: mode is 'off'`);
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

    console.log(`Synchronizing all ON devices to ${newMode} mode`);

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
        console.error(`Error synchronizing mode for device ${deviceId}:`, error);
      }
    });

    await Promise.allSettled(promises);
    this.state.currentMode = newMode;
  }

  getDeviceStates(): Map<string, DeviceState> {
    return new Map(this.state.deviceStates);
  }

  getState(): CoordinatorState {
    return {
      ...this.state,
      deviceStates: new Map(this.state.deviceStates),
    };
  }

  getAutoModeController(): AutoModeController {
    return this.autoModeController;
  }

  async getDevices(): Promise<UnifiedDevice[]> {
    if (!this.api.hasAuth()) {
      console.warn('Cannot get devices: No SmartThings authentication');
      return [];
    }

    try {
      return await this.api.getDevices(this.state.pairedDevices);
    } catch (error) {
      console.error('Error getting unified devices:', error);
      return [];
    }
  }

  async handleHAPThermostatEvent(event: HAPThermostatEvent): Promise<void> {
    console.log(`Handling HAP thermostat event for device ${event.deviceId}:`, event);

    const currentState = this.state.deviceStates.get(event.deviceId);
    if (!currentState) {
      console.error(`No state found for device ${event.deviceId}`);
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
            console.log(`🤖 Device ${event.deviceId} switching to AUTO mode - enrolling in AutoModeController`);
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
              console.log(`🔓 Device ${event.deviceId} leaving AUTO mode - unenrolling from AutoModeController`);
              await this.autoModeController.unenrollDevice(event.deviceId);
            }

            // Normal mode change (heat/cool/off) - send to SmartThings
            await this.changeMode(event.deviceId, event.mode);
          }
        }
      }
    } catch (error) {
      console.error(`Error handling HAP thermostat event for device ${event.deviceId}:`, error);
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
      console.log(`🧹 Cleaning up ${staleDevices.length} stale enrolled device(s) that no longer exist`);
      for (const deviceId of staleDevices) {
        await this.autoModeController.unenrollDevice(deviceId);
        console.log(`   Unenrolled: ${deviceId}`);
      }
    }
  }

  /**
   * Evaluates all auto-mode enrolled devices and applies the controller's decision
   */
  private async evaluateAndApplyAutoMode(): Promise<void> {
    const enrolledIds = this.autoModeController.getEnrolledDeviceIds();
    if (enrolledIds.length === 0) {
      console.log('⏩ No devices enrolled in auto mode, skipping evaluation');
      return;
    }

    console.log(`🤖 Evaluating auto mode for ${enrolledIds.length} enrolled devices`);

    // Gather device information for evaluation
    const autoModeDevices: AutoModeDevice[] = [];
    const invalidDeviceIds: string[] = [];

    for (const deviceId of enrolledIds) {
      const state = this.state.deviceStates.get(deviceId);
      if (!state) {
        console.warn(`⚠️  Enrolled device ${deviceId} has no state, skipping`);
        invalidDeviceIds.push(deviceId);
        continue;
      }

      // Validate temperature values
      if (!this.isValidTemperature(state.currentTemperature)) {
        console.warn(`⚠️  Device ${state.name} (${deviceId}) has invalid current temperature: ${state.currentTemperature}, skipping`);
        invalidDeviceIds.push(deviceId);
        continue;
      }

      if (!this.isValidTemperature(state.temperatureSetpoint)) {
        console.warn(`⚠️  Device ${state.name} (${deviceId}) has invalid temperature setpoint: ${state.temperatureSetpoint}, skipping`);
        invalidDeviceIds.push(deviceId);
        continue;
      }

      // Use heating/cooling setpoints as thresholds
      // If not available, use temperatureSetpoint ± 2°F as fallback
      const lowerBound = state.heatingSetpoint || (state.temperatureSetpoint - 2);
      const upperBound = state.coolingSetpoint || (state.temperatureSetpoint + 2);

      // Validate bounds are reasonable
      if (!this.isValidTemperature(lowerBound) || !this.isValidTemperature(upperBound)) {
        console.warn(`⚠️  Device ${state.name} (${deviceId}) has invalid temperature bounds (L:${lowerBound}, U:${upperBound}), skipping`);
        invalidDeviceIds.push(deviceId);
        continue;
      }

      if (lowerBound >= upperBound) {
        console.warn(`⚠️  Device ${state.name} (${deviceId}) has invalid bounds: lower (${lowerBound}) >= upper (${upperBound}), skipping`);
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
      console.log(`⚠️  ${invalidDeviceIds.length} enrolled device(s) have invalid state`);
    }

    if (autoModeDevices.length === 0) {
      console.log('⏩ No valid device states for auto mode evaluation');
      return;
    }

    // Evaluate and get controller decision
    const decision = this.autoModeController.evaluate(autoModeDevices);
    console.log(`🎯 Auto mode decision: ${decision.mode}`);
    console.log(`   Heat demand: ${decision.totalHeatDemand.toFixed(1)}, Cool demand: ${decision.totalCoolDemand.toFixed(1)}`);
    console.log(`   Reason: ${decision.reason}`);

    if (decision.switchSuppressed) {
      console.log(`   ⏸️  Mode switch suppressed (${decision.secondsUntilSwitchAllowed}s remaining)`);
    }

    // Apply decision to all enrolled devices
    const modeChanged = await this.autoModeController.applyDecision(decision);
    if (modeChanged) {
      console.log(`🔄 Applying ${decision.mode} mode to all enrolled devices`);

      // Set all enrolled devices to the determined mode
      const promises = enrolledIds.map(async (deviceId) => {
        try {
          const currentState = this.state.deviceStates.get(deviceId);
          if (!currentState) {
            console.warn(`   ⚠️  Device ${deviceId} has no state, skipping mode application`);
            return { deviceId, success: false, reason: 'No state' };
          }

          // Update SmartThings device
          const success = await this.api.setMode(deviceId, decision.mode as 'heat' | 'cool' | 'off');

          if (!success) {
            console.error(`   ✗ Failed to set mode for ${currentState.name} (API returned false)`);
            return { deviceId, success: false, reason: 'API failed' };
          }

          // Update local state (keep mode as 'auto' in our state, actual mode is tracked by controller)
          currentState.lastUpdated = new Date();
          this.state.deviceStates.set(deviceId, currentState);

          console.log(`   ✓ Set ${currentState.name} to ${decision.mode}`);
          return { deviceId, success: true };
        } catch (error) {
          console.error(`   ✗ Failed to set mode for device ${deviceId}:`, error);
          return { deviceId, success: false, reason: 'Exception', error };
        }
      });

      const results = await Promise.allSettled(promises);
      const successCount = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
      const failureCount = results.length - successCount;

      if (failureCount > 0) {
        console.log(`⚠️  Auto mode application completed with ${failureCount} failure(s) and ${successCount} success(es)`);
      } else {
        console.log(`✅ Auto mode application complete (${successCount} device(s) updated)`);
      }

      await this.saveState();
    } else {
      console.log(`   No mode change needed (staying in ${decision.mode})`);
    }
  }

  private async getDeviceStateByDevice(device: UnifiedDevice): Promise<DeviceState | null> {
    try {
      const status = await this.api.getDeviceStatus(device.deviceId);
      if (!status) {
        console.error(`No status returned for device ${device.name}`);
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
      console.error(`Failed to get device state for ${device.name}:`, error);
      return null;
    }
  }

  stop(): void {
    if (this.pollTask) {
      this.pollTask.stop();
      this.pollTask = null;
      console.log('Coordinator polling stopped');
    }
  }
}