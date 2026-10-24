import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=await mkdtemp(path.join(tmpdir(),'mew-shared-footer-'));
await writeFile(path.join(root,'a.html'),'<p>Alpha</p>');await writeFile(path.join(root,'b.html'),'<p>Beta</p>');
const server=spawn(process.execPath,['server.js','-p','41878','-r',root],{windowsHide:true,stdio:'pipe'});let browser;
try {
 for(let i=0;i<60;i++){try{if((await fetch('http://127.0.0.1:41878/')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
 const page=await browser.newPage({viewport:{width:1500,height:950}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41878/?file=a.html');await page.waitForFunction(()=>window.mewWorkbench?.editor.getValue().includes('Alpha'));
 assert.equal(await page.locator('#fileName').count(),0);assert.equal(await page.locator('footer #prevFileBtn').count(),1);assert.equal(await page.locator('header #nextFileBtn').count(),0);
 assert.equal(await page.locator('#languageInfo').textContent(),'HTML · UTF-8');
 await page.evaluate(()=>{const e=mewWorkbench.editor;e.executeEdits('test',[{range:e.getModel().getFullModelRange(),text:'<p>Autosaved Alpha</p>'}]);});
 await page.locator('#nextFileBtn').click();await page.waitForFunction(()=>mewWorkbench.editor.getValue().includes('Beta'));
 assert.equal(await readFile(path.join(root,'a.html'),'utf8'),'<p>Autosaved Alpha</p>');
 await page.locator('#prevFileBtn').click();await page.waitForFunction(()=>mewWorkbench.editor.getValue().includes('Autosaved Alpha'));
 await page.evaluate(()=>{const e=mewWorkbench.editor;e.executeEdits('test',[{range:e.getModel().getFullModelRange(),text:'<p>Unsaved conflict</p>'}]);});
 await writeFile(path.join(root,'a.html'),'<p>External content</p>');
 await page.locator('#nextFileBtn').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.length>0);
 assert.equal(await page.evaluate(()=>mewWorkbench.editor.getValue()),'<p>Unsaved conflict</p>');assert.equal(await readFile(path.join(root,'a.html'),'utf8'),'<p>External content</p>');
 await page.evaluate(()=>MewEditorCore.footer.notify('Long reminder '.repeat(100),true));
 for(const width of [1500,700,400]){await page.setViewportSize({width,height:950});await page.waitForTimeout(100);assert.equal(await page.locator('footer').evaluate(f=>{const r=f.getBoundingClientRect();return [...f.querySelectorAll('#prevFileBtn,#nextFileBtn')].every(b=>b.getBoundingClientRect().right<=r.right&&b.getBoundingClientRect().left>=r.left);}),true);}
 assert.deepEqual(errors,[]);console.log('PASS index: shared footer, no filename, autosave arrows, save-conflict navigation blocked, narrow footer arrows exposed');
}finally{await browser?.close();server.kill();}
