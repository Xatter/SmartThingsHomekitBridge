/**
 * Web Routes Unit Tests
 *
 * These tests ensure the web API routes correctly delegate to the Coordinator
 * for all device commands, which is critical for Samsung AC compatibility.
 *
 * See SPEC.md "Critical Implementation Notes" for why this matters.
 */

import { Request, Response, Router } from 'express';
import { createDevicesRoutes } from './devices';
import { SmartThingsAPI } from '@/api/SmartThingsAPI';
import { Coordinator } from '@/coordinator/Coordinator';
import { DeviceInclusionManager } from '@/config/DeviceInclusionManager';
import { DeviceState } from '@/types';

// Mock dependencies
jest.mock('@/api/SmartThingsAPI');
jest.mock('@/coordinator/Coordinator');
jest.mock('@/config/DeviceInclusionManager');

describe('Device Routes', () => {
  let mockApi: jest.Mocked<SmartThingsAPI>;
  let mockCoordinator: jest.Mocked<Coordinator>;
  let mockInclusionManager: jest.Mocked<DeviceInclusionManager>;
  let router: Router;

  // Helper to create mock request/response
  const createMockReqRes = (params: Record<string, string> = {}, body: Record<string, any> = {}) => {
    const req = {
      params,
      body,
    } as unknown as Request;

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      redirect: jest.fn().mockReturnThis(),
    } as unknown as Response;

    return { req, res };
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockApi = {
      hasAuth: jest.fn().mockReturnValue(true),
      getDevices: jest.fn().mockResolvedValue([]),
      getDeviceStatus: jest.fn().mockResolvedValue(null),
      setTemperature: jest.fn().mockResolvedValue(true),
      setMode: jest.fn().mockResolvedValue(true),
      turnLightOn: jest.fn().mockResolvedValue(true),
      turnLightOff: jest.fn().mockResolvedValue(true),
    } as any;

    mockCoordinator = {
      getState: jest.fn().mockReturnValue({
        pairedDevices: [],
        deviceStates: new Map(),
        averageTemperature: 70,
        currentMode: 'off',
      }),
      getDeviceState: jest.fn(),
      getDevice: jest.fn(),
      getDevices: jest.fn().mockReturnValue([]),
      handleThermostatEvent: jest.fn().mockResolvedValue(undefined),
      reloadDevices: jest.fn().mockResolvedValue(undefined),
    } as any;

    mockInclusionManager = {
      isIncluded: jest.fn().mockReturnValue(true),
      setIncluded: jest.fn().mockResolvedValue(undefined),
    } as any;

    router = createDevicesRoutes(mockApi, mockCoordinator, mockInclusionManager);
  });

  describe('POST /:deviceId/temperature', () => {
    const mockDeviceState: DeviceState = {
      id: 'device-123',
      name: 'Test AC',
      currentTemperature: 72,
      temperatureSetpoint: 70,
      mode: 'heat',
      lightOn: false,
      lastUpdated: new Date(),
      switchState: 'on',
    };

    beforeEach(() => {
      mockCoordinator.getDeviceState.mockReturnValue(mockDeviceState);
    });

    test('CRITICAL: must use Coordinator.handleThermostatEvent, NOT api.setTemperature', async () => {
      /**
       * This test enforces the critical requirement from SPEC.md:
       * All temperature changes MUST route through Coordinator.handleThermostatEvent()
       * to ensure Samsung AC compatibility (they lack thermostatHeatingSetpoint).
       *
       * If this test fails, Samsung ACs will get 422 errors when setting temperature
       * in heat mode because the API will try to use thermostatHeatingSetpoint.
       */
      const { req, res } = createMockReqRes(
        { deviceId: 'device-123' },
        { temperature: 72 }
      );

      // Get the route handler
      const routeHandler = (router as any).stack.find(
        (layer: any) => layer.route?.path === '/:deviceId/temperature' && layer.route?.methods?.post
      )?.route?.stack[0]?.handle;

      expect(routeHandler).toBeDefined();
      await routeHandler(req, res);

      // CRITICAL: Must call Coordinator, NOT direct API
      expect(mockCoordinator.handleThermostatEvent).toHaveBeenCalledWith({
        deviceId: 'device-123',
        type: 'temperature',
        temperature: 72,
      });

      // MUST NOT call api.setTemperature directly (bypasses Samsung AC logic)
      expect(mockApi.setTemperature).not.toHaveBeenCalled();

      expect(res.json).toHaveBeenCalledWith({ success: true, temperature: 72 });
    });

    test('should reject temperature when device is off', async () => {
      mockCoordinator.getDeviceState.mockReturnValue({
        ...mockDeviceState,
        mode: 'off',
      });

      const { req, res } = createMockReqRes(
        { deviceId: 'device-123' },
        { temperature: 72 }
      );

      const routeHandler = (router as any).stack.find(
        (layer: any) => layer.route?.path === '/:deviceId/temperature' && layer.route?.methods?.post
      )?.route?.stack[0]?.handle;

      await routeHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Cannot set temperature when device is off' });
      expect(mockCoordinator.handleThermostatEvent).not.toHaveBeenCalled();
    });

    test('should reject invalid temperature values', async () => {
      const { req, res } = createMockReqRes(
        { deviceId: 'device-123' },
        { temperature: 200 } // Invalid - too high
      );

      const routeHandler = (router as any).stack.find(
        (layer: any) => layer.route?.path === '/:deviceId/temperature' && layer.route?.methods?.post
      )?.route?.stack[0]?.handle;

      await routeHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid temperature value' });
    });

    test('should return 404 for unknown device', async () => {
      mockCoordinator.getDeviceState.mockReturnValue(undefined);

      const { req, res } = createMockReqRes(
        { deviceId: 'unknown-device' },
        { temperature: 72 }
      );

      const routeHandler = (router as any).stack.find(
        (layer: any) => layer.route?.path === '/:deviceId/temperature' && layer.route?.methods?.post
      )?.route?.stack[0]?.handle;

      await routeHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Device not found' });
    });
  });

  describe('POST /:deviceId/mode', () => {
    test('CRITICAL: must use Coordinator.handleThermostatEvent, NOT api.setMode', async () => {
      /**
       * This test enforces the critical requirement from SPEC.md:
       * All mode changes MUST route through Coordinator.handleThermostatEvent()
       * to ensure Samsung AC compatibility (they use switch for off, not mode).
       *
       * If this test fails, Samsung ACs will get errors when trying to turn off
       * because the API will try to use airConditionerMode:off which is invalid.
       */
      const { req, res } = createMockReqRes(
        { deviceId: 'device-123' },
        { mode: 'cool' }
      );

      const routeHandler = (router as any).stack.find(
        (layer: any) => layer.route?.path === '/:deviceId/mode' && layer.route?.methods?.post
      )?.route?.stack[0]?.handle;

      expect(routeHandler).toBeDefined();
      await routeHandler(req, res);

      // CRITICAL: Must call Coordinator, NOT direct API
      expect(mockCoordinator.handleThermostatEvent).toHaveBeenCalledWith({
        deviceId: 'device-123',
        type: 'mode',
        mode: 'cool',
      });

      // MUST NOT call api.setMode directly (bypasses Samsung AC logic)
      expect(mockApi.setMode).not.toHaveBeenCalled();

      expect(res.json).toHaveBeenCalledWith({ success: true, mode: 'cool' });
    });

    test('should reject invalid mode values', async () => {
      const { req, res } = createMockReqRes(
        { deviceId: 'device-123' },
        { mode: 'invalid' }
      );

      const routeHandler = (router as any).stack.find(
        (layer: any) => layer.route?.path === '/:deviceId/mode' && layer.route?.methods?.post
      )?.route?.stack[0]?.handle;

      await routeHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid mode value' });
    });

    test('should handle all valid mode values', async () => {
      const validModes = ['heat', 'cool', 'auto', 'off'];

      for (const mode of validModes) {
        jest.clearAllMocks();

        const { req, res } = createMockReqRes(
          { deviceId: 'device-123' },
          { mode }
        );

        const routeHandler = (router as any).stack.find(
          (layer: any) => layer.route?.path === '/:deviceId/mode' && layer.route?.methods?.post
        )?.route?.stack[0]?.handle;

        await routeHandler(req, res);

        expect(mockCoordinator.handleThermostatEvent).toHaveBeenCalledWith({
          deviceId: 'device-123',
          type: 'mode',
          mode,
        });
        expect(res.json).toHaveBeenCalledWith({ success: true, mode });
      }
    });
  });

  describe('Authentication checks', () => {
    test('temperature endpoint should require auth', async () => {
      mockApi.hasAuth.mockReturnValue(false);

      const { req, res } = createMockReqRes(
        { deviceId: 'device-123' },
        { temperature: 72 }
      );

      const routeHandler = (router as any).stack.find(
        (layer: any) => layer.route?.path === '/:deviceId/temperature' && layer.route?.methods?.post
      )?.route?.stack[0]?.handle;

      await routeHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Not authenticated' });
    });

    test('mode endpoint should require auth', async () => {
      mockApi.hasAuth.mockReturnValue(false);

      const { req, res } = createMockReqRes(
        { deviceId: 'device-123' },
        { mode: 'cool' }
      );

      const routeHandler = (router as any).stack.find(
        (layer: any) => layer.route?.path === '/:deviceId/mode' && layer.route?.methods?.post
      )?.route?.stack[0]?.handle;

      await routeHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Not authenticated' });
    });
  });
});
