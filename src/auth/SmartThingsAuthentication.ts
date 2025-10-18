import { promises as fs } from 'fs';
import { SmartThingsAuthToken } from '@/types';
import { logger } from '@/utils/logger';
import { withRetry } from '@/utils/retry';

export class SmartThingsAuthentication {
  private token: SmartThingsAuthToken | null = null;
  private readonly tokenPath: string;

  constructor(tokenPath: string) {
    this.tokenPath = tokenPath;
  }

  async load(): Promise<void> {
    try {
      const tokenData = await fs.readFile(this.tokenPath, 'utf-8');
      this.token = JSON.parse(tokenData);

      if (this.token && this.isTokenExpired()) {
        logger.warn('SmartThings token has expired');
        this.token = null;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ err: error }, 'Error loading SmartThings token');
      }
      this.token = null;
    }
  }

  hasAuth(): boolean {
    return this.token !== null && !this.isTokenExpired();
  }

  getToken(): SmartThingsAuthToken | null {
    if (!this.hasAuth()) {
      return null;
    }
    return this.token;
  }

  getAccessToken(): string | null {
    const token = this.getToken();
    return token ? token.access_token : null;
  }

  async save(token: SmartThingsAuthToken): Promise<void> {
    logger.debug({ path: this.tokenPath }, '💾 SmartThingsAuthentication.save() called');

    this.token = token;

    try {
      const dir = require('path').dirname(this.tokenPath);
      logger.debug({ dir }, 'Creating directory');
      await fs.mkdir(dir, { recursive: true });

      logger.debug('Writing token to file');
      await fs.writeFile(this.tokenPath, JSON.stringify(token, null, 2));
      logger.info({ path: this.tokenPath }, '✅ SmartThings token saved successfully');
    } catch (error) {
      logger.error({ err: error }, '❌ Error saving SmartThings token');
      throw error;
    }
  }

  async refreshToken(): Promise<boolean> {
    if (!this.token?.refresh_token) {
      return false;
    }

    try {
      const refreshToken = this.token.refresh_token;
      const clientCredentials = Buffer.from(
        `${process.env.SMARTTHINGS_CLIENT_ID}:${process.env.SMARTTHINGS_CLIENT_SECRET}`
      ).toString('base64');

      const response = await withRetry(
        () => fetch('https://api.smartthings.com/oauth/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${clientCredentials}`,
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken!,
          }),
        }),
        { maxRetries: 3, operationName: 'refresh OAuth token' }
      );

      if (!response.ok) {
        logger.error({ status: response.statusText }, 'Failed to refresh token');
        return false;
      }

      const tokenData: any = await response.json();
      const newToken: SmartThingsAuthToken = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token || this.token.refresh_token,
        expires_at: Date.now() + (tokenData.expires_in * 1000),
        token_type: tokenData.token_type,
        scope: tokenData.scope,
      };

      await this.save(newToken);
      return true;
    } catch (error) {
      logger.error({ err: error }, 'Error refreshing token');
      return false;
    }
  }

  private isTokenExpired(): boolean {
    if (!this.token) {
      return true;
    }

    const bufferTime = 5 * 60 * 1000;
    return Date.now() >= (this.token.expires_at - bufferTime);
  }

  /**
   * Checks if token should be proactively refreshed.
   * Uses a longer threshold (1 hour) to refresh before expiration.
   */
  private shouldProactivelyRefresh(): boolean {
    if (!this.token) {
      return false;
    }

    // Refresh if token will expire within 1 hour
    const proactiveThreshold = 60 * 60 * 1000; // 1 hour
    return Date.now() >= (this.token.expires_at - proactiveThreshold);
  }

  /**
   * Gets time until token expiration in milliseconds.
   * Returns null if no token exists.
   */
  getTimeUntilExpiration(): number | null {
    if (!this.token) {
      return null;
    }
    return this.token.expires_at - Date.now();
  }

  async ensureValidToken(): Promise<boolean> {
    if (this.hasAuth()) {
      return true;
    }

    if (this.token && this.isTokenExpired()) {
      const refreshed = await this.refreshToken();
      if (refreshed) {
        return true;
      }
    }

    return false;
  }

  /**
   * Proactively checks and refreshes token if it's close to expiration.
   * Should be called periodically (e.g., every hour) to maintain fresh tokens.
   * @returns true if token was refreshed or is still valid, false if refresh failed
   */
  async checkAndRefreshToken(): Promise<boolean> {
    if (!this.token) {
      logger.debug('No token to refresh');
      return false;
    }

    const timeUntilExpiration = this.getTimeUntilExpiration();
    if (timeUntilExpiration === null) {
      return false;
    }

    const hoursUntilExpiration = timeUntilExpiration / (60 * 60 * 1000);

    if (this.shouldProactivelyRefresh()) {
      logger.info({ hoursUntilExpiration: hoursUntilExpiration.toFixed(2) },
        '🔄 Token expiring soon, proactively refreshing');

      const refreshed = await this.refreshToken();
      if (refreshed) {
        logger.info('✅ Token proactively refreshed successfully');
        return true;
      } else {
        logger.error('❌ Failed to proactively refresh token');
        return false;
      }
    } else {
      logger.debug({ hoursUntilExpiration: hoursUntilExpiration.toFixed(2) },
        '✓ Token still valid, no refresh needed');
      return true;
    }
  }

  clear(): void {
    this.token = null;
  }
}