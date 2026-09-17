import { beforeSyncPayload, onAuthenticatePayload } from '@hocuspocus/server';
import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { User } from '@docmost/db/types/entity.types';
import { PageProtectionService } from '../../core/page/protection/page-protection.service';
import { PageAccessService } from '../../core/page/page-access/page-access.service';
import { getPageId } from '../collaboration.util';

@Injectable()
export class CollaborationProtectionService {
  constructor(
    private readonly protection: PageProtectionService,
    private readonly access: PageAccessService,
    private readonly pageRepo: PageRepo,
  ) {}

  credentials(token: string): { token: string; protectionVersion: string } {
    try {
      const credentials = JSON.parse(token);
      if (
        typeof credentials.token !== 'string' ||
        typeof credentials.protectionVersion !== 'string' ||
        !/^[a-f0-9]{32}$/.test(credentials.protectionVersion)
      )
        throw new Error();
      return credentials;
    } catch {
      throw new UnauthorizedException(
        'Refresh the page to use versioned collaboration',
      );
    }
  }

  async authenticate(
    pageId: string,
    version: string,
    config: onAuthenticatePayload['connectionConfig'],
  ) {
    const state = await this.protection.resolve(pageId);
    if (state.isLocked || version !== state.version) config.readOnly = true;
  }

  async validateContentUpdate(documentName: string, user: User) {
    const page = await this.pageRepo.findById(getPageId(documentName));
    if (!page) throw new NotFoundException('Page not found');
    await this.access.validateCanModifyContent(page, user);
  }

  async beforeSync({
    type,
    documentName,
    context,
    connection,
  }: beforeSyncPayload) {
    // Every update, including reconnect SyncStep2, is checked before Y.applyUpdate.
    // A failed check makes this connection read-only; it must reauthenticate to edit.
    try {
      const page = await this.pageRepo.findById(getPageId(documentName));
      if (!page) throw new NotFoundException('Page not found');
      await this.access.validateCanView(page, context.user);
      const state = await this.protection.resolve(page.id);
      const stale = state.version !== context.protectionVersion;
      if (state.isLocked || stale || page.deletedAt) {
        connection.readOnly = true;
        connection.sendStateless(
          JSON.stringify({ type: 'protection.changed' }),
        );
      }
      if (type !== 0 && !connection.readOnly) {
        await this.access.validateCanEdit(page, context.user);
      }
    } catch (error) {
      connection.readOnly = true;
      connection.sendStateless(
        JSON.stringify({ type: 'protection.unavailable' }),
      );
      throw error;
    }
  }
}
