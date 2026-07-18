import { Plugin, PluginContext, PluginWebRoute } from '../../types';
import { UnifiedDevice } from '@/types';
import { AutoModeController, AutoModeDevice } from './AutoModeController';
import { Request, Response } from 'express';
import { isThermostatLikeDevice } from '@/utils/deviceUtils';

interface PendingFlip {
  targetMode: 'heat' | 'cool';
  phase: 'awaiting_off' | 'awaiting_min_off_time';
  startedAt: number;
  allOffAt?: number;
  deviceIds: string[];
  /** Number of drivePendingFlip() calls that observed awaiting_off without all devices reporting off. */
  driveAttempts: number;
  /**
   * Set on a restored flip whose startedAt is older than STALE_FLIP_MS, or
   * whose persisted shape is malformed/internally inconsistent. When set,
   * the next drivePendingFlip() call aborts-with-restore immediately
   * instead of resuming the state machine.
   */
  stale?: boolean;
}

/**
 * drivePendingFlip only runs on poll cycles (>=60s apart, per node-cron
 * minute granularity). Abort after this many consecutive awaiting_off
 * drives that still haven't observed all enrolled devices reporting off.
 */
const MAX_AWAITING_OFF_DRIVES = 3;

/** A restored pending flip older than this is considered stale and aborted-with-restore on the first poll. */
const STALE_FLIP_MS = 30 * 60 * 1000;

/**
 * HVAC Auto-Mode Plugin
 *
 * Implements intelligent multi-device HVAC coordination for systems with
 * a shared outdoor compressor. When users set thermostats to AUTO mode,
 * this plugin automatically enrolls them and coordinates mode switching
 * (HEAT/COOL/OFF) based on weighted demand calculations.
 *
 * Features:
 * - Proportional demand calculation
 * - Conflict resolution with dominance thresholds
 * - Timing protections (min on/off/lock times)
 * - Flip guard for shoulder season stability
 * - Freeze/high-temp safety overrides
 * - Web dashboard for real-time monitoring
 */
class HVACAutoModePlugin implements Plugin {
  name = 'hvac-auto-mode';
  version = '2.0.0';
  description = 'Intelligent multi-device HVAC auto-mode coordination';

  private context!: PluginContext;
  private controller!: AutoModeController;
  private readonly AUTO_MODE_MARKER = 'auto';
  private pendingFlip: PendingFlip | null = null;

  async init(context: PluginContext): Promise<void> {
    this.context = context;

    // Initialize the auto-mode controller. Persistence is delegated back to
    // the plugin context — the controller itself never touches the filesystem.
    this.controller = new AutoModeController(
      (state) => this.context.saveState('state', state),
      this.context.config // Pass through config from plugin settings
    );

    // Load controller state
    const savedState = await this.context.loadState('state');
    if (savedState) {
      this.controller.restoreState(savedState);
      this.context.logger.info(
        {
          mode: this.controller.getCurrentMode(),
          enrolledCount: this.controller.getEnrolledDeviceIds().length,
        },
        'Auto-mode controller state restored'
      );
    }

    // Restore any in-flight heat<->cool flip that was interrupted by a restart.
    // The persisted value is treated as untrusted input: a malformed or
    // internally inconsistent flip is marked stale so the first poll runs
    // abort-with-restore instead of resuming a state machine that could
    // hold units powered off forever.
    const rawFlip = await this.context.loadState<unknown>('pendingFlip');
    const restoredFlip = this.sanitizeRestoredFlip(rawFlip);
    if (restoredFlip) {
      const ageMs = Date.now() - restoredFlip.startedAt;
      if (restoredFlip.stale) {
        this.context.logger.warn(
          { rawFlip },
          '⚠️  Restored pending flip is malformed — will abort with restore on first poll'
        );
      } else if (ageMs > STALE_FLIP_MS) {
        restoredFlip.stale = true;
        this.context.logger.warn(
          { targetMode: restoredFlip.targetMode, ageMs },
          '⚠️  Restored pending flip is stale (>30min) — will abort with restore on first poll'
        );
      } else {
        this.context.logger.info(
          { targetMode: restoredFlip.targetMode, phase: restoredFlip.phase, ageMs },
          '♻️  Restored in-progress heat<->cool flip'
        );
      }
      this.pendingFlip = restoredFlip;
    }

    this.context.logger.info('HVAC Auto-Mode plugin initialized');
  }

