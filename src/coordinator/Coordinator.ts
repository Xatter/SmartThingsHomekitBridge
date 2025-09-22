import * as cron from 'node-cron';
import { promises as fs } from 'fs';
import { SmartThingsAPI } from '@/api/SmartThingsAPI';
import { LightingMonitor } from '@/monitoring/LightingMonitor';
import { CoordinatorState, DeviceState, MatterThermostatEvent, UnifiedDevice } from '@/types';

export class Coordinator {
  private readonly api: SmartThingsAPI;
  private readonly lightingMonitor: LightingMonitor;
  private readonly stateFilePath: string;
  private state: CoordinatorState;
  private pollTask: cron.ScheduledTask | null = null;
  private readonly pollInterval: string;

  constructor(
    api: SmartThingsAPI,
    lightingMonitor: LightingMonitor,
    stateFilePath: string,
    pollIntervalSeconds: number = 300
  ) {
    this.api = api;
    this.lightingMonitor = lightingMonitor;
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
    await this.reloadDevices();
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

      this.state.pairedDevices = deviceIds;
      this.lightingMonitor.setDevices(deviceIds);

      console.log(`✅ Reloaded devices: Found ${deviceIds.length} HVAC devices`);

      await this.updateDeviceStates();
      await this.saveState();
    } catch (error) {
      console.error('❌ Error reloading devices:', error);
    }
  }

  private async updateDeviceStates(): Promise<void> {
    const promises = this.state.pairedDevices.map(async (deviceId) => {
      try {
        const deviceState = await this.api.getDeviceStatus(deviceId);
        if (deviceState) {
          this.state.deviceStates.set(deviceId, deviceState);
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

    console.log('Coordinator: Polling devices for state changes');

    const previousAverageTemp = this.state.averageTemperature;
    await this.updateDeviceStates();

    if (Math.abs(this.state.averageTemperature - previousAverageTemp) > 0.5) {
      console.log(`Temperature change detected: ${previousAverageTemp}°F -> ${this.state.averageTemperature}°F`);
      await this.synchronizeTemperatures();
    }

    await this.saveState();
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

  async handleMatterThermostatEvent(event: MatterThermostatEvent): Promise<void> {
    console.log(`Handling Matter thermostat event for device ${event.deviceId}:`, event);

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
          await this.changeMode(event.deviceId, event.mode);
        }
      }
    } catch (error) {
      console.error(`Error handling Matter event for device ${event.deviceId}:`, error);
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