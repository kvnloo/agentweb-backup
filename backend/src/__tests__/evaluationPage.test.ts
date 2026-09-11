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