  async start(): Promise<void> {
    this.context.logger.info('HVAC Auto-Mode plugin started');
  }

  async stop(): Promise<void> {
    // Save the full internal state (including timing locks) on shutdown.
    await this.saveControllerState();

    this.context.logger.info('HVAC Auto-Mode plugin stopped');
  }

  /**
   * Handle all thermostat-like devices (thermostats and air conditioners)
   */
  shouldHandleDevice(device: UnifiedDevice): boolean {
    return isThermostatLikeDevice(device);
  }

  /**
   * Intercept HomeKit -> SmartThings state changes
   * Enroll/unenroll devices based on mode changes
   * Handles both thermostatMode (traditional thermostats) and airConditionerMode (Samsung ACs)
   */
  async beforeSetSmartThingsState(device: UnifiedDevice, state: any): Promise<any | null> {
    // Check for mode changes in either thermostatMode or airConditionerMode
    const modeField = state.thermostatMode ? 'thermostatMode' :
                     state.airConditionerMode ? 'airConditionerMode' : null;

    if (modeField) {
      const mode = state[modeField].toLowerCase();

      // Check if switching to AUTO mode (enroll)
      if (mode === this.AUTO_MODE_MARKER) {
        await this.controller.enrollDevice(device.deviceId);
        this.context.logger.info(
          { deviceId: device.deviceId, deviceName: device.label },
          '✅ Device enrolled in auto-mode'
        );

        // Don't send AUTO to SmartThings - keep current mode
        // Let the controller decide the actual mode
        const currentMode = this.controller.getCurrentMode();
        return {
          ...state,
          [modeField]: currentMode,
        };
      }

      // Switching to manual mode (HEAT/COOL/OFF) - unenroll
      if (['heat', 'cool', 'off'].includes(mode)) {
        await this.controller.unenrollDevice(device.deviceId);
        this.context.logger.info(
          { deviceId: device.deviceId, deviceName: device.label, mode },
          '🚫 Device unenrolled from auto-mode'
        );
      }
    }

    return state;
  }

  /**
   * Intercept SmartThings -> HomeKit state changes
   * Display AUTO in HomeKit for enrolled devices
   */
  async beforeSetHomeKitState(device: UnifiedDevice, state: any): Promise<any | null> {
    const enrolledIds = this.controller.getEnrolledDeviceIds();

    if (enrolledIds.includes(device.deviceId)) {
      // Device is enrolled - show AUTO in HomeKit
      return {
        ...state,
        mode: this.AUTO_MODE_MARKER,
      };
    }

    return state;
  }

