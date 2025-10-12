import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { SmartThingsAuthentication } from '@/auth/SmartThingsAuthentication';
import { SmartThingsAuthToken } from '@/types';
import { logger } from '@/utils/logger';
import { withRetry } from '@/utils/retry';

export function createAuthRoutes(auth: SmartThingsAuthentication, onAuthSuccess?: () => void): Router {
  const router = Router();

  router.get('/smartthings', (req: Request, res: Response) => {
    const state = uuidv4();
    const authUrl = new URL('https://api.smartthings.com/oauth/authorize');

    authUrl.searchParams.append('client_id', process.env.SMARTTHINGS_CLIENT_ID!);
    authUrl.searchParams.append('redirect_uri', process.env.SMARTTHINGS_REDIRECT_URI!);
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('scope', 'r:devices:* x:devices:*');
    authUrl.searchParams.append('state', state);

    req.session = req.session || {};
    (req.session as any).oauthState = state;

    res.redirect(authUrl.toString());
  });

  router.get('/smartthings/callback', async (req: Request, res: Response) => {
    logger.debug({ query: req.query, hasSession: !!req.session }, '🔄 OAuth callback received');

    try {
      const { code, state, error } = req.query;

      if (error) {
        logger.error({ error }, '❌ OAuth error');
        return res.redirect('/setup?error=oauth_error');
      }

      if (!code || !state) {
        logger.error({ code: !!code, state: !!state }, '❌ Missing code or state in callback');
        return res.redirect('/setup?error=missing_params');
      }

      const sessionState = req.session && (req.session as any).oauthState;
      logger.debug({ urlState: state, sessionState }, 'State comparison');

      if (state !== sessionState) {
        logger.error('❌ OAuth state mismatch');
        return res.redirect('/setup?error=state_mismatch');
      }

      logger.info({
        hasClientId: !!process.env.SMARTTHINGS_CLIENT_ID,
        hasClientSecret: !!process.env.SMARTTHINGS_CLIENT_SECRET,
        redirectUri: process.env.SMARTTHINGS_REDIRECT_URI
      }, '🔄 Exchanging authorization code for access token');

      const tokenRequestBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code: code as string,
        redirect_uri: process.env.SMARTTHINGS_REDIRECT_URI!,
      });

      const clientCredentials = Buffer.from(
        `${process.env.SMARTTHINGS_CLIENT_ID}:${process.env.SMARTTHINGS_CLIENT_SECRET}`
      ).toString('base64');

      logger.debug('Using Basic Auth for client credentials');

      const tokenResponse = await withRetry(
        () => fetch('https://api.smartthings.com/oauth/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${clientCredentials}`,
          },
          body: tokenRequestBody,
        }),
        { maxRetries: 3, operationName: 'exchange OAuth authorization code' }
      );

      logger.debug({ status: tokenResponse.status }, 'Token response received');

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        logger.error({
          status: tokenResponse.status,
          errorText,
          headers: Object.fromEntries(tokenResponse.headers.entries())
        }, '❌ Token exchange failed');
        return res.redirect('/setup?error=token_exchange_failed');
      }

      const tokenData: any = await tokenResponse.json();
      logger.info('✅ Token response received');

      const authToken: SmartThingsAuthToken = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: Date.now() + (tokenData.expires_in * 1000),
        token_type: tokenData.token_type,
        scope: tokenData.scope,
      };

      logger.debug('💾 Saving auth token');
      await auth.save(authToken);
      logger.info('✅ Auth token saved successfully');

      logger.debug('🎉 Calling onAuthSuccess callback');
      if (onAuthSuccess) {
        onAuthSuccess();
      }

      logger.info('↩️ Redirecting to /setup?success=true');
      res.redirect('/setup?success=true');
    } catch (error) {
      logger.error({ err: error }, 'OAuth callback error');
      res.redirect('/setup?error=callback_error');
    }
  });

  router.get('/status', (req: Request, res: Response) => {
    const hasAuth = auth.hasAuth();
    const token = auth.getToken();

    logger.debug({
      hasAuth,
      hasToken: !!token,
      expiresAt: token ? new Date(token.expires_at) : null,
      scope: token?.scope
    }, '🔍 Auth status check');

    res.json({
      authenticated: hasAuth,
      token: hasAuth ? {
        expires_at: token?.expires_at,
        scope: token?.scope,
      } : null,
    });
  });

  router.post('/logout', async (req: Request, res: Response) => {
    try {
      auth.clear();
      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error }, 'Logout error');
      res.status(500).json({ error: 'Failed to logout' });
    }
  });

  return router;
}