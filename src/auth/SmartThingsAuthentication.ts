import { promises as fs } from 'fs';
import { SmartThingsAuthToken } from '@/types';

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
        console.warn('SmartThings token has expired');
        this.token = null;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Error loading SmartThings token:', error);
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
    console.log('💾 SmartThingsAuthentication.save() called');
    console.log('Token path:', this.tokenPath);
    console.log('Token to save:', { ...token, access_token: '***', refresh_token: '***' });

    this.token = token;

    try {
      const dir = require('path').dirname(this.tokenPath);
      console.log('Creating directory:', dir);
      await fs.mkdir(dir, { recursive: true });

      console.log('Writing token to file...');
      await fs.writeFile(this.tokenPath, JSON.stringify(token, null, 2));
      console.log('✅ SmartThings token saved successfully to:', this.tokenPath);
    } catch (error) {
      console.error('❌ Error saving SmartThings token:', error);
      throw error;
    }
  }

  async refreshToken(): Promise<boolean> {
    if (!this.token?.refresh_token) {
      return false;
    }

    try {
      const clientCredentials = Buffer.from(
        `${process.env.SMARTTHINGS_CLIENT_ID}:${process.env.SMARTTHINGS_CLIENT_SECRET}`
      ).toString('base64');

      const response = await fetch('https://api.smartthings.com/oauth/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${clientCredentials}`,
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.token.refresh_token,
        }),
      });

      if (!response.ok) {
        console.error('Failed to refresh token:', response.statusText);
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
      console.error('Error refreshing token:', error);
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

  clear(): void {
    this.token = null;
  }
}