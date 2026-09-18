import 'reflect-metadata';
import {
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Packer } from 'docx';
import JSZip = require('jszip');
import { DocxExportService } from './docx-export.service';
import { DocxExportController } from './docx-export.controller';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

const attachmentId = '01990000-0000-7000-8000-000000000001';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);
const text = (value: string, marks?: any[]) => ({
  type: 'text',
  text: value,
  marks,
});
const paragraph = (...content: any[]) => ({ type: 'paragraph', content });
const image = (attrs = { attachmentId }) => ({ type: 'image', attrs });
const doc = (...content: any[]) => ({ type: 'doc', content });
function setup(content = doc(paragraph(text('中文正文')))) {
  const page = {
    id: 'page',
    title: '中文 / 标题',
    workspaceId: 'ws',
    spaceId: 'space',
    content,
    deletedAt: null,
  } as any;
  const imagePage = { ...page, id: 'image-page' };
  const pages = {
    findById: jest.fn(async (id: string) => (id === 'page' ? page : imagePage)),
  };
  const attachment = {
    id: attachmentId,
    pageId: imagePage.id,
    workspaceId: 'ws',
    filePath: 'private.png',
    fileName: 'SECRET.png',
    deletedAt: null,
  };
  const attachments = { findById: jest.fn().mockResolvedValue(attachment) };
  const permissions = { canUserAccessPage: jest.fn().mockResolvedValue(true) };
  const ability = {
    createForUser: jest.fn().mockResolvedValue({ cannot: () => false }),
  };
  const access = new PageAccessService(
    permissions as any,
    ability as any,
    {} as any,
    {} as any,
  );
  const storage = { read: jest.fn().mockResolvedValue(png) };
  const service = new DocxExportService(
    pages as any,
    attachments as any,
    access,
    storage as any,
  );
  const user = { id: 'user', workspaceId: 'ws' } as any;
  return {
    service,
    page,
    imagePage,
    pages,
    attachment,
    attachments,
    permissions,
    ability,
    access,
    storage,
    user,
  };
}
async function xml(buffer: Buffer, file = 'word/document.xml') {
  return (await JSZip.loadAsync(buffer)).file(file)!.async('string');
}

