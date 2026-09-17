import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';

export type ProtectionMode = 'inherit' | 'locked' | 'unlocked';
export interface PageProtection {
  mode: ProtectionMode;
  isLocked: boolean;
  rootDefaultLocked: boolean;
  sourcePageId: string | null;
  version: string;
}

@Injectable()
export class PageProtectionService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pageRepo: PageRepo,
  ) {}

  async resolveMany(
    pageIds: string[],
    db: KyselyDB | KyselyTransaction = this.db,
  ) {
    if (!pageIds.length) return new Map<string, PageProtection>();
    const { rows } = await sql<PageProtection & { pageId: string }>`
      WITH RECURSIVE ancestors AS (
        SELECT id AS page_id, id, parent_page_id, space_id, workspace_id,
          is_locked, protection_version, 0 AS depth
        FROM pages WHERE id IN (${sql.join(pageIds)})
        UNION ALL
        SELECT a.page_id, p.id, p.parent_page_id, p.space_id, p.workspace_id,
          p.is_locked, p.protection_version, a.depth + 1
        FROM ancestors a JOIN pages p ON p.id = a.parent_page_id
          AND p.workspace_id = a.workspace_id AND p.space_id = a.space_id
      ), space_defaults AS (
        SELECT id,
          coalesce((settings->'pageProtection'->>'rootDefaultLocked')::boolean, true) AS root_default_locked,
          coalesce((settings->'pageProtection'->>'version')::bigint, 0) AS space_version
        FROM spaces
      )
      SELECT page_id, s.root_default_locked,
        CASE (array_agg(is_locked ORDER BY depth))[1]
          WHEN true THEN 'locked' WHEN false THEN 'unlocked' ELSE 'inherit' END AS mode,
        coalesce((array_agg(is_locked ORDER BY depth)
          FILTER (WHERE is_locked IS NOT NULL))[1], s.root_default_locked) AS is_locked,
        (array_agg(a.id ORDER BY depth) FILTER (WHERE is_locked IS NOT NULL))[1] AS source_page_id,
        md5('space-root-default-v1:' || s.space_version::text || ':' || string_agg(a.id::text || ':' || protection_version::text || ':' || space_id::text,
          '/' ORDER BY depth)) AS version
      FROM ancestors a JOIN space_defaults s ON s.id = a.space_id
      GROUP BY page_id, s.root_default_locked, s.space_version
    `.execute(db);
    return new Map(rows.map(({ pageId, ...state }) => [pageId, state]));
  }

  async resolve(pageId: string, db: KyselyDB | KyselyTransaction = this.db) {
    const state = (await this.resolveMany([pageId], db)).get(pageId);
    if (!state) throw new NotFoundException('Page not found');
    return state;
  }

  async assertWritable(pageId: string, version?: string) {
    const state = await this.resolve(pageId);
    if (version !== undefined && version !== state.version) {
      throw new ConflictException('Page protection changed');
    }
    if (state.isLocked) throw new ForbiddenException('Page is locked');
    return state;
  }

  async setSpaceDefault(
    spaceId: string,
    workspaceId: string,
    rootDefaultLocked: boolean,
    trx: KyselyTransaction,
  ) {
    // Serialize with protection changes and moves before taking the space row lock.
    await this.pageRepo.lockPageHierarchySpaces([spaceId], trx);
    const space = await trx
      .selectFrom('spaces')
      .select(
        sql<boolean>`coalesce(
        (settings->'pageProtection'->>'rootDefaultLocked')::boolean, true
      )`.as('rootDefaultLocked'),
      )
      .where('id', '=', spaceId)
      .where('workspaceId', '=', workspaceId)
      .forUpdate()
      .executeTakeFirst();
    if (!space) throw new NotFoundException('Space not found');
    if (space.rootDefaultLocked === rootDefaultLocked)
      return space.rootDefaultLocked;

    await trx
      .updateTable('spaces')
      .set({
        settings: sql`coalesce(settings, '{}'::jsonb) || jsonb_build_object(
        'pageProtection', coalesce(settings->'pageProtection', '{}'::jsonb)
          || jsonb_build_object('rootDefaultLocked', ${rootDefaultLocked}::boolean,
            'version', coalesce((settings->'pageProtection'->>'version')::bigint, 0) + 1)
      )`,
      })
      .where('id', '=', spaceId)
      .where('workspaceId', '=', workspaceId)
      .execute();
    // PostgreSQL delivers this through the existing bridge only after commit.
    await sql`SELECT pg_notify('page_protection', ${spaceId})`.execute(trx);
    return space.rootDefaultLocked;
  }

  async set(
    pageId: string,
    spaceId: string,
    mode: ProtectionMode,
    version: string,
  ) {
    return this.db.transaction().execute(async (trx) => {
      // Use the same lock as moves so version comparison and mutation are atomic.
      await this.pageRepo.lockPageHierarchySpaces([spaceId], trx);
      const page = await trx
        .selectFrom('pages')
        .select(['spaceId', 'deletedAt'])
        .where('id', '=', pageId)
        .executeTakeFirst();
      if (!page || page.deletedAt)
        throw new NotFoundException('Page not found');
      if (page.spaceId !== spaceId) throw new ConflictException('Page moved');
      const state = await this.resolve(pageId, trx);
      if (state.version !== version)
        throw new ConflictException('Page protection changed');
      await trx
        .updateTable('pages')
        .set({
          isLocked: mode === 'inherit' ? null : mode === 'locked',
        })
        .where('id', '=', pageId)
        .execute();
      return this.resolve(pageId, trx);
    });
  }
}
