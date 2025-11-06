import { promises as fs } from 'fs';
import * as path from 'path';
import { logger } from '@/utils/logger';

/**
 * Represents a device participating in auto-mode coordination
 */
export interface AutoModeDevice {
  /** Device ID */
  id: string;
  /** Device name for logging */
  name: string;
  /** Current temperature in Fahrenheit */
  currentTemperature: number;
  /** Lower bound (heating threshold) in Fahrenheit */
  lowerBound: number;
  /** Upper bound (cooling threshold) in Fahrenheit */
  upperBound: number;
  /** Weight/priority for this device (default: 1.0) */
  weight: number;
}

/**
 * Demand calculation result for a device
 */
export interface DeviceDemand {
  deviceId: string;
  deviceName: string;
  heatDemand: number;  // Weighted heat demand
  coolDemand: number;  // Weighted cool demand
  rawHeatDelta: number;  // Degrees below lower bound
  rawCoolDelta: number;  // Degrees above upper bound
}

/**
 * Decision made by the controller
 */
export interface ControllerDecision {
  /** Desired global mode */
  mode: 'heat' | 'cool' | 'off';
  /** Total heat demand across all devices */
  totalHeatDemand: number;
  /** Total cool demand across all devices */
  totalCoolDemand: number;
  /** Per-device demand breakdown */
  deviceDemands: DeviceDemand[];
  /** Why this mode was selected */
  reason: string;
  /** Whether a mode switch was suppressed by timing locks */
  switchSuppressed: boolean;
  /** Time until next switch allowed (seconds), or 0 if now */
  secondsUntilSwitchAllowed: number;
}

/**
 * Persistent state for the auto-mode controller
 */
interface ControllerState {
  /** Current global mode */
  currentMode: 'heat' | 'cool' | 'off';
  /** Timestamp of last mode switch (epoch ms) */
  lastSwitchTime: number;
  /** Timestamp when compressor last turned on (epoch ms) */
  lastOnTime: number;
  /** Timestamp when compressor last turned off (epoch ms) */
  lastOffTime: number;
  /** List of device IDs enrolled in auto mode */
  enrolledDeviceIds: string[];
}

/**
 * Configuration parameters for the auto-mode controller
 */
export interface ControllerConfig {
  /** Hysteresis below heating threshold (°F) */
  heatHysteresis: number;
  /** Hysteresis above cooling threshold (°F) */
  coolHysteresis: number;
  /** Flip guard margin for shoulder seasons (°F) */
  flipGuard: number;
  /** Minimum compressor runtime (seconds) */
  minOnTime: number;
  /** Minimum off-time before restart (seconds) */
  minOffTime: number;
  /** Minimum time before mode flip (seconds) */
  minLockTime: number;
  /** Relative dominance threshold (fraction, e.g., 0.25 = 25%) */
  relativeDominanceThreshold: number;
  /** Absolute demand gap threshold (°F) */
  absoluteDominanceThreshold: number;
  /** Freeze protection temperature (°F) */
  freezeProtectionTemp: number;
  /** High temperature protection (°F) */
  highTempProtectionTemp: number;
}

/**
 * Multi-device HVAC auto-mode coordinator.
 *
 * Implements a sophisticated control algorithm for coordinating multiple
 * HVAC devices that share a single outdoor compressor. Uses weighted
 * demand voting with timing protections to balance comfort across devices
 * while preventing compressor damage and mode thrashing.
 *
 * Key features:
 * - Proportional demand calculation based on temperature deviation
 * - Weighted voting with hysteresis for conflict resolution
 * - Timing protections (minimum on/off/lock times)
 * - Flip guard for shoulder-season stability
 * - Freeze and high-temperature protection
 * - State persistence across restarts
 */
export class AutoModeController {
  private state: ControllerState;
  private readonly statePath: string;
  private readonly config: ControllerConfig;

