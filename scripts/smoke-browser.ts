import { runBrowser } from '../src/tools/browser-auto.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'browser-live-'));
process.env.CYBER_BROWSER_PROFILE_DIR = join(root, 'profiles');
process.env.CYBER_EVIDENCE_DIR = join(root, 'evidence');
// Uses the normal installed engine resolver (or CYBER_CLOAKBROWSER_DIR).
const server = Bun.serve({hostname:'127.0.0.1', port:0, fetch(req) {
  const url = new URL(req.url);
  if (url.pathname === '/api/test') return Response.json({ok:true});
  if (url.pathname === '/download') return new Response('{"fixture":true}', {headers:{'Content-Type':'application/json','Content-Disposition':'attachment; filename="fixture.json"'}});
  if (url.pathname === '/frame') return new Response('<h1>Frame content</h1><input id="name"><input type="checkbox" id="agree"><select id="plan"><option value="basic">Basic</option></select>', {headers:{'Content-Type':'text/html'}});
  return new Response('<title>Fixture</title><h1>Main content</h1><iframe src="/frame"></iframe><button onclick="fetch(\'/api/test\')">Fetch</button><button id="popup" onclick="window.open(\'/popup\')">Popup</button><button id="dialog" onclick="alert(\'fixture-dialog\')">Dialog</button><a id="download" href="/download">Download</a><script>setTimeout(()=>{let b=document.createElement("button");b.id="late";b.textContent="Late";document.body.append(b)},100)</script>'.replace('src="/frame"', 'src="http://localhost:' + url.port + '/frame"'),{headers:{'Content-Type':'text/html'}});
}});
const url = `http://127.0.0.1:${server.port}/`;
async function call(params:any) {
 const r = await runBrowser({...params, profile:'smoke', timeoutSec:15}, undefined);
 if (r.isError) throw new Error(r.text);
 return r;
}
try {
 const first = await call({action:'navigate',url});
 console.log('navigate:',first.meta.tabId);
 const frames = await call({action:'frames'}); console.log(frames.text);
 await call({action:'act',frame:0,steps:[{op:'fill',frame:1,sel:'#name',value:'Alice'},{op:'check',frame:1,sel:'#agree'},{op:'select',frame:1,sel:'#plan',value:'basic'},{op:'waitSel',sel:'#never-present',state:'hidden'}]});
 const result = await call({action:'eval',frame:1,code:'return document.querySelector("#name").value + ":" + document.querySelector("#agree").checked'});
 if (!result.text.includes('Alice:true')) throw new Error('iframe actions did not affect iframe');
 await call({action:'eval',code:'setTimeout(() => { const b=document.createElement("button"); b.id="waited"; b.textContent="Ready"; document.body.append(b); }, 750); return true'});
 const waitStarted = Date.now();
 await call({action:'act',steps:[{op:'click',sel:'#waited'},{op:'click',sel:'text=Fetch'},{op:'waitSel',sel:'h1'}]});
 if (Date.now() - waitStarted < 500) throw new Error('delayed element did not exercise automatic waits');
 await new Promise(r=>setTimeout(r,100));
 const network = await call({action:'network',networkFilter:'/api/test'});
 if (!network.text.includes('/api/test')) throw new Error('persistent network capture missing');
 const networkRows = network.network as Array<{captureId?:string;url?:string}> | undefined;
 const captureId = networkRows?.find((r) => r.url?.includes('/api/test'))?.captureId;
 if (!captureId) throw new Error('network capture reference missing');
 const responseArtifact = await call({action:'networkArtifact',captureId});
 if (!JSON.stringify(responseArtifact).includes('browser-network-response')) throw new Error('network body artifact missing');
 const dom = await call({action:'domSnapshot'});
 const fetchRef = (dom.dom as Array<{ref:string;text:string}>).find((r) => r.text === 'Fetch')?.ref;
 if (!fetchRef) throw new Error('structured DOM element ref missing');
 await call({action:'act',steps:[{op:'click',ref:fetchRef}]});
 const dialog = await call({action:'act',dialogAction:'accept',steps:[{op:'click',sel:'#dialog'}]});
 if (!dialog.text.includes('fixture-dialog')) throw new Error('JavaScript dialog was not reported and handled');
 await call({action:'act',steps:[{op:'click',sel:'#download'}]});
 const downloads = await call({action:'downloads'});
 if (!downloads.text.includes('fixture.json')) throw new Error('download discovery missing');
 const file = await call({action:'download',downloadIndex:0});
 if (!JSON.stringify(file).includes('browser-download')) throw new Error('download artifact missing');
 await call({action:'act',steps:[{op:'click',sel:'#popup'}]});
 const popupTabs = await call({action:'tabs'});
 if (!popupTabs.text.includes('popup')) throw new Error('popup tab discovery missing');
 const second = await call({action:'newTab',url:url+'other'});
 await call({action:'switchTab',tabId:first.meta.tabId});
 const selected = await call({action:'snapshot'});
 if (selected.meta.tabId !== first.meta.tabId) throw new Error('selection did not persist');
 await call({action:'close',tabId:second.meta.tabId});
 const afterClose=await call({action:'snapshot',tabId:first.meta.tabId});
 if (afterClose.meta.tabId !== first.meta.tabId) throw new Error('stable ID lost on tab close');
 console.log('PASS: real browser DOM refs, frames, delayed actions, network/download artifacts, dialog handling, popup discovery and stable tabs');
} finally {
 try { await call({action:'close',shutdown:true}); } catch(e) { console.error('cleanup:',String(e)); }
 server.stop(true); rmSync(root,{recursive:true,force:true});
}
