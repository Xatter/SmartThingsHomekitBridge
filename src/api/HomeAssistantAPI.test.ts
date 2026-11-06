/**
 * Tests for the Home Assistant local device backend.
 *
 * The backend is the SmartThings-independent device source added when the PA
 * units moved to fully-local control. It must expose the same surface as
 * SmartThingsAPI and translate SmartThings-style capability commands into HA
 * service calls - the Coordinator and plugins build those commands without
 * knowing which backend is active.
 */

const mockFetch = jest.fn();

beforeEach(() => {
  mockFetch.mockReset();
  // Default: every HA service call succeeds (individual tests override for
  // state reads and failure paths).
  mockFetch.mockImplementation(() => okJson([]));
  (global as any).fetch = mockFetch;
});

function haStateResponse(entityId: string, state: string, attrs: Record<string, any>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ entity_id: entityId, state, attributes: attrs }),
    text: async () => JSON.stringify({ entity_id: entityId, state, attributes: attrs }),
  };
}

function okJson(body: any) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

const ENTITY_MAP = {
  '981073a0-test': {
    entity_id: 'climate.samsung_ac',
    light_switch: 'switch.samsung_ac_display_light',
    name: 'Samsung-Room-Air-Conditioner',
    label: 'Room air conditioner 1',
  },
};

function newBackend() {
  const { HomeAssistantAPI } = require('@/api/HomeAssistantAPI');
  return new HomeAssistantAPI({
    url: 'http://192.168.2.2:8123',
    token: 'test-token',
    entityMap: ENTITY_MAP,
  });
}

