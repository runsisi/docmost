import {
  Body,
  Controller,
  HttpCode,
  NotFoundException,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { OAuthScope } from '../../../common/decorators/oauth-scope.decorator';
import { PageAccessService } from '../page-access/page-access.service';
import { PageProtectionDto } from './page-protection.dto';
import { PageProtectionService } from './page-protection.service';
import { PageProtectionInterceptor } from './page-protection.interceptor';

@UseGuards(JwtAuthGuard)
@UseInterceptors(PageProtectionInterceptor)
@Controller('pages')
export class PageProtectionController {
  constructor(
    private readonly pageRepo: PageRepo,
    private readonly access: PageAccessService,
    private readonly protection: PageProtectionService,
  ) {}

  @HttpCode(200)
  @Post('protection')
  @OAuthScope('write')
  async set(
    @Body() dto: PageProtectionDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const page = await this.pageRepo.findById(dto.pageId);
    if (!page || page.deletedAt || page.workspaceId !== workspace.id)
      throw new NotFoundException('Page not found');
    await this.access.validateCanEdit(page, user);
    await this.protection.set(page.id, page.spaceId, dto.mode, dto.version);
    const updated = await this.pageRepo.findById(page.id, {
      includeSpace: true,
      includeContent: true,
      includeCreator: true,
      includeLastUpdatedBy: true,
      includeContributors: true,
      includeDeletedBy: true,
    });
    return {
      ...updated,
      permissions: await this.access.validateCanViewWithPermissions(
        updated,
        user,
      ),
    };
  }
}
