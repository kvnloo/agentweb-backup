import express from 'express';
import request from 'supertest';
import { evaluationPage } from '../routes/evaluationPage';
import { execFileSync } from 'child_process';

describe('Evaluation workspace page simulator controls', () => {
  it('lets the candidate query, create, inspect, update, publish, pause, activate and reset with visible disclosure', async () => {
    const app = express(); app.use('/evaluation', evaluationPage);
    const response = await request(app).get('/evaluation');
    // Node loads jsdom's ESM dependencies; Jest's CJS transformer cannot.
    execFileSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const { JSDOM } = require(${JSON.stringify(require.resolve('jsdom'))});
      (async () => {
        const html = require('node:fs').readFileSync(0, 'utf8');
        const calls = [];
        const dom = new JSDOM(html, {runScripts:'dangerously',url:'http://localhost/evaluation',beforeParse(window) {
          window.fetch = async (path, options) => {
            const body = options.body ? JSON.parse(options.body) : undefined; calls.push({path,body});
            const result = path === '/api/auth/login' ? {token:'synthetic',user:{userId:'eval_page'}} :
              body?.action === 'simulate' ? {ok:true,disclosure:'Simulation complete — not sent to Meta',objects:[],warnings:[],errors:[]} :
              {remaining:5,materials:[],artifacts:[],simulation:{objects:[],seed:[]}};
            return {ok:true,json:async()=>result};
          };
        }});
        const document = dom.window.document;
        const settle = () => new Promise(resolve => setTimeout(resolve, 0));
        document.getElementById('email').value = 'synthetic@example.invalid';
        document.getElementById('password').value = 'synthetic-password';
        document.getElementById('login').dispatchEvent(new dom.window.Event('submit',{cancelable:true})); await settle();
        assert.equal(document.querySelector('h1').textContent,'Evaluation workspace');
        for (const operation of ['query','create','inspect','update','publish','pause','activate','reset']) {
          document.getElementById('simulationOperation').value = operation;
          document.getElementById('simulationFields').value = JSON.stringify({name:'Proposal'});
          document.getElementById('simulationId').value = 'sim_eval_page_object';
          document.getElementById('simulate').click(); await settle();
          assert.equal(calls.filter(c=>c.body?.command).at(-1)?.body.command.operation,operation);
          assert.match(document.getElementById('simulationResult').textContent,/Simulation complete — not sent to Meta/);
        }
        assert(calls.every(c=>c.path.startsWith('/api/evaluation')||c.path==='/api/auth/login'));
        dom.window.fetch = async () => ({ok:false,status:403});
        document.getElementById('simulationOperation').value='query';document.getElementById('simulate').click();await settle();
        assert.equal(document.getElementById('workspace').hidden,false);
        dom.window.close();
      })().catch(e=>{console.error(e);process.exit(1)});
    `], { input: response.text, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
  });
});

describe('Access Portal fragment bootstrap', () => {
  it('scrubs before verification, reveals only verified evaluation state, keeps tokens in memory, and clears logout races', async () => {
    const app = express(); app.use('/evaluation', evaluationPage);
    const response = await request(app).get('/evaluation');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['content-security-policy']).toContain("connect-src 'self'");
    execFileSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const { JSDOM } = require(${JSON.stringify(require.resolve('jsdom'))});
      const html = require('node:fs').readFileSync(0, 'utf8');
      const settle = () => new Promise(resolve => setTimeout(resolve, 0));
      (async () => {
        for (const mode of ['valid','invalid','revoked','non-eval','malformed','logout-race','scrub-fails']) {
          const calls=[]; let resolveVerification;
          const dom=new JSDOM(html,{runScripts:'dangerously',url:'https://api.agentweb.pro/evaluation#token=synthetic-delegate',beforeParse(window){
            if(mode==='scrub-fails') window.history.replaceState=()=>{throw new Error('unavailable');};
            window.fetch=async(path,options)=>{
              assert.equal(window.location.hash,'','fragment must be scrubbed before network');
              assert.equal(window.document.getElementById('workspace').hidden,true,'workspace must remain hidden during bootstrap');
              calls.push({path,options});
              return await new Promise(resolve=>{resolveVerification=resolve;});
            };
          }});
          const el=id=>dom.window.document.getElementById(id);
          await settle();
          if(mode==='scrub-fails'){assert.equal(calls.length,0);assert.equal(el('workspace').hidden,true);dom.window.close();continue;}
          assert.equal(dom.window.location.hash,'');
          assert.equal(calls.length,1);
          assert.equal(calls[0].path,'/api/evaluation');
          assert.equal(calls[0].options.headers.Authorization,'Bearer synthetic-delegate');
          assert.equal(calls[0].options.cache,'no-store');
          assert.equal(calls[0].options.referrerPolicy,'no-referrer');
          if(mode==='logout-race')el('logout').click();
          resolveVerification({ok:!['invalid','revoked'].includes(mode),status:mode==='revoked'?403:401,json:async()=> mode==='malformed'?null:{userId:mode==='non-eval'?'customer':'eval_test',status:'active',remaining:5,materials:[],artifacts:[]}});
          await settle();
          assert.equal(el('workspace').hidden,mode!=='valid');
          assert.equal(el('reviewWorkspace').hidden,true);
          assert.equal(dom.window.localStorage.length,0);assert.equal(dom.window.sessionStorage.length,0);assert.equal(dom.window.document.cookie,'');
          const followups=[];
          dom.window.fetch=async(path,options)=>{followups.push({path,options});return {ok:false,status:401};};
          if(mode==='valid'){dom.window.location.hash='token=another';el('logout').click();}
          el('simulate').click();await settle();
          assert.equal(followups[0]?.options.headers.Authorization,undefined,'logout or failed bootstrap must discard token');
          assert.equal(dom.window.location.hash,'');
          assert.equal(el('workspace').hidden,true);
          dom.window.close();
        }
      })().catch(e=>{console.error(e);process.exit(1)});
    `], { input: response.text, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
  });
});
