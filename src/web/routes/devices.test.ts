/**
 * Web Routes Unit Tests
 *
 * These tests ensure the web API routes correctly delegate to the Coordinator
 * for all device commands, which is critical for Samsung AC compatibility.
 *
 * See SPEC.md "Critical Implementation Notes" for why this matters.
 */

import { Request, Response, NextFunction, Router } from 'express';
import { createDevicesRoutes } from './devices';
import { createHomeKitRoutes } from './homekit';
import { apiMutationGuard, wrapAsyncHandler, handleSystemRestart } from '@/web/server';
import { SmartThingsAPI } from '@/api/SmartThingsAPI';
import { Coordinator } from '@/coordinator/Coordinator';
import { DeviceInclusionManager } from '@/config/DeviceInclusionManager';
import { SmartThingsHAPServer } from '@/hap/HAPServer';
import { DeviceState } from '@/types';

// Mock dependencies
jest.mock('@/api/SmartThingsAPI');
jest.mock('@/coordinator/Coordinator');
jest.mock('@/config/DeviceInclusionManager');

// Helper to create mock request/response, shared across the describe blocks
// in this file.
//
// Route handlers under test are invoked directly (grabbed off the router
// stack), bypassing the app-level apiMutationGuard middleware in server.ts.
// Requests still carry a realistic X-Requested-With header by default so the
// mocks reflect what the real same-origin frontend sends; the guard
// middleware itself is unit-tested separately below.
const createMockReqRes = (
  params: Record<string, string> = {},
  body: Record<string, any> = {},
  headers: Record<string, string> = { 'x-requested-with': 'XMLHttpRequest' }
) => {
  const lowerHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    lowerHeaders[key.toLowerCase()] = value;
  }

  const req = {
    params,
    body,
    get: (name: string) => lowerHeaders[name.toLowerCase()],
  } as unknown as Request;

  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    redirect: jest.fn().mockReturnThis(),
    headersSent: false,
  } as unknown as Response;

  return { req, res };
};

