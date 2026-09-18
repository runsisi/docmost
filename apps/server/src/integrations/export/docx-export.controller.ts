import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { User } from '@docmost/db/types/entity.types';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PageIdDto } from '../../core/page/dto/page.dto';
import { getPageTitle, sanitizeFileName } from '../../common/helpers';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { AUDIT_SERVICE, IAuditService } from '../audit/audit.service';
import { DocxExportService } from './docx-export.service';

@Controller()
export class DocxExportController {
  constructor(
    private readonly docxExport: DocxExportService,
    @Inject(AUDIT_SERVICE) private readonly audit: IAuditService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('pages/export-docx')
  async exportPage(
    @Body() dto: PageIdDto,
    @AuthUser() user: User,
    @Res() res: FastifyReply,
  ) {
    const { buffer, warningCount, page } = await this.docxExport.exportPage(
      dto.pageId,
      user,
    );
    this.audit.log({
      event: AuditEvent.PAGE_EXPORTED,
      resourceType: AuditResource.PAGE,
      resourceId: page.id,
      spaceId: page.spaceId,
      metadata: {
        title: getPageTitle(page.title),
        format: 'docx',
        includeChildren: false,
        includeAttachments: false,
        spaceId: page.spaceId,
      },
    });
    const fileName =
      (sanitizeFileName(getPageTitle(page.title), { preserveSpaces: true }) ||
        'untitled') + '.docx';
    const encoded = encodeURIComponent(fileName).replace(
      /[!'()*]/g,
      (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase(),
    );
    res.headers({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`,
      'X-Docmost-Export-Warning-Count': String(warningCount),
    });
    return res.send(buffer);
  }
}
