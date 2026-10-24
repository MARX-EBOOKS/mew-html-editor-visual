import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=await mkdtemp(path.join(tmpdir(),'mew-footer-'));
await mkdir(path.join(root,'1'));
await writeFile(path.join(root,'1','ME01-001.html'),'<p>First</p>');
await writeFile(path.join(root,'1','ME01-002.html'),'<p>Second</p>');
await writeFile(path.join(root,'config.json'),JSON.stringify({volumes:[{id:'1',pages:{directory:'1',pattern:'^ME01-([0-9]+)[.]html$'},pdf:'missing.pdf'}]}));
const server=spawn(process.execPath,['reader-server.js','-p','41879','-c',path.join(root,'config.json')],{windowsHide:true,stdio:'pipe'});
let browser;
try {
 for(let i=0;i<60;i++){try{if((await fetch('http://127.0.0.1:41879/api/reader/config')).ok)break;}catch{} await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
 const page=await browser.newPage({viewport:{width:1500,height:950}}); const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:41879/reader.html?volume=1&page=1&mode=source');
 await page.waitForFunction(()=>window.readerMonaco?.editor.getValue().includes('First'));
 assert.equal(await page.locator('header #chapterTitle').count(),1);
 assert.equal(await page.locator('header #pageContext').count(),1);
 assert.equal(await page.locator('footer #status').count(),1);
 assert.equal(await page.locator('#prevFileBtn').isDisabled(),true);
 assert.equal(await page.locator('#languageInfo').textContent(),'HTML · UTF-8');
 assert.match(await page.locator('#fileInfo').textContent(),/ME01-001.html/);
 await page.evaluate(()=>readerMonaco.editor.setPosition({lineNumber:1,column:4}));
 assert.equal(await page.locator('#positionInfo').textContent(),'Ln 1, Col 4');
 for(const dock of ['editor-top','editor-bottom','window-top','window-bottom','floating']){
  await page.locator(`[data-dock="${dock}"]`).click();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('footer.statusbar').evaluate(f=>{const a=f.getBoundingClientRect(),b=document.querySelector('#sourcePane').getBoundingClientRect();return a.height>=24&&a.top>=b.bottom-1&&a.bottom<=innerHeight;}),true,`footer layout at ${dock}`);
 }
 await page.locator('[data-dock="editor-top"]').evaluate(button=>button.click());
 await page.evaluate(()=>{const e=readerMonaco.editor;e.executeEdits('footer-test',[{range:e.getModel().getFullModelRange(),text:'<p>Saved by footer</p>'}]);});
 await page.locator('#nextFileBtn').click();
 await page.waitForFunction(()=>readerMonaco.editor.getValue().includes('Second'));
 assert.equal(await readFile(path.join(root,'1','ME01-001.html'),'utf8'),'<p>Saved by footer</p>');
 assert.equal(await page.locator('#nextFileBtn').isDisabled(),true);
 await page.locator('#prevFileBtn').click();
 await page.waitForFunction(()=>readerMonaco.editor.getValue().includes('Saved by footer'));
 await page.locator('#modeBtn').click(); assert.equal(await page.locator('footer.statusbar').isVisible(),true);
 await page.locator('#darkBtn').click();
 await page.evaluate(()=>ReaderUI.notify('Saved reminder',true));
 assert.equal(await page.locator('header #status').count(),0);
 assert.equal(await page.locator('footer #status').textContent(),'Saved reminder');
 assert.equal(await page.locator('#nextFileBtn').evaluate(b=>Math.abs(b.getBoundingClientRect().right-b.parentElement.getBoundingClientRect().right)<15),true);
 await page.evaluate(()=>ReaderUI.notify('A very long reminder '.repeat(100),true));
 for(const width of [1500,1000,700,400]) {
  await page.setViewportSize({width,height:950});
  await page.waitForTimeout(100);
  assert.equal(await page.locator('footer.statusbar').evaluate(f=>{
   const fr=f.getBoundingClientRect(), status=f.querySelector('#status');
   return ['prevFileBtn','nextFileBtn'].every(id=>{const b=f.querySelector('#'+id),r=b.getBoundingClientRect();return r.left>=fr.left&&r.right<=fr.right&&r.width>=20;}) && status.scrollWidth>status.clientWidth;
  }),true,`long reminder truncates and arrows fit at width ${width}`);
 }
 await page.setViewportSize({width:1500,height:950});
 await page.screenshot({path:'tmp/reader-footer.png'});
 await page.evaluate(()=>ReaderUI.setWorkspaceMode('reader'));
 assert.equal(await page.locator('footer #status').isVisible(),true);
 await page.evaluate(()=>ReaderUI.setWorkspaceMode('combined'));
 assert.equal(await page.locator('.text-pane footer #nextFileBtn').isVisible(),true);
 assert.deepEqual(errors,[]);
 console.log('PASS: footer position/file/encoding, all five dock layouts, arrow boundaries, autosave and return navigation, visual mode and dark theme; screenshot tmp/reader-footer.png');
}finally{await browser?.close();server.kill();}
