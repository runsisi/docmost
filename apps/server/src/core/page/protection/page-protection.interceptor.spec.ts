import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { PageProtectionInterceptor } from './page-protection.interceptor';

describe('Protection response privacy and batching', () => {
  const state = {
    mode: 'inherit',
    isLocked: true,
    sourcePageId: 'hidden',
    version: 'version',
  };
  it.each([new ForbiddenException(), new NotFoundException()])(
    'does not disclose an inaccessible source',
    async (error) => {
      const service = {
        resolveMany: jest.fn().mockResolvedValue(new Map([['child', state]])),
      };
      const repo = {
        findById: jest
          .fn()
          .mockResolvedValue({ id: 'hidden', title: 'Secret title' }),
      };
      const access = { validateCanView: jest.fn().mockRejectedValue(error) };
      const interceptor = new PageProtectionInterceptor(
        service as any,
        repo as any,
        access as any,
      );
      const context = {
        switchToHttp: () => ({ getRequest: () => ({ user: { user: {} } }) }),
      } as any;
      const page = {
        id: 'child',
        slugId: 'slug',
        spaceId: 'space',
        permissions: { canEdit: true },
      };
      const result = await firstValueFrom(
        interceptor.intercept(context, { handle: () => of(page) }),
      );
      expect(result.protection.sourceTitle).toBeNull();
      expect(result.protection.sourcePageId).toBeNull();
      expect(result.protection.inherited).toBe(true);
      expect(result.permissions.canEdit).toBe(true);
      expect(result.permissions.canModifyContent).toBe(false);
    },
  );
  it('resolves a list in one batch and avoids per-page source lookups', async () => {
    const service = {
      resolveMany: jest.fn().mockResolvedValue(
        new Map([
          ['a', state],
          ['b', state],
        ]),
      ),
    };
    const repo = { findById: jest.fn() };
    const interceptor = new PageProtectionInterceptor(
      service as any,
      repo as any,
      {} as any,
    );
    const result = await firstValueFrom(
      interceptor.intercept({} as any, {
        handle: () =>
          of({
            items: [
              { id: 'a', slugId: 'a', spaceId: 'space' },
              { id: 'b', slugId: 'b', spaceId: 'space' },
            ],
          }),
      }),
    );
    expect(service.resolveMany).toHaveBeenCalledTimes(1);
    expect(repo.findById).not.toHaveBeenCalled();
    expect(result.items.every((p) => p.isLocked === true)).toBe(true);
  });
});
