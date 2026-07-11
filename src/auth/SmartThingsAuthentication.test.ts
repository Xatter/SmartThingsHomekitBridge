import { SmartThingsAuthentication } from './SmartThingsAuthentication';
import { SmartThingsAuthToken } from '@/types';
import { promises as fs } from 'fs';

// Mock fs module
jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
    mkdir: jest.fn(),
    rename: jest.fn(),
    unlink: jest.fn(),
  },
}));

// Mock path module
jest.mock('path', () => ({
  ...jest.requireActual('path'),
  dirname: jest.fn((p: string) => p.substring(0, p.lastIndexOf('/'))),
}));

// Mock global fetch
global.fetch = jest.fn();

describe('SmartThingsAuthentication', () => {
  let auth: SmartThingsAuthentication;
  const mockTokenPath = '/test/data/token.json';

  const createMockToken = (overrides: Partial<SmartThingsAuthToken> = {}): SmartThingsAuthToken => ({
    access_token: 'mock-access-token',
    refresh_token: 'mock-refresh-token',
    expires_at: Date.now() + 3600000, // 1 hour from now
    token_type: 'Bearer',
    scope: 'r:devices:* x:devices:*',
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    auth = new SmartThingsAuthentication(mockTokenPath);

    // Set up environment variables
    process.env.SMARTTHINGS_CLIENT_ID = 'test-client-id';
    process.env.SMARTTHINGS_CLIENT_SECRET = 'test-client-secret';

    // Default happy-path fs mocks (atomicWriteJson uses mkdir/writeFile/rename;
    // clearPersistent uses unlink). Individual tests override as needed.
    (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
    (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
    (fs.rename as jest.Mock).mockResolvedValue(undefined);
    (fs.unlink as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.SMARTTHINGS_CLIENT_ID;
    delete process.env.SMARTTHINGS_CLIENT_SECRET;
  });

  describe('load', () => {
    test('given valid token file, should load token', async () => {
      const mockToken = createMockToken();
      (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(mockToken));

      await auth.load();

      expect(auth.hasAuth()).toBe(true);
      expect(auth.getAccessToken()).toBe(mockToken.access_token);
    });

    test('given expired token, should report no auth but retain token for refresh', async () => {
      const expiredToken = createMockToken({
        expires_at: Date.now() - 1000, // Expired 1 second ago
      });
      (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(expiredToken));

      await auth.load();

      expect(auth.hasAuth()).toBe(false);
      expect(auth.getAccessToken()).toBeNull();
      // The expired access token must NOT be discarded: its refresh_token
      // may still be valid, and dropping it would permanently require
      // manual re-auth after any restart past expiry. getTimeUntilExpiration
      // returning non-null proves the token object is still held in memory.
      expect(auth.getTimeUntilExpiration()).not.toBeNull();
    });

    test('given expired token file, should keep refresh_token so ensureValidToken can refresh', async () => {
      const expiredToken = createMockToken({
        expires_at: Date.now() - 1000,
        refresh_token: 'still-valid-refresh-token',
      });
      (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(expiredToken));

      await auth.load();
      expect(auth.hasAuth()).toBe(false);

      const newTokenResponse = {
        access_token: 'restart-refreshed-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'r:devices:* x:devices:*',
      };

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => newTokenResponse,
      });

      const ensured = await auth.ensureValidToken();

      expect(ensured).toBe(true);
      expect(auth.hasAuth()).toBe(true);
      expect(auth.getAccessToken()).toBe('restart-refreshed-token');

      const calledBody = (global.fetch as jest.Mock).mock.calls[0][1].body as URLSearchParams;
      expect(calledBody.get('refresh_token')).toBe('still-valid-refresh-token');
    });

    test('given file does not exist, should handle gracefully', async () => {
      const error: NodeJS.ErrnoException = new Error('File not found');
      error.code = 'ENOENT';
      (fs.readFile as jest.Mock).mockRejectedValue(error);

      await auth.load();

      expect(auth.hasAuth()).toBe(false);
    });

    test('given corrupted token file, should handle gracefully', async () => {
      (fs.readFile as jest.Mock).mockResolvedValue('invalid json {');

      await auth.load();

      expect(auth.hasAuth()).toBe(false);
    });

    test('given other file error, should handle gracefully and log error', async () => {
      const error = new Error('Permission denied');
      (fs.readFile as jest.Mock).mockRejectedValue(error);

      await auth.load();

      expect(auth.hasAuth()).toBe(false);
    });
  });

  describe('hasAuth', () => {
    test('given valid token, should return true', async () => {
      const mockToken = createMockToken();
      (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(mockToken));
      await auth.load();

      const actual = auth.hasAuth();
      const expected = true;

      expect(actual).toBe(expected);
    });

    test('given expired token, should return false', async () => {
      const expiredToken = createMockToken({
        expires_at: Date.now() - 1000,
      });
      (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(expiredToken));
      await auth.load();

      const actual = auth.hasAuth();
      const expected = false;

      expect(actual).toBe(expected);
    });

    test('given token expiring within 5 minutes, should return false', async () => {
      const soonToExpireToken = createMockToken({
        expires_at: Date.now() + (4 * 60 * 1000), // 4 minutes from now
      });
      (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(soonToExpireToken));
      await auth.load();

      const actual = auth.hasAuth();
      const expected = false;

      expect(actual).toBe(expected);
    });

    test('given no token, should return false', () => {
      const actual = auth.hasAuth();
      const expected = false;

      expect(actual).toBe(expected);
    });
  });

  describe('getToken', () => {
    test('given valid token, should return token object', async () => {
      const mockToken = createMockToken();
      (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(mockToken));
      await auth.load();

      const actual = auth.getToken();

      expect(actual).toEqual(mockToken);
    });

    test('given expired token, should return null', async () => {
      const expiredToken = createMockToken({
        expires_at: Date.now() - 1000,
      });
      (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(expiredToken));
      await auth.load();

      const actual = auth.getToken();
      const expected = null;

      expect(actual).toBe(expected);
    });
  });

  describe('getAccessToken', () => {
    test('given valid token, should return access token string', async () => {
      const mockToken = createMockToken();
      (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(mockToken));
      await auth.load();

      const actual = auth.getAccessToken();
      const expected = 'mock-access-token';

      expect(actual).toBe(expected);
    });

    test('given no token, should return null', () => {
      const actual = auth.getAccessToken();
      const expected = null;

      expect(actual).toBe(expected);
    });
  });

  describe('save', () => {
    // atomicWriteJson writes to a uniquely-named temp file next to the
    // target, then renames it into place. The contract that matters here is
    // write-to-temp-then-rename-to-target, so match the temp name loosely
    // rather than encoding its exact uniqueness scheme.
    const tempFilePattern = /token\.json\..+\.tmp$/;

    test('given valid token, should save atomically via temp file + rename', async () => {
      const mockToken = createMockToken();

      await auth.save(mockToken);

      expect(fs.mkdir).toHaveBeenCalledWith(
        expect.any(String),
        { recursive: true }
      );
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringMatching(tempFilePattern),
        JSON.stringify(mockToken, null, 2),
        'utf-8'
      );
      // The rename must move the exact temp file that was written.
      const writtenTempPath = (fs.writeFile as jest.Mock).mock.calls[0][0];
      expect(writtenTempPath).toMatch(tempFilePattern);
      expect(fs.rename).toHaveBeenCalledWith(writtenTempPath, mockTokenPath);
    });

    test('given save succeeds, should make token available via getAccessToken', async () => {
      const mockToken = createMockToken();

      await auth.save(mockToken);

      expect(auth.getAccessToken()).toBe(mockToken.access_token);
      expect(auth.hasAuth()).toBe(true);
    });

    test('given directory creation fails, should throw error', async () => {
      const mockToken = createMockToken();
      const error = new Error('Permission denied');
      (fs.mkdir as jest.Mock).mockRejectedValue(error);

      await expect(auth.save(mockToken)).rejects.toThrow('Permission denied');
    });

    test('given file write fails, should throw error', async () => {
      const mockToken = createMockToken();
      const error = new Error('Disk full');
      (fs.writeFile as jest.Mock).mockRejectedValue(error);

      await expect(auth.save(mockToken)).rejects.toThrow('Disk full');
    });
  });

  describe('refreshToken', () => {
    const mockFetch = global.fetch as jest.Mock;

    beforeEach(() => {
      mockFetch.mockClear();
      // Reset fs mocks to prevent pollution from previous tests
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
    });

    test('given valid refresh token, should request new token from SmartThings', async () => {
      const initialToken = createMockToken();
      await auth.save(initialToken);

      const newTokenResponse = {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'r:devices:* x:devices:*',
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => newTokenResponse,
      });

      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);

      const actual = await auth.refreshToken();
      const expected = true;

      expect(actual).toBe(expected);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.smartthings.com/oauth/token',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': expect.stringContaining('Basic'),
          }),
        })
      );
    });

    test('given successful refresh, should save new token', async () => {
      const initialToken = createMockToken();
      await auth.save(initialToken);

      const newTokenResponse = {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'r:devices:* x:devices:*',
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => newTokenResponse,
      });

      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);

      await auth.refreshToken();

      expect(auth.getAccessToken()).toBe('new-access-token');
    });

    test('given no refresh_token in response, should use existing refresh token', async () => {
      const initialToken = createMockToken({ refresh_token: 'original-refresh' });
      await auth.save(initialToken);

      const newTokenResponse = {
        access_token: 'new-access-token',
        // No refresh_token in response
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'r:devices:* x:devices:*',
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => newTokenResponse,
      });

      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);

      await auth.refreshToken();

      const savedToken = auth.getToken();
      expect(savedToken?.refresh_token).toBe('original-refresh');
    });

    test('given no existing refresh token, should return false', async () => {
      const actual = await auth.refreshToken();
      const expected = false;

      expect(actual).toBe(expected);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test('given API returns error, should return false', async () => {
      const initialToken = createMockToken();
      await auth.save(initialToken);

      mockFetch.mockResolvedValue({
        ok: false,
        statusText: 'Invalid refresh token',
      });

      const actual = await auth.refreshToken();
      const expected = false;

      expect(actual).toBe(expected);
    });

    test('given network error, should return false and log error', async () => {
      const initialToken = createMockToken();
      await auth.save(initialToken);

      mockFetch.mockRejectedValue(new Error('Network error'));

      const actual = await auth.refreshToken();
      const expected = false;

      expect(actual).toBe(expected);
    });

    test('given refresh succeeds, should calculate correct expires_at', async () => {
      const initialToken = createMockToken();
      await auth.save(initialToken);

      const expiresIn = 7200; // 2 hours
      const beforeCall = Date.now();

      const newTokenResponse = {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: expiresIn,
        token_type: 'Bearer',
        scope: 'r:devices:* x:devices:*',
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => newTokenResponse,
      });

      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);

      await auth.refreshToken();

      const afterCall = Date.now();
      const savedToken = auth.getToken();

      expect(savedToken?.expires_at).toBeGreaterThanOrEqual(beforeCall + (expiresIn * 1000));
      expect(savedToken?.expires_at).toBeLessThanOrEqual(afterCall + (expiresIn * 1000));
    });

    test('given two concurrent refreshToken calls, should coalesce into a single fetch', async () => {
      const initialToken = createMockToken();
      await auth.save(initialToken);
      mockFetch.mockClear();

      let resolveFetch!: (value: unknown) => void;
      mockFetch.mockImplementation(() => new Promise((resolve) => {
        resolveFetch = resolve;
      }));

      const newTokenResponse = {
        access_token: 'coalesced-access-token',
        refresh_token: 'coalesced-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'r:devices:* x:devices:*',
      };

      const p1 = auth.refreshToken();
      const p2 = auth.refreshToken();

      // Flush microtasks so both calls have reached the fetch invocation
      // before we assert only one underlying call was made.
      await Promise.resolve();
      await Promise.resolve();

      expect(mockFetch).toHaveBeenCalledTimes(1);

      resolveFetch({
        ok: true,
        status: 200,
        json: async () => newTokenResponse,
      });

      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1).toBe(true);
      expect(r2).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(auth.getAccessToken()).toBe('coalesced-access-token');
    });

    test('given 500 then 200, should retry via withRetry and succeed', async () => {
      const initialToken = createMockToken();
      await auth.save(initialToken);
      mockFetch.mockClear();

      const newTokenResponse = {
        access_token: 'retried-access-token',
        refresh_token: 'retried-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'r:devices:* x:devices:*',
      };

      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => newTokenResponse });

      const actual = await auth.refreshToken();

      expect(actual).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(auth.getAccessToken()).toBe('retried-access-token');
    }, 15000);

    test('given 400, should NOT retry and should return false', async () => {
      const initialToken = createMockToken();
      await auth.save(initialToken);
      mockFetch.mockClear();

      mockFetch.mockResolvedValue({ ok: false, status: 400, statusText: 'Bad Request' });

      const actual = await auth.refreshToken();

      expect(actual).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test('given fetch options, should include an AbortSignal timeout', async () => {
      const initialToken = createMockToken();
      await auth.save(initialToken);
      mockFetch.mockClear();

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'x',
          refresh_token: 'y',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'r:devices:*',
        }),
      });

      await auth.refreshToken();

      const options = mockFetch.mock.calls[0][1];
      expect(options.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('ensureValidToken', () => {
    beforeEach(() => {
      // Reset fs mocks to prevent pollution from previous tests
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
    });

    test('given valid token, should return true without refresh', async () => {
      const mockToken = createMockToken();
      await auth.save(mockToken);

      const actual = await auth.ensureValidToken();
      const expected = true;

      expect(actual).toBe(expected);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('given expired token with valid refresh, should refresh and return true', async () => {
      const expiredToken = createMockToken({
        expires_at: Date.now() - 1000,
      });
      await auth.save(expiredToken);

      const newTokenResponse = {
        access_token: 'refreshed-access-token',
        refresh_token: 'refreshed-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'r:devices:* x:devices:*',
      };

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => newTokenResponse,
      });

      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);

      const actual = await auth.ensureValidToken();
      const expected = true;

      expect(actual).toBe(expected);
      expect(auth.getAccessToken()).toBe('refreshed-access-token');
    });

    test('given expired token and refresh fails, should return false', async () => {
      const expiredToken = createMockToken({
        expires_at: Date.now() - 1000,
      });
      await auth.save(expiredToken);

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        statusText: 'Invalid refresh token',
      });

      const actual = await auth.ensureValidToken();
      const expected = false;

      expect(actual).toBe(expected);
    });

    test('given no token, should return false', async () => {
      const actual = await auth.ensureValidToken();
      const expected = false;

      expect(actual).toBe(expected);
    });
  });

  describe('clear', () => {
    beforeEach(() => {
      // Reset fs mocks to prevent pollution from previous tests
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
    });

    test('given existing token, should clear auth state', async () => {
      const mockToken = createMockToken();
      await auth.save(mockToken);

      expect(auth.hasAuth()).toBe(true);

      auth.clear();

      expect(auth.hasAuth()).toBe(false);
      expect(auth.getAccessToken()).toBeNull();
    });

    test('given no token, should handle gracefully', () => {
      expect(() => auth.clear()).not.toThrow();
      expect(auth.hasAuth()).toBe(false);
    });
  });

  describe('clearPersistent', () => {
    test('given existing token file, should clear in-memory token and delete file', async () => {
      const mockToken = createMockToken();
      await auth.save(mockToken);
      expect(auth.hasAuth()).toBe(true);

      await auth.clearPersistent();

      expect(fs.unlink).toHaveBeenCalledWith(mockTokenPath);
      expect(auth.hasAuth()).toBe(false);
      expect(auth.getAccessToken()).toBeNull();
    });

    test('given token file does not exist (ENOENT), should be tolerated without throwing', async () => {
      const error: NodeJS.ErrnoException = new Error('File not found');
      error.code = 'ENOENT';
      (fs.unlink as jest.Mock).mockRejectedValue(error);

      await expect(auth.clearPersistent()).resolves.toBeUndefined();
      expect(auth.hasAuth()).toBe(false);
    });

    test('given unlink fails with a non-ENOENT error, should not throw', async () => {
      const error = new Error('Permission denied');
      (fs.unlink as jest.Mock).mockRejectedValue(error);

      await expect(auth.clearPersistent()).resolves.toBeUndefined();
      expect(auth.hasAuth()).toBe(false);
    });

    test('given no prior token, should still attempt to delete file and not throw', async () => {
      await expect(auth.clearPersistent()).resolves.toBeUndefined();
      expect(fs.unlink).toHaveBeenCalledWith(mockTokenPath);
    });
  });

  describe('getTimeUntilExpiration', () => {
    test('given valid token, should return time in milliseconds until expiration', async () => {
      const expiresAt = Date.now() + 7200000; // 2 hours from now
      const mockToken = createMockToken({ expires_at: expiresAt });
      await auth.save(mockToken);

      const timeUntilExpiration = auth.getTimeUntilExpiration();

      expect(timeUntilExpiration).not.toBeNull();
      expect(timeUntilExpiration).toBeGreaterThan(7100000); // ~2 hours
      expect(timeUntilExpiration).toBeLessThanOrEqual(7200000);
    });

    test('given no token, should return null', () => {
      const timeUntilExpiration = auth.getTimeUntilExpiration();

      expect(timeUntilExpiration).toBeNull();
    });

    test('given expired token, should return negative value', async () => {
      const expiresAt = Date.now() - 1000; // Expired 1 second ago
      const mockToken = createMockToken({ expires_at: expiresAt });
      await auth.save(mockToken);

      const timeUntilExpiration = auth.getTimeUntilExpiration();

      expect(timeUntilExpiration).not.toBeNull();
      expect(timeUntilExpiration).toBeLessThan(0);
    });
  });

  describe('checkAndRefreshToken', () => {
    const mockFetch = global.fetch as jest.Mock;

    beforeEach(() => {
      mockFetch.mockClear();
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
    });

    test('given token expiring within 1 hour, should proactively refresh', async () => {
      // Token expires in 30 minutes
      const mockToken = createMockToken({
        expires_at: Date.now() + (30 * 60 * 1000),
      });
      await auth.save(mockToken);

      const newTokenResponse = {
        access_token: 'proactive-refresh-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'r:devices:* x:devices:*',
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => newTokenResponse,
      });

      const actual = await auth.checkAndRefreshToken();
      const expected = true;

      expect(actual).toBe(expected);
      expect(mockFetch).toHaveBeenCalled();
      expect(auth.getAccessToken()).toBe('proactive-refresh-token');
    });

    test('given token valid for more than 1 hour, should not refresh', async () => {
      // Token expires in 2 hours
      const mockToken = createMockToken({
        expires_at: Date.now() + (2 * 60 * 60 * 1000),
      });
      await auth.save(mockToken);

      const actual = await auth.checkAndRefreshToken();
      const expected = true;

      expect(actual).toBe(expected);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(auth.getAccessToken()).toBe('mock-access-token');
    });

    test('given token expiring in exactly 1 hour, should proactively refresh', async () => {
      // Token expires in exactly 1 hour
      const mockToken = createMockToken({
        expires_at: Date.now() + (60 * 60 * 1000),
      });
      await auth.save(mockToken);

      const newTokenResponse = {
        access_token: 'refreshed-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'r:devices:* x:devices:*',
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => newTokenResponse,
      });

      const actual = await auth.checkAndRefreshToken();

      expect(actual).toBe(true);
      expect(mockFetch).toHaveBeenCalled();
    });

    test('given no token, should return false', async () => {
      const actual = await auth.checkAndRefreshToken();
      const expected = false;

      expect(actual).toBe(expected);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test('given refresh fails, should return false', async () => {
      const mockToken = createMockToken({
        expires_at: Date.now() + (30 * 60 * 1000), // 30 minutes
      });
      await auth.save(mockToken);

      mockFetch.mockResolvedValue({
        ok: false,
        statusText: 'Invalid refresh token',
      });

      const actual = await auth.checkAndRefreshToken();
      const expected = false;

      expect(actual).toBe(expected);
    });

    test('given already expired token, should attempt refresh', async () => {
      const mockToken = createMockToken({
        expires_at: Date.now() - 1000, // Already expired
      });
      await auth.save(mockToken);

      const newTokenResponse = {
        access_token: 'late-refresh-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'r:devices:* x:devices:*',
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => newTokenResponse,
      });

      const actual = await auth.checkAndRefreshToken();

      expect(actual).toBe(true);
      expect(mockFetch).toHaveBeenCalled();
      expect(auth.getAccessToken()).toBe('late-refresh-token');
    });
  });

  describe('integration: OAuth flow simulation', () => {
    test('full OAuth flow: initial auth, expiry, refresh', async () => {
      // Step 1: Initial authentication (simulated save)
      const initialToken = createMockToken({
        expires_at: Date.now() + 3600000, // 1 hour
      });
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      await auth.save(initialToken);
      expect(auth.hasAuth()).toBe(true);

      // Step 2: Token expires
      const expiredToken = createMockToken({
        expires_at: Date.now() - 1000,
        refresh_token: initialToken.refresh_token,
      });
      await auth.save(expiredToken);
      expect(auth.hasAuth()).toBe(false);

      // Step 3: Automatic refresh via ensureValidToken
      const refreshedTokenResponse = {
        access_token: 'auto-refreshed-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'r:devices:* x:devices:*',
      };

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => refreshedTokenResponse,
      });

      const ensured = await auth.ensureValidToken();

      expect(ensured).toBe(true);
      expect(auth.hasAuth()).toBe(true);
      expect(auth.getAccessToken()).toBe('auto-refreshed-token');
    });
  });
});
