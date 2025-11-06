import { SmartThingsAuthentication } from './SmartThingsAuthentication';
import { SmartThingsAuthToken } from '@/types';
import { promises as fs } from 'fs';

// Mock fs module
jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
    mkdir: jest.fn(),
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

    test('given expired token, should clear token and return no auth', async () => {
      const expiredToken = createMockToken({
        expires_at: Date.now() - 1000, // Expired 1 second ago
      });
      (fs.readFile as jest.Mock).mockResolvedValue(JSON.stringify(expiredToken));

      await auth.load();

      expect(auth.hasAuth()).toBe(false);
      expect(auth.getAccessToken()).toBeNull();
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
    test('given valid token, should save to file with proper formatting', async () => {
      const mockToken = createMockToken();
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

      await auth.save(mockToken);

      expect(fs.mkdir).toHaveBeenCalledWith(
        expect.any(String),
        { recursive: true }
      );
      expect(fs.writeFile).toHaveBeenCalledWith(
        mockTokenPath,
        JSON.stringify(mockToken, null, 2)
      );
    });

    test('given save succeeds, should make token available via getAccessToken', async () => {
      const mockToken = createMockToken();
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);

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
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
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