  /**
   * Run auto-mode coordination on each poll cycle.
   * Note: Auto-mode detection/correction is handled by the auto-mode-monitor plugin.
   * This plugin focuses on enrollment-based coordination via the AutoModeController.
   */
  async onPollCycle(devices: UnifiedDevice[]): Promise<void> {
    // If a heat<->cool flip is in progress, drive its state machine and
    // skip demand evaluation until it completes or aborts.
    if (this.pendingFlip) {
      await this.drivePendingFlip(devices);
      return;
    }

    const enrolledIds = this.controller.getEnrolledDeviceIds();
    if (enrolledIds.length === 0) {
      // No devices enrolled
      return;
    }

    // Build AutoModeDevice array from enrolled devices
    const autoModeDevices: AutoModeDevice[] = [];

    for (const deviceId of enrolledIds) {
      const device = devices.find(d => d.deviceId === deviceId);
      if (!device) {
        this.context.logger.warn(
          { deviceId },
          '⚠️  Enrolled device not found, skipping'
        );
        continue;
      }

      // Validate required fields
      const temp = device.currentTemperature;
      let heatSetpoint = device.heatingSetpoint;
      let coolSetpoint = device.coolingSetpoint;

      // Validate temperature is available
      if (temp === undefined || isNaN(temp)) {
        this.context.logger.warn(
          { deviceId, deviceName: device.label, temp },
          '⚠️  Device has invalid temperature data, skipping'
        );
        continue;
      }

      // Handle devices that only report one setpoint (common with Samsung ACs)
      // Create reasonable default bounds based on available setpoint
      const DEFAULT_TEMP_BAND = 4; // °F between heating and cooling setpoints

      if (coolSetpoint !== undefined && !isNaN(coolSetpoint)) {
        // Device has cooling setpoint - use it for upper bound
        // If no heating setpoint, create one based on cooling setpoint
        if (heatSetpoint === undefined || isNaN(heatSetpoint)) {
          heatSetpoint = coolSetpoint - DEFAULT_TEMP_BAND;
          this.context.logger.debug(
            { deviceId, deviceName: device.label, coolSetpoint, inferredHeatSetpoint: heatSetpoint },
            'Inferred heating setpoint from cooling setpoint'
          );
        }
      } else if (heatSetpoint !== undefined && !isNaN(heatSetpoint)) {
        // Device only has heating setpoint - create cooling setpoint
        coolSetpoint = heatSetpoint + DEFAULT_TEMP_BAND;
        this.context.logger.debug(
          { deviceId, deviceName: device.label, heatSetpoint, inferredCoolSetpoint: coolSetpoint },
          'Inferred cooling setpoint from heating setpoint'
        );
      } else {
        // No valid setpoints at all
        this.context.logger.warn(
          { deviceId, deviceName: device.label, heatSetpoint, coolSetpoint },
          '⚠️  Device has no valid setpoints, skipping'
        );
        continue;
      }

      autoModeDevices.push({
        id: deviceId,
        name: device.label,
        currentTemperature: temp,
        lowerBound: heatSetpoint,
        upperBound: coolSetpoint,
        weight: 1.0, // Could be configurable per-device
      });
    }

    if (autoModeDevices.length === 0) {
      this.context.logger.debug('No valid enrolled devices for auto-mode evaluation');
      return;
    }

    // Evaluate controller decision
    const decision = this.controller.evaluate(autoModeDevices);

    this.context.logger.debug(
      {
        mode: decision.mode,
        heatDemand: decision.totalHeatDemand.toFixed(1),
        coolDemand: decision.totalCoolDemand.toFixed(1),
        reason: decision.reason,
        suppressed: decision.switchSuppressed,
      },
      '🤖 Auto-mode evaluation'
    );

    const previousMode = this.controller.getCurrentMode();
    const isHeatCoolFlip =
      decision.mode !== previousMode &&
      previousMode !== 'off' &&
      decision.mode !== 'off';

    if (isHeatCoolFlip) {
      // Samsung multi-zone compressor can only run one mode at a time.
      // Disagreeing units get powered off by the system. To actually flip,
      // we must turn everything off, wait min-off-time, then bring units
      // back up in the new mode so the first one establishes the system mode.
      await this.startFlip(decision.mode as 'heat' | 'cool', autoModeDevices, devices);
    } else {
      // No mode change, or transitions to/from off — no off-cycle needed
      const modeChanged = await this.controller.applyDecision(decision);

      if (modeChanged) {
        this.context.logger.info(
          { mode: decision.mode, enrolledCount: autoModeDevices.length },
          '🎯 Applying mode to all enrolled devices'
        );

        for (const device of autoModeDevices) {
          try {
            await this.context.setSmartThingsState(device.id, {
              thermostatMode: decision.mode,
            });
            this.context.logger.debug(
              { deviceId: device.id, deviceName: device.name, mode: decision.mode },
              '✅ Device mode updated'
            );
          } catch (error) {
            this.context.logger.error(
              { err: error, deviceId: device.id, deviceName: device.name },
              '❌ Failed to update device mode'
            );
          }
        }
      } else {
        // Reconciliation: even though the controller's mode hasn't changed,
        // verify that enrolled devices actually match. An external actor (e.g.
        // another plugin, a physical remote, SmartThings cloud) may have
        // changed a device's mode out from under us.
        const expectedMode = this.controller.getCurrentMode();
        if (expectedMode !== 'off') {
          const desyncedDevices = autoModeDevices.filter(d => {
            const unified = devices.find(u => u.deviceId === d.id);
            if (!unified?.currentState) return false;
            const actualMode = unified.currentState.mode;
            // Samsung ACs report switch:off as mode:'off', skip those
            if (actualMode === 'off' && unified.currentState.switchState === 'off') return false;
            return actualMode !== expectedMode;
          });

          if (desyncedDevices.length > 0) {
            this.context.logger.warn(
              {
                expectedMode,
                desyncedCount: desyncedDevices.length,
                devices: desyncedDevices.map(d => d.name),
              },
              '🔄 Detected desynced devices, re-sending mode'
            );

            for (const device of desyncedDevices) {
              try {
                await this.context.setSmartThingsState(device.id, {
                  thermostatMode: expectedMode,
                });
                this.context.logger.info(
                  { deviceId: device.id, deviceName: device.name, mode: expectedMode },
                  '✅ Reconciled device mode'
                );
              } catch (error) {
                this.context.logger.error(
                  { err: error, deviceId: device.id, deviceName: device.name },
                  '❌ Failed to reconcile device mode'
                );
              }
            }
          }
        }
      }
    }

    // Save controller state after each evaluation
    await this.saveControllerState();
  }

