import { promises as fs } from 'fs';
import { SmartThingsAuthToken } from '@/types';
import { logger } from '@/utils/logger';
import { withRetry, RetryableError } from '@/utils/retry';
import { atomicWriteJson } from '@/utils/atomicWrite';
import { singleFlight } from '@/utils/singleFlight';

const REFRESH_TIMEOUT_MS = 15000;

export class SmartThingsAuthentication {
  private token: SmartThingsAuthToken | null = null;
  private readonly tokenPath: string;
  private readonly performRefresh: () => Promise<boolean>;

  constructor(tokenPath: string) {
    this.tokenPath = tokenPath;
    // Refresh tokens are single-use and rotating: two concurrent refresh
    // calls would race to consume the same refresh_token, so all callers
    // during an in-flight refresh must share the same underlying promise.
    this.performRefresh = singleFlight(() => this.doRefreshToken());
  }

  async load(): Promise<void> {
    try {
      const tokenData = await fs.readFile(this.tokenPath, 'utf-8');
      this.token = JSON.parse(tokenData);

      if (this.token && this.isTokenExpired()) {
        // Keep the expired token in memory rather than discarding it: the
        // access token is expired, but the refresh_token may still be
        // valid, and ensureValidToken()/checkAndRefreshToken() need the
        // refresh_token to recover without requiring manual re-auth.
        logger.warn('SmartThings access token has expired; will attempt refresh using stored refresh token');
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
      await atomicWriteJson(this.tokenPath, token);
      logger.info({ path: this.tokenPath }, '✅ SmartThings token saved successfully');
    } catch (error) {
      logger.error({ err: error }, '❌ Error saving SmartThings token');
      throw error;
    }
  }

  /**
   * Refreshes the access token using the stored refresh token.
   *
   * Refresh tokens are single-use and rotating, so concurrent invocations
   * are coalesced onto a single in-flight refresh (see the constructor) —
   * every caller during an in-flight refresh awaits the same promise and
   * only one HTTP request is made.
   */
  async refreshToken(): Promise<boolean> {
    return this.performRefresh();
  }

  private async doRefreshToken(): Promise<boolean> {
    if (!this.token?.refresh_token) {
      return false;
    }

    const refreshToken = this.token.refresh_token;

    try {
      const clientCredentials = Buffer.from(
        `${process.env.SMARTTHINGS_CLIENT_ID}:${process.env.SMARTTHINGS_CLIENT_SECRET}`
      ).toString('base64');

      const response = await withRetry(
        async () => {
          const res = await fetch('https://api.smartthings.com/oauth/token', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Authorization': `Basic ${clientCredentials}`,
            },
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: refreshToken!,
            }),
            signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
          });

          if (!res.ok) {
            // fetch() resolves (does not reject) on HTTP error statuses, so
            // withRetry never sees a rejection to retry on unless we throw
            // here ourselves. Attaching statusCode lets isRetryableError()
            // classify 5xx/429 as retryable and 4xx (e.g. 400/401 - a
            // consumed/invalid refresh token) as fatal.
            const error: RetryableError = new Error(
              `SmartThings token refresh failed: ${res.status} ${res.statusText}`
            );
            error.statusCode = res.status;
            throw error;
          }

          return res;
        },
        { maxRetries: 3, operationName: 'refresh OAuth token' }
      );

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
      const statusCode = (error as RetryableError)?.statusCode;
      logger.error({ err: error, statusCode }, 'Error refreshing token');
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

  /**
   * Clears the in-memory token and best-effort deletes the persisted token
   * file. Used for logout: unlike clear(), this also removes the on-disk
   * token so a restart doesn't silently pick the credentials back up.
   */
  async clearPersistent(): Promise<void> {
    this.token = null;

    try {
      await fs.unlink(this.tokenPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ err: error, path: this.tokenPath }, 'Error deleting SmartThings token file');
      }
    }
  }
}