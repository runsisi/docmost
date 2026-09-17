import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { createHash, randomBytes } from 'node:crypto';
import * as oidc from 'openid-client';
import { z } from 'zod';
import { FastifyReply, FastifyRequest } from 'fastify';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { KyselyDB } from '../../../database/types/kysely.types';
import { User, Workspace } from '../../../database/types/entity.types';
import { UserRepo } from '../../../database/repos/user/user.repo';
import { UserSessionRepo } from '../../../database/repos/session/user-session.repo';
import { GroupUserRepo } from '../../../database/repos/group/group-user.repo';
import { SessionService } from '../../session/session.service';
import { isUserDisabled } from '../../../common/helpers';
import { UserRole } from '../../../common/helpers/types/permission';
import { validateAllowedEmail } from '../auth.util';
import { getWorkspaceDefaultPageEditMode } from '../../workspace/workspace.util';

const FLOW_COOKIE = 'gitea_flow';
const FLOW_PATH = '/api/auth/gitea';
const FLOW_TTL = 600;
const profileSchema = z.object({
  sub: z.string().min(1).max(255),
  email: z
    .email()
    .max(320)
    .transform((email) => email.toLowerCase()),
  email_verified: z.boolean().optional(),
  name: z.string().optional(),
  preferred_username: z.string().optional(),
});
type Profile = z.infer<typeof profileSchema>;
type Binding = { userId: string; sessionId: string; tokenHash: string };
type Flow = {
  workspaceId: string;
  issuer: string;
  state: string;
  nonce: string;
  verifier: string;
  binding?: Binding;
};

@Injectable()
export class GiteaService {
  constructor(
    private readonly environment: EnvironmentService,
    private readonly redisService: RedisService,
    @InjectKysely() private readonly db: KyselyDB,
    private readonly userRepo: UserRepo,
    private readonly groupUserRepo: GroupUserRepo,
    private readonly sessionRepo: UserSessionRepo,
    private readonly sessions: SessionService,
  ) {}

  private requireEnabled() {
    if (!this.environment.isGiteaEnabled()) {
      throw new NotFoundException('Gitea login is not enabled.');
    }
  }

  private async client() {
    const { issuer, clientId, clientSecret } =
      this.environment.getGiteaConfig();
    const config = await oidc.discovery(
      new URL(issuer),
      clientId,
      clientSecret,
      undefined,
      {
        execute: issuer.startsWith('http:') ? [oidc.allowInsecureRequests] : [],
        timeout: 10,
      },
    );
    // Also verify the ID token signature, including when an HTTP issuer is configured.
    oidc.enableNonRepudiationChecks(config);
    return config;
  }