describe('Single-page Word export', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uses the login guard and emits binary, encoded filename, warning count, and audit', async () => {
    expect(
      Reflect.getMetadata(
        GUARDS_METADATA,
        DocxExportController.prototype.exportPage,
      ),
    ).toContain(JwtAuthGuard);
    const { service, page, user } = setup();
    const audit = { log: jest.fn() };
    const controller = new DocxExportController(service, audit as any);
    const response = { headers: jest.fn(), send: jest.fn() };
    await controller.exportPage({ pageId: page.id }, user, response as any);
    const headers = response.headers.mock.calls[0][0];
    expect(headers['Content-Type']).toContain('wordprocessingml.document');
    expect(headers['Content-Disposition']).toContain("filename*=UTF-8''");
    expect(decodeURIComponent(headers['Content-Disposition'])).toContain(
      '中文  标题.docx',
    );
    expect(headers['X-Docmost-Export-Warning-Count']).toBe('0');
    expect(Buffer.isBuffer(response.send.mock.calls[0][0])).toBe(true);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: page.id,
        metadata: expect.objectContaining({ format: 'docx' }),
      }),
    );
  });

  it.each([
    'missing',
    'deleted',
    'cross-workspace',
    'restricted',
    'not-space-member',
  ])('rejects %s pages before reading attachments', async (mode) => {
    const x = setup(doc(image()));
    if (mode === 'missing') x.pages.findById.mockResolvedValue(undefined);
    if (mode === 'deleted') x.page.deletedAt = new Date();
    if (mode === 'cross-workspace') x.user.workspaceId = 'other';
    if (mode === 'restricted')
      x.permissions.canUserAccessPage.mockResolvedValue(false);
    if (mode === 'not-space-member')
      x.ability.createForUser.mockResolvedValue({ cannot: () => true });
    await expect(x.service.exportPage('page', x.user)).rejects.toBeInstanceOf(
      mode === 'missing' || mode === 'deleted'
        ? NotFoundException
        : ForbiddenException,
    );
    expect(x.storage.read).not.toHaveBeenCalled();
    expect(x.attachments.findById).not.toHaveBeenCalled();
  });

  it('preserves Chinese text, styles, links, breaks, lists, merged cells, image relationships and the source', async () => {
    const cell = (value: string, attrs = {}) => ({
      type: 'tableCell',
      attrs,
      content: [paragraph(text(value))],
    });
    const content = doc(
      paragraph(
        text('中文正文', [
          { type: 'bold' },
          { type: 'italic' },
          { type: 'underline' },
          { type: 'strike' },
          { type: 'textStyle', attrs: { color: '#ff0000' } },
        ]),
        { type: 'hardBreak' },
        text('链接', [
          { type: 'link', attrs: { href: 'https://example.com' } },
        ]),
        { type: 'hardBreak' },
      ),
      {
        type: 'orderedList',
        attrs: { start: 3 },
        content: [
          {
            type: 'listItem',
            content: [
              paragraph(text('有序列表')),
              {
                type: 'bulletList',
                content: [
                  { type: 'listItem', content: [paragraph(text('嵌套无序'))] },
                ],
              },
            ],
          },
        ],
      },
      {
        type: 'taskList',
        content: [
          {
            type: 'taskItem',
            attrs: { checked: true },
            content: [paragraph(text('已完成'))],
          },
        ],
      },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              cell('合并列', { colspan: 2 }),
              cell('跨行', { rowspan: 2 }),
            ],
          },
          { type: 'tableRow', content: [cell('甲'), cell('乙')] },
        ],
      },
      image(),
      { type: 'pageBreak' },
      paragraph(text('分页后')),
      paragraph(text('脚注'), {
        type: 'footnoteReference',
        attrs: { referenceNumber: 1, 'data-id': 'footnote-1', id: 'fnref:1' },
      }),
      {
        type: 'footnotes',
        content: [
          {
            type: 'footnote',
            attrs: { id: 'fn:1', 'data-id': 'footnote-1' },
            content: [paragraph(text('脚注正文'))],
          },
        ],
      },
    );
    const original = structuredClone(content);
    const x = setup(content);
    const result = await x.service.exportPage('page', x.user);
    const body = await xml(result.buffer);
    for (const value of [
      '中文正文',
      '中文 / 标题',
      '<w:b/>',
      '<w:i/>',
      '<w:u ',
      '<w:strike/>',
      'ff0000',
      '<w:br/>',
      '<w:hyperlink ',
      '<w:numPr>',
      '☑',
      '<w:gridSpan w:val="2"',
      '<w:vMerge w:val="restart"',
      '<w:vMerge w:val="continue"',
      '<w:drawing>',
      '<w:pageBreakBefore/>',
    ])
      expect(body).toContain(value);
    const rels = await xml(result.buffer, 'word/_rels/document.xml.rels');
    expect(rels).toContain('https://example.com');
    expect(rels).toContain('.png');
    const numbering = await xml(result.buffer, 'word/numbering.xml');
    expect(numbering).toContain('<w:start w:val="3"');
    expect(numbering).toContain('<w:numFmt w:val="bullet"');
    expect(await xml(result.buffer, 'word/footnotes.xml')).toContain(
      '脚注正文',
    );
    expect(body.match(/<w:gridCol /g)).toHaveLength(3);
    expect(result.warningCount).toBe(0);
    expect(content).toEqual(original);
    expect(x.storage.read).toHaveBeenCalledWith('private.png');
  });

  it.each([
    'missing',
    'deleted',
    'cross-workspace',
    'owner-deleted',
    'owner-cross-workspace',
    'restricted',
    'no-owner',
  ])('redacts unavailable attachment metadata: %s', async (mode) => {
    const x = setup(doc(image()));
    if (mode === 'missing') x.attachments.findById.mockResolvedValue(undefined);
    if (mode === 'deleted') x.attachment.deletedAt = new Date() as any;
    if (mode === 'cross-workspace') x.attachment.workspaceId = 'other';
    if (mode === 'owner-deleted') x.imagePage.deletedAt = new Date();
    if (mode === 'owner-cross-workspace') x.imagePage.workspaceId = 'other';
    if (mode === 'restricted')
      x.permissions.canUserAccessPage.mockImplementation(
        async (_, id) => id === 'page',
      );
    if (mode === 'no-owner') x.attachment.pageId = null;
    const result = await x.service.exportPage('page', x.user);
    expect(result.warningCount).toBe(1);
    const body = await xml(result.buffer);
    expect(body).toContain('图片不可用或无权访问');
    expect(body).not.toContain('SECRET');
    expect(body).not.toContain('private.png');
    expect(x.storage.read).not.toHaveBeenCalled();
  });

  it('keeps missing and unsupported images visible, uses file signatures, and never fetches external URLs', async () => {
    const x = setup(
      doc(
        image(),
        image({ src: 'https://example.com/image.png' } as any),
        image({ attachmentId: 'invalid' }),
      ),
    );
    x.storage.read.mockRejectedValue(new Error('missing'));
    let result = await x.service.exportPage('page', x.user);
    expect(result.warningCount).toBe(3);
    expect(x.attachments.findById).toHaveBeenCalledTimes(1);
    expect(await xml(result.buffer)).toContain('图片文件缺失');
    x.page.content = doc(image());
    x.storage.read.mockResolvedValue(Buffer.from('<svg/>'));
    result = await x.service.exportPage('page', x.user);
    expect(result.warningCount).toBe(1);
    expect(await xml(result.buffer)).toContain('图片格式不支持');
  });

  it('embeds readable diagram images and attachment paths without trusting extensions', async () => {
    const x = setup(
      doc(
        { type: 'drawio', attrs: { attachmentId } },
        {
          type: 'excalidraw',
          attrs: { src: `/api/files/${attachmentId}/diagram.svg?t=1` },
        },
      ),
    );
    const result = await x.service.exportPage('page', x.user);
    expect(result.warningCount).toBe(0);
    expect((await xml(result.buffer)).match(/<w:drawing>/g)).toHaveLength(2);
    expect(await xml(result.buffer, 'word/_rels/document.xml.rels')).toContain(
      '.png',
    );
  });

  it('fails closed when attachment permission queries fail', async () => {
    const x = setup(doc(image()));
    x.permissions.canUserAccessPage.mockImplementation(async (_, id) => {
      if (id !== 'page') throw new Error('permission query unavailable');
      return true;
    });
    await expect(x.service.exportPage('page', x.user)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(x.storage.read).not.toHaveBeenCalled();
  });

  it('exports a title-only empty page and rejects malformed saved documents', async () => {
    const x = setup();
    x.page.content = null;
    expect((await x.service.exportPage('page', x.user)).warningCount).toBe(0);
    x.page.content = { type: 'paragraph' };
    await expect(x.service.exportPage('page', x.user)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('reports unsupported nodes, formulas, diagrams, media and columns at their positions', async () => {
    const x = setup(
      doc(
        { type: 'futureBlock' },
        { type: 'base' },
        { type: 'subpages' },
        { type: 'transclusionReference' },
        paragraph(
          text('前'),
          { type: 'futureInline' },
          { type: 'mathInline', attrs: { text: 'x^2' } },
          text('后'),
        ),
        { type: 'mathBlock', attrs: { text: '\\frac{1}{2}' } },
        { type: 'drawio' },
        { type: 'excalidraw' },
        ...['video', 'audio', 'pdf', 'attachment', 'embed', 'youtube'].map(
          (type) => ({
            type,
            attrs: { src: 'https://example.com/media', name: '文件' },
          }),
        ),
        {
          type: 'columns',
          content: [
            { type: 'column', content: [paragraph(text('左栏'))] },
            { type: 'column', content: [paragraph(text('右栏'))] },
          ],
        },
      ),
    );
    const result = await x.service.exportPage('page', x.user);
    const body = await xml(result.buffer);
    expect(result.warningCount).toBe(16);
    for (const value of [
      'futureBlock',
      'futureInline',
      'Base 数据表内容未转换',
      '子页面列表内容未转换',
      '引用块引用内容未转换',
      'x^2',
      '\\frac{1}{2}',
      'Draw.io 图示',
      'Excalidraw 图示',
      '左栏',
      '右栏',
    ])
      expect(body).toContain(value);
    expect(body.indexOf('左栏')).toBeLessThan(body.indexOf('右栏'));
  });

  it('propagates database failures and fails the entire request when generation fails', async () => {
    const x = setup();
    x.pages.findById.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(x.service.exportPage('page', x.user)).rejects.toThrow(
      'database unavailable',
    );
    jest
      .spyOn(Packer, 'toBuffer')
      .mockRejectedValue(new Error('packing failed'));
    await expect(x.service.exportPage('page', x.user)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});
