// Run against a disposable database after building the server:
// DATABASE_URL=postgresql://.../docmost_gitea_test node test/gitea-accounts.integration.cjs
// The database must have a workspace initialized through /api/auth/setup.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const { randomUUID } = require('node:crypto');
const load = createRequire(resolve('dist/main.js'));
const { Kysely, CamelCasePlugin } = load('kysely');
const { PostgresJSDialect } = load('kysely-postgres-js');
const postgres = load('postgres');
const { GiteaService } = load('./core/auth/gitea/gitea.service');
const { UserRepo } = load('./database/repos/user/user.repo');
const { GroupUserRepo } = load('./database/repos/group/group-user.repo');
const { GroupRepo } = load('./database/repos/group/group.repo');

async function main() {
  assert.ok(
    new URL(process.env.DATABASE_URL).pathname.endsWith('_test'),
    'A disposable _test database is required',
  );
  const db = new Kysely({
    dialect: new PostgresJSDialect({
      postgres: postgres(process.env.DATABASE_URL),
    }),
    plugins: [new CamelCasePlugin()],
  });
  const created = [];
  try {
    const workspace = await db
      .selectFrom('workspaces')
      .selectAll()
      .executeTakeFirstOrThrow();
    const userRepo = new UserRepo(db);
    const groupRepo = new GroupUserRepo(db, new GroupRepo(db), userRepo);
    const env = { getGiteaConfig: () => ({ allowSignup: true }) };
    const service = new GiteaService(env, {}, db, userRepo, groupRepo, {}, {});
    const issuer = 'https://gitea-test.example';
    const profile = {
      sub: randomUUID(),
      email: `gitea-${randomUUID()}@example.com`,
      email_verified: true,
      name: 'Gitea test',
    };
    const attempts = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        service.resolveUser(workspace, issuer, profile),
      ),
    );
    const users = attempts
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value);
    created.push(...new Set(users.map((user) => user.id)));
    for (const attempt of attempts) {
      if (attempt.status === 'rejected') throw attempt.reason;
    }
    assert.equal(
      new Set(users.map((u) => u.id)).size,
      1,
      'Concurrent first logins create only one user',
    );
    assert.equal(users[0].role, 'member');
    const memberships = await db
      .selectFrom('groupUsers')
      .select('groupId')
      .where('userId', '=', users[0].id)
      .execute();
    assert.ok(memberships.length > 0, 'New users join the default group');
    const bindings = await db
      .selectFrom('giteaAccounts')
      .selectAll()
      .where('subject', '=', profile.sub)
      .execute();
    assert.equal(bindings.length, 1);

    await assert.rejects(
      () =>
        service.resolveUser(workspace, issuer, {
          ...profile,
          sub: randomUUID(),
        }),
      /email exists/,
    );
    await assert.rejects(
      () =>
        service.resolveUser(workspace, issuer, {
          ...profile,
          sub: randomUUID(),
          email: `gitea-${randomUUID()}@example.com`,
          email_verified: false,
        }),
      /Verify your email/,
    );
    env.getGiteaConfig = () => ({ allowSignup: false });
    await assert.rejects(
      () =>
        service.resolveUser(workspace, issuer, {
          ...profile,
          sub: randomUUID(),
          email: `gitea-${randomUUID()}@example.com`,
        }),
      /signup is disabled/,
    );
    assert.equal(
      (
        await service.resolveUser(workspace, issuer, {
          ...profile,
          email: 'changed@example.com',
        })
      ).id,
      users[0].id,
      'Existing identity survives an external email change',
    );
    await assert.rejects(
      () =>
        service.resolveUser(
          { ...workspace, enforceMfa: true },
          issuer,
          profile,
        ),
      /complete MFA/,
    );
    await db
      .insertInto('userMfa')
      .values({
        userId: users[0].id,
        workspaceId: workspace.id,
        isEnabled: true,
      })
      .execute();
    await assert.rejects(
      () => service.resolveUser(workspace, issuer, profile),
      /complete MFA/,
    );
    await db.deleteFrom('userMfa').where('userId', '=', users[0].id).execute();
    await userRepo.updateUser(
      { deactivatedAt: new Date() },
      users[0].id,
      workspace.id,
    );
    await assert.rejects(
      () => service.resolveUser(workspace, issuer, profile),
      /disabled/,
    );
    await userRepo.updateUser(
      { deactivatedAt: null, deletedAt: new Date() },
      users[0].id,
      workspace.id,
    );
    await assert.rejects(
      () => service.resolveUser(workspace, issuer, profile),
      /disabled/,
    );
    await userRepo.updateUser({ deletedAt: null }, users[0].id, workspace.id);

    env.getGiteaConfig = () => ({ allowSignup: true });
    const another = {
      sub: randomUUID(),
      email: `gitea-${randomUUID()}@example.com`,
      email_verified: true,
    };
    const second = await service.resolveUser(workspace, issuer, another);
    created.push(second.id);
    await assert.rejects(
      () => service.resolveUser(workspace, issuer, profile, second.id),
      /already linked to another user/,
    );
    await assert.rejects(
      () =>
        service.resolveUser(
          workspace,
          issuer,
          { ...profile, sub: randomUUID() },
          second.id,
        ),
      /already registered or linked/,
    );
    console.log(
      'PASS: concurrent signup, member role, group membership, stable identity, email collision, unverified email, disabled signup, MFA, disabled/deleted users and binding conflicts.',
    );
  } finally {
    try {
      if (created.length) {
        await db.transaction().execute(async (trx) => {
          await trx
            .deleteFrom('groupUsers')
            .where('userId', 'in', created)
            .execute();
          await trx.deleteFrom('users').where('id', 'in', created).execute();
        });
      }
    } finally {
      await db.destroy();
    }
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
