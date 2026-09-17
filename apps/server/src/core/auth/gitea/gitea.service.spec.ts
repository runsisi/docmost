jest.mock('openid-client', () => ({
  discovery: jest.fn(),
  allowInsecureRequests: jest.fn(),
  enableNonRepudiationChecks: jest.fn(),
  randomPKCECodeVerifier: () => 'verifier',
  randomState: () => 'expected-state',
  randomNonce: () => 'expected-nonce',
  calculatePKCECodeChallenge: async () => 'challenge',
  buildAuthorizationUrl: jest.fn(
    () => new URL('https://gitea.example/authorize'),
  ),
  authorizationCodeGrant: jest.fn(),
  fetchUserInfo: jest.fn(),
}));

import * as oidc from 'openid-client';
import { GiteaService } from './gitea.service';

describe('Gitea login transactions', () => {
  let service: GiteaService;
  let req: any;
  let res: any;
  let redis: any;
  let sessionRepo: any;
  let sessions: any;
  const workspace = { id: 'workspace' } as any;
  const config = {
    serverMetadata: () => ({ issuer: 'https://gitea.example' }),
  };
  const user = { id: 'user', workspaceId: 'workspace' } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    const values = new Map<string, string>();
    redis = {
      set: jest.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
      getdel: jest.fn(async (key: string) => {
        const value = values.get(key);
        values.delete(key);
        return value;
      }),
    };
    req = {
      cookies: {},
      raw: {},
      url: '/api/auth/gitea/callback?code=code&state=expected-state',
    };
    res = {
      setCookie: jest.fn((key: string, value: string) => {
        req.cookies[key] = value;
      }),
      clearCookie: jest.fn(),
    };
    sessionRepo = { findActiveById: jest.fn() };
    sessions = { createSessionAndToken: jest.fn(async () => 'local-session') };
    service = new GiteaService(
      {
        isGiteaEnabled: () => true,
        getGiteaConfig: () => ({
          issuer: 'https://gitea.example',
          clientId: 'client',
          clientSecret: 'secret',
        }),
        getAppUrl: () => 'http://localhost:3010',
        isHttps: () => false,
        getCookieExpiresIn: () => new Date(),
      } as any,
      { getOrThrow: () => redis } as any,
      {} as any,
      {} as any,
      {} as any,
      sessionRepo,
      sessions,
    );
    jest.spyOn(service, 'resolveUser').mockResolvedValue(user);
    (oidc.discovery as jest.Mock).mockResolvedValue(config);
    (oidc.authorizationCodeGrant as jest.Mock).mockResolvedValue({
      access_token: 'token',
      claims: () => ({ sub: 'external-user' }),
    });
    (oidc.fetchUserInfo as jest.Mock).mockResolvedValue({
      sub: 'external-user',
      email: 'user@example.com',
      email_verified: true,
    });
  });

  it('uses PKCE, nonce, state and signature verification before creating a local session', async () => {
    await service.start(workspace, req, res);
    expect(oidc.buildAuthorizationUrl).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        scope: 'openid email profile',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        state: 'expected-state',
        nonce: 'expected-nonce',
      }),
    );
    expect(await service.callback(workspace, req, res)).toEqual({
      redirect: '/home',
    });
    expect(oidc.enableNonRepudiationChecks).toHaveBeenCalledWith(config);
    expect(oidc.authorizationCodeGrant).toHaveBeenCalledWith(
      config,
      expect.any(URL),
      {
        expectedState: 'expected-state',
        expectedNonce: 'expected-nonce',
        pkceCodeVerifier: 'verifier',
        idTokenExpected: true,
      },
    );
    expect(oidc.fetchUserInfo).toHaveBeenCalledWith(
      config,
      'token',
      'external-user',
    );
    expect(sessions.createSessionAndToken).toHaveBeenCalledWith(user);
  });

  it('rejects replayed callbacks', async () => {
    await service.start(workspace, req, res);
    await service.callback(workspace, req, res);
    await expect(service.callback(workspace, req, res)).rejects.toThrow(
      'already used',
    );
    expect(sessions.createSessionAndToken).toHaveBeenCalledTimes(1);
  });

  it('rejects missing browser cookies without exchanging the code', async () => {
    await expect(service.callback(workspace, req, res)).rejects.toThrow(
      'expired',
    );
    expect(oidc.authorizationCodeGrant).not.toHaveBeenCalled();
  });

  it('rejects a callback to another workspace', async () => {
    await service.start(workspace, req, res);
    await expect(
      service.callback({ id: 'other' } as any, req, res),
    ).rejects.toThrow('Workspace does not match');
    expect(oidc.authorizationCodeGrant).not.toHaveBeenCalled();
  });

  it('does not create users or sessions if the provider rejects the token/state/nonce', async () => {
    await service.start(workspace, req, res);
    (oidc.authorizationCodeGrant as jest.Mock).mockRejectedValue(
      new Error('invalid nonce'),
    );
    await expect(service.callback(workspace, req, res)).rejects.toThrow(
      'authentication failed',
    );
    expect(service.resolveUser).not.toHaveBeenCalled();
    expect(sessions.createSessionAndToken).not.toHaveBeenCalled();
  });

  it('validates the external profile before entering the account transaction', async () => {
    await service.start(workspace, req, res);
    (oidc.fetchUserInfo as jest.Mock).mockResolvedValue({
      sub: '',
      email: 'invalid',
    });
    await expect(service.callback(workspace, req, res)).rejects.toThrow(
      'authentication failed',
    );
    expect(service.resolveUser).not.toHaveBeenCalled();
  });

  it('rejects linking when the browser changes local accounts', async () => {
    req.cookies.authToken = 'original-token';
    req.raw.sessionId = 'session';
    await service.start(workspace, req, res, user);
    req.cookies.authToken = 'other-token';
    await expect(service.callback(workspace, req, res)).rejects.toThrow(
      'session changed',
    );
    expect(service.resolveUser).not.toHaveBeenCalled();
  });

  it('rejects linking after the original session was revoked', async () => {
    req.cookies.authToken = 'original-token';
    req.raw.sessionId = 'session';
    await service.start(workspace, req, res, user);
    sessionRepo.findActiveById.mockResolvedValue(undefined);
    await expect(service.callback(workspace, req, res)).rejects.toThrow(
      'session expired',
    );
    expect(service.resolveUser).not.toHaveBeenCalled();
  });

  it('links to the authenticated user without replacing the local session', async () => {
    req.cookies.authToken = 'original-token';
    req.raw.sessionId = 'session';
    await service.start(workspace, req, res, user);
    sessionRepo.findActiveById.mockResolvedValue({
      userId: 'user',
      workspaceId: 'workspace',
    });
    expect(await service.callback(workspace, req, res)).toEqual({
      redirect: '/settings/account/profile?gitea=linked',
    });
    expect(service.resolveUser).toHaveBeenCalledWith(
      workspace,
      'https://gitea.example',
      expect.any(Object),
      'user',
    );
    expect(sessions.createSessionAndToken).not.toHaveBeenCalled();
  });
});
