import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { mergeMap } from 'rxjs';
import { PageProtectionService } from './page-protection.service';
import { PageAccessService } from '../page-access/page-access.service';
import { PageRepo } from '@docmost/db/repos/page/page.repo';

@Injectable()
export class PageProtectionInterceptor implements NestInterceptor {
  constructor(
    private readonly protection: PageProtectionService,
    private readonly pageRepo: PageRepo,
    private readonly access: PageAccessService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(
      mergeMap(async (result) => {
        const pages = Array.isArray(result)
          ? result
          : (result?.items ?? (result?.page ? [result.page] : [result]));
        const records = pages.filter((p) => p?.id && p?.slugId && p?.spaceId);
        const states = await this.protection.resolveMany(
          records.map((p) => p.id),
        );
        // Source titles are only included on detail responses after access validation.
        for (const page of records) {
          const state = states.get(page.id);
          if (!state) continue;
          page.isLocked = state.isLocked;
          page.protection = {
            ...state,
            sourcePageId: null,
            sourceTitle: null,
            inherited: state.mode === 'inherit' && state.sourcePageId !== null,
          };
          if (page.permissions) {
            page.permissions.canManageProtection =
              page.permissions.canEdit && !page.deletedAt;
            page.permissions.canModifyContent =
              page.permissions.canEdit && !state.isLocked && !page.deletedAt;
          }
          if (
            records.length === 1 &&
            state.sourcePageId &&
            context.switchToHttp().getRequest().user?.user
          ) {
            const source = await this.pageRepo.findById(state.sourcePageId);
            try {
              await this.access.validateCanView(
                source,
                context.switchToHttp().getRequest().user.user,
              );
              page.protection.sourcePageId = source.id;
              page.protection.sourceTitle = source.title;
            } catch (error) {
              if (
                !(error instanceof ForbiddenException) &&
                !(error instanceof NotFoundException)
              )
                throw error;
            }
          }
        }
        return result;
      }),
    );
  }
}