  private callbackUrl() {
    return `${this.environment.getAppUrl()}${FLOW_PATH}/callback`;
  }

  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  async start(
    workspace: Workspace,
    req: FastifyRequest,
    res: FastifyReply,
    user?: User,
  ) {
    this.requireEnabled();
    const config = await this.client();
    const verifier = oidc.randomPKCECodeVerifier();
    const flow: Flow = {
      workspaceId: workspace.id,
      issuer: config.serverMetadata().issuer,
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      verifier,
    };
    if (user) {
      const sessionId = (req.raw as any).sessionId;
      if (!sessionId || !req.cookies.authToken) {
        throw new UnauthorizedException('Sign in again before linking Gitea.');
      }
      flow.binding = {
        userId: user.id,
        sessionId,
        tokenHash: this.hash(req.cookies.authToken),
      };
    }
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: this.callbackUrl(),
      scope: 'openid email profile',
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
    });
    const browserToken = randomBytes(32).toString('hex');
    await this.redisService
      .getOrThrow()
      .set(
        `gitea:flow:${this.hash(browserToken)}`,
        JSON.stringify(flow),
        'EX',
        FLOW_TTL,
      );
    res.setCookie(FLOW_COOKIE, browserToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.environment.isHttps(),
      path: FLOW_PATH,
      maxAge: FLOW_TTL,
    });
    return url.href;
  }

  async callback(workspace: Workspace, req: FastifyRequest, res: FastifyReply) {
    this.requireEnabled();
    const browserToken = req.cookies[FLOW_COOKIE];
    res.clearCookie(FLOW_COOKIE, { path: FLOW_PATH });
    if (!browserToken)
      throw new BadRequestException('Gitea login expired. Please try again.');
    const stored = await this.redisService
      .getOrThrow()
      .getdel(`gitea:flow:${this.hash(browserToken)}`);
    if (!stored)
      throw new BadRequestException('Gitea login expired or already used.');
    const flow: Flow = JSON.parse(stored);
    if (flow.workspaceId !== workspace.id)
      throw new BadRequestException('Workspace does not match.');
    const config = await this.client();
    if (flow.issuer !== config.serverMetadata().issuer)
      throw new BadRequestException('Gitea issuer changed.');

    let profile: Profile;
    try {
      const currentUrl = new URL(this.callbackUrl());
      currentUrl.search = new URL(req.url, this.environment.getAppUrl()).search;
      const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        pkceCodeVerifier: flow.verifier,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      const info = await oidc.fetchUserInfo(
        config,
        tokens.access_token,
        claims.sub,
      );
      profile = profileSchema.parse(info);
    } catch {
      throw new BadRequestException(
        'Gitea authentication failed. Please try again.',
      );
    }

    if (flow.binding) {
      const { sessionId, userId, tokenHash } = flow.binding;
      if (
        !req.cookies.authToken ||
        this.hash(req.cookies.authToken) !== tokenHash
      ) {
        throw new UnauthorizedException(
          'Your login session changed. Please link Gitea again.',
        );
      }
      const session = await this.sessionRepo.findActiveById(sessionId);
      if (
        !session ||
        session.userId !== userId ||
        session.workspaceId !== workspace.id
      ) {
        throw new UnauthorizedException(
          'Your login session expired. Please sign in again.',
        );
      }
    }
    const user = await this.resolveUser(
      workspace,
      flow.issuer,
      profile,
      flow.binding?.userId,
    );
    if (flow.binding)
      return { redirect: '/settings/account/profile?gitea=linked' };
    const token = await this.sessions.createSessionAndToken(user);
    res.setCookie('authToken', token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      expires: this.environment.getCookieExpiresIn(),
      secure: this.environment.isHttps(),
    });
    return { redirect: '/home' };
  }

  async status(workspace: Workspace, user: User) {
    if (!this.environment.isGiteaEnabled())
      return { enabled: false, linked: false };
    const { issuer } = this.environment.getGiteaConfig();
    const account = await this.db
      .selectFrom('giteaAccounts')
      .select('id')
      .where('workspaceId', '=', workspace.id)
      .where('userId', '=', user.id)
      .where('issuer', '=', issuer)
      .executeTakeFirst();
    return { enabled: true, linked: !!account };
  }

  async resolveUser(
    workspace: Workspace,
    issuer: string,
    profile: Profile,
    linkUserId?: string,
  ): Promise<User> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        // Serialize callbacks for one external identity; database constraints also protect bindings.
        const identity = JSON.stringify([workspace.id, issuer, profile.sub]);
        await sql`select pg_advisory_xact_lock(hashtextextended(${identity}, 0))`.execute(
          trx,
        );
        const account = await trx
          .selectFrom('giteaAccounts')
          .selectAll()
          .where('workspaceId', '=', workspace.id)
          .where('issuer', '=', issuer)
          .where('subject', '=', profile.sub)
          .executeTakeFirst();
        if (account && linkUserId && account.userId !== linkUserId) {
          throw new ConflictException(
            'This Gitea account is already linked to another user.',
          );
        }
        let user: User;
        const userId = account?.userId ?? linkUserId;
        if (userId) {
          const existingUser = await trx
            .selectFrom('users')
            .select(this.userRepo.baseFields)
            .select(this.userRepo.withUserMfa)
            .where('id', '=', userId)
            .where('workspaceId', '=', workspace.id)
            .forUpdate()
            .executeTakeFirst();
          if (!existingUser || isUserDisabled(existingUser))
            throw new ForbiddenException('This account is disabled.');
          if (
            !linkUserId &&
            (workspace.enforceMfa || existingUser.mfa?.isEnabled)
          ) {
            throw new ForbiddenException(
              'Use your existing login method to complete MFA.',
            );
          }
          user = existingUser;
        } else {
          const existing = await this.userRepo.findByEmail(
            profile.email,
            workspace.id,
            { trx },
          );
          if (existing) {
            throw new ConflictException(
              'An account with this email exists. Sign in with your existing account and link Gitea in My Profile.',
            );
          }
          if (!this.environment.getGiteaConfig().allowSignup) {
            throw new ForbiddenException(
              'Gitea signup is disabled. Sign in with an existing account and link Gitea in My Profile.',
            );
          }
          if (profile.email_verified !== true)
            throw new ForbiddenException(
              'Verify your email in Gitea before signing up.',
            );
          if (workspace.enforceMfa)
            throw new ForbiddenException(
              'Use your existing login method to complete MFA.',
            );
          validateAllowedEmail(profile.email, workspace);
          user = await this.userRepo.insertUser(
            {
              name: (
                profile.name?.trim() ||
                profile.preferred_username?.trim() ||
                profile.email.split('@')[0]
              ).slice(0, 50),
              email: profile.email,
              emailVerifiedAt: new Date(),
              password: randomBytes(32).toString('hex'),
              hasGeneratedPassword: true,
              role: UserRole.MEMBER,
              workspaceId: workspace.id,
            },
            trx,
            { pageEditMode: getWorkspaceDefaultPageEditMode(workspace) },
          );
          await this.groupUserRepo.addUserToDefaultGroup(
            user.id,
            workspace.id,
            trx,
          );
        }
        if (!account) {
          await trx
            .insertInto('giteaAccounts')
            .values({
              workspaceId: workspace.id,
              userId: user.id,
              issuer,
              subject: profile.sub,
            })
            .execute();
        }
        if (!linkUserId)
          await this.userRepo.updateUser(
            { lastLoginAt: new Date() },
            user.id,
            workspace.id,
            trx,
          );
        return user;
      });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === '23505') {
        throw new ConflictException(
          'The user or Gitea identity is already registered or linked. Sign in with your existing account.',
        );
      }
      throw error;
    }
  }
}
