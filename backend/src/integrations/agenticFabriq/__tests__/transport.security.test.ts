import { AgenticFabriqClient } from '../client';
import { AgenticFabriqMcpBridge, resolveMcpExternalUrl } from '../mcpBridge';
import * as config from '../config';
jest.mock('dns/promises', () => ({ lookup: jest.fn(async () => [{ address: '93.184.216.34', family: 4 }]) }));
const origin = 'https://api.example.com';
beforeEach(() => {
  process.env.AGENTIC_FABRIQ_API_BASE_URL = origin;
  delete process.env.AGENTIC_FABRIQ_MCP_ALLOWED_ORIGINS;
  jest.spyOn(config, 'getAgenticFabriqApiBaseUrl').mockReturnValue(origin);
  jest.spyOn(config, 'getAgenticFabriqAppCredentials').mockResolvedValue({ appId: 'app', appSecret: 'secret' });
  jest.spyOn(config, 'getAgenticFabriqPrivateKeyPem').mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());
it.each(['http://api.example.com/mcp/external','https://evil.example/mcp/external',
  'https://api.example.com.evil.example/mcp/external','https://user:pass@api.example.com/mcp/external',
  'https://api.example.com:8443/mcp/external','https://127.0.0.1/mcp/external',
  'https://169.254.169.254/mcp/external','https://[::1]/mcp/external',
  'https://api.example.com/mcp/external#private','https://api.example.com/mcp/external?secret=x'])('rejects hostile endpoint %s', url => {
  expect(() => resolveMcpExternalUrl(origin, url)).toThrow();
});
it('accepts the exact configured origin', () => expect(resolveMcpExternalUrl(origin, `${origin}/mcp/external`)).toBe(`${origin}/mcp/external`));
it('rejects direct bridge bearer exfiltration before fetch', async () => {
  const fetcher = jest.fn();
  await expect(new AgenticFabriqMcpBridge(fetcher).listTools('https://evil.example/mcp/external', 'secret')).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(['rest','mcp'])('%s rejects redirects without forwarding credentials', async kind => {
  const fetcher = jest.fn(async (_url: any, _init: any) => new Response('', { status: 302, headers: { location: 'https://evil.example' } }));
  const operation = kind === 'rest' ? new AgenticFabriqClient({fetchImpl: fetcher}).listConnections('app','private-user') : new AgenticFabriqMcpBridge(fetcher).listTools(`${origin}/mcp/external`, 'secret');
  await expect(operation).rejects.toThrow();
  expect(fetcher.mock.calls[0][1]).toMatchObject({redirect:'error'});
});
it.each(['rest','mcp'])('%s caps chunks before buffering the whole stream', async kind => {
  let pulls = 0; const cancel = jest.fn();
  const fetcher = jest.fn(async () => new Response(new ReadableStream({pull(c) { pulls++; c.enqueue(new Uint8Array(100)); if (pulls === 10) c.close(); }, cancel})));
  const operation = kind === 'rest' ? new AgenticFabriqClient({fetchImpl: fetcher, maxResponseBytes: 120}).listConnections('app','private-user') : new AgenticFabriqMcpBridge(fetcher,100,120).listTools(`${origin}/mcp/external`, 'secret');
  await expect(operation).rejects.toMatchObject({name:'AgenticFabriqResponseTooLargeError'});
  expect(pulls).toBeLessThan(5); expect(cancel).toHaveBeenCalled();
});
it.each(['rest','mcp'])('%s deadline includes stalled body reads', async kind => {
  const cancel = jest.fn();
  const fetcher = jest.fn(async () => new Response(new ReadableStream({start(c) { c.enqueue(new TextEncoder().encode('{}')); const timer = setTimeout(() => { try { c.close(); } catch {} }, 100); timer.unref(); }, cancel})));
  const operation = kind === 'rest' ? new AgenticFabriqClient({fetchImpl: fetcher,timeoutMs: 10}).listConnections('app','private-user') : new AgenticFabriqMcpBridge(fetcher,10).listTools(`${origin}/mcp/external`, 'secret');
  await expect(operation).rejects.toMatchObject({name:'AgenticFabriqTimeoutError'}); expect(cancel).toHaveBeenCalled();
});
it.each([null, 'bad', {connections:[null]}, {connections:[{tool:1,connection_id:'x',status:'connected'}]}])('rejects malformed connections %j', async body => {
  await expect(new AgenticFabriqClient({fetchImpl: async () => Response.json(body)}).listConnections('app','private-user')).rejects.toThrow();
});
it.each([{access_token:1,expires_in:900},{access_token:'secret',expires_in:Infinity},{access_token:'secret',expires_in:901},{access_token:'secret',expires_in:'900'}])('rejects malformed tokens %j', async body => {
  await expect(new AgenticFabriqClient({fetchImpl: async () => Response.json(body)}).mintUserToken('app','private-user')).rejects.toThrow();
});
it.each([{jsonrpc:'1.0',id:'wrong',result:{tools:[]}}, {jsonrpc:'2.0',id:'wrong',result:{tools:[]}}, {jsonrpc:'2.0',result:{tools:[]}}])('rejects malformed RPC envelope', async body => {
  await expect(new AgenticFabriqMcpBridge(async () => Response.json(body)).listTools(`${origin}/mcp/external`,'secret')).rejects.toThrow();
});
it('redacts transport errors and concrete request identifiers', async () => {
  const fetcher = async () => { throw new Error('private-user private-account https://host/concrete/path secret'); };
  await expect(new AgenticFabriqClient({fetchImpl:fetcher}).listConnections('app','private-user')).rejects.not.toThrow(/private-user|private-account|concrete|secret/);
});
it.each(['127.0.0.1','10.0.0.1','169.254.169.254','::1','fc00::1','fe80::1','::ffff:7f00:1'])('rejects allowlisted host resolving to %s before fetch', async address => {
  const {lookup} = jest.requireMock('dns/promises');
  lookup.mockResolvedValueOnce([{address, family:address.includes(':') ? 6 : 4}]);
  const fetcher = jest.fn();
  await expect(new AgenticFabriqMcpBridge(fetcher).listTools(`${origin}/mcp/external`, 'secret')).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it('passes a DNS-pinned dispatcher for the validated public address', async () => {
  const fetcher = jest.fn(async (_url:any, init:any) => {
    expect(init.dispatcher).toBeDefined();
    return Response.json({jsonrpc:'2.0',id:JSON.parse(init.body).id,result:{tools:[]}});
  });
  await expect(new AgenticFabriqMcpBridge(fetcher).listTools(`${origin}/mcp/external`,'secret')).resolves.toEqual([]);
});
it.each([null,[],{gmail:null},{gmail:{oauth:'yes'}}])('rejects malformed capabilities %j', async body => {
  await expect(new AgenticFabriqClient({fetchImpl:async () => Response.json(body)}).getProviderCapabilities('app')).rejects.toThrow();
});
it.each([null,{}, {oauth_url:'http://evil.example',state:'a'.repeat(64),connection_id:'bound'},
  {oauth_url:'https://vendor.example/consent',state:'other',connection_id:'bound'},
  {oauth_url:'https://vendor.example/consent',state:'a'.repeat(64),connection_id:'other'}])('rejects malformed OAuth response', async body => {
  await expect(new AgenticFabriqClient({fetchImpl:async () => Response.json(body)}).initiateOAuth('app','user','gmail',{connectionId:'bound',state:'a'.repeat(64)})).rejects.toThrow();
});
it.each([null,{}, {connect_url:'https://vendor.example',connection_id:'bound',expires_in:'900'},
  {connect_url:'https://vendor.example',connection_id:'other',expires_in:900}])('rejects malformed credentials response', async body => {
  await expect(new AgenticFabriqClient({fetchImpl:async () => Response.json(body)}).initiateCredentials('app','user','gmail',{connectionId:'bound'})).rejects.toThrow();
});
it.each([{}, {tools:null}, {tools:[null]}, {tools:[{name:'tool'}]}, {tools:[{name:'tool',inputSchema:[]}]},
  {tools:[{name:'tool',inputSchema:{type:'object'},description:32}]}, {tools:[],nextCursor:'more'},
  {tools:[{name:'tool',inputSchema:{type:'object'}},{name:'tool',inputSchema:{type:'object'}}]}])('rejects malformed MCP descriptors', async result => {
  const fetcher = async (_url:any, init:any) => Response.json({jsonrpc:'2.0',id:JSON.parse(init.body).id,result});
  await expect(new AgenticFabriqMcpBridge(fetcher).listTools(`${origin}/mcp/external`,'secret')).rejects.toThrow();
});
it.each([{}, {content:[null]}, {content:[{type:'text',text:42}]}, {content:[],isError:'false'}, {content:[],isError:true}])('rejects malformed MCP call results', async result => {
  const fetcher = async (_url:any, init:any) => Response.json({jsonrpc:'2.0',id:JSON.parse(init.body).id,result});
  await expect(new AgenticFabriqMcpBridge(fetcher).callTool(`${origin}/mcp/external`,'secret','read',{})).rejects.toThrow();
});
it('rejects JSON with invalid UTF-8 rather than accepting replacement characters', async () => {
  const bytes = new Uint8Array([123,34,120,34,58,34,255,34,125]);
  await expect(new AgenticFabriqClient({fetchImpl:async () => new Response(bytes)}).ensureExternalUser('app','user')).rejects.toThrow();
});
it('redacts app-header acquisition failures', async () => {
  jest.spyOn(config, 'getAgenticFabriqAppCredentials').mockRejectedValue(new Error('private-user concrete/path secret'));
  await expect(new AgenticFabriqClient({fetchImpl:jest.fn()}).listConnections('app','user')).rejects.not.toThrow(/private-user|concrete|secret/);
});
it.each(['rest','mcp'])('%s rejects noncanonical mapped IPv6 from DNS', async kind => {
  const {lookup} = jest.requireMock('dns/promises');
  lookup.mockResolvedValueOnce([{address:'0:0:0:0:0:ffff:7f00:1',family:6}]);
  const fetcher = jest.fn(async (_url:any, init:any) => Response.json(kind === 'rest' ? {connections:[]} : {jsonrpc:'2.0',id:JSON.parse(init.body).id,result:{tools:[]}}));
  const operation = kind === 'rest' ? new AgenticFabriqClient({fetchImpl:fetcher}).listConnections('app','user') : new AgenticFabriqMcpBridge(fetcher).listTools(`${origin}/mcp/external`,'secret');
  await expect(operation).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
});
it.each([[], 'ok', 1, {error:'failed'}])('rejects malformed mutation acknowledgments %j', async body => {
  const client = new AgenticFabriqClient({fetchImpl:async () => Response.json(body)});
  await expect(client.ensureExternalUser('app','user')).rejects.toThrow();
  await expect(client.deleteConnection('app','user','bound','gmail')).rejects.toThrow();
});
it('refuses OAuth initiation without our generated state before a vendor call', async () => {
  const fetcher = jest.fn(async () => Response.json({oauth_url:'https://vendor.example',state:'vendor-state',connection_id:'default'}));
  await expect(new AgenticFabriqClient({fetchImpl:fetcher}).initiateOAuth('app','user','gmail')).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it('rejects literal JSON null as a mutation acknowledgment while accepting HTTP 204', async () => {
  await expect(new AgenticFabriqClient({fetchImpl:async () => Response.json(null)}).ensureExternalUser('app','user')).rejects.toThrow();
  await expect(new AgenticFabriqClient({fetchImpl:async () => new Response(null,{status:204})}).ensureExternalUser('app','user')).resolves.toBeUndefined();
});
it.each(['💥', 'secret"token', 'secret:token'])('rejects non-bearer token syntax %s', async access_token => {
  await expect(new AgenticFabriqClient({fetchImpl:async () => Response.json({access_token,expires_in:900})}).mintUserToken('app','user')).rejects.toThrow();
});
it.each([{type:'object',properties:null}, {type:'object',properties:{query:42}}, {type:'object',required:'query'},
  {type:'object',required:['missing']}, {type:'object',additionalProperties:'yes'}])('rejects malformed descriptor schema', async inputSchema => {
  const fetcher = async (_url:any, init:any) => Response.json({jsonrpc:'2.0',id:JSON.parse(init.body).id,result:{tools:[{name:'read',inputSchema}]}});
  await expect(new AgenticFabriqMcpBridge(fetcher).listTools(`${origin}/mcp/external`,'secret')).rejects.toThrow();
});
