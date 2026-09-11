import { Router } from 'express';
import { randomBytes } from 'crypto';

export const evaluationPage = Router();
evaluationPage.get('/', (_req, res) => {
  const nonce = randomBytes(16).toString('base64');
  res.set({ 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` }).type('html').send(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Evaluation workspace</title>
<style nonce="${nonce}">body{font:16px system-ui;max-width:850px;margin:40px auto;padding:0 20px;color:#18252e}input,textarea,button{font:inherit;padding:10px;margin:8px 0}textarea{box-sizing:border-box;width:100%;min-height:150px}button{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere}label{display:block}img{max-width:100%}[hidden]{display:none}</style>
<h1>Evaluation workspace</h1><p>Query the approved case, build simulated campaigns, and develop creatives with Emma. Simulation complete — not sent to Meta. No delivery or spend occurs.</p>
<form id="login"><label>Email <input id="email" type="email" autocomplete="username" required></label><label>Password <input id="password" type="password" autocomplete="current-password" required></label><button>Sign in</button></form>
<p id="status" role="status" aria-live="polite"></p>
<main id="workspace" hidden><button id="logout">Sign out</button><p id="budget"></p><details><summary>Approved case material</summary><pre id="materials"></pre></details>
<h2>Meta simulation</h2><p>All IDs and changes belong to this evaluation. Reset restores the approved starting case and removes disposable artifacts; generation calls are not refunded.</p>
<label>Operation <select id="simulationOperation"><option value="query">Query</option><option value="inspect">Inspect</option><option value="create">Create</option><option value="update">Update</option><option value="publish">Publish</option><option value="pause">Pause</option><option value="activate">Activate</option><option value="reset">Reset / reseed</option></select></label>
<label>Object <select id="simulationKind"><option value="campaign">Campaign</option><option value="adset">Ad set</option><option value="ad">Ad</option><option value="creative">Creative / upload</option></select></label>
<label>Query source <select id="simulationSource"><option value="current">Current simulation</option><option value="approved">Frozen approved dataset</option></select></label>
<label>Object ID <input id="simulationId" autocomplete="off" placeholder="Copy an ID from the results"></label>
<label for="simulationFields">Fields (JSON)</label><textarea id="simulationFields" maxlength="40000">{"name":"Proposed campaign","objective":"LEADS","budget":5000,"budgetType":"daily"}</textarea>
<details><summary>Supported fields</summary><p>Budgets use integer USD cents. Campaign: name, objective (AWARENESS, TRAFFIC, LEADS, SALES), budget and budgetType (daily/lifetime). Ad set: name, parentId (campaign), targeting (sanitized text), optional budget. Campaign/ad set schedules: startTime and endTime in UTC, for example 2030-01-01T00:00:00.000Z. Ad: name, parentId (ad set), creativeId. Creative: name, text, own artifactId, or upload {mime,base64} up to 24 KB. For larger creatives, upload an artifact below and copy its ID. No external IDs, URLs, or credentials.</p></details>
<button id="simulate">Run simulation</button><pre id="simulationResult" role="status" aria-live="polite"></pre>
<label for="prompt">Ask Emma</label><textarea id="prompt" maxlength="8000" placeholder="Analyze the case and propose an ad strategy"></textarea><button id="analyze">Analyze / strategize</button> <button id="creative">Generate creative</button>
<pre id="answer"></pre><img id="preview" alt="Generated evaluation creative" hidden>
<label>Upload an artifact (up to 240 KB)<input id="upload" type="file"></label><h2>Evaluation artifacts</h2><div id="artifacts"></div></main>
<section id="reviewWorkspace" hidden><button id="reviewLogout">Sign out</button><h2>Review an evaluation</h2><label>Evaluation user ID <input id="reviewUserId" autocomplete="off"></label><button id="review">Inspect simulation and audit</button><pre id="reviewResult"></pre><div id="reviewArtifacts"></div></section>
<script nonce="${nonce}">
let token = ''; let previewUrl = ''; const el = id => document.getElementById(id);
const status = text => { el('status').textContent = text; };
function logout() { token = ''; if(previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = ''; el('login').hidden = false; el('workspace').hidden = true; el('reviewWorkspace').hidden = true; for(const id of ['materials','answer','artifacts','simulationResult','reviewResult','reviewArtifacts']) el(id).textContent = ''; el('prompt').value = ''; el('simulationId').value = ''; el('reviewUserId').value = ''; el('preview').hidden = true; }
async function api(path, body, blob) {
  const response = await fetch(path, {method:body ? 'POST':'GET',cache:'no-store',headers:{'Content-Type':'application/json',...(token ? {Authorization:'Bearer '+token}:{})},...(body ? {body:JSON.stringify(body)}:{})});
  if(!response.ok) { if(response.status === 401) logout(); throw new Error('Request denied or unavailable.'); }
  return blob ? response.blob() : response.json();
}
async function refresh() {
  const data = await api('/api/evaluation'); el('budget').textContent = 'Generation calls remaining: '+data.remaining;
  el('materials').textContent = (Array.isArray(data.materials) ? data.materials.filter(m=>m && typeof m.title==='string' && typeof m.text==='string') : []).map(m => m.title+'\\n'+m.text).join('\\n\\n'); el('artifacts').textContent = '';
  for(const item of (Array.isArray(data.artifacts) ? data.artifacts.filter(a=>a && typeof a.artifactId==='string' && typeof a.mime==='string') : [])) { const button = document.createElement('button'); button.textContent = 'Download '+item.artifactId; button.onclick = async () => {try{const blob = await api('/api/evaluation/artifacts/'+encodeURIComponent(item.artifactId),null,true);const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=item.artifactId+(item.mime==='image/jpeg'?'.jpg':item.mime==='text/plain'?'.txt':'.bin');link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){status(e.message);}};el('artifacts').append(button,document.createElement('br')); }
}
el('login').onsubmit = async event => { event.preventDefault(); const password=el('password').value; el('password').value=''; try{const data=await api('/api/auth/login',{email:el('email').value,password});token=data.token;if(typeof data.user?.userId!=='string')throw new Error('Request denied or unavailable.');if(data.user.userId.startsWith('eval_')){await refresh();el('workspace').hidden=false;}else{el('reviewWorkspace').hidden=false;}el('login').hidden=true;status('Signed in.');}catch(e){logout();status(e.message);} };
async function generate(action) { el('analyze').disabled=el('creative').disabled=true; status('Emma is working…');try{const data=await api('/api/evaluation',{action,prompt:el('prompt').value});el('answer').textContent=data.text || '';if(data.mime!=='image/jpeg'){if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl='';el('preview').removeAttribute('src');el('preview').hidden=true;}if(data.mime==='image/jpeg'){const blob=await api('/api/evaluation/artifacts/'+encodeURIComponent(data.artifactId),null,true);if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=URL.createObjectURL(blob);el('preview').src=previewUrl;el('preview').hidden=false;}await refresh();status('Artifact saved.');}catch(e){status(e.message);}finally{el('analyze').disabled=el('creative').disabled=false;}}
el('analyze').onclick=()=>generate('analyze');el('creative').onclick=()=>generate('generate_creative');el('logout').onclick=logout;
el('simulate').onclick=async()=>{el('simulate').disabled=true;try{
  const operation=el('simulationOperation').value;const command={operation};
  if(operation==='query'){command.kind=el('simulationKind').value;command.source=el('simulationSource').value;}
  if(operation==='inspect'){command.source=el('simulationSource').value;}
  if(['inspect','update','publish','pause','activate'].includes(operation))command.id=el('simulationId').value;
  if(operation==='create')command.kind=el('simulationKind').value;
  if(['create','update'].includes(operation))command.fields=JSON.parse(el('simulationFields').value);
  const data=await api('/api/evaluation',{action:'simulate',command});el('simulationResult').textContent=JSON.stringify(data,null,2);await refresh();status(data.disclosure);
}catch(e){status(e.message);}finally{el('simulate').disabled=false;}};
el('reviewLogout').onclick=logout;
el('review').onclick=async()=>{try{
  const base='/api/admin/evaluations/'+encodeURIComponent(el('reviewUserId').value);
  const data=await api(base);el('reviewResult').textContent=JSON.stringify(data,null,2);el('reviewArtifacts').textContent='';
  for(const item of (Array.isArray(data.artifacts)?data.artifacts.filter(a=>a && typeof a.artifactId==='string'):[])){
    const button=document.createElement('button');button.textContent='Download '+item.artifactId;button.onclick=async()=>{try{const blob=await api(base+'/artifacts/'+encodeURIComponent(item.artifactId),null,true);const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=item.artifactId;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){status(e.message);}};el('reviewArtifacts').append(button);
  }
}catch(e){status(e.message);}};
el('upload').onchange=async()=>{try{const file=el('upload').files[0];if(!file)return;if(file.size>240000)throw new Error('Artifact exceeds 240 KB.');const bytes=new Uint8Array(await file.arrayBuffer());let raw='';for(const byte of bytes)raw+=String.fromCharCode(byte);await api('/api/evaluation',{action:'upload_artifact',base64:btoa(raw)});await refresh();status('Artifact uploaded.');}catch(e){status(e.message);}finally{el('upload').value='';}};
</script></html>`);
});