  /**
   * Start a heat<->cool flip by sending off to all enrolled devices and
   * entering the awaiting_off phase of the state machine.
   */
  private async startFlip(
    targetMode: 'heat' | 'cool',
    enrolledDevices: AutoModeDevice[],
    allDevices: UnifiedDevice[]
  ): Promise<void> {
    const enrolledIds = enrolledDevices.map(d => d.id);

    // Warn if any non-enrolled HVAC unit is on in a conflicting mode — it
    // will anchor the system mode and our flip will not actually take.
    const conflicting = allDevices.filter(d =>
      isThermostatLikeDevice(d) &&
      !enrolledIds.includes(d.deviceId) &&
      d.currentState?.switchState === 'on' &&
      d.currentState?.mode &&
      d.currentState.mode !== 'off' &&
      d.currentState.mode !== targetMode
    );
    if (conflicting.length > 0) {
      this.context.logger.warn(
        {
          targetMode,
          conflictingDevices: conflicting.map(d => ({
            deviceId: d.deviceId,
            name: d.label,
            mode: d.currentState?.mode,
          })),
        },
        '⚠️  Non-enrolled HVAC unit(s) on in conflicting mode — flip may not take effect at the Samsung compressor'
      );
    }

    this.context.logger.info(
      { targetMode, deviceCount: enrolledDevices.length },
      '🔻 Mode flip starting — sending OFF to all enrolled devices'
    );

    // Record and persist the flip BEFORE sending any OFF commands. If the
    // process dies mid-send (crash, OOM, deploy), the restored flip either
    // resumes or aborts-with-restore on the next startup — either way the
    // units are brought back. Persisting after the sends would leave a
    // crash window where devices are off with no record of the flip.
    this.pendingFlip = {
      targetMode,
      phase: 'awaiting_off',
      startedAt: Date.now(),
      deviceIds: enrolledIds,
      driveAttempts: 0,
    };
    await this.savePendingFlip();

    for (const device of enrolledDevices) {
      try {
        await this.context.setSmartThingsState(device.id, {
          thermostatMode: 'off',
        });
      } catch (error) {
        this.context.logger.error(
          { err: error, deviceId: device.id, deviceName: device.name },
          '❌ Failed to send OFF during flip start'
        );
      }
    }
  }