  /**
   * Creates a new auto-mode controller.
   * @param statePath - Path to persist controller state
   * @param config - Optional configuration overrides
   */
  constructor(statePath: string, config?: Partial<ControllerConfig>) {
    this.statePath = statePath;

    // Default configuration based on the algorithm specification
    this.config = {
      heatHysteresis: 0.7,
      coolHysteresis: 0.7,
      flipGuard: 2.0,
      minOnTime: 600,     // 10 minutes
      minOffTime: 300,    // 5 minutes
      minLockTime: 1800,  // 30 minutes
      relativeDominanceThreshold: 0.25,  // 25%
      absoluteDominanceThreshold: 2.0,    // 2.0°F
      freezeProtectionTemp: 50,
      highTempProtectionTemp: 90,
      ...config,
    };

    // Initialize state
    this.state = {
      currentMode: 'off',
      lastSwitchTime: 0,
      lastOnTime: 0,
      lastOffTime: 0,
      enrolledDeviceIds: [],
    };
  }

  /**
   * Loads persisted state from disk.
   */
  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.statePath, 'utf-8');
      this.state = JSON.parse(data);
      logger.info({
        mode: this.state.currentMode,
        enrolledCount: this.state.enrolledDeviceIds.length,
      }, 'Auto-mode controller state loaded');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ err: error }, 'Error loading auto-mode controller state');
      }
      // If file doesn't exist, keep default initialized state
    }
  }

  /**
   * Persists current state to disk.
   */
  async save(): Promise<void> {
    try {
      const dir = path.dirname(this.statePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.statePath, JSON.stringify(this.state, null, 2));
      logger.debug('Auto-mode controller state saved');
    } catch (error) {
      logger.error({ err: error }, 'Error saving auto-mode controller state');
      throw error;
    }
  }

  /**
   * Enrolls a device in auto-mode coordination.
   * @param deviceId - Device to enroll
   */
  async enrollDevice(deviceId: string): Promise<void> {
    if (!this.state.enrolledDeviceIds.includes(deviceId)) {
      this.state.enrolledDeviceIds.push(deviceId);
      await this.save();
      logger.info({ deviceId, totalEnrolled: this.state.enrolledDeviceIds.length }, 'Device enrolled in auto mode');
    }
  }

  /**
   * Removes a device from auto-mode coordination.
   * @param deviceId - Device to unenroll
   */
  async unenrollDevice(deviceId: string): Promise<void> {
    const index = this.state.enrolledDeviceIds.indexOf(deviceId);
    if (index !== -1) {
      this.state.enrolledDeviceIds.splice(index, 1);
      await this.save();
      logger.info({ deviceId, totalEnrolled: this.state.enrolledDeviceIds.length }, 'Device unenrolled from auto mode');
    }
  }

  /**
   * Gets list of enrolled device IDs.
   */
  getEnrolledDeviceIds(): string[] {
    return [...this.state.enrolledDeviceIds];
  }

  /**
   * Gets current global mode.
   */
  getCurrentMode(): 'heat' | 'cool' | 'off' {
    return this.state.currentMode;
  }

  /**
   * Gets configuration.
   */
  getConfig(): ControllerConfig {
    return { ...this.config };
  }

  /**
   * Calculates demand for a single device.
   */
  private calculateDeviceDemand(device: AutoModeDevice): DeviceDemand {
    const { id, name, currentTemperature, lowerBound, upperBound, weight } = device;

    // Raw deltas (how far outside comfort band)
    let rawHeatDelta = Math.max(0, lowerBound - currentTemperature);
    let rawCoolDelta = Math.max(0, currentTemperature - upperBound);

    // Apply flip guard relative to current mode
    if (this.state.currentMode === 'cool') {
      // If running cool, suppress heat demand unless significantly below threshold
      const heatThreshold = lowerBound - this.config.heatHysteresis - this.config.flipGuard;
      if (currentTemperature >= heatThreshold) {
        rawHeatDelta = 0;
      }
    } else if (this.state.currentMode === 'heat') {
      // If running heat, suppress cool demand unless significantly above threshold
      const coolThreshold = upperBound + this.config.coolHysteresis + this.config.flipGuard;
      if (currentTemperature <= coolThreshold) {
        rawCoolDelta = 0;
      }
    }

    // Weighted demands
    const heatDemand = weight * rawHeatDelta;
    const coolDemand = weight * rawCoolDelta;

    return {
      deviceId: id,
      deviceName: name,
      heatDemand,
      coolDemand,
      rawHeatDelta,
      rawCoolDelta,
    };
  }

  /**
   * Evaluates all enrolled devices and determines the optimal mode.
   *
   * @param devices - Current state of all enrolled devices
   * @returns Decision including mode, demands, and reasoning
   */
  evaluate(devices: AutoModeDevice[]): ControllerDecision {
    const now = Date.now();

    // Filter to only enrolled devices
    const enrolledDevices = devices.filter(d =>
      this.state.enrolledDeviceIds.includes(d.id)
    );

    // Calculate demands for each device
    const deviceDemands = enrolledDevices.map(d => this.calculateDeviceDemand(d));

    // Total demands
    const totalHeatDemand = deviceDemands.reduce((sum, d) => sum + d.heatDemand, 0);
    const totalCoolDemand = deviceDemands.reduce((sum, d) => sum + d.coolDemand, 0);

    // Safety checks
    const hasFreezeDanger = enrolledDevices.some(d =>
      d.currentTemperature < this.config.freezeProtectionTemp
    );
    const hasHighTempDanger = enrolledDevices.some(d =>
      d.currentTemperature > this.config.highTempProtectionTemp
    );

    if (hasFreezeDanger) {
      return {
        mode: 'heat',
        totalHeatDemand,
        totalCoolDemand,
        deviceDemands,
        reason: `Freeze protection activated (device below ${this.config.freezeProtectionTemp}°F)`,
        switchSuppressed: false,
        secondsUntilSwitchAllowed: 0,
      };
    }

    if (hasHighTempDanger) {
      return {
        mode: 'cool',
        totalHeatDemand,
        totalCoolDemand,
        deviceDemands,
        reason: `High temperature protection activated (device above ${this.config.highTempProtectionTemp}°F)`,
        switchSuppressed: false,
        secondsUntilSwitchAllowed: 0,
      };
    }

    // Determine desired mode using algorithm
    const decision = this.decideMode(totalHeatDemand, totalCoolDemand, now);

    return {
      mode: decision.mode,
      totalHeatDemand,
      totalCoolDemand,
      deviceDemands,
      reason: decision.reason,
      switchSuppressed: decision.switchSuppressed,
      secondsUntilSwitchAllowed: decision.secondsUntilSwitchAllowed,
    };
  }

  /**
   * Core decision logic: determines which mode to run based on demands.
   */
  private decideMode(
    heatTotal: number,
    coolTotal: number,
    now: number
  ): { mode: 'heat' | 'cool' | 'off'; reason: string; switchSuppressed: boolean; secondsUntilSwitchAllowed: number } {
    const current = this.state.currentMode;

    // No demand scenario
    if (heatTotal === 0 && coolTotal === 0) {
      if (current === 'off') {
        return {
          mode: 'off',
          reason: 'No heating or cooling demand from any device',
          switchSuppressed: false,
          secondsUntilSwitchAllowed: 0,
        };
      }
      // Check if we can turn off (respects min_on_time)
      const canSwitch = this.canSwitchMode('off', now);
      if (canSwitch.allowed) {
        return {
          mode: 'off',
          reason: 'No heating or cooling demand from any device',
          switchSuppressed: false,
          secondsUntilSwitchAllowed: 0,
        };
      }
      return {
        mode: current,
        reason: `No demand but switch to OFF suppressed (${canSwitch.reason})`,
        switchSuppressed: true,
        secondsUntilSwitchAllowed: canSwitch.secondsRemaining,
      };
    }

    // Only heat demand
    if (heatTotal > 0 && coolTotal === 0) {
      if (current === 'heat') {
        return {
          mode: 'heat',
          reason: `Continuing heat mode (demand: ${heatTotal.toFixed(1)})`,
          switchSuppressed: false,
          secondsUntilSwitchAllowed: 0,
        };
      }
      const canSwitch = this.canSwitchMode('heat', now);
      if (canSwitch.allowed) {
        return {
          mode: 'heat',
          reason: `Switching to heat (demand: ${heatTotal.toFixed(1)})`,
          switchSuppressed: false,
          secondsUntilSwitchAllowed: 0,
        };
      }
      return {
        mode: current,
        reason: `Heat requested but switch suppressed (${canSwitch.reason})`,
        switchSuppressed: true,
        secondsUntilSwitchAllowed: canSwitch.secondsRemaining,
      };
    }

    // Only cool demand
    if (coolTotal > 0 && heatTotal === 0) {
      if (current === 'cool') {
        return {
          mode: 'cool',
          reason: `Continuing cool mode (demand: ${coolTotal.toFixed(1)})`,
          switchSuppressed: false,
          secondsUntilSwitchAllowed: 0,
        };
      }
      const canSwitch = this.canSwitchMode('cool', now);
      if (canSwitch.allowed) {
        return {
          mode: 'cool',
          reason: `Switching to cool (demand: ${coolTotal.toFixed(1)})`,
          switchSuppressed: false,
          secondsUntilSwitchAllowed: 0,
        };
      }
      return {
        mode: current,
        reason: `Cool requested but switch suppressed (${canSwitch.reason})`,
        switchSuppressed: true,
        secondsUntilSwitchAllowed: canSwitch.secondsRemaining,
      };
    }

    // Conflict: both heat and cool demands exist
    const winner = heatTotal > coolTotal ? 'heat' : 'cool';
    const winnerTotal = winner === 'heat' ? heatTotal : coolTotal;
    const loserTotal = winner === 'heat' ? coolTotal : heatTotal;

    // Check dominance
    const relativeDominance = winnerTotal >= loserTotal * (1 + this.config.relativeDominanceThreshold);
    const absoluteDominance = (winnerTotal - loserTotal) >= this.config.absoluteDominanceThreshold;
    const isDominant = relativeDominance || absoluteDominance;

    // If current mode is the winner, keep it
    if (current === winner) {
      return {
        mode: current,
        reason: `Continuing ${current} (H:${heatTotal.toFixed(1)} C:${coolTotal.toFixed(1)}, ${winner} dominates)`,
        switchSuppressed: false,
        secondsUntilSwitchAllowed: 0,
      };
    }

    // Winner is different from current - check if we can/should switch
    if (!isDominant) {
      return {
        mode: current,
        reason: `Conflict but no clear winner (H:${heatTotal.toFixed(1)} C:${coolTotal.toFixed(1)}), holding ${current}`,
        switchSuppressed: false,
        secondsUntilSwitchAllowed: 0,
      };
    }

    // Winner is dominant, check timing
    const canSwitch = this.canSwitchMode(winner, now);
    if (canSwitch.allowed) {
      return {
        mode: winner,
        reason: `Switching to ${winner} (H:${heatTotal.toFixed(1)} C:${coolTotal.toFixed(1)}, ${winner} dominates by ${(winnerTotal - loserTotal).toFixed(1)})`,
        switchSuppressed: false,
        secondsUntilSwitchAllowed: 0,
      };
    }

    return {
      mode: current,
      reason: `${winner} dominates but switch suppressed (${canSwitch.reason})`,
      switchSuppressed: true,
      secondsUntilSwitchAllowed: canSwitch.secondsRemaining,
    };
  }

  /**
   * Checks if a mode switch is allowed based on timing protections.
   */
  private canSwitchMode(
    desiredMode: 'heat' | 'cool' | 'off',
    now: number
  ): { allowed: boolean; reason: string; secondsRemaining: number } {
    const current = this.state.currentMode;

    // No timing restrictions if switching from off
    if (current === 'off') {
      const timeSinceOff = (now - this.state.lastOffTime) / 1000;
      const minOffSeconds = this.config.minOffTime;
      if (timeSinceOff < minOffSeconds) {
        return {
          allowed: false,
          reason: `Min off-time not met (${Math.ceil(minOffSeconds - timeSinceOff)}s remaining)`,
          secondsRemaining: Math.ceil(minOffSeconds - timeSinceOff),
        };
      }
      return { allowed: true, reason: '', secondsRemaining: 0 };
    }

    // Switching to off
    if (desiredMode === 'off') {
      const timeSinceOn = (now - this.state.lastOnTime) / 1000;
      const minOnSeconds = this.config.minOnTime;
      if (timeSinceOn < minOnSeconds) {
        return {
          allowed: false,
          reason: `Min on-time not met (${Math.ceil(minOnSeconds - timeSinceOn)}s remaining)`,
          secondsRemaining: Math.ceil(minOnSeconds - timeSinceOn),
        };
      }
      return { allowed: true, reason: '', secondsRemaining: 0 };
    }

    // Switching between heat and cool requires both min_on and min_lock
    const timeSinceOn = (now - this.state.lastOnTime) / 1000;
    const timeSinceSwitch = (now - this.state.lastSwitchTime) / 1000;

    const minOnSeconds = this.config.minOnTime;
    const minLockSeconds = this.config.minLockTime;

    if (timeSinceOn < minOnSeconds) {
      return {
        allowed: false,
        reason: `Min on-time not met (${Math.ceil(minOnSeconds - timeSinceOn)}s remaining)`,
        secondsRemaining: Math.ceil(minOnSeconds - timeSinceOn),
      };
    }

    if (timeSinceSwitch < minLockSeconds) {
      return {
        allowed: false,
        reason: `Min lock time not met (${Math.ceil(minLockSeconds - timeSinceSwitch)}s remaining)`,
        secondsRemaining: Math.ceil(minLockSeconds - timeSinceSwitch),
      };
    }

    return { allowed: true, reason: '', secondsRemaining: 0 };
  }

  /**
   * Applies a controller decision, updating internal state.
   * Call this after evaluate() to commit the mode change.
   *
   * @param decision - Decision from evaluate()
   * @returns true if mode changed, false otherwise
   */
  async applyDecision(decision: ControllerDecision): Promise<boolean> {
    const now = Date.now();
    const previousMode = this.state.currentMode;

    if (decision.mode === previousMode) {
      return false;
    }

    // Update timing records
    this.state.lastSwitchTime = now;
    if (decision.mode === 'off') {
      this.state.lastOffTime = now;
    } else {
      this.state.lastOnTime = now;
    }

    this.state.currentMode = decision.mode;

    logger.info({
      from: previousMode,
      to: decision.mode,
      reason: decision.reason,
      heatDemand: decision.totalHeatDemand.toFixed(1),
      coolDemand: decision.totalCoolDemand.toFixed(1),
    }, '🔄 Auto-mode controller switched modes');

    await this.save();
    return true;
  }

  /**
   * Gets a status summary for display/debugging.
   */
  getStatus(): {
    currentMode: string;
    enrolledDeviceCount: number;
    enrolledDeviceIds: string[];
    timeSinceLastSwitch: number;
    config: ControllerConfig;
  } {
    const now = Date.now();
    return {
      currentMode: this.state.currentMode,
      enrolledDeviceCount: this.state.enrolledDeviceIds.length,
      enrolledDeviceIds: [...this.state.enrolledDeviceIds],
      timeSinceLastSwitch: Math.floor((now - this.state.lastSwitchTime) / 1000),
      config: { ...this.config },
    };
  }
}
