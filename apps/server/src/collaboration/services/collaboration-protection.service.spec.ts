import { CollaborationProtectionService } from './collaboration-protection.service';

jest.mock('../collaboration.util', () => ({
  getPageId: (name: string) => name.substring(5),
}));

function setup(locked = false, version = 'v1') {
  const protection = {
    resolve: jest.fn().mockResolvedValue({ isLocked: locked, version }),
  };
  const access = { validateCanView: jest.fn(), validateCanEdit: jest.fn() };
  const pages = { findById: jest.fn().mockResolvedValue({ id: 'page' }) };
  const extension = new CollaborationProtectionService(
    protection as any,
    access as any,
    pages as any,
  );
  const connection = { readOnly: false, sendStateless: jest.fn() };
  const event = {
    type: 2,
    documentName: 'page.page',
    context: { protectionVersion: 'v1', user: {} },
    connection,
  } as any;
  return { extension, event, protection, access, connection };
}

describe('Collaboration protection before applying updates', () => {
  it('requires a versioned credential instead of accepting an old bare token', () => {
    const { extension } = setup();
    expect(() => extension.credentials('old.jwt.token')).toThrow(
      'versioned collaboration',
    );
    expect(() =>
      extension.credentials(
        JSON.stringify({ token: 'jwt', protectionVersion: null }),
      ),
    ).toThrow('versioned collaboration');
    const credentials = { token: 'jwt', protectionVersion: 'a'.repeat(32) };
    expect(extension.credentials(JSON.stringify(credentials))).toEqual(
      credentials,
    );
  });

  it('keeps stale authentication read-only even after the page is unlocked', async () => {
    const { extension } = setup(false, 'v3');
    const config = { readOnly: false } as any;
    await extension.authenticate('page', 'v1', config);
    expect(config.readOnly).toBe(true);
  });

  it.each([1, 2])(
    'blocks sync message %s on an already-connected client after locking',
    async (type) => {
      const { extension, event, connection } = setup(true);
      await extension.beforeSync({ ...event, type });
      expect(connection.readOnly).toBe(true);
      expect(connection.sendStateless).toHaveBeenCalledWith(
        JSON.stringify({ type: 'protection.changed' }),
      );
    },
  );

  it('rejects stale updates even when a page has been unlocked again', async () => {
    const { extension, event, connection } = setup(false, 'v3');
    await extension.beforeSync(event);
    expect(connection.readOnly).toBe(true);
  });

  it('does not upgrade a read-only connection when protection is unlocked', async () => {
    const { extension, event, connection } = setup();
    connection.readOnly = true;
    await extension.beforeSync(event);
    expect(connection.readOnly).toBe(true);
  });

  it('permits current-version writes and still checks original permissions', async () => {
    const { extension, event, connection, access } = setup();
    await extension.beforeSync(event);
    expect(connection.readOnly).toBe(false);
    expect(access.validateCanEdit).toHaveBeenCalled();
  });

  it('fails closed before application when the protection query fails', async () => {
    const { extension, event, protection, connection } = setup();
    protection.resolve.mockRejectedValue(new Error('query failed'));
    await expect(extension.beforeSync(event)).rejects.toThrow('query failed');
    expect(connection.readOnly).toBe(true);
  });
});
