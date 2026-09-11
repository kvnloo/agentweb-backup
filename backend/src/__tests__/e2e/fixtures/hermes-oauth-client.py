"""Read-only installed Hermes imports; only the supplied loopback fixture receives requests."""
import asyncio
import io
import logging
import sys
from contextlib import redirect_stderr
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
import httpx2 as httpx
from mcp.client.auth.oauth2 import OAuthClientProvider
from tools import mcp_oauth as native
from tools.mcp_oauth_provider import HermesProviderMixin

logging.disable(logging.CRITICAL)  # SDK exception logs may include state; never print auth material.
base = sys.argv[1]
assert urlsplit(base).hostname == '127.0.0.1'

class Storage:
    tokens = None
    info = None
    async def get_tokens(self): return self.tokens
    async def set_tokens(self, value): self.tokens = value
    async def get_client_info(self): return self.info
    async def set_client_info(self, value): self.info = value

class Provider(HermesProviderMixin, OAuthClientProvider):
    pass

async def flow(bad_state=False, bad_pkce=False):
    storage = Storage()
    callback_url = None
    port = native._reserve_callback_port()
    async def redirect(url):
        nonlocal callback_url
        params = {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}
        assert params['code_challenge_method'] == 'S256'
        assert params['resource'] == base + '/mcp'
        async with httpx.AsyncClient() as browser:
            consent = await browser.get(url)
            assert consent.status_code == 302
            form = {k: v[0] for k, v in parse_qs(urlsplit(consent.headers['location']).query).items()}
            for key in ('client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method'):
                assert form[key] == params[key]
            form.update(approved='true')
            assert (await browser.post(base + '/oauth/authorize/decision', data=form)).status_code == 401
            form['jwt'] = 'fixture-login'
            approved = await browser.post(base + '/oauth/authorize/decision', data=form)
            assert approved.status_code == 302
            callback_url = approved.headers['location']
            assert set(parse_qs(urlsplit(callback_url).query)) == {'code', 'state'}
    async def callback():
        # No loopback HTTP request: simulate the failed browser callback, then paste
        # the exact Location through Hermes' own reader, as its CLI does on stdin.
        pasted = callback_url
        if bad_state:
            from urllib.parse import urlencode
            parts = urlsplit(pasted)
            query = {k: v[0] for k, v in parse_qs(parts.query).items()}
            query['state'] = 'other-session'
            pasted = parts._replace(query=urlencode(query)).geturl()
        with native.force_interactive_oauth(), patch.object(sys, 'stdin', io.StringIO(pasted + '\n')), redirect_stderr(io.StringIO()):
            return await native._make_callback_waiter(port, timeout=5)()
    provider = Provider(server_url=base + '/mcp', storage=storage,
        client_metadata=native._build_client_metadata({'_resolved_port': port}),
        redirect_handler=redirect, callback_handler=callback)
    original = provider._exchange_token_authorization_code
    valid_verifier = None
    async def capture(code, verifier):
        nonlocal valid_verifier
        valid_verifier = verifier
        return await original(code, 'x' * 43 if bad_pkce else verifier)
    provider._exchange_token_authorization_code = capture
    headers = {'Accept': 'application/json, text/event-stream'}
    async with httpx.AsyncClient(auth=provider, headers=headers) as client:
        response = await client.post(base + '/mcp', json={'jsonrpc': '2.0', 'id': 1,
            'method': 'initialize', 'params': {'protocolVersion': '2025-06-18',
                'capabilities': {}, 'clientInfo': {'name': 'Hermes Agent', 'version': 'fixture'}}})
        assert response.status_code == 200
        assert not bad_state and not bad_pkce
        headers['Mcp-Session-Id'] = response.headers['mcp-session-id']
        async def rpc(method, params, id):
            r = await client.post(base + '/mcp', headers=headers,
                json={'jsonrpc': '2.0', 'id': id, 'method': method, 'params': params})
            assert r.status_code == 200
            import json
            return json.loads(next(line[6:] for line in r.text.splitlines() if line.startswith('data: ')))
        assert (await rpc('tools/list', {}, 2))['result']['tools'][0]['name'] == 'fixture_identity'
        assert (await rpc('tools/call', {'name': 'fixture_identity', 'arguments': {}}, 3))['result']['content'][0]['text'] == 'fixture-user:false'
        async with httpx.AsyncClient() as raw:
            code = parse_qs(urlsplit(callback_url).query)['code'][0]
            replay = await raw.post(base + '/oauth/token', data={'grant_type': 'authorization_code',
                'code': code, 'client_id': storage.info.client_id,
                'redirect_uri': str(storage.info.redirect_uris[0]), 'code_verifier': valid_verifier})
            assert replay.status_code == 400 and replay.json()['error'] == 'invalid_grant'
        await client.delete(base + '/mcp', headers=headers)

async def main():
    # Reproduce the native headless guard independently of server behavior.
    with patch.object(sys, 'stdin', io.StringIO()):
        try: await native._make_redirect_handler(49152)(base + '/oauth/authorize')
        except native.OAuthNonInteractiveError: pass
        else: raise AssertionError('Expected native non-TTY rejection')
    await flow()
    from mcp.client.auth.exceptions import OAuthFlowError, OAuthTokenError
    for kwargs, error in [({'bad_state': True}, OAuthFlowError), ({'bad_pkce': True}, OAuthTokenError)]:
        try: await flow(**kwargs)
        except error: pass
        else: raise AssertionError('Expected security rejection')
    print('PASS: native paste, state rejection, PKCE, replay, MCP identity')

asyncio.run(main())
