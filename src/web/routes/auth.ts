import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { SmartThingsAuthentication } from '@/auth/SmartThingsAuthentication';
import { SmartThingsAuthToken } from '@/types';

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
    console.log('===== OAUTH CALLBACK HANDLER EXECUTED =====');
    console.log('🔄 OAuth callback received');
    console.log('Query params:', req.query);
    console.log('Session:', req.session);

    try {
      const { code, state, error } = req.query;

      if (error) {
        console.error('❌ OAuth error:', error);
        return res.redirect('/setup?error=oauth_error');
      }

      if (!code || !state) {
        console.error('❌ Missing code or state in callback');
        console.log('Code:', code, 'State:', state);
        return res.redirect('/setup?error=missing_params');
      }

      const sessionState = req.session && (req.session as any).oauthState;
      console.log('State comparison - URL:', state, 'Session:', sessionState);

      if (state !== sessionState) {
        console.error('❌ OAuth state mismatch');
        return res.redirect('/setup?error=state_mismatch');
      }

      console.log('🔄 Exchanging authorization code for access token');
      console.log('Environment check:');
      console.log('- CLIENT_ID:', process.env.SMARTTHINGS_CLIENT_ID ? '✅' : '❌');
      console.log('- CLIENT_SECRET:', process.env.SMARTTHINGS_CLIENT_SECRET ? '✅' : '❌');
      console.log('- REDIRECT_URI:', process.env.SMARTTHINGS_REDIRECT_URI);

      const tokenRequestBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code: code as string,
        redirect_uri: process.env.SMARTTHINGS_REDIRECT_URI!,
      });

      const clientCredentials = Buffer.from(
        `${process.env.SMARTTHINGS_CLIENT_ID}:${process.env.SMARTTHINGS_CLIENT_SECRET}`
      ).toString('base64');

      console.log('Token request body:', tokenRequestBody.toString());
      console.log('Using Basic Auth for client credentials');

      const tokenResponse = await fetch('https://api.smartthings.com/oauth/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${clientCredentials}`,
        },
        body: tokenRequestBody,
      });

      console.log('Token response status:', tokenResponse.status);

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        console.error('❌ Token exchange failed - Status:', tokenResponse.status);
        console.error('❌ Error response body:', errorText);
        console.error('❌ Response headers:', Object.fromEntries(tokenResponse.headers.entries()));
        return res.redirect('/setup?error=token_exchange_failed');
      }

      const tokenData: any = await tokenResponse.json();
      console.log('✅ Token response received:', tokenData);

      const authToken: SmartThingsAuthToken = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: Date.now() + (tokenData.expires_in * 1000),
        token_type: tokenData.token_type,
        scope: tokenData.scope,
      };

      console.log('💾 Saving auth token...');
      await auth.save(authToken);
      console.log('✅ Auth token saved successfully');

      console.log('🎉 Calling onAuthSuccess callback...');
      if (onAuthSuccess) {
        onAuthSuccess();
      }

      console.log('↩️ Redirecting to /setup?success=true');
      res.redirect('/setup?success=true');
    } catch (error) {
      console.error('OAuth callback error:', error);
      res.redirect('/setup?error=callback_error');
    }
  });

  router.get('/status', (req: Request, res: Response) => {
    console.log('🔍 Auth status check');
    const hasAuth = auth.hasAuth();
    const token = auth.getToken();

    console.log('- Has auth:', hasAuth);
    console.log('- Token exists:', !!token);
    if (token) {
      console.log('- Token expires at:', new Date(token.expires_at));
      console.log('- Token scope:', token.scope);
    }

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
      console.error('Logout error:', error);
      res.status(500).json({ error: 'Failed to logout' });
    }
  });

  return router;
}