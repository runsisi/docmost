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
assert(owner, 'Existing administrator is required');
let space, otherSpace;
const temporarySpaces = [];
const runId = randomUUID();
const temporaryUsers = [];
const roots = [];
const originalSpaceState = sql("select md5(string_agg(id::text || coalesce(settings::text,''), '' order by id)) from spaces");
const originalMemberships = sql("select md5(string_agg(id::text || role, '' order by id)) from space_members");
const originalIds = json('select coalesce(json_agg(id),\'[]\') from pages');
const pageFingerprints = () => json("select json_agg(p) from (select id, md5(coalesce(title,'')) as title, md5(coalesce(content::text,'')) as content, is_locked, protection_version from pages order by id) p");
const originalFingerprints = pageFingerprints();
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
  async function bodyText(tab) {
    const value = await tab.waitForFunction(()=>Array.from(document.querySelectorAll('.tiptap')).find(el=>el.editor?.extensionManager.extensions.some(e=>e.name==='collaboration' && e.options.provider?.synced))?.editor.getText());
    return value.jsonValue();
  }
  async function waitVersion(tab,version) {
    await tab.waitForFunction(version=>Array.from(document.querySelectorAll('.tiptap')).some(el=>{
      const provider=el.editor?.extensionManager.extensions.find(e=>e.name==='collaboration')?.options.provider;
      return provider?.synced && JSON.parse(provider.configuration.token).protectionVersion===version;
    }),version);
  }
  async function toggleInheritance(tab,box,checked) {
    const id=await box.getAttribute('id');
    const [response]=await Promise.all([
      tab.waitForResponse(r=>r.url().endsWith('/api/pages/protection')),
      box.click(),
    ]);
    assert.equal(response.status(),200);
    await tab.waitForFunction(({id,checked})=>{
      const input=document.getElementById(id);
      return input?.checked===checked && !input.disabled;
    },{id,checked});
  }
  async function waitEditable(tab,editable) {
    await tab.waitForFunction(expected=>Array.from(document.querySelectorAll('.tiptap')).some(el=>el.editor?.extensionManager.extensions.some(e=>e.name==='collaboration') && el.editor.isEditable===expected),editable,{timeout:20000});
  }
  try {
    admin = await context(owner);
    for (const suffix of ['main','other']) {
      const createdSpace = await post(admin,'/spaces/create',{name:`Protection ${suffix} ${runId}`,slug:`protection-${suffix}-${runId}`});
      temporarySpaces.push(createdSpace.id);
      if (suffix==='main') space=createdSpace; else otherSpace=createdSpace;
    }
    for (const role of ['reader','outsider','writer','admin']) {
      const id = randomUUID(); temporaryUsers.push(id);
      sql(`insert into users (id,name,email,role,workspace_id,email_verified_at) values ('${id}','Protection ${role}','protection-${runId}-${role}@example.invalid','member','${owner.workspace_id}',now())`);
      if (role!=='outsider') await post(admin,'/spaces/members/add',{spaceId:space.id,userIds:[id],groupIds:[],role});
    }
    const writer = await context({id:temporaryUsers[2],workspace_id:owner.workspace_id});
    const spaceAdmin = await context({id:temporaryUsers[3],workspace_id:owner.workspace_id});
    const reader = await context({id:temporaryUsers[0],workspace_id:owner.workspace_id});
    const outsider = await context({id:temporaryUsers[1],workspace_id:owner.workspace_id});
    const A = await create('A'); const B = await create('B',A.id); const C = await create('C',B.id); const D = await create('D',C.id);
    assert.equal(A.protection.mode,'inherit'); assert.equal(A.isLocked,true);
    assert.equal(A.protection.rootDefaultLocked,true);
    // Both root and lazily loaded descendants must update without collapsing the tree.
    {
      const tab=await open(admin,B);
      const peer=await open(writer,B);
      const lockSelector = page => `a[href$="${page.slugId}"] [aria-label="Locked"], a[href$="${page.slugId}"] [aria-label="已锁定"]`;
      async function treeLocked(page,locked) {
        for (const browserTab of [tab,peer]) {
          await browserTab.locator(`a[href$="${page.slugId}"]`).first().waitFor();
          await browserTab.locator(lockSelector(page)).waitFor({state:locked?'visible':'hidden',timeout:5000});
        }
      }
      await treeLocked(A,true); await treeLocked(B,true);
      await set(A.id,'unlocked'); await waitEditable(tab,true);
      await treeLocked(A,false); await treeLocked(B,false);
      await set(A.id,'locked'); await waitEditable(tab,false);
      await treeLocked(A,true); await treeLocked(B,true);
      await set(B.id,'unlocked'); await treeLocked(A,true); await treeLocked(B,false);
      await set(A.id,'inherit'); await set(B.id,'inherit');
      await post(admin,'/spaces/update',{spaceId:space.id,rootDefaultLocked:false});
      await treeLocked(A,false); await treeLocked(B,false);
      await post(admin,'/spaces/update',{spaceId:space.id,rootDefaultLocked:true});
      await treeLocked(A,true); await treeLocked(B,true);
      await tab.close(); await peer.close();
      record('two-browser sidebar root/expanded child locks refresh after page/ancestor/space-default changes without reload or collapse');
      if (process.env.PROTECTION_TEST_FOCUS==='sidebar') return;
    }
    const defaultSetting = async (locked,ctx=spaceAdmin) => post(ctx,'/spaces/update',{spaceId:space.id,rootDefaultLocked:locked});
    const settings = async () => (await post(admin,'/spaces/info',{spaceId:space.id})).settings;
    const rawPages = () => sql(`select json_agg(p order by id) from (select id,is_locked,protection_version from pages where space_id='${space.id}') p`);
    const originalRaw = rawPages();
    const initialVersion = (await info(D.id)).protection.version;
    await defaultSetting(true);
    assert.equal((await info(D.id)).protection.version,initialVersion);
    const initialSpaceVersion = (await settings())?.pageProtection?.version ?? 0;
    assert.equal(initialSpaceVersion,2);
    for (const invalid of [null,'false',0]) await post(admin,'/spaces/update',{spaceId:space.id,rootDefaultLocked:invalid},400);
    await defaultSetting(false);
    assert.equal((await settings()).pageProtection.version,initialSpaceVersion+1);
    assert.equal((await info(D.id)).isLocked,false);
    assert.equal((await info(D.id)).protection.sourcePageId,null);
    assert.equal(rawPages(),originalRaw,'Default changes must not rewrite pages');
    await post(writer,'/spaces/update',{spaceId:space.id,rootDefaultLocked:true},403);
    await post(reader,'/spaces/update',{spaceId:space.id,rootDefaultLocked:true},403);
    await post(outsider,'/spaces/update',{spaceId:space.id,rootDefaultLocked:true},[403,404]);
    await post(admin,'/spaces/update',{spaceId:space.id,rootDefaultLocked:false,version:900,settings:{pageProtection:{version:900}}});
    assert.equal((await settings()).pageProtection.version,initialSpaceVersion+1,'Client cannot set version');
    const fresh = await create('New default'); assert.equal(fresh.isLocked,false);
    await post(admin,'/pages/move-to-space',{pageId:fresh.id,spaceId:otherSpace.id});
    assert.equal((await info(fresh.id)).isLocked,true);
    await post(admin,'/pages/move-to-space',{pageId:fresh.id,spaceId:space.id});
    assert.equal((await info(fresh.id)).isLocked,false);
    const beforeCycle = (await info(D.id)).protection.version;
    await defaultSetting(true); await defaultSetting(false);
    assert.notEqual((await info(D.id)).protection.version,beforeCycle);
    await post(writer,'/pages/update',{pageId:D.id,title:'stale',protectionVersion:beforeCycle},409);
    await post(writer,'/pages/protection',{pageId:D.id,mode:'unlocked',version:beforeCycle},409);
    sql(`update spaces set settings=settings || '{"testSetting":{"keep":true},"comments":{"allowViewerComments":false}}'::jsonb where id='${space.id}'`);
    await Promise.all([defaultSetting(true),defaultSetting(true)]);
    assert.equal((await settings()).pageProtection.version,initialSpaceVersion+4,'Concurrent identical writes increment once');
    await defaultSetting(false);
    assert.deepEqual((await settings()).testSetting,{keep:true});
    assert.deepEqual((await settings()).comments,{allowViewerComments:false});
    record('default locked; independent spaces; existing/new/inheriting/moved pages; no page rewrites; server-only versions, no-op/concurrent updates and stale conflicts; space admin allowed, members denied');
    await set(A.id,'locked',writer);
    assert.equal((await info(B.id)).isLocked,true);
    assert.equal((await info(D.id)).protection.sourcePageId,A.id);
    await set(C.id,'unlocked',writer);
    assert.equal((await info(D.id)).isLocked,false);
    await defaultSetting(true);
    assert.equal((await info(D.id)).isLocked,false);
    assert.equal((await info(B.id)).isLocked,true);
    await defaultSetting(false);
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

    await set(live.id,'inherit'); await waitEditable(adminTab,true); await waitEditable(writerTab,true);
    await writer.setOffline(true);
    await writerTab.evaluate(()=>{const el=Array.from(document.querySelectorAll('.tiptap')).find(el=>el.editor?.extensionManager.extensions.some(e=>e.name==='collaboration'));el.editor.commands.insertContent(' OFFLINE-RECOVERY-ONLY');});
    await defaultSetting(true); await defaultSetting(false);
    await writer.setOffline(false);
    await writerTab.getByText(/Local recovery copies|本地恢复副本/).waitFor({timeout:30000});
    await waitEditable(writerTab,true);
    await waitEditable(adminTab,true);
    const onlineVersion = (await info(live.id)).protection.version;
    await waitVersion(adminTab,onlineVersion); await waitVersion(writerTab,onlineVersion);
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
    await defaultSetting(true); await defaultSetting(false);
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
    await toggleInheritance(adminTab,adminTab.getByRole('checkbox',{name:/^(Use space default|使用空间默认设置)$/}),true);
    await waitEditable(adminTab,true);
    assert.equal((await info(live.id)).protection.mode,'inherit');
    const inheritBox = adminTab.getByRole('checkbox',{name:/^(Use space default|使用空间默认设置)$/});
    await toggleInheritance(adminTab,inheritBox,false);
    assert.equal((await info(live.id)).protection.mode,'unlocked');
    await toggleInheritance(adminTab,inheritBox,true);
    await adminTab.keyboard.press('Escape');
    const childTab = await open(admin,B);
    await childTab.getByRole('button',{name:/^(Page protection|页面保护)$/}).click();
    const childBox = childTab.getByRole('checkbox',{name:/^(Inherit parent page|继承父页面)$/});
    assert(await childBox.isChecked());
    await toggleInheritance(childTab,childBox,false);
    assert.equal((await info(B.id)).protection.mode,'locked');
    await toggleInheritance(childTab,childBox,true);
    assert.equal((await info(B.id)).protection.mode,'inherit');
    await childTab.close();
    record('root/child inheritance checkboxes retain actual unlocked/locked state when unchecked and restore inheritance when checked');

    const settingTab = await open(spaceAdmin,live);
    await settingTab.getByRole('button',{name:/^(Space settings|空间设置)$/}).click();
    await settingTab.getByRole('tab',{name:/^(Settings|设置)$/}).click();
    const toggle = settingTab.getByRole('switch',{name:/^(Lock root pages by default|根页面默认锁定)/});
    assert.equal(await toggle.isChecked(),false);
    // A second open settings dialog must refresh via the space notification.
    await adminTab.getByRole('button',{name:/^(Space settings|空间设置)$/}).click();
    await adminTab.getByRole('tab',{name:/^(Settings|设置)$/}).click();
    const secondToggle = adminTab.getByRole('switch',{name:/^(Lock root pages by default|根页面默认锁定)/});
    await toggle.click({force:true});
    await waitEditable(writerTab,false);
    await adminTab.waitForFunction(()=>document.querySelector('input[role="switch"]')?.checked===true);
    assert(await secondToggle.isChecked());
    await settingTab.screenshot({path:path.join(output,'space-default.png'),fullPage:true});
    await toggle.click({force:true}); await waitEditable(writerTab,true);
    await adminTab.waitForFunction(()=>document.querySelector('input[role="switch"]')?.checked===false);
    await settingTab.route('**/api/spaces/update',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({message:'Simulated save failure'})}));
    await toggle.click({force:true});
    await settingTab.getByText(/Failed to change space page protection|修改空间页面保护设置失败/).waitFor();
    assert.equal(await toggle.isChecked(),false);
    assert.equal((await settings()).pageProtection.rootDefaultLocked,false);
    await settingTab.unroute('**/api/spaces/update');
    await settingTab.close();
    await adminTab.getByRole('button',{name:/^(Close|关闭)$/}).click();
    record('space administrator switch saves immediately without license; two-browser settings/editor refresh; failed save retains real state');
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
    await readerTab.getByRole('button',{name:/^(Page protection|页面保护)$/}).click();
    assert(await readerTab.getByRole('checkbox',{name:/^(Use space default|使用空间默认设置)$/}).isDisabled());
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
      const { PageRepo } = require('./dist/database/repos/page/page.repo');
      const assert = require('node:assert/strict');
      const service = new PageProtectionService(db, new PageRepo(db, null, null));
      (async()=>{
        const listener = postgres(process.env.DATABASE_URL,{max:1});
        const notifications=[];
        let notified;
        await listener.listen('page_protection',id=>{if(id===${JSON.stringify(space.id)}) {notifications.push(id); notified?.();}});
        const initial=await service.resolve(${JSON.stringify(D.id)});
        await assert.rejects(db.transaction().execute(async trx=>{
          await service.setSpaceDefault(${JSON.stringify(space.id)},${JSON.stringify(owner.workspace_id)},!initial.rootDefaultLocked,trx);
          assert.notEqual((await service.resolve(${JSON.stringify(D.id)},trx)).version,initial.version);
          await new Promise(resolve=>setTimeout(resolve,100));
          assert.equal(notifications.length,0,'No notification before commit');
          throw new Error('Intentional rollback');
        }),/Intentional rollback/);
        assert.deepEqual(await service.resolve(${JSON.stringify(D.id)}),initial);
        await new Promise(resolve=>setTimeout(resolve,100));
        assert.equal(notifications.length,0,'Rollback must not notify');
        const committedNotice=new Promise(resolve=>{notified=resolve});
        await db.transaction().execute(trx=>service.setSpaceDefault(${JSON.stringify(space.id)},${JSON.stringify(owner.workspace_id)},!initial.rootDefaultLocked,trx));
        await Promise.race([committedNotice,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Commit notification missing')),3000))]);
        await db.transaction().execute(trx=>service.setSpaceDefault(${JSON.stringify(space.id)},${JSON.stringify(owner.workspace_id)},initial.rootDefaultLocked,trx));
        await listener.end();
        const results = {transactionRollbackAndCommitNotification:true};
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
  } catch (error) {
    console.error('VALIDATION_FAILURE',error);
    for (const [i,tab] of browser.contexts().flatMap(ctx=>ctx.pages()).entries()) {
      await tab.screenshot({path:path.join(output,`failure-${i}.png`)}).catch(()=>{});
    }
    throw error;
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
    if (temporarySpaces.length) sql(`delete from spaces where id in (${temporarySpaces.map(id=>`'${id}'`).join(',')})`);
    if (temporaryUsers.length) sql(`delete from users where id in (${temporaryUsers.map(id=>`'${id}'`).join(',')})`);
    const after = sql(`select md5(string_agg(id::text || coalesce(title,'') || coalesce(content::text,'') || coalesce(is_locked::text,'inherit'), '' order by id)) from pages where id in (${originalIds.map(id=>`'${id}'`).join(',')})`);
    if (after!==originalSnapshot) fs.writeFileSync(path.join(output,'original-page-changes.json'),JSON.stringify({before:originalFingerprints,after:pageFingerprints()},null,2));
    assert.equal(after,originalSnapshot,'Original documents must be unchanged');
    assert.equal(sql("select md5(string_agg(id::text || coalesce(settings::text,''), '' order by id)) from spaces"),originalSpaceState);
    assert.equal(sql("select md5(string_agg(id::text || role, '' order by id)) from space_members"),originalMemberships);
    assert.equal(sql(`select count(*) from spaces where id in (${temporarySpaces.map(id=>`'${id}'`).join(',')})`),'0');
    record('temporary spaces/pages/accounts removed; original documents unchanged');
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
