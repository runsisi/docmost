// Run only against the existing local Compose environment; never provisions services.
// PLAYWRIGHT_MODULE may name an existing playwright-core installation.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const { execFileSync } = require('node:child_process');
const { createHmac, randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = 'http://192.168.1.60:3010';
const output = process.env.PROTECTION_TEST_OUTPUT || '/tmp/docmost-protection-validation';
fs.mkdirSync(output, { recursive: true });
function sql(query) {
  return execFileSync('docker', ['exec', 'docmost-local-db-1', 'psql', '-U', 'docmost', '-d', 'docmost', '-v', 'ON_ERROR_STOP=1', '-tAc', query], { encoding: 'utf8' }).trim();
}
const json = query => JSON.parse(sql(query));
const container = JSON.parse(execFileSync('docker', ['inspect', 'docmost-local-docmost-1']))[0];
const secret = container.Config.Env.find(v => v.startsWith('APP_SECRET=')).slice(11);
const users = json('select json_agg(u) from (select id,email,name,role,workspace_id from users) u');
const owner = users.find(u => u.role === 'owner');
const member = users.find(u => u.role === 'member');
assert(owner && member, 'Existing administrator and member are required');
const space = json("select row_to_json(s) from (select id,slug from spaces where slug='general') s");
const otherSpace = json("select row_to_json(s) from (select id,slug from spaces where slug='xcube') s");
const runId = randomUUID();
const temporaryUsers = [];
const roots = [];
const originalIds = json('select coalesce(json_agg(id),\'[]\') from pages');
const originalSnapshot = sql(`select md5(string_agg(id::text || coalesce(title,'') || coalesce(content::text,'') || coalesce(is_locked::text,'inherit'), '' order by id)) from pages where id in (${originalIds.map(id=>`'${id}'`).join(',')})`);
function token(user) {
  const iat = Math.floor(Date.now()/1000);
  const h = Buffer.from(JSON.stringify({ alg:'HS256', typ:'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ sub:user.id, email:user.email, workspaceId:user.workspace_id, type:'access', iat, exp:iat+3600 })).toString('base64url');
  return `${h}.${p}.${createHmac('sha256',secret).update(`${h}.${p}`).digest('base64url')}`;
}
const content = text => ({ type:'doc',content:[{type:'paragraph',content:[{type:'text',text}]}] });
const record = message => console.log('PASS '+message);
(async () => {
  const browser = await chromium.launch({ executablePath:'/usr/bin/chromium', headless:true, args:['--no-sandbox'] });
  let admin;
  const errors = [];
  async function context(user) {
    const ctx = await browser.newContext({ viewport:{width:1440,height:1000} });
    await ctx.addCookies([{ name:'authToken',value:token(user),url:base,httpOnly:true,sameSite:'Lax' }]);
    return ctx;
  }
  async function post(ctx, endpoint, data, status=200) {
    const response = await ctx.request.post(base+'/api'+endpoint,{data});
    assert((Array.isArray(status) ? status : [status]).includes(response.status()),endpoint+': '+response.status()+' '+await response.text());
    const body = await response.json();
    return body.data;
  }
  const info = (id,ctx=admin) => post(ctx,'/pages/info',{pageId:id});
  const set = async (id,mode,ctx=admin) => post(ctx,'/pages/protection',{pageId:id,mode,version:(await info(id,ctx)).protection.version});
  async function create(title,parentPageId,ctx=admin) {
    const page = await post(ctx,'/pages/create',{spaceId:space.id,title:`Protection test ${runId} ${title}`,parentPageId,format:'json',content:content('Initial body '+title)});
    roots.push(page.id);
    return page;
  }
  async function open(ctx,page) {
    const tab = await ctx.newPage();
    tab.on('pageerror',error=>errors.push(error.message));
    await tab.goto(base+`/s/${space.slug}/p/${page.slugId}`);
    await tab.waitForFunction(()=>Array.from(document.querySelectorAll('.tiptap')).some(el=>el.editor?.extensionManager.extensions.some(e=>e.name==='collaboration' && e.options.provider?.synced)),null,{timeout:30000});
    const editMode = tab.getByRole('radio', { name: /^(Edit|编辑)$/ });
    if (await editMode.count()) await editMode.evaluate(el => document.querySelector(`label[for="${el.id}"]`).click());
    return tab;
  }
  const bodyText = tab => tab.evaluate(()=>Array.from(document.querySelectorAll('.tiptap')).find(el=>el.editor?.extensionManager.extensions.some(e=>e.name==='collaboration'))?.editor.getText());
  async function waitEditable(tab,editable) {
    await tab.waitForFunction(expected=>Array.from(document.querySelectorAll('.tiptap')).some(el=>el.editor?.extensionManager.extensions.some(e=>e.name==='collaboration') && el.editor.isEditable===expected),editable,{timeout:20000});
  }
  try {
    admin = await context(owner);
    const writer = await context(member);
    for (const role of ['reader','outsider']) {
      const id = randomUUID(); temporaryUsers.push(id);
      sql(`insert into users (id,name,email,role,workspace_id,email_verified_at) values ('${id}','Protection ${role}','protection-${runId}-${role}@example.invalid','member','${owner.workspace_id}',now())`);
      if (role==='reader') sql(`insert into space_members (user_id,space_id,role) values ('${id}','${space.id}','reader')`);
    }
    const reader = await context({id:temporaryUsers[0],workspace_id:owner.workspace_id});
    const outsider = await context({id:temporaryUsers[1],workspace_id:owner.workspace_id});
    const A = await create('A'); const B = await create('B',A.id); const C = await create('C',B.id); const D = await create('D',C.id);
    assert.equal(A.protection.mode,'inherit'); assert.equal(A.isLocked,false);
    await set(A.id,'locked',writer);
    assert.equal((await info(B.id)).isLocked,true);
    assert.equal((await info(D.id)).protection.sourcePageId,A.id);
    await set(C.id,'unlocked',writer);
    assert.equal((await info(D.id)).isLocked,false);
    const oldVersion = (await info(D.id)).protection.version;
    await set(A.id,'unlocked'); await set(A.id,'locked');
    assert.equal((await info(C.id)).protection.mode,'unlocked');
    assert.notEqual((await info(D.id)).protection.version,oldVersion);
    await set(C.id,'inherit'); assert.equal((await info(D.id)).isLocked,true);
    record('multilevel inheritance, independent overrides, restore inheritance, ancestor lock/unlock ABA');

    const version = (await info(B.id)).protection.version;
    const race = await Promise.all(['locked','unlocked'].map(mode => admin.request.post(base+'/api/pages/protection',{data:{pageId:B.id,mode,version}})));
    assert.deepEqual(race.map(r=>r.status()).sort(),[200,409]); await set(B.id,'inherit');
    for (const ctx of [reader,outsider]) {
      const response = await ctx.request.post(base+'/api/pages/protection',{data:{pageId:A.id,mode:'unlocked',version:(await info(A.id)).protection.version}});
      assert([403,404].includes(response.status()));
    }
    await post(outsider,'/pages/info',{pageId:A.id},[403,404]);
    await post(reader,'/pages/update',{pageId:C.id,title:'not allowed'},403);
    await post(admin,'/pages/protection',{pageId:A.id,mode:'invalid',version},400);
    const restricted = await create('Restricted');
    const accessId = randomUUID();
    sql(`insert into page_access (id,page_id,workspace_id,space_id,access_level,creator_id) values ('${accessId}','${restricted.id}','${owner.workspace_id}','${space.id}','restricted','${owner.id}')`);
    sql(`insert into page_permissions (page_access_id,user_id,role,added_by_id) values ('${accessId}','${owner.id}','writer','${owner.id}')`);
    await set(restricted.id,'unlocked');
    await post(writer,'/pages/info',{pageId:restricted.id},403);
    await post(writer,'/pages/protection',{pageId:restricted.id,mode:'unlocked',version:(await info(restricted.id)).protection.version},403);
    record('optimistic concurrency, readers/nonmembers, page restrictions survive explicit unlock, malformed requests');

    const locked = await info(B.id);
    assert.equal(locked.permissions.canEdit,true); assert.equal(locked.permissions.canManageProtection,true); assert.equal(locked.permissions.canModifyContent,false);
    for (const changes of [{title:'rejected'},{icon:'X'},{coverPhoto:'rejected'},{content:content('rejected'),operation:'replace',format:'json'}])
      await post(writer,'/pages/update',{pageId:B.id,...changes},403);
    await post(writer,'/pages/labels/add',{pageId:B.id,names:['protection-test']},403);
    await post(writer,'/pages/labels/remove',{pageId:B.id,labelId:randomUUID()},403);
    const upload = await writer.request.post(base+'/api/files/upload',{multipart:{pageId:B.id,file:{name:'test.txt',mimeType:'text/plain',buffer:Buffer.from('rejected')}}});
    assert.equal(upload.status(),403);
    record('HTTP body/title/icon/cover/label/file writes blocked; original edit and protection rights retained');

    const newChild = await create('new child',B.id,writer); assert.equal(newChild.isLocked,true);
    const E = await create('E');
    await post(writer,'/pages/move',{pageId:E.id,parentPageId:B.id,position:E.position}); assert.equal((await info(E.id)).isLocked,true);
    await set(E.id,'unlocked'); await post(writer,'/pages/move',{pageId:E.id,parentPageId:A.id,position:E.position}); assert.equal((await info(E.id)).isLocked,false);
    const copy = await post(writer,'/pages/duplicate',{pageId:A.id}); roots.push(copy.id, ...copy.childPageIds);
    const copies = json(`select json_agg(p) from (select id,title,is_locked from pages where id in ('${copy.id}',${copy.childPageIds.map(id=>`'${id}'`).join(',')})) p`);
    assert(copies.some(p=>p.is_locked===false)); assert(copies.some(p=>p.is_locked===null)); assert.equal((await info(copy.id)).isLocked,true);
    await post(writer,'/pages/delete',{pageId:E.id}); await post(writer,'/pages/restore',{pageId:E.id}); assert.equal((await info(E.id)).protection.mode,'unlocked');
    await post(admin,'/pages/move-to-space',{pageId:E.id,spaceId:otherSpace.id}); assert.equal((await info(E.id)).protection.mode,'unlocked');
    const tree = await post(writer,'/pages/sidebar-pages',{spaceId:space.id,pageId:A.id});
    assert(tree.items.every(p=>typeof p.isLocked==='boolean'));
    const trashParent = await create('Trash parent',A.id);
    const restoredChild = await create('Restored child',trashParent.id);
    await set(restoredChild.id,'locked');
    await post(writer,'/pages/delete',{pageId:trashParent.id});
    await post(writer,'/pages/restore',{pageId:restoredChild.id});
    const detached = await info(restoredChild.id);
    assert.equal(detached.parentPageId,null); assert.equal(detached.protection.mode,'locked');
    record('create under lock; move/cross-space move; duplicate explicit settings; trash restore/detach; batched tree state');

    const live = await create('Live');
    const adminTab = await open(admin,live); const writerTab = await open(writer,live);
    await waitEditable(writerTab,true);
    await writerTab.evaluate(()=>{const el=Array.from(document.querySelectorAll('.tiptap')).find(el=>el.editor?.extensionManager.extensions.some(e=>e.name==='collaboration'));el.editor.commands.insertContent(' accepted');});
    await adminTab.waitForFunction(()=>document.body.innerText.includes('accepted'));
    await set(live.id,'locked'); await waitEditable(adminTab,false); await waitEditable(writerTab,false);
    await adminTab.screenshot({path:path.join(output,'locked.png'),fullPage:true});
    // Keep the old authenticated provider connected without the UI invalidation handler.
    await writerTab.evaluate(()=>{const el=Array.from(document.querySelectorAll('.tiptap')).find(el=>el.editor?.extensionManager.extensions.some(e=>e.name==='collaboration'));el.editor.commands.insertContent(' FORGED-LOCKED-WRITE');});
    await new Promise(r=>setTimeout(r,1200)); assert(!(await bodyText(adminTab)).includes('FORGED-LOCKED-WRITE'));
    record('two browsers synchronize protection; server rejects forged writes from a connected client');

    const comment = await post(writer,'/comments/create',{pageId:live.id,type:'page',content:JSON.stringify(content('Locked page comment'))});
    await post(writer,'/comments/create',{pageId:live.id,parentCommentId:comment.id,content:JSON.stringify(content('Reply while locked'))});
    await post(writer,'/comments/resolve',{commentId:comment.id,resolved:true});
    await post(writer,'/comments/resolve',{commentId:comment.id,resolved:false});
    const selection = await adminTab.evaluate(() => {
      const editor = Array.from(document.querySelectorAll('.tiptap')).find(el=>el.editor?.extensionManager.extensions.some(e=>e.name==='collaboration')).editor;
      const provider = editor.extensionManager.extensions.find(e=>e.name==='collaboration').options.provider;
      const text = provider.document.getXmlFragment('default').get(0).get(0);
      const id = item => ({ client:item.client, clock:item.clock });
      let first = text._start; while (first.deleted) first = first.right;
      return { anchor:{type:id(text._item.id),tname:null,item:null,assoc:-1}, head:{type:id(text._item.id),tname:null,item:null,assoc:0} };
    });
    const inline = await post(writer,'/comments/create',{pageId:live.id,type:'inline',selection:'Initial body',yjsSelection:selection,content:JSON.stringify(content('Inline while locked'))});
    await adminTab.locator(`[data-comment-id="${inline.id}"]`).first().waitFor();
    await post(writer,'/comments/resolve',{commentId:inline.id,resolved:true});
    await post(writer,'/comments/resolve',{commentId:inline.id,resolved:false});
    await writerTab.locator(`[data-comment-id="${inline.id}"]`).first().waitFor();
    record('comments, replies, resolving/reopening and controlled server inline marks work while locked');

    await set(live.id,'unlocked'); await waitEditable(adminTab,true); await waitEditable(writerTab,true);
    await writer.setOffline(true);
    await writerTab.evaluate(()=>{const el=Array.from(document.querySelectorAll('.tiptap')).find(el=>el.editor?.extensionManager.extensions.some(e=>e.name==='collaboration'));el.editor.commands.insertContent(' OFFLINE-RECOVERY-ONLY');});
    await set(live.id,'locked'); await set(live.id,'unlocked');
    await writer.setOffline(false);
    await writerTab.getByText(/Local recovery copies|本地恢复副本/).waitFor({timeout:30000});
    await waitEditable(writerTab,true);
    await waitEditable(adminTab,true);
    assert(!(await bodyText(adminTab)).includes('OFFLINE-RECOVERY-ONLY'));
    assert(!(await bodyText(writerTab)).includes('OFFLINE-RECOVERY-ONLY'));
    assert(await writerTab.evaluate(()=>Object.values(localStorage).some(v=>v.includes('OFFLINE-RECOVERY-ONLY'))));
    await writerTab.screenshot({path:path.join(output,'recovery.png'),fullPage:true});
    await writerTab.reload(); await writerTab.waitForFunction(()=>Array.from(document.querySelectorAll('.tiptap')).some(el=>el.editor?.extensionManager.extensions.some(e=>e.name==='collaboration' && e.options.provider?.synced)));
    assert(!(await bodyText(writerTab)).includes('OFFLINE-RECOVERY-ONLY'));
    const recoveryPanel = writerTab.getByRole('alert');
    const downloads = [];
    const exportButtons = recoveryPanel.getByRole('button',{name:/^(Export|导出)$/});
    for (let i=0; i<await exportButtons.count(); i++) {
      const downloadPromise = writerTab.waitForEvent('download'); await exportButtons.nth(i).click();
      const download = await downloadPromise; const file = path.join(output,`recovery-${i}.md`); await download.saveAs(file);
      downloads.push(fs.readFileSync(file,'utf8'));
    }
    assert(downloads.some(text=>text.includes('OFFLINE-RECOVERY-ONLY')));
    await recoveryPanel.getByRole('button',{name:/^(Copy|复制)$/}).first().click();
    record('offline lock/unlock, reconnect/reload, recovery export/copy and no automatic replay');

    const originalTitle = (await info(live.id)).title;
    const titleVersion = (await info(live.id)).protection.version;
    let releaseTitle;
    const titleGate = new Promise(resolve => { releaseTitle = resolve; });
    let titleArrived;
    const titleRequest = new Promise(resolve => { titleArrived = resolve; });
    await writerTab.route('**/api/pages/update', async route => {
      if (route.request().postDataJSON().title === 'PENDING-TITLE-RECOVERY') {
        assert.equal(route.request().postDataJSON().protectionVersion, titleVersion);
        titleArrived(); await titleGate;
      }
      await route.continue();
    });
    await writerTab.getByRole('radio',{name:/^(Edit|编辑)$/}).evaluate(el=>document.querySelector(`label[for="${el.id}"]`).click());
    await waitEditable(writerTab,true);
    await writerTab.evaluate(()=>document.querySelector('[aria-label="Page title"], [aria-label="页面标题"]').editor.commands.setContent('PENDING-TITLE-RECOVERY'));
    await titleRequest;
    await set(live.id,'locked'); await set(live.id,'unlocked');
    releaseTitle();
    await waitEditable(writerTab,true);
    await new Promise(r=>setTimeout(r,800));
    assert.equal((await info(live.id)).title,originalTitle);
    assert(await writerTab.evaluate(()=>Object.values(localStorage).some(v=>v.includes('PENDING-TITLE-RECOVERY'))));
    const current = await info(live.id);
    await post(writer,'/pages/update',{pageId:live.id,content:content('History restored body'),operation:'replace',format:'json',protectionVersion:current.protection.version});
    await adminTab.waitForFunction(()=>document.body.innerText.includes('History restored body'));
    assert.equal((await info(live.id)).protection.version,current.protection.version);
    record('pending title preserves its edit-time version; content restoration preserves protection');

    await adminTab.getByRole('button',{name:/^(Lock page|锁定页面)$/}).click();
    await waitEditable(adminTab,false);
    await adminTab.getByRole('button',{name:/^(Page protection|页面保护)$/}).click();
    await adminTab.getByRole('menuitem',{name:/^(Inherit parent page|继承父页面)$/}).click();
    await waitEditable(adminTab,true);
    assert.equal((await info(live.id)).protection.mode,'inherit');
    record('header lock toggle and inherit-parent menu work in the browser');
    const historyTitle = 'History title '+runId;
    sql(`insert into page_history (page_id,slug_id,title,content,last_updated_by_id,space_id,workspace_id,created_at)
      values ('${live.id}','${live.slugId}','${historyTitle}','${JSON.stringify(content('History dialog restored body'))}'::jsonb,'${owner.id}','${space.id}','${owner.workspace_id}',now()+interval '1 second')`);
    const beforeHistory = await info(live.id);
    await writerTab.getByRole('button',{name:/^(Page actions|页面操作)$/}).click();
    await writerTab.getByRole('menuitem',{name:/^(Page history|页面历史)$/}).click();
    await writerTab.getByText('History dialog restored body',{exact:true}).first().waitFor();
    await writerTab.getByRole('button',{name:/^(Restore|恢复)$/}).last().click();
    const historyResponse = writerTab.waitForResponse(r=>r.url().endsWith('/api/pages/update'));
    await writerTab.getByRole('button',{name:/^(Confirm|确认)$/}).click();
    assert.equal((await historyResponse).status(),200);
    await writerTab.getByRole('dialog',{name:/^(Page history|页面历史)$/}).waitFor({state:'hidden'});
    await writerTab.getByRole('heading',{name:historyTitle,exact:true}).waitFor();
    await adminTab.getByRole('heading',{name:historyTitle,exact:true}).waitFor();
    await adminTab.waitForFunction(()=>document.body.innerText.includes('History dialog restored body'));
    assert.equal((await info(live.id)).protection.version,beforeHistory.protection.version);
    await set(live.id,'locked'); await waitEditable(writerTab,false);
    await writerTab.getByRole('button',{name:/^(Page actions|页面操作)$/}).click();
    await writerTab.getByRole('menuitem',{name:/^(Page history|页面历史)$/}).click();
    assert.equal(await writerTab.getByRole('button',{name:/^(Restore|恢复)$/}).count(),0);
    await writerTab.getByRole('button',{name:/^(Close|关闭)$/}).first().click();
    await set(live.id,'unlocked');
    record('history dialog restores title and body across browsers without changing protection; locked restore is unavailable');

    const readerTab = await open(reader,live); await waitEditable(readerTab,false);
    assert.equal(await readerTab.getByRole('button',{name:/^(Lock page|锁定页面)$/}).isDisabled(),true);
    await post(reader,'/pages/update',{pageId:live.id,title:'reader after unlock'},403);
    record('unlock never upgrades reader access; protection controls are view-only');
    assert.deepEqual(errors,[]);
    record('browser console has no uncaught errors');
    const benchmarkCode = `
      const { Kysely, CamelCasePlugin } = require('kysely');
      const { PostgresJSDialect } = require('kysely-postgres-js');
      const postgres = require('postgres');
      const { PageProtectionService } = require('./dist/core/page/protection/page-protection.service');
      const times = [];
      const db = new Kysely({ dialect:new PostgresJSDialect({postgres:postgres(process.env.DATABASE_URL,{max:1})}), plugins:[new CamelCasePlugin()], log:e=>{if(e.level==='query') times.push(e.queryDurationMillis);} });
      const service = new PageProtectionService(db, {});
      (async()=>{
        const results = {};
        for (const [label,ids] of Object.entries({leaf:${JSON.stringify([D.id])},batch:${JSON.stringify([A.id,B.id,C.id,D.id])}})) {
          for(let i=0;i<5;i++) await service.resolveMany(ids);
          times.length=0;
          for(let i=0;i<50;i++) await service.resolveMany(ids);
          times.sort((a,b)=>a-b);
          results[label]={queries:times.length,meanMs:times.reduce((a,b)=>a+b,0)/times.length,p95Ms:times[Math.floor(times.length*0.95)]};
        }
        console.log(JSON.stringify(results)); await db.destroy();
      })().catch(e=>{console.error(e);process.exit(1)});
    `;
    const measurements = execFileSync('docker',['exec','-w','/app/apps/server','docmost-local-docmost-1','node','-e',benchmarkCode],{encoding:'utf8'});
    fs.writeFileSync(path.join(output,'query-cost.json'),measurements);
    console.log('QUERY_COST '+measurements.trim());
  } finally {
    await browser.close();
    // All cleanup is restricted to rows created by this run.
    const created = roots.length ? roots.join(',') : '';
    if (created) {
      const ids = created.split(',');
      // Flush pending Yjs stores before deleting test records.
      await new Promise(r=>setTimeout(r,11000));
      sql(`delete from pages where id in (${ids.map(id=>`'${id}'`).join(',')})`);
    }
    if (temporaryUsers.length) sql(`delete from users where id in (${temporaryUsers.map(id=>`'${id}'`).join(',')})`);
    const after = sql(`select md5(string_agg(id::text || coalesce(title,'') || coalesce(content::text,'') || coalesce(is_locked::text,'inherit'), '' order by id)) from pages where id in (${originalIds.map(id=>`'${id}'`).join(',')})`);
    assert.equal(after,originalSnapshot,'Original documents must be unchanged');
    record('temporary pages/accounts removed; original documents unchanged');
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
