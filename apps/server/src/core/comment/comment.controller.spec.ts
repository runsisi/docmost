import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { CommentController } from './comment.controller';
import { ResolveCommentDto } from './dto/resolve-comment.dto';
import { AuditEvent } from '../../common/events/audit-events';

jest.mock('../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class {},
}));

function setup() {
  const user = { id: 'writer-1' } as any;
  const workspace = { id: 'workspace-1' } as any;
  const comment = {
    id: 'comment-1',
    pageId: 'page-1',
    workspaceId: workspace.id,
    resolvedAt: null,
  };
  const page = {
    id: comment.pageId,
    workspaceId: workspace.id,
    spaceId: 'space-1',
    deletedAt: null,
  };
  const comments = { findById: jest.fn().mockResolvedValue(comment) };
  const pages = { findById: jest.fn().mockResolvedValue(page) };
  const service = {
    resolve: jest
      .fn()
      .mockResolvedValue({ ...comment, resolvedAt: new Date() }),
  };
  const access = { validateCanComment: jest.fn().mockResolvedValue(undefined) };
  const audit = { log: jest.fn() };
  const controller = new CommentController(
    service as any,
    comments as any,
    pages as any,
    {} as any,
    access as any,
    {} as any,
    audit as any,
  );
  const dto = { commentId: comment.id, resolved: true };
  return {
    controller,
    user,
    workspace,
    comment,
    page,
    comments,
    pages,
    service,
    access,
    audit,
    dto,
  };
}

describe('Comment resolution boundary', () => {
  it('allows a page commenter to resolve without a license', async () => {
    const {
      controller,
      user,
      workspace,
      comment,
      page,
      service,
      access,
      audit,
      dto,
    } = setup();
    await controller.resolve(dto, user, workspace);
    expect(access.validateCanComment).toHaveBeenCalledWith(
      page,
      user,
      workspace.id,
    );
    expect(service.resolve).toHaveBeenCalledWith(comment, true, user);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: AuditEvent.COMMENT_RESOLVED }),
    );
  });

  it('rejects a user without comment permission before modifying the comment', async () => {
    const { controller, user, workspace, service, access, dto } = setup();
    access.validateCanComment.mockRejectedValue(new ForbiddenException());
    await expect(controller.resolve(dto, user, workspace)).rejects.toThrow(
      ForbiddenException,
    );
    expect(service.resolve).not.toHaveBeenCalled();
  });

  it.each(['missing', 'other-workspace'])(
    'does not resolve a %s comment',
    async (kind) => {
      const { controller, user, workspace, comments, service, dto } = setup();
      comments.findById.mockResolvedValue(
        kind === 'missing' ? undefined : { workspaceId: 'other' },
      );
      await expect(controller.resolve(dto, user, workspace)).rejects.toThrow(
        NotFoundException,
      );
      expect(service.resolve).not.toHaveBeenCalled();
    },
  );

  it.each(['missing', 'deleted', 'other-workspace'])(
    'does not resolve a comment on a %s page',
    async (kind) => {
      const { controller, user, workspace, pages, page, service, access, dto } =
        setup();
      pages.findById.mockResolvedValue(
        kind === 'missing'
          ? undefined
          : {
              ...page,
              ...(kind === 'deleted'
                ? { deletedAt: new Date() }
                : { workspaceId: 'other' }),
            },
      );
      await expect(controller.resolve(dto, user, workspace)).rejects.toThrow(
        NotFoundException,
      );
      expect(service.resolve).not.toHaveBeenCalled();
      expect(access.validateCanComment).not.toHaveBeenCalled();
    },
  );

  it('records reopen actions separately', async () => {
    const {
      controller,
      user,
      workspace,
      comments,
      comment,
      service,
      audit,
      dto,
    } = setup();
    comments.findById.mockResolvedValue({ ...comment, resolvedAt: new Date() });
    service.resolve.mockResolvedValue({ ...comment, resolvedAt: null });
    await controller.resolve({ ...dto, resolved: false }, user, workspace);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: AuditEvent.COMMENT_REOPENED }),
    );
  });

  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const metadata = { type: 'body' as const, metatype: ResolveCommentDto };
  const commentId = '018f0000-0000-7000-8000-000000000001';

  it.each([true, false])(
    'accepts the boolean resolved=%s',
    async (resolved) => {
      await expect(
        pipe.transform({ commentId, resolved }, metadata),
      ).resolves.toEqual({ commentId, resolved });
    },
  );

  it.each([undefined, null, 'false', 'true', 0, 1])(
    'rejects invalid resolved=%s',
    async (resolved) => {
      await expect(
        pipe.transform({ commentId, resolved }, metadata),
      ).rejects.toThrow(BadRequestException);
    },
  );

  it('rejects invalid comment IDs', async () => {
    await expect(
      pipe.transform({ commentId: 'invalid', resolved: true }, metadata),
    ).rejects.toThrow(BadRequestException);
  });
});