  /**
   * Drive the pending flip state machine. Called instead of demand
   * evaluation while a flip is in progress.
   */
  private async drivePendingFlip(devices: UnifiedDevice[]): Promise<void> {
    const flip = this.pendingFlip!;

    // A restored flip that has exceeded the max age is not resumed — the
    // enrolled units were already sent OFF and may have been sitting idle
    // for a long time. Abort and restore their pre-flip mode immediately.
    if (flip.stale) {
      await this.abortFlip(flip, 'Restored pending flip exceeded max age');
      return;
    }

    // Never command devices the user has since unenrolled (e.g. via a
    // manual HomeKit mode change). Intersect on every drive.
    const enrolledIds = this.controller.getEnrolledDeviceIds();
    const stillEnrolled = flip.deviceIds.filter(id => enrolledIds.includes(id));

    if (stillEnrolled.length === 0) {
      this.context.logger.warn(
        { targetMode: flip.targetMode, deviceIds: flip.deviceIds },
        '🚫 All flip devices have been unenrolled — clearing pending flip without sending commands'
      );
      this.pendingFlip = null;
      await this.savePendingFlip();
      return;
    }

    if (stillEnrolled.length !== flip.deviceIds.length) {
      this.context.logger.info(
        { targetMode: flip.targetMode, before: flip.deviceIds, after: stillEnrolled },
        '✂️  Flip device set trimmed — one or more devices were unenrolled mid-flip'
      );
      flip.deviceIds = stillEnrolled;
      await this.savePendingFlip();
    }

    const now = Date.now();
    const flipDevices = devices.filter(d => flip.deviceIds.includes(d.deviceId));

    if (flip.phase === 'awaiting_off') {
      const allOff = flipDevices.length > 0 &&
        flipDevices.every(d => d.currentState?.switchState === 'off');

      if (allOff) {
        flip.phase = 'awaiting_min_off_time';
        flip.allOffAt = now;
        await this.savePendingFlip();
        this.context.logger.info(
          { targetMode: flip.targetMode, minOffSeconds: this.controller.getConfig().minOffTime },
          '✅ All enrolled devices off — waiting min-off-time before flipping mode'
        );
        return;
      }

      flip.driveAttempts += 1;

      if (flip.driveAttempts >= MAX_AWAITING_OFF_DRIVES) {
        const stillOn = flipDevices
          .filter(d => d.currentState?.switchState !== 'off')
          .map(d => ({ deviceId: d.deviceId, name: d.label, switch: d.currentState?.switchState }));
        this.context.logger.warn(
          { targetMode: flip.targetMode, driveAttempts: flip.driveAttempts, stillOn },
          '❌ Off-cycle drive attempts exhausted — aborting flip with restore'
        );
        await this.abortFlip(flip, 'Off-cycle drive attempts exhausted');
        return;
      }

      await this.savePendingFlip();
      this.context.logger.debug(
        { driveAttempts: flip.driveAttempts },
        '⏳ Waiting for all enrolled devices to report off'
      );
      return;
    }

    // awaiting_min_off_time
    const minOffMs = this.controller.getConfig().minOffTime * 1000;
    const elapsedSinceOff = now - (flip.allOffAt ?? now);

    if (elapsedSinceOff < minOffMs) {
      this.context.logger.debug(
        { remainingMs: minOffMs - elapsedSinceOff },
        '⏳ Holding off-cycle for compressor min-off-time'
      );
      return;
    }

    // Min-off elapsed: bring units up in the new mode.
    this.context.logger.info(
      { targetMode: flip.targetMode, deviceCount: flip.deviceIds.length },
      '🔺 Min-off-time elapsed — applying new mode to enrolled devices'
    );

    for (const deviceId of flip.deviceIds) {
      try {
        await this.context.setSmartThingsState(deviceId, {
          thermostatMode: flip.targetMode,
        });
      } catch (error) {
        this.context.logger.error(
          { err: error, deviceId },
          '❌ Failed to apply target mode after flip'
        );
      }
    }

    // Commit the mode change to the controller now that the flip has executed.
    await this.controller.applyDecision({
      mode: flip.targetMode,
      totalHeatDemand: 0,
      totalCoolDemand: 0,
      deviceDemands: [],
      reason: 'Flip committed after off-cycle',
      switchSuppressed: false,
      secondsUntilSwitchAllowed: 0,
    });

    this.pendingFlip = null;
    await this.savePendingFlip();
    await this.saveControllerState();
  }

  /**
   * Abort a pending flip, restoring the controller's pre-flip mode to any
   * flip devices that are still enrolled (the enrolled units were already
   * sent OFF as part of starting the flip, so they must not be left
   * powered off). If the pre-flip mode is 'off', there is nothing to
   * restore — just clear the flip.
   */
  private async abortFlip(flip: PendingFlip, reason: string): Promise<void> {
    const preFlipMode = this.controller.getCurrentMode();
    const enrolledIds = this.controller.getEnrolledDeviceIds();
    const restoreTargets = flip.deviceIds.filter(id => enrolledIds.includes(id));

    this.context.logger.warn(
      { targetMode: flip.targetMode, preFlipMode, restoreTargets, reason },
      '↩️  Aborting flip — restoring pre-flip mode to still-enrolled devices'
    );

    if (preFlipMode !== 'off') {
      for (const deviceId of restoreTargets) {
        try {
          await this.context.setSmartThingsState(deviceId, {
            thermostatMode: preFlipMode,
          });
        } catch (error) {
          this.context.logger.error(
            { err: error, deviceId },
            '❌ Failed to restore pre-flip mode during abort'
          );
        }
      }
    }

    this.pendingFlip = null;
    await this.savePendingFlip();
  }

  /**
   * Persist the pending flip (or its clearing) to plugin state so an
   * in-flight flip survives a restart.
   */
  private async savePendingFlip(): Promise<void> {
    await this.context.saveState('pendingFlip', this.pendingFlip);
  }

