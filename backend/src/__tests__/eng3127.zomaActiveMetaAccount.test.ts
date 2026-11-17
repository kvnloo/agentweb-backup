/**
 * ENG-3127: several usable Meta ad accounts and no account_id -> run against the one that is
 * actually spending; tie / no spend still refuses, naming every account.
 */
import { resolveMetaToolkitAdAccount, __resetActiveMetaAccountCache } from '../mcp/metaToolkitGateway';

const acct = (id: string, name: string) =>
  ({ platform: 'meta', account_id: id, account_name: name, account_type: 'ad_account', config: { ad_account_id: id, access_token: 't', account_type: 'ad_account' } }) as any;

const accounts = [acct('462458168257715', 'Flatfee Ad Account'), acct('1304228911295568', 'Flatfee'), acct('855894574281337', 'Gloco.ai')];

function deps(spend: Record<string, number>) {
  return { listAccounts: async () => accounts, now: () => 1_000, accountSpend: jest.fn(async (_a: any, id: string) => spend[id] ?? 0) } as any;
}

beforeEach(() => __resetActiveMetaAccountCache());

test('picks the only account with spend', async () => {
  const d = deps({ '462458168257715': 251.14 });
  await expect(resolveMetaToolkitAdAccount('u1', undefined, d)).resolves.toBe('462458168257715');
});

test('picks the highest spender', async () => {
  const d = deps({ '462458168257715': 251.14, '855894574281337': 10 });
  await expect(resolveMetaToolkitAdAccount('u1', undefined, d)).resolves.toBe('462458168257715');
});

test('no spend anywhere refuses and lists accounts', async () => {
  await expect(resolveMetaToolkitAdAccount('u1', undefined, deps({}))).rejects.toThrow(/Flatfee Ad Account \(462458168257715\).*Gloco\.ai \(855894574281337\)/);
});

test('tie refuses', async () => {
  const d = deps({ '462458168257715': 5, '855894574281337': 5 });
  await expect(resolveMetaToolkitAdAccount('u1', undefined, d)).rejects.toThrow(/pass account_id/);
});

test('explicit account_id is honoured without probing spend', async () => {
  const d = deps({ '462458168257715': 251.14 });
  await expect(resolveMetaToolkitAdAccount('u1', '855894574281337', d)).resolves.toBe('855894574281337');
  expect(d.accountSpend).not.toHaveBeenCalled();
});

test('spend probe errors are treated as zero', async () => {
  const d = { listAccounts: async () => accounts, now: () => 1_000, accountSpend: async (_a: any, id: string) => { if (id === '1304228911295568') throw new Error('x'); return id === '462458168257715' ? 3 : 0; } } as any;
  await expect(resolveMetaToolkitAdAccount('u1', undefined, d)).resolves.toBe('462458168257715');
});

test('result is cached per user', async () => {
  const d = deps({ '462458168257715': 1 });
  await resolveMetaToolkitAdAccount('u1', undefined, d);
  await resolveMetaToolkitAdAccount('u1', undefined, d);
  expect(d.accountSpend).toHaveBeenCalledTimes(3);
});