describe('Device Routes', () => {
  let mockApi: jest.Mocked<SmartThingsAPI>;
  let mockCoordinator: jest.Mocked<Coordinator>;
  let mockInclusionManager: jest.Mocked<DeviceInclusionManager>;
  let router: Router;

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

/**
 * apiMutationGuard is the app-level middleware in server.ts that blocks
 * cross-origin "drive-by" mutations (see CLAUDE.md / server.ts docs for the
 * threat model): any LAN webpage can otherwise issue a simple, no-preflight
 * cross-origin POST against this unauthenticated control API.
 */
describe('apiMutationGuard middleware', () => {
  const originalToken = process.env.WEB_API_TOKEN;

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.WEB_API_TOKEN;
    } else {
      process.env.WEB_API_TOKEN = originalToken;
    }
  });

  const createGuardReqRes = (method: string, path: string, headers: Record<string, string> = {}) => {
    const lowerHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      lowerHeaders[key.toLowerCase()] = value;
    }

    const req = {
      method,
      path,
      get: (name: string) => lowerHeaders[name.toLowerCase()],
    } as unknown as Request;

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;

    const next = jest.fn() as unknown as NextFunction;

    return { req, res, next };
  };

  test('mutating /api request without X-Requested-With header -> 403', () => {
    delete process.env.WEB_API_TOKEN;
    const { req, res, next } = createGuardReqRes('POST', '/api/devices/device-123/mode');

    apiMutationGuard(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
    expect(next).not.toHaveBeenCalled();
  });

  test('mutating /api request with X-Requested-With header -> passes', () => {
    delete process.env.WEB_API_TOKEN;
    const { req, res, next } = createGuardReqRes('POST', '/api/devices/device-123/mode', {
      'X-Requested-With': 'XMLHttpRequest',
    });

    apiMutationGuard(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('SECURITY: uppercase /API path is still guarded (Express matches case-insensitively) -> 403', () => {
    // Express 4 route matching is case-insensitive by default, so a request
    // to /API/devices/:id/mode still reaches the mutating route handler. The
    // guard must not be fooled into calling next() by the upper-cased prefix.
    delete process.env.WEB_API_TOKEN;
    const { req, res, next } = createGuardReqRes('POST', '/API/devices/device-123/mode');

    apiMutationGuard(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
    expect(next).not.toHaveBeenCalled();
  });

  test('SECURITY: mixed-case /Api path without header -> 403', () => {
    delete process.env.WEB_API_TOKEN;
    const { req, res, next } = createGuardReqRes('POST', '/Api/plugins/hvac-auto-mode/enable');

    apiMutationGuard(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('GET /api request without the header -> passes (GET is exempt)', () => {
    delete process.env.WEB_API_TOKEN;
    const { req, res, next } = createGuardReqRes('GET', '/api/devices');

    apiMutationGuard(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('non-/api paths are ignored entirely', () => {
    delete process.env.WEB_API_TOKEN;
    const { req, res, next } = createGuardReqRes('POST', '/some-static-asset.js');

    apiMutationGuard(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('OAuth redirect routes stay exempt from the header requirement', () => {
    delete process.env.WEB_API_TOKEN;
    const smartthingsStart = createGuardReqRes('GET', '/api/auth/smartthings');
    const smartthingsCallback = createGuardReqRes('GET', '/api/auth/smartthings/callback');

    apiMutationGuard(smartthingsStart.req, smartthingsStart.res, smartthingsStart.next);
    apiMutationGuard(smartthingsCallback.req, smartthingsCallback.res, smartthingsCallback.next);

    expect(smartthingsStart.next).toHaveBeenCalled();
    expect(smartthingsCallback.next).toHaveBeenCalled();
  });

  describe('when WEB_API_TOKEN is set', () => {
    beforeEach(() => {
      process.env.WEB_API_TOKEN = 'test-token-123';
    });

    test('missing Authorization header -> 401', () => {
      const { req, res, next } = createGuardReqRes('POST', '/api/devices/device-123/mode', {
        'X-Requested-With': 'XMLHttpRequest',
      });

      apiMutationGuard(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    test('wrong bearer token -> 403', () => {
      const { req, res, next } = createGuardReqRes('POST', '/api/devices/device-123/mode', {
        'X-Requested-With': 'XMLHttpRequest',
        Authorization: 'Bearer wrong-token',
      });

      apiMutationGuard(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    test('correct bearer token -> passes', () => {
      const { req, res, next } = createGuardReqRes('POST', '/api/devices/device-123/mode', {
        'X-Requested-With': 'XMLHttpRequest',
        Authorization: 'Bearer test-token-123',
      });

      apiMutationGuard(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    test('SECURITY: uppercase /API path still enforces the bearer token', () => {
      // Even with a valid X-Requested-With header, an uppercase-path mutating
      // request must not bypass the token check. Missing bearer -> 401.
      const { req, res, next } = createGuardReqRes('POST', '/API/devices/device-123/mode', {
        'X-Requested-With': 'XMLHttpRequest',
      });

      apiMutationGuard(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    test('SECURITY: uppercase /API path with a wrong bearer -> 403', () => {
      const { req, res, next } = createGuardReqRes('POST', '/API/devices/device-123/mode', {
        'X-Requested-With': 'XMLHttpRequest',
        Authorization: 'Bearer wrong-token',
      });

      apiMutationGuard(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
  });
});

describe('wrapAsyncHandler', () => {
  test('a rejecting handler resolves the request with 500 instead of hanging', async () => {
    const rejectingHandler = jest.fn().mockRejectedValue(new Error('boom'));
    const wrapped = wrapAsyncHandler(rejectingHandler);

    const { req, res } = createMockReqRes();
    const next = jest.fn() as unknown as NextFunction;

    await wrapped(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
  });

  test('does not double-send if the handler already sent a response before rejecting', async () => {
    const rejectingHandler = jest.fn().mockImplementation(async (_req: Request, res: Response) => {
      (res as any).headersSent = true;
      throw new Error('boom after response already sent');
    });
    const wrapped = wrapAsyncHandler(rejectingHandler);

    const { req, res } = createMockReqRes();
    const next = jest.fn() as unknown as NextFunction;

    await wrapped(req, res, next);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  test('a resolving handler behaves normally', async () => {
    const okHandler = jest.fn().mockImplementation(async (_req: Request, res: Response) => {
      res.json({ ok: true });
    });
    const wrapped = wrapAsyncHandler(okHandler);

    const { req, res } = createMockReqRes();
    const next = jest.fn() as unknown as NextFunction;

    await wrapped(req, res, next);

    expect(res.json).toHaveBeenCalledWith({ ok: true });
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('handleSystemRestart', () => {
  let killSpy: jest.SpyInstance;

  // Deliberately using real timers here rather than jest.useFakeTimers() /
  // spying on global.setTimeout: process.kill is mocked so a real 500ms
  // timer firing is harmless, and both approaches to faking the timer proved
  // unreliable in this environment's Node runtime.
  beforeEach(() => {
    killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true as never);
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  test('without { confirm: true } -> 400 and does not schedule a shutdown', async () => {
    const { req, res } = createMockReqRes({}, {});

    handleSystemRestart(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));

    await new Promise(resolve => setTimeout(resolve, 600));
    expect(killSpy).not.toHaveBeenCalled();
  }, 10000);

  test('with { confirm: true } -> proceeds and schedules the shutdown', async () => {
    const { req, res } = createMockReqRes({}, { confirm: true });

    handleSystemRestart(req, res);

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: true, message: 'Restarting bridge...' });

    await new Promise(resolve => setTimeout(resolve, 600));
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
  }, 10000);
});

describe('POST /api/homekit/reset-pairing confirmation', () => {
  let mockHapServer: jest.Mocked<SmartThingsHAPServer>;
  let homekitRouter: Router;

  beforeEach(() => {
    mockHapServer = {
      getQrCode: jest.fn().mockReturnValue('qr-code-data'),
      getPairingCode: jest.fn().mockReturnValue('123-45-678'),
      isPaired: jest.fn().mockReturnValue(true),
      resetPairing: jest.fn().mockResolvedValue(undefined),
    } as any;

    homekitRouter = createHomeKitRoutes(mockHapServer);
  });

  const getResetPairingHandler = () =>
    (homekitRouter as any).stack.find(
      (layer: any) => layer.route?.path === '/reset-pairing' && layer.route?.methods?.post
    )?.route?.stack[0]?.handle;

  test('without { confirm: true } -> 400 and does not reset pairing', async () => {
    const { req, res } = createMockReqRes({}, {});
    const handler = getResetPairingHandler();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
    expect(mockHapServer.resetPairing).not.toHaveBeenCalled();
  });

  test('with { confirm: true } -> proceeds to reset pairing', async () => {
    const { req, res } = createMockReqRes({}, { confirm: true });
    const handler = getResetPairingHandler();

    await handler(req, res);

    expect(mockHapServer.resetPairing).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});