describe('HomeAssistantAPI', () => {
  describe('hasAuth', () => {
    it('is false without a token', () => {
      const { HomeAssistantAPI } = require('@/api/HomeAssistantAPI');
      const backend = new HomeAssistantAPI({ url: 'http://x', token: '', entityMap: ENTITY_MAP as any });
      expect(backend.hasAuth()).toBe(false);
    });

    it('is true with a token and a non-empty map', () => {
      expect(newBackend().hasAuth()).toBe(true);
    });
  });

  describe('getAllDevices', () => {
    it('synthesizes Samsung-AC-shaped metadata keyed by the historical device ID', async () => {
      const backend = newBackend();
      const devices = await backend.getAllDevices();
      expect(devices).toHaveLength(1);
      const d = devices[0];
      expect(d.deviceId).toBe('981073a0-test');
      // The ST-era name/label are preserved so HomeKit accessory naming and
      // the web UI stay identical across backend switches.
      expect(d.name).toBe('Samsung-Room-Air-Conditioner');
      expect(d.label).toBe('Room air conditioner 1');
      const capIds = d.capabilities.map((c: any) => c.id);
      // The Coordinator's Samsung path requires airConditionerMode without
      // thermostatMode, and the single-register path requires
      // thermostatCoolingSetpoint - all three must hold.
      expect(capIds).toContain('airConditionerMode');
      expect(capIds).not.toContain('thermostatMode');
      expect(capIds).toContain('thermostatCoolingSetpoint');
      expect(capIds).toContain('switch');
    });
  });

  describe('getDeviceStatus', () => {
    it('maps the HA climate state into the bridge DeviceState', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.endsWith('/api/states/climate.samsung_ac')) {
          return haStateResponse('climate.samsung_ac', 'heat', {
            temperature: 59,
            current_humidity: 58,
          });
        }
        if (url.endsWith('/api/states/switch.samsung_ac_display_light')) {
          return haStateResponse('switch.samsung_ac_display_light', 'off', {});
        }
        throw new Error(`unexpected url ${url}`);
      });

      const backend = newBackend();
      const status = await backend.getDeviceStatus('981073a0-test');
      expect(status).not.toBeNull();
      expect(status!.id).toBe('981073a0-test');
      expect(status!.name).toBe('Samsung-Room-Air-Conditioner');
      expect(status!.mode).toBe('heat');
      expect(status!.currentTemperature).toBe(59);
      expect(status!.temperatureSetpoint).toBe(59);
      // Single-register unit: coolingSetpoint carries the register, heating
      // stays undefined (mirrors the SmartThings payload for these units).
      expect(status!.coolingSetpoint).toBe(59);
      expect(status!.heatingSetpoint).toBeUndefined();
      expect(status!.switchState).toBe('on');
      expect(status!.lightOn).toBe(false);
      expect(status!.humidity).toBe(58);
    });

    it('collapses dry/wind hvac modes to cool, off stays off', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.endsWith('/api/states/climate.samsung_ac')) {
          return haStateResponse('climate.samsung_ac', 'dry', { temperature: 72 });
        }
        throw new Error(`unexpected url ${url}`);
      });
      const backend = newBackend();
      const status = await backend.getDeviceStatus('981073a0-test');
      expect(status!.mode).toBe('cool');
    });

    it('returns null when the entity is missing', async () => {
      mockFetch.mockImplementation(() => ({ ok: false, status: 404, text: async () => '' }));
      const backend = newBackend();
      // withRetry surfaces the failure; getDeviceStatus catches and nulls it.
      expect(await backend.getDeviceStatus('981073a0-test')).toBeNull();
    });
  });

  describe('executeCommands', () => {
    it('translates switch on/off to climate turn_on/turn_off', async () => {
      const backend = newBackend();
      await backend.executeCommands('981073a0-test', [
        { component: 'main', capability: 'switch', command: 'on', arguments: [] },
      ]);
      const [call] = mockFetch.mock.calls;
      expect(call[0].endsWith('/api/services/climate/turn_on')).toBe(true);
      expect(JSON.parse(call[1].body)).toEqual({ entity_id: 'climate.samsung_ac' });
    });

    it('translates setAirConditionerMode to set_hvac_mode', async () => {
      const backend = newBackend();
      await backend.executeCommands('981073a0-test', [
        { component: 'main', capability: 'airConditionerMode', command: 'setAirConditionerMode', arguments: ['heat'] },
      ]);
      const [call] = mockFetch.mock.calls;
      expect(call[0].endsWith('/api/services/climate/set_hvac_mode')).toBe(true);
      expect(JSON.parse(call[1].body)).toEqual({ entity_id: 'climate.samsung_ac', hvac_mode: 'heat' });
    });

    it('routes the mode-off command to turn_off (Samsung ACs have no off mode)', async () => {
      const backend = newBackend();
      await backend.executeCommands('981073a0-test', [
        { component: 'main', capability: 'airConditionerMode', command: 'setAirConditionerMode', arguments: ['off'] },
      ]);
      const [call] = mockFetch.mock.calls;
      expect(call[0].endsWith('/api/services/climate/turn_off')).toBe(true);
    });

    it('translates single-register setpoint writes to set_temperature', async () => {
      const backend = newBackend();
      await backend.executeCommands('981073a0-test', [
        { component: 'main', capability: 'thermostatCoolingSetpoint', command: 'setCoolingSetpoint', arguments: [73] },
      ]);
      const [call] = mockFetch.mock.calls;
      expect(call[0].endsWith('/api/services/climate/set_temperature')).toBe(true);
      expect(JSON.parse(call[1].body)).toEqual({ entity_id: 'climate.samsung_ac', temperature: 73 });
    });

    it('translates the inverted Samsung display-light execute commands', async () => {
      const backend = newBackend();
      // Light_On turns the display OFF (Samsung naming is inverted) - the
      // display light is the mapped switch entity.
      await backend.executeCommands('981073a0-test', [
        {
          component: 'main',
          capability: 'execute',
          command: 'execute',
          arguments: ['mode/vs/0', { 'x.com.samsung.da.options': ['Light_On'] }],
        },
      ]);
      const [call] = mockFetch.mock.calls;
      expect(call[0].endsWith('/api/services/switch/turn_off')).toBe(true);
      expect(JSON.parse(call[1].body)).toEqual({ entity_id: 'switch.samsung_ac_display_light' });
    });

    it('ignores unknown capabilities without failing the batch', async () => {
      const backend = newBackend();
      await expect(
        backend.executeCommands('981073a0-test', [
          { component: 'main', capability: 'someFutureCapability', command: 'doThing', arguments: [] },
        ])
      ).resolves.toBeUndefined();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws a partial-failure error naming succeeded commands when a later one fails', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.endsWith('/api/services/climate/turn_on')) return okJson([]);
        return { ok: false, status: 500, text: async () => 'boom' };
      });
      const backend = newBackend();
      await expect(
        backend.executeCommands('981073a0-test', [
          { component: 'main', capability: 'switch', command: 'on', arguments: [] },
          { component: 'main', capability: 'airConditionerMode', command: 'setAirConditionerMode', arguments: ['heat'] },
        ])
      ).rejects.toThrow(/partially failed.*succeeded=\[main\/switch\/on\]/);
    });
  });

  describe('setTemperature', () => {
    it('writes the setpoint and best-effort turns the display light off', async () => {
      const backend = newBackend();
      const ok = await backend.setTemperature('981073a0-test', 73, 'cool');
      expect(ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [setpointCall] = mockFetch.mock.calls;
      expect(setpointCall[0].endsWith('/api/services/climate/set_temperature')).toBe(true);
      expect(JSON.parse(setpointCall[1].body)).toEqual({ entity_id: 'climate.samsung_ac', temperature: 73 });
      const [lightUrl] = mockFetch.mock.calls[1];
      expect(lightUrl.endsWith('/api/services/switch/turn_off')).toBe(true);
    });
  });
});