  /**
   * Validate a restored PendingFlip loaded from persistence, treating it as
   * untrusted input. Returns null when there is nothing to restore.
   *
   * A malformed or internally inconsistent flip (wrong types, unknown
   * phase, or 'awaiting_min_off_time' without allOffAt — which would hold
   * forever since elapsedSinceOff would always compute as 0 with the units
   * powered off) is returned with `stale: true` so the first poll runs the
   * abort-with-restore path instead of resuming. If deviceIds is unusable,
   * fall back to the currently enrolled IDs so the abort can still restore
   * the units that were sent OFF.
   */
  private sanitizeRestoredFlip(raw: unknown): PendingFlip | null {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const candidate = raw as Record<string, unknown>;

    const validTargetMode = candidate.targetMode === 'heat' || candidate.targetMode === 'cool';
    const validPhase = candidate.phase === 'awaiting_off' || candidate.phase === 'awaiting_min_off_time';
    const validStartedAt = typeof candidate.startedAt === 'number' && Number.isFinite(candidate.startedAt);
    const validAllOffAt =
      candidate.allOffAt === undefined ||
      (typeof candidate.allOffAt === 'number' && Number.isFinite(candidate.allOffAt));
    const validDeviceIds =
      Array.isArray(candidate.deviceIds) &&
      candidate.deviceIds.length > 0 &&
      candidate.deviceIds.every((id) => typeof id === 'string');
    const validDriveAttempts =
      typeof candidate.driveAttempts === 'number' && Number.isFinite(candidate.driveAttempts);
    const consistent =
      candidate.phase !== 'awaiting_min_off_time' ||
      (typeof candidate.allOffAt === 'number' && Number.isFinite(candidate.allOffAt));

    const malformed = !(
      validTargetMode &&
      validPhase &&
      validStartedAt &&
      validAllOffAt &&
      validDeviceIds &&
      validDriveAttempts &&
      consistent
    );

    return {
      // Placeholder values below are only ever used on the abort-with-restore
      // path (malformed => stale), which does not read targetMode/phase/
      // startedAt beyond logging.
      targetMode: validTargetMode ? (candidate.targetMode as 'heat' | 'cool') : 'heat',
      phase: validPhase ? (candidate.phase as PendingFlip['phase']) : 'awaiting_off',
      startedAt: validStartedAt ? (candidate.startedAt as number) : Date.now(),
      allOffAt:
        typeof candidate.allOffAt === 'number' && Number.isFinite(candidate.allOffAt)
          ? candidate.allOffAt
          : undefined,
      deviceIds: validDeviceIds
        ? [...(candidate.deviceIds as string[])]
        : this.controller.getEnrolledDeviceIds(),
      driveAttempts: validDriveAttempts ? (candidate.driveAttempts as number) : 0,
      ...(malformed ? { stale: true } : {}),
    };
  }

  /**
   * Save controller state to plugin persistence
   */
  private async saveControllerState(): Promise<void> {
    await this.context.saveState('state', this.controller.getState());
  }

  /**
   * Provide web routes for the auto-mode dashboard
   */
  getWebRoutes(): PluginWebRoute[] {
    return [
      {
        path: '/status',
        method: 'get',
        handler: async (req: Request, res: Response) => {
          const status = this.controller.getStatus();
          res.json(status);
        },
      },
      {
        path: '/decision',
        method: 'get',
        handler: async (req: Request, res: Response) => {
          try {
            const devices = this.context.getDevices();
            const enrolledIds = this.controller.getEnrolledDeviceIds();

            const autoModeDevices: AutoModeDevice[] = devices
              .filter(d => enrolledIds.includes(d.deviceId))
              .filter(d =>
                d.currentTemperature !== undefined &&
                d.heatingSetpoint !== undefined &&
                d.coolingSetpoint !== undefined
              )
              .map(d => ({
                id: d.deviceId,
                name: d.label,
                currentTemperature: d.currentTemperature!,
                lowerBound: d.heatingSetpoint!,
                upperBound: d.coolingSetpoint!,
                weight: 1.0,
              }));

            if (autoModeDevices.length === 0) {
              res.json({
                mode: 'off',
                totalHeatDemand: 0,
                totalCoolDemand: 0,
                deviceDemands: [],
                reason: 'No enrolled devices with valid data',
                switchSuppressed: false,
                secondsUntilSwitchAllowed: 0,
              });
              return;
            }

            const decision = this.controller.evaluate(autoModeDevices);
            res.json(decision);
          } catch (error) {
            this.context.logger.error({ err: error }, '❌ Failed to compute auto-mode decision');
            res.status(500).json({ error: 'Failed to compute auto-mode decision' });
          }
        },
      },
    ];
  }
}

// Export the plugin instance
export default new HVACAutoModePlugin();
