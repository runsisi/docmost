// Run against a locally built server using the existing local Compose database.
// Never targets the production deployment; removes only its temporary space.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { execFileSync } = require('node:child_process');
const { createHmac, randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const base = process.env.DOCX_TEST_URL || 'http://127.0.0.1:3012';
assert.equal(new URL(base).hostname, '127.0.0.1', 'Use a temporary local validation server');
const output = process.env.DOCX_TEST_OUTPUT || '/tmp/docmost-docx-validation';
fs.mkdirSync(output, { recursive: true });
function sql(query) {
  return execFileSync('docker', ['exec', 'docmost-local-db-1', 'psql', '-U', 'docmost', '-d', 'docmost', '-v', 'ON_ERROR_STOP=1', '-tAc', query], { encoding: 'utf8' }).trim();
}
const owner = JSON.parse(sql("select row_to_json(u) from (select id,email,workspace_id from users where role='owner' limit 1) u"));
const container = JSON.parse(execFileSync('docker', ['inspect', 'docmost-local-docmost-1']))[0];
const secret = container.Config.Env.find(value => value.startsWith('APP_SECRET=')).slice(11);
const iat = Math.floor(Date.now() / 1000);
const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const payload = Buffer.from(JSON.stringify({ sub: owner.id, email: owner.email, workspaceId: owner.workspace_id, type: 'access', iat, exp: iat + 1800 })).toString('base64url');
const token = `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;
const paragraph = value => ({ type: 'paragraph', content: [{ type: 'text', text: value }] });
const content = (...nodes) => ({ type: 'doc', content: nodes });
const record = message => console.log('PASS ' + message);
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'authToken', value: token, url: base, httpOnly: true, sameSite: 'Lax' }]);
  async function post(endpoint, data) {
    const response = await context.request.post(base + '/api' + endpoint, { data });
    assert.equal(response.status(), 200, endpoint + ': ' + await response.text());
    return (await response.json()).data;
  }
  const fingerprint = () => sql("select md5(string_agg(id::text || coalesce(title,'') || coalesce(content::text,''), '' order by id)) from pages");
  const before = fingerprint();
  let space;
  const uploadedPaths = [];
  try {
    const run = randomUUID();
    space = await post('/spaces/create', { name: `Word export ${run}`, slug: `word-export-${run}` });
    const page = await post('/pages/create', { spaceId: space.id, title: '中文 Word / 导出样本', format: 'json', content: content(paragraph('可编辑中文正文')) });
    const unauth = await browser.newContext();
    assert.equal((await unauth.request.post(base + '/api/pages/export-docx', { data: { pageId: page.id } })).status(), 401);
    await unauth.close();
    assert.equal((await context.request.post(base + '/api/pages/export-docx', { data: {} })).status(), 400);
    assert.equal((await context.request.post(base + '/api/pages/export-docx', { data: { pageId: randomUUID() } })).status(), 404);
    record('HTTP login, request validation and missing-page errors');

    const tab = await context.newPage();
    const errors = [];
    tab.on('pageerror', error => errors.push(error.message));
    await tab.goto(base + `/s/${space.slug}/p/${page.slugId}`);
    await tab.getByRole('button', { name: /^(Page actions|页面操作)$/ }).waitFor();
    async function modal() {
      await tab.getByRole('button', { name: /^(Page actions|页面操作)$/ }).click();
      await tab.getByRole('menuitem', { name: /^(Export|导出)$/ }).click();
      return tab.getByRole('dialog');
    }
    async function format(dialog, name) {
      await dialog.getByLabel(/Select export format|选择导出格式/).click();
      await tab.getByRole('option', { name, exact: true }).click();
    }
    async function download(dialog, suffix) {
      const pending = tab.waitForEvent('download');
      await dialog.getByRole('button', { name: /^(Export|导出)$/ }).click();
      const file = await pending;
      assert(file.suggestedFilename().endsWith(suffix));
      await file.saveAs(path.join(output, file.suggestedFilename()));
      return file;
    }
    let dialog = await modal();
    await format(dialog, 'Word (.docx)');
    assert.equal(await dialog.getByRole('switch').count(), 0);
    const file = await download(dialog, '.docx');
    assert.equal(file.suggestedFilename(), '中文 Word  导出样本.docx');
    await tab.getByText(/^(Export successful|导出成功)$/).waitFor();
    record('community Word selection, hidden switches, Chinese filename and success notification');
    for (const name of ['Markdown', 'HTML']) {
      dialog = await modal();
      await format(dialog, name);
      assert.equal(await dialog.getByRole('switch').count(), 2);
      await download(dialog, name === 'HTML' ? '.html' : '.md');
    }
    record('Markdown and HTML browser downloads remain available');

    // Inject an HTTP error to exercise the real binary Axios response path.
    for (const status of [403, 404, 500]) {
      await tab.route('**/api/pages/export-docx', route => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ message: `Word error ${status}` }) }));
      dialog = await modal();
      await format(dialog, 'Word (.docx)');
      await dialog.getByRole('button', { name: /^(Export|导出)$/ }).click();
      await tab.getByText(new RegExp(`Word error ${status}`)).waitFor();
      await dialog.getByRole('button', { name: /^(Cancel|取消)$/ }).click();
      await tab.unroute('**/api/pages/export-docx');
    }
    record('403, 404 and 500 JSON errors from binary requests are readable');
    await tab.close();

    const info = await post('/pages/info', { pageId: page.id });
    await post('/pages/protection', { pageId: page.id, mode: 'unlocked', version: info.protection.version });
    const imageTab = await context.newPage();
    await imageTab.setContent('<div style="width:600px;height:180px;background:#e8f0fe;color:#174ea6;font:32px sans-serif;padding:20px">Word 导出测试图片<br>中文正文 · 图片 · 合并单元格</div>');
    const png = await imageTab.locator('div').screenshot();
    await imageTab.close();
    const upload = await context.request.post(base + '/api/files/upload', { multipart: { pageId: page.id, file: { name: '测试图片.png', mimeType: 'image/png', buffer: png } } });
    assert.equal(upload.status(), 200, await upload.text());
    const attachment = await upload.json();
    uploadedPaths.push(sql(`select file_path from attachments where id='${attachment.id}'`));
    const cell = (value, attrs = {}) => ({ type: 'tableCell', attrs, content: [paragraph(value)] });
    const sample = content(
      paragraph('中文正文与复杂表格'),
      { type: 'table', content: [
        { type: 'tableRow', content: [cell('横向合并', { colspan: 2 }), cell('纵向合并', { rowspan: 2 })] },
        { type: 'tableRow', content: [cell('第一列'), cell('第二列')] },
      ] },
      { type: 'image', attrs: { attachmentId: attachment.id, src: `/api/files/${attachment.id}/测试图片.png` } },
      { type: 'image', attrs: { src: 'https://example.invalid/external.png' } },
      { type: 'mathBlock', attrs: { text: '\\frac{1}{2}' } },
    );
    await post('/pages/update', { pageId: page.id, content: sample, operation: 'replace', format: 'json' });
    const saved = sql(`select content::text from pages where id='${page.id}'`);
    const result = await context.request.post(base + '/api/pages/export-docx', { data: { pageId: page.id } });
    assert.equal(result.status(), 200, await result.text());
    assert.equal(result.headers()['x-docmost-export-warning-count'], '2');
    const data = await result.body();
    fs.writeFileSync(path.join(output, '中文图片复杂表格.docx'), data);
    const zip = await JSZip.loadAsync(data);
    const xml = await zip.file('word/document.xml').async('string');
    for (const value of ['中文正文', '横向合并', '<w:gridSpan', '<w:vMerge', '<w:drawing>', 'Word 导出说明']) assert(xml.includes(value), value);
    assert.equal(saved, sql(`select content::text from pages where id='${page.id}'`));
    record('saved Chinese/image/merged-table DOCX, warning header and unchanged source');

    const warningTab = await context.newPage();
    // Use the same real page export with a download-only UI regression.
    await warningTab.goto(base + `/s/${space.slug}/p/${page.slugId}`);
    await warningTab.getByRole('button', { name: /^(Page actions|页面操作)$/ }).click();
    await warningTab.getByRole('menuitem', { name: /^(Export|导出)$/ }).click();
    dialog = warningTab.getByRole('dialog');
    await dialog.getByLabel(/Select export format|选择导出格式/).click();
    await warningTab.getByRole('option', { name: 'Word (.docx)', exact: true }).click();
    await dialog.getByRole('button', { name: /^(Export|导出)$/ }).click();
    await warningTab.getByText(/Exported with incomplete content|已导出，部分内容未完整转换/).waitFor();
    record('browser download shows the degradation notification');
    await warningTab.close();
    await post('/pages/delete', { pageId: page.id });
    assert.equal((await context.request.post(base + '/api/pages/export-docx', { data: { pageId: page.id } })).status(), 404);
    record('deleted page cannot be exported');
    assert.deepEqual(errors, []);
  } finally {
    if (space) {
      await post('/spaces/delete', { spaceId: space.id });
      assert.equal(sql(`select count(*) from pages where space_id='${space.id}'`), '0');
    }
    for (const file of uploadedPaths) fs.rmSync(path.join(__dirname, '../data/storage', file), { force: true });
    await browser.close();
    assert.equal(fingerprint(), before, 'Existing page titles and saved content must remain unchanged');
    record('temporary data removed and existing pages unchanged');
  }
})().catch(error => { console.error(String(error.message).replace(/authToken=[^\s]+/g, 'authToken=[redacted]')); process.exitCode = 1; });
