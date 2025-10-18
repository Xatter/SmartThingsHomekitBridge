import { promises as fs } from 'fs';
import * as path from 'path';
import { Logger } from 'pino';
import { PluginContext as IPluginContext } from './types';
import { UnifiedDevice } from '@/types';
import { SmartThingsAPI } from '@/api/SmartThingsAPI';
import { SmartThingsHAPServer } from '@/hap/HAPServer';

/**
 * Implementation of PluginContext interface
 * Provides plugins with controlled access to bridge functionality
 */
export class PluginContextImpl implements IPluginContext {
  public readonly pluginName: string;
  public readonly logger: Logger;
  public readonly config: any;

  private readonly getDevicesImpl: () => UnifiedDevice[];
  private readonly getDeviceImpl: (deviceId: string) => UnifiedDevice | undefined;
  private readonly api: SmartThingsAPI;
  private readonly hapServer: SmartThingsHAPServer;
  private readonly persistPath: string;

  constructor(
    pluginName: string,
    logger: Logger,
    config: any,
    getDevicesImpl: () => UnifiedDevice[],
    getDeviceImpl: (deviceId: string) => UnifiedDevice | undefined,
    api: SmartThingsAPI,
    hapServer: SmartThingsHAPServer,
    persistPath: string
  ) {
    this.pluginName = pluginName;
    this.logger = logger;
    this.config = config;
    this.getDevicesImpl = getDevicesImpl;
    this.getDeviceImpl = getDeviceImpl;
    this.api = api;
    this.hapServer = hapServer;
    this.persistPath = path.join(persistPath, 'plugins', pluginName);
  }

  getDevices(): UnifiedDevice[] {
    return this.getDevicesImpl();
  }

  getDevice(deviceId: string): UnifiedDevice | undefined {
    return this.getDeviceImpl(deviceId);
  }

  async setSmartThingsState(deviceId: string, state: any): Promise<any> {
    this.logger.debug({ deviceId, state }, 'Plugin requesting SmartThings state update');

    const device = this.getDevice(deviceId);
    if (!device) {
      throw new Error(`Device ${deviceId} not found`);
    }

    // Apply state changes to SmartThings
    const commands: any[] = [];

    if (state.thermostatMode !== undefined) {
      commands.push({
        component: 'main',
        capability: 'thermostatMode',
        command: 'setThermostatMode',
        arguments: [state.thermostatMode],
      });
    }

    if (state.heatingSetpoint !== undefined) {
      commands.push({
        component: 'main',
        capability: 'thermostatHeatingSetpoint',
        command: 'setHeatingSetpoint',
        arguments: [state.heatingSetpoint],
      });
    }

    if (state.coolingSetpoint !== undefined) {
      commands.push({
        component: 'main',
        capability: 'thermostatCoolingSetpoint',
        command: 'setCoolingSetpoint',
        arguments: [state.coolingSetpoint],
      });
    }

    if (commands.length > 0) {
      await this.api.executeCommands(deviceId, commands);
    }

    // Return the new state from SmartThings
    const updatedStatus = await this.api.getDeviceStatus(deviceId);
    return updatedStatus;
  }

  async setHomeKitState(deviceId: string, state: any): Promise<void> {
    this.logger.debug({ deviceId, state }, 'Plugin requesting HomeKit state update');

    const device = this.getDevice(deviceId);
    if (!device) {
      throw new Error(`Device ${deviceId} not found`);
    }

    // Update HomeKit accessory state
    await this.hapServer.updateDeviceState(deviceId, state);
  }

  async saveState(key: string, data: any): Promise<void> {
    await fs.mkdir(this.persistPath, { recursive: true });
    const filePath = path.join(this.persistPath, `${key}.json`);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    this.logger.debug({ key, filePath }, 'Plugin state saved');
  }

  async loadState<T = any>(key: string): Promise<T | undefined> {
    const filePath = path.join(this.persistPath, `${key}.json`);
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      this.logger.debug({ key, filePath }, 'Plugin state loaded');
      return JSON.parse(data) as T;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        this.logger.debug({ key, filePath }, 'Plugin state file not found');
        return undefined;
      }
      throw error;
    }
  }
}
