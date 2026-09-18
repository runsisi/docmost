// Uses the existing local Compose environment and removes its temporary space.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { execFileSync } = require('node:child_process');
const { createHmac, randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const base = 'http://192.168.1.60:3010';
function sql(query) {
  return execFileSync('docker', ['exec', 'docmost-local-db-1', 'psql', '-U', 'docmost', '-d', 'docmost', '-v', 'ON_ERROR_STOP=1', '-tAc', query], { encoding: 'utf8' }).trim();
}
const owner = JSON.parse(sql("select row_to_json(u) from (select id,email,workspace_id from users where role='owner' limit 1) u"));
const container = JSON.parse(execFileSync('docker', ['inspect', 'docmost-local-docmost-1']))[0];
const secret = container.Config.Env.find(value => value.startsWith('APP_SECRET=')).slice(11);
const iat = Math.floor(Date.now() / 1000);
const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const payload = Buffer.from(JSON.stringify({ sub: owner.id, email: owner.email, workspaceId: owner.workspace_id, type: 'access', iat, exp: iat + 600 })).toString('base64url');
const token = `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  await context.addCookies([{ name: 'authToken', value: token, url: base, httpOnly: true, sameSite: 'Lax' }]);
  async function post(endpoint, data) {
    const response = await context.request.post(base + '/api' + endpoint, { data });
    assert.equal(response.status(), 200, endpoint);
    return (await response.json()).data;
  }
  let space;
  try {
    const id = randomUUID();
    space = await post('/spaces/create', { name: `Trash preview ${id}`, slug: `trash-preview-${id}` });
    const title = `Deleted preview ${id}`;
    const body = `Preview body ${id}`;
    const page = await post('/pages/create', {
      spaceId: space.id, title, format: 'json',
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }] },
    });
    await post('/pages/delete', { pageId: page.id });
    const tab = await context.newPage();
    const errors = [];
    tab.on('pageerror', error => { errors.push(error.message); console.error('BROWSER_ERROR', error.stack); });
    await tab.goto(base + `/s/${space.slug}/trash`);
    await tab.getByText(title, { exact: true }).click();
    try {
      await tab.getByRole('dialog').getByText(body, { exact: true }).waitFor({ timeout: 5000 });
    } catch (error) {
      console.error('PREVIEW_FAILURE', JSON.stringify({ errors, visibleText: await tab.locator('body').innerText() }));
      await tab.reload();
      await tab.getByText(title, { exact: true }).waitFor();
      console.log('RELOAD_RECOVERS_TRASH_LIST');
      throw error;
    }
    assert.deepEqual(errors, [], 'Preview must not crash');
    assert.equal(await tab.getByRole('dialog').locator('[contenteditable="true"]').count(), 0);
    await tab.keyboard.press('Escape');
    await tab.getByRole('dialog').waitFor({ state: 'hidden' });
    await tab.getByText(title, { exact: true }).waitFor();
    await tab.getByText(title, { exact: true }).click();
    await tab.getByRole('dialog').getByText(body, { exact: true }).waitFor();
    await tab.getByRole('dialog').getByRole('button', { name: /^(Close|关闭)$/ }).click();
    await tab.getByRole('dialog').waitFor({ state: 'hidden' });
    await tab.getByText(title, { exact: true }).waitFor();
    assert.deepEqual(errors, [], 'Reopening and closing the preview must not crash');
    console.log('PASS deleted document preview is read-only and reopens/closes without losing trash entries');
  } finally {
    if (space) {
      await post('/spaces/delete', { spaceId: space.id });
      assert.equal(sql(`select count(*) from spaces where id='${space.id}'`), '0');
      assert.equal(sql(`select count(*) from pages where space_id='${space.id}'`), '0');
      console.log('PASS temporary space and pages removed');
    }
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
