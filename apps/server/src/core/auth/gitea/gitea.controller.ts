import {
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  ForbiddenException,
  HttpException,
  Logger,
} from '@nestjs/common';
import { ThrottlerGuard, SkipThrottle } from '@nestjs/throttler';
import { FastifyReply, FastifyRequest } from 'fastify';
import { GiteaService } from './gitea.service';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { RequireSessionAuth } from '../../../common/decorators/require-session-auth.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { User, Workspace } from '../../../database/types/entity.types';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import {
  ALL_NAMED_THROTTLERS_SKIPPED,
  AUTH_THROTTLER,
} from '../../../integrations/throttle/throttler-names';

@Controller('auth/gitea')
@SkipThrottle({ ...ALL_NAMED_THROTTLERS_SKIPPED, [AUTH_THROTTLER]: false })
@UseGuards(ThrottlerGuard)
export class GiteaController {
  private readonly logger = new Logger(GiteaController.name);
  constructor(
    private readonly gitea: GiteaService,
    private readonly environment: EnvironmentService,
  ) {}

  @Get('config')
  config() {
    return { enabled: this.environment.isGiteaEnabled() };
  }

  @Get('login')
  async login(
    @AuthWorkspace() workspace: Workspace,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    return res.redirect(await this.gitea.start(workspace, req, res), 302);
  }

  @Get('callback')
  async callback(
    @AuthWorkspace() workspace: Workspace,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    try {
      const result = await this.gitea.callback(workspace, req, res);
      return res.redirect(result.redirect, 302);
    } catch (error) {
      const expected =
        error instanceof HttpException && error.getStatus() < 500;
      if (!expected)
        this.logger.error(
          'Gitea callback failed due to a server or identity provider error.',
        );
      const message = expected
        ? error.message
        : 'Gitea login is temporarily unavailable. Please try again.';
      const target = req.cookies.authToken
        ? '/settings/account/profile'
        : '/login';
      return res.redirect(
        `${target}?${new URLSearchParams({ giteaError: message })}`,
        302,
      );
    }
  }

  @Post('link')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @RequireSessionAuth()
  async link(
    @AuthWorkspace() workspace: Workspace,
    @AuthUser() user: User,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    if (req.headers.origin !== this.environment.getAppUrl()) {
      throw new ForbiddenException(
        'Link Gitea from your Docmost profile page.',
      );
    }
    return { url: await this.gitea.start(workspace, req, res, user) };
  }

  @Post('status')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @RequireSessionAuth()
  status(@AuthWorkspace() workspace: Workspace, @AuthUser() user: User) {
    return this.gitea.status(workspace, user);
  }
}
