import { ForbiddenException } from '@nestjs/common';
import { PageAccessService } from './page-access.service';

function setup(locked = true) {
  const permissions = {
    canUserEditPage: jest.fn().mockResolvedValue({
      hasAnyRestriction: false,
      canAccess: true,
      canEdit: true,
    }),
    canUserAccessPage: jest.fn().mockResolvedValue(true),
  };
  const ability = {
    createForUser: jest
      .fn()
      .mockResolvedValue({ can: () => true, cannot: () => false }),
  };
  const protection = {
    assertWritable: jest.fn(async () => {
      if (locked) throw new ForbiddenException('Page is locked');
    }),
  };
  const service = new PageAccessService(
    permissions as any,
    ability as any,
    { findById: jest.fn() } as any,
    protection as any,
  );
  const page = {
    id: 'page',
    spaceId: 'space',
    workspaceId: 'workspace',
  } as any;
  const user = { id: 'user', workspaceId: 'workspace' } as any;
  return { service, page, user, permissions, protection };
}

describe('Page protection access boundaries', () => {
  it('retains organization and comment permissions while blocking content', async () => {
    const { service, page, user } = setup();
    await expect(service.validateCanEdit(page, user)).resolves.toEqual({
      hasRestriction: false,
    });
    await expect(
      service.validateCanComment(page, user, user.workspaceId),
    ).resolves.toBeUndefined();
    await expect(service.validateCanModifyContent(page, user)).rejects.toThrow(
      'Page is locked',
    );
  });

  it('an explicit unlock never grants access to a restricted reader', async () => {
    const { service, page, user, permissions, protection } = setup(false);
    permissions.canUserEditPage.mockResolvedValue({
      hasAnyRestriction: true,
      canAccess: true,
      canEdit: false,
    });
    await expect(
      service.validateCanModifyContent(page, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(protection.assertWritable).not.toHaveBeenCalled();
  });

  it('rejects cross-workspace access before protection changes can be authorized', async () => {
    const { service, page, user } = setup(false);
    await expect(
      service.validateCanEdit(page, { ...user, workspaceId: 'other' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('passes the submitted version to the write boundary and fails closed on query errors', async () => {
    const { service, page, user, protection } = setup(false);
    protection.assertWritable.mockRejectedValue(
      new Error('database unavailable'),
    );
    await expect(
      service.validateCanModifyContent(page, user, 'old-version'),
    ).rejects.toThrow('database unavailable');
    expect(protection.assertWritable).toHaveBeenCalledWith(
      'page',
      'old-version',
    );
  });
});
