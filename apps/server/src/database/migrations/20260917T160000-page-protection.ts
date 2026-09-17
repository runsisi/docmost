import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE pages ALTER COLUMN is_locked DROP NOT NULL,
    ALTER COLUMN is_locked DROP DEFAULT,
    ADD COLUMN protection_version bigint NOT NULL DEFAULT 0`.execute(db);
  await sql`UPDATE pages SET is_locked = NULL WHERE is_locked = false`.execute(
    db,
  );
  // The trigger covers all hierarchy writers, including restore and cross-space moves.
  // NOTIFY is delivered only after commit; no page identity or title is broadcast.
  await sql`CREATE FUNCTION page_protection_changed() RETURNS trigger AS $$
    BEGIN
      IF NEW.is_locked IS DISTINCT FROM OLD.is_locked
        OR NEW.parent_page_id IS DISTINCT FROM OLD.parent_page_id
        OR NEW.space_id IS DISTINCT FROM OLD.space_id
        OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
        NEW.protection_version := OLD.protection_version + 1;
        PERFORM pg_notify('page_protection', OLD.space_id::text);
        IF NEW.space_id IS DISTINCT FROM OLD.space_id THEN
          PERFORM pg_notify('page_protection', NEW.space_id::text);
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`.execute(db);
  await sql`CREATE TRIGGER page_protection_changed BEFORE UPDATE ON pages
    FOR EACH ROW EXECUTE FUNCTION page_protection_changed()`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TRIGGER page_protection_changed ON pages`.execute(db);
  await sql`DROP FUNCTION page_protection_changed()`.execute(db);
  await sql`UPDATE pages SET is_locked = false WHERE is_locked IS NULL`.execute(
    db,
  );
  await sql`ALTER TABLE pages ALTER COLUMN is_locked SET DEFAULT false,
    ALTER COLUMN is_locked SET NOT NULL, DROP COLUMN protection_version`.execute(
    db,
  );
}
