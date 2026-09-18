import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { AttachmentRepo } from '@docmost/db/repos/attachment/attachment.repo';
import { User } from '@docmost/db/types/entity.types';
import { JSONContent } from '@tiptap/core';
import { isUUID } from 'class-validator';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import { StorageService } from '../storage/storage.service';
import { getPageTitle } from '../../common/helpers';
import { createPageDocx, ExportImage } from './docx-export.adapter';

@Injectable()
export class DocxExportService {
  private readonly logger = new Logger(DocxExportService.name);

  constructor(
    private readonly pageRepo: PageRepo,
    private readonly attachmentRepo: AttachmentRepo,
    private readonly pageAccess: PageAccessService,
    private readonly storage: StorageService,
  ) {}

  async exportPage(pageId: string, user: User) {
    const page = await this.pageRepo.findById(pageId, { includeContent: true });
    if (!page || page.deletedAt) throw new NotFoundException('Page not found');
    await this.pageAccess.validateCanView(page, user);

    try {
      const result = await createPageDocx(
        (page.content as JSONContent) ?? { type: 'doc', content: [] },
        getPageTitle(page.title),
        (attrs) => this.resolveImage(attrs, user),
      );
      return { ...result, page };
    } catch (error) {
      this.logger.error(
        'Failed to generate Word document',
        error instanceof Error ? error.stack : String(error),
      );
      throw new InternalServerErrorException(
        'Failed to generate Word document',
      );
    }
  }

  private async resolveImage(
    attrs: Record<string, any>,
    user: User,
  ): Promise<ExportImage> {
    // Only attachment IDs or local file paths are resolved. Never fetch URLs.
    const id =
      attrs.attachmentId ||
      (typeof attrs.src === 'string'
        ? attrs.src.match(/^\/api\/files\/([^/?#]+)\//)?.[1]
        : undefined);
    if (!id) return { warning: '未嵌入外部图片或缺少附件引用' };
    if (typeof id !== 'string' || !isUUID(id))
      return { warning: '图片附件引用无效' };
    const attachment = await this.attachmentRepo.findById(id);
    // Do not expose filenames, paths, or other metadata on access failure.
    const unavailable = { warning: '图片不可用或无权访问' };
    if (
      !attachment ||
      attachment.deletedAt ||
      attachment.workspaceId !== user.workspaceId ||
      !attachment.pageId
    ) {
      return unavailable;
    }
    const page = await this.pageRepo.findById(attachment.pageId);
    if (!page || page.deletedAt) return unavailable;
    try {
      await this.pageAccess.validateCanView(page, user);
    } catch (error) {
      if (error instanceof ForbiddenException) return unavailable;
      throw error;
    }
    try {
      return { data: await this.storage.read(attachment.filePath) };
    } catch {
      return { warning: '图片文件缺失或无法读取' };
    }
  }
}
