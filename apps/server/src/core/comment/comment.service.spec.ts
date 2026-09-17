import { BadRequestException } from '@nestjs/common';
import { CommentService } from './comment.service';
import { QueueJob } from '../../integrations/queue/constants';

jest.mock('../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class {},
}));

function setup(overrides: Record<string, unknown> = {}) {
  const comment = {
    id: 'comment-1',
    pageId: 'page-1',
    spaceId: 'space-1',
    workspaceId: 'workspace-1',
    creatorId: 'author-1',
    parentCommentId: null,
    resolvedAt: null,
    resolvedById: null,
    type: 'inline',
    ...overrides,
  } as any;
  const user = { id: 'writer-1', name: 'Writer' } as any;
  let stored = { ...comment };
  const repo = {
    resolveComment: jest.fn(async (_id, resolved, actorId) => {
      if ((stored.resolvedAt != null) === resolved) return undefined;
      stored = {
        ...stored,
        resolvedAt: resolved ? new Date() : null,
        resolvedById: resolved ? actorId : null,
        resolvedBy: resolved ? user : null,
      };
      return stored;
    }),
    findById: jest.fn(async () => stored),
  };
  const ws = { emitCommentEvent: jest.fn() };
  const collab = { handleYjsEvent: jest.fn().mockResolvedValue(undefined) };
  const notification = { add: jest.fn().mockResolvedValue(undefined) };
  const service = new CommentService(
    repo as any,
    {} as any,
    ws as any,
    collab as any,
    {} as any,
    notification as any,
  );
  return { service, comment, user, repo, ws, collab, notification };
}

describe('Comment resolution', () => {
  it('resolves a thread and synchronizes its inline mark, subscribers and author notification', async () => {
    const { service, comment, user, collab, ws, notification } = setup();
    const result = await service.resolve(comment, true, user);
    expect(result.resolvedAt).toBeInstanceOf(Date);
    expect(result.resolvedById).toBe(user.id);
    expect(collab.handleYjsEvent).toHaveBeenCalledWith(
      'resolveCommentMark',
      'page.page-1',
      {
        commentId: comment.id,
        resolved: true,
        user,
      },
    );
    expect(ws.emitCommentEvent).toHaveBeenCalledWith(
      comment.spaceId,
      comment.pageId,
      {
        operation: 'commentResolved',
        pageId: comment.pageId,
        comment: result,
      },
    );
    expect(notification.add).toHaveBeenCalledWith(
      QueueJob.COMMENT_RESOLVED_NOTIFICATION,
      {
        commentId: comment.id,
        commentCreatorId: comment.creatorId,
        pageId: comment.pageId,
        spaceId: comment.spaceId,
        workspaceId: comment.workspaceId,
        actorId: user.id,
      },
    );
  });

  it('reopens a thread and clears resolver metadata without a resolved notification', async () => {
    const { service, comment, user, collab, notification } = setup({
      resolvedAt: new Date(),
      resolvedById: 'previous-resolver',
    });
    const result = await service.resolve(comment, false, user);
    expect(result.resolvedAt).toBeNull();
    expect(result.resolvedById).toBeNull();
    expect(collab.handleYjsEvent).toHaveBeenCalledWith(
      'resolveCommentMark',
      'page.page-1',
      {
        commentId: comment.id,
        resolved: false,
        user,
      },
    );
    expect(notification.add).not.toHaveBeenCalled();
  });

  it('does not repeat side effects for duplicate resolve requests', async () => {
    const { service, comment, user, collab, notification } = setup();
    const first = await service.resolve(comment, true, user);
    const second = await service.resolve(comment, true, user);
    expect(second.resolvedAt).toEqual(first.resolvedAt);
    expect(collab.handleYjsEvent).toHaveBeenCalledTimes(1);
    expect(notification.add).toHaveBeenCalledTimes(1);
  });

  it('rejects resolving a reply without changing its parent thread', async () => {
    const { service, comment, user, repo } = setup({
      parentCommentId: 'parent-1',
    });
    await expect(service.resolve(comment, true, user)).rejects.toThrow(
      BadRequestException,
    );
    expect(repo.resolveComment).not.toHaveBeenCalled();
  });

  it('does not open the collaboration document for a page-level comment', async () => {
    const { service, comment, user, collab } = setup({ type: 'page' });
    await service.resolve(comment, true, user);
    expect(collab.handleYjsEvent).not.toHaveBeenCalled();
  });

  it('does not notify the resolver about their own comment', async () => {
    const { service, comment, user, notification } = setup({
      creatorId: 'writer-1',
    });
    await service.resolve(comment, true, user);
    expect(notification.add).not.toHaveBeenCalled();
  });

  it('returns the saved state when inline synchronization fails', async () => {
    const { service, comment, user, collab, ws } = setup();
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => {});
    collab.handleYjsEvent.mockRejectedValue(
      new Error('collaboration unavailable'),
    );
    expect(
      (await service.resolve(comment, true, user)).resolvedAt,
    ).toBeInstanceOf(Date);
    expect(ws.emitCommentEvent).toHaveBeenCalled();
  });

  it('returns the saved state when notification queuing fails', async () => {
    const { service, comment, user, notification } = setup();
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => {});
    notification.add.mockRejectedValue(new Error('queue unavailable'));
    expect(
      (await service.resolve(comment, true, user)).resolvedAt,
    ).toBeInstanceOf(Date);
  });
});
