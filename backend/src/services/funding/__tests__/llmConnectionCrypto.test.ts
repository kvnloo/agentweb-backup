/**
 * ENG-2105 (A1): envelope encryption for customer provider keys.
 */
const kmsCalls: Array<{ op: string; params: any }> = [];
const kmsConstructed: any[] = [];
jest.mock('aws-sdk', () => {
  class EC2MetadataCredentials {
    readonly kind = 'instance-metadata';
    constructor(public opts: unknown) {}
  }
  class SharedIniFileCredentials {
    readonly kind = 'shared-profile';
  }
  class KMS {
    constructor(opts: unknown) {
      kmsConstructed.push(opts);
    }
    generateDataKey(params: any) {
      kmsCalls.push({ op: 'generateDataKey', params });
      return { promise: async () => ({ Plaintext: Buffer.alloc(32, 7), CiphertextBlob: Buffer.from('wrapped') }) };
    }
    decrypt(params: any) {
      kmsCalls.push({ op: 'decrypt', params });
      return { promise: async () => ({ Plaintext: Buffer.alloc(32, 7) }) };
    }
  }
  return { __esModule: true, default: { KMS, EC2MetadataCredentials, SharedIniFileCredentials } };
});

import {
  AwsKmsPort,
  LLM_CONNECTION_KMS_ALIAS_DEV,
  LLM_CONNECTION_KMS_ALIAS_PROD,
  llmConnectionKmsAlias,
  openSecret,
  sealSecret,
} from '../llmConnectionCrypto';
import { FakeKms } from './llmConnectionTestKit';

const CTX = { connectionId: 'conn-1', ownerUserId: 'user-1', provider: 'anthropic' };
const SECRET = 'sk-ant-api03-THIS-IS-THE-CUSTOMER-KEY-0123456789';

describe('llmConnectionCrypto', () => {
  const env = { ...process.env };
  beforeEach(() => {
    kmsCalls.length = 0;
    kmsConstructed.length = 0;
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it('seals and opens a secret, and stores nothing readable', async () => {
    const kms = new FakeKms();
    const sealed = await sealSecret(kms, SECRET, CTX);
    expect(JSON.stringify(sealed)).not.toContain(SECRET);
    expect(Buffer.from(sealed.ciphertext, 'base64').toString('utf8')).not.toContain('sk-ant');
    expect(await openSecret(kms, sealed, CTX)).toBe(SECRET);
  });

  it('uses a fresh data key and nonce for every seal', async () => {
    const kms = new FakeKms();
    const a = await sealSecret(kms, SECRET, CTX);
    const b = await sealSecret(kms, SECRET, CTX);
    expect(a.wrappedDataKey).not.toBe(b.wrappedDataKey);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('passes connection, owner and provider to KMS as the encryption context', async () => {
    const kms = new FakeKms();
    const sealed = await sealSecret(kms, SECRET, CTX);
    await openSecret(kms, sealed, CTX);
    expect(kms.generateCalls).toEqual([CTX]);
    expect(kms.decryptCalls).toEqual([CTX]);
  });

  it.each([
    ['another connection', { ...CTX, connectionId: 'conn-2' }],
    ['another owner', { ...CTX, ownerUserId: 'user-2' }],
    ['another provider', { ...CTX, provider: 'openai' }],
  ])('does not open under %s', async (_label, other) => {
    const kms = new FakeKms();
    const sealed = await sealSecret(kms, SECRET, CTX);
    await expect(openSecret(kms, sealed, other)).rejects.toThrow();
  });

  it('binds the context in the AES layer too, so it holds even if KMS did not check it', async () => {
    const kms = new FakeKms();
    const sealed = await sealSecret(kms, SECRET, CTX);
    kms.ignoreContext = true;
    await expect(openSecret(kms, sealed, { ...CTX, connectionId: 'conn-2' })).rejects.toThrow();
    expect(await openSecret(kms, sealed, CTX)).toBe(SECRET);
  });

  it('rejects a tampered ciphertext or tag', async () => {
    const kms = new FakeKms();
    const sealed = await sealSecret(kms, SECRET, CTX);
    const flipped = Buffer.from(sealed.ciphertext, 'base64');
    flipped[0] ^= 1;
    await expect(openSecret(kms, { ...sealed, ciphertext: flipped.toString('base64') }, CTX)).rejects.toThrow();
    const tag = Buffer.from(sealed.tag, 'base64');
    tag[0] ^= 1;
    await expect(openSecret(kms, { ...sealed, tag: tag.toString('base64') }, CTX)).rejects.toThrow();
  });

  it('refuses an incomplete context', async () => {
    await expect(sealSecret(new FakeKms(), SECRET, { ...CTX, ownerUserId: '' })).rejects.toThrow(/incomplete/);
  });

  it('uses the production key only when NODE_ENV is production', () => {
    expect(llmConnectionKmsAlias('production')).toBe(LLM_CONNECTION_KMS_ALIAS_PROD);
    for (const other of ['development', 'staging', 'test', '', undefined]) {
      expect(llmConnectionKmsAlias(other)).toBe(LLM_CONNECTION_KMS_ALIAS_DEV);
    }
  });

  it('calls KMS with instance-role credentials, never the static keys in the environment', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIASTATICKEY';
    process.env.AWS_SECRET_ACCESS_KEY = 'static-secret';
    process.env.NODE_ENV = 'production';
    process.env.ENG1816_KMS_LOCAL_CREDENTIALS = '1'; // must be ignored in production
    const port = new AwsKmsPort('alias/some-key');
    await port.generateDataKey(CTX);

    expect(kmsConstructed).toHaveLength(1);
    expect(kmsConstructed[0].credentials.kind).toBe('instance-metadata');
    expect(JSON.stringify(kmsConstructed[0])).not.toContain('AKIASTATICKEY');
    expect(kmsCalls[0]).toEqual({
      op: 'generateDataKey',
      params: { KeyId: 'alias/some-key', KeySpec: 'AES_256', EncryptionContext: CTX },
    });
  });

  it('lets a developer machine use its own profile, outside production only', async () => {
    process.env.NODE_ENV = 'development';
    process.env.ENG1816_KMS_LOCAL_CREDENTIALS = '1';
    await new AwsKmsPort().generateDataKey(CTX);
    expect(kmsConstructed[0].credentials.kind).toBe('shared-profile');
    expect(kmsCalls[0].params.KeyId).toBe(LLM_CONNECTION_KMS_ALIAS_DEV);
  });

  it('decrypts with the same context and without naming a key', async () => {
    await new AwsKmsPort('alias/some-key').decrypt(Buffer.from('wrapped'), CTX);
    expect(kmsCalls[0].op).toBe('decrypt');
    expect(kmsCalls[0].params.EncryptionContext).toEqual(CTX);
    expect(kmsCalls[0].params.KeyId).toBeUndefined();
  });
});
