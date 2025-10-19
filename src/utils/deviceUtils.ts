import { UnifiedDevice } from '@/types';

/**
 * Determines if a device has thermostat-like capabilities.
 *
 * This includes:
 * - Traditional thermostats (with thermostatMode, thermostatHeatingSetpoint, etc.)
 * - Air conditioners (with airConditionerMode)
 * - Any device with temperature control capabilities
 *
 * @param device - Device to check (can be UnifiedDevice or capabilities array)
 * @returns true if device has thermostat-like capabilities
 */
export function isThermostatLikeDevice(
  device: UnifiedDevice | { capabilities?: Array<{ id: string; version: number }> }
): boolean {
  const caps = device.capabilities;
  if (!caps || caps.length === 0) {
    return false;
  }

  // Build a set of capability IDs for faster lookup
  const capabilityIds = new Set(caps.map(c => c.id));

  // Check for any thermostat or air conditioner capabilities
  return (
    capabilityIds.has('thermostat') ||
    capabilityIds.has('thermostatMode') ||
    capabilityIds.has('airConditionerMode') ||
    capabilityIds.has('customThermostatSetpointControl') ||
    capabilityIds.has('custom.thermostatSetpointControl') ||
    // Has temperature measurement AND at least one setpoint capability
    (capabilityIds.has('temperatureMeasurement') &&
     (capabilityIds.has('thermostatCoolingSetpoint') ||
      capabilityIds.has('thermostatHeatingSetpoint')))
  );
}

/**
 * Determines if a device supports heating.
 *
 * @param device - Device to check
 * @returns true if device has heating capabilities
 */
export function supportsHeating(
  device: UnifiedDevice | { capabilities?: Array<{ id: string; version: number }> }
): boolean {
  const caps = device.capabilities;
  if (!caps || caps.length === 0) {
    return false;
  }

  const capabilityIds = new Set(caps.map(c => c.id));

  return (
    capabilityIds.has('thermostatHeatingSetpoint') ||
    capabilityIds.has('thermostatMode')  // Traditional thermostats usually support heat/cool
  );
}

/**
 * Determines if a device supports cooling.
 *
 * @param device - Device to check
 * @returns true if device has cooling capabilities
 */
export function supportsCooling(
  device: UnifiedDevice | { capabilities?: Array<{ id: string; version: number }> }
): boolean {
  const caps = device.capabilities;
  if (!caps || caps.length === 0) {
    return false;
  }

  const capabilityIds = new Set(caps.map(c => c.id));

  return (
    capabilityIds.has('thermostatCoolingSetpoint') ||
    capabilityIds.has('thermostatMode') ||  // Traditional thermostats usually support heat/cool
    capabilityIds.has('airConditionerMode')  // Air conditioners are primarily for cooling
  );
}
