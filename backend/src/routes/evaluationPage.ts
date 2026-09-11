import { Router } from 'express';
import { randomBytes } from 'crypto';

export const evaluationPage = Router();
evaluationPage.get('/', (_req, res) => {
  const nonce = randomBytes(16).toString('base64');
  res.set({ 'Cache-Control': 'no-store', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` }).type('html').send(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Emma evaluation workspace</title>
<style nonce="${nonce}">body{font:16px system-ui;max-width:850px;margin:40px auto;padding:0 20px;color:#18252e}input,textarea,button{font:inherit;padding:10px;margin:8px 0}textarea{box-sizing:border-box;width:100%;min-height:150px}button{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere}label{display:block}img{max-width:100%}[hidden]{display:none}</style>
<h1>Emma evaluation workspace</h1><p>Strategy, analysis, and creative generation using your approved case material. Artifacts remain in this evaluation.</p>
<form id="login"><label>Email <input id="email" type="email" autocomplete="username" required></label><label>Password <input id="password" type="password" autocomplete="current-password" required></label><button>Sign in</button></form>
<p id="status" role="status" aria-live="polite"></p>
<main id="workspace" hidden><button id="logout">Sign out</button><p id="budget"></p><details><summary>Approved case material</summary><pre id="materials"></pre></details>
<label for="prompt">Ask Emma</label><textarea id="prompt" maxlength="8000" placeholder="Analyze the case and propose an ad strategy"></textarea><button id="analyze">Analyze / strategize</button> <button id="creative">Generate creative</button>
<pre id="answer"></pre><img id="preview" alt="Generated evaluation creative" hidden>
<label>Upload an artifact (up to 240 KB)<input id="upload" type="file"></label><h2>Evaluation artifacts</h2><div id="artifacts"></div></main>
<script nonce="${nonce}">
let token = ''; let previewUrl = ''; const el = id => document.getElementById(id);
const status = text => { el('status').textContent = text; };
function logout() { token = ''; if(previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = ''; el('login').hidden = false; el('workspace').hidden = true; for(const id of ['materials','answer','artifacts']) el(id).textContent = ''; el('prompt').value = ''; el('preview').hidden = true; }
async function api(path, body, blob) {
  const response = await fetch(path, {method:body ? 'POST':'GET',cache:'no-store',headers:{'Content-Type':'application/json',...(token ? {Authorization:'Bearer '+token}:{})},...(body ? {body:JSON.stringify(body)}:{})});
  if(!response.ok) { if(response.status === 401) logout(); throw new Error('Request denied or unavailable.'); }
  return blob ? response.blob() : response.json();
}
async function refresh() {
  const data = await api('/api/evaluation'); el('budget').textContent = 'Generation calls remaining: '+data.remaining;
  el('materials').textContent = data.materials.map(m => m.title+'\\n'+m.text).join('\\n\\n'); el('artifacts').textContent = '';
  for(const item of data.artifacts || []) { const button = document.createElement('button'); button.textContent = 'Download '+item.artifactId; button.onclick = async () => {try{const blob = await api('/api/evaluation/artifacts/'+encodeURIComponent(item.artifactId),null,true);const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=item.artifactId+(item.mime==='image/jpeg'?'.jpg':item.mime==='text/plain'?'.txt':'.bin');link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){status(e.message);}};el('artifacts').append(button,document.createElement('br')); }
}
el('login').onsubmit = async event => { event.preventDefault(); const password=el('password').value; el('password').value=''; try{const data=await api('/api/auth/login',{email:el('email').value,password});token=data.token;await refresh();el('login').hidden=true;el('workspace').hidden=false;status('Signed in.');}catch(e){logout();status(e.message);} };
async function generate(action) { el('analyze').disabled=el('creative').disabled=true; status('Emma is working…');try{const data=await api('/api/evaluation',{action,prompt:el('prompt').value});el('answer').textContent=data.text || '';if(data.mime!=='image/jpeg'){if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl='';el('preview').removeAttribute('src');el('preview').hidden=true;}if(data.mime==='image/jpeg'){const blob=await api('/api/evaluation/artifacts/'+encodeURIComponent(data.artifactId),null,true);if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=URL.createObjectURL(blob);el('preview').src=previewUrl;el('preview').hidden=false;}await refresh();status('Artifact saved.');}catch(e){status(e.message);}finally{el('analyze').disabled=el('creative').disabled=false;}}
el('analyze').onclick=()=>generate('analyze');el('creative').onclick=()=>generate('generate_creative');el('logout').onclick=logout;
el('upload').onchange=async()=>{try{const file=el('upload').files[0];if(!file)return;if(file.size>240000)throw new Error('Artifact exceeds 240 KB.');const bytes=new Uint8Array(await file.arrayBuffer());let raw='';for(const byte of bytes)raw+=String.fromCharCode(byte);await api('/api/evaluation',{action:'upload_artifact',base64:btoa(raw)});await refresh();status('Artifact uploaded.');}catch(e){status(e.message);}finally{el('upload').value='';}};
</script></html>`);
});
