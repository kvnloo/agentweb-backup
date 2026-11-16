import { randomBytes } from 'crypto';
import { InMemoryDynamo } from '../../../__tests__/helpers/inMemoryDynamo';
import type { KmsPort, SecretContext } from '../llmConnectionCrypto';
import { LLM_CONNECTIONS_OWNER_INDEX, LLM_CONNECTIONS_ORG_INDEX, LLM_CONNECTIONS_PROVIDER_INDEX, LLM_CONNECTIONS_TABLE, LlmConnectionDb } from '../llmConnectionDb';

/** Behaves like KMS for the properties that matter: opaque wrapped keys, bound to their encryption context. */
export class FakeKms implements KmsPort {
  private readonly keys = new Map<string, { key: Buffer; context: string }>();
  generateCalls: SecretContext[] = [];
  decryptCalls: SecretContext[] = [];
  /** When true, decrypt ignores the context, to prove the AES layer binds it too. */
  ignoreContext = false;

  async generateDataKey(context: SecretContext) {
    this.generateCalls.push({ ...context });
    const key = randomBytes(32);
    const handle = randomBytes(16);
    this.keys.set(handle.toString('hex'), { key: Buffer.from(key), context: JSON.stringify(context) });
    return { plaintext: key, wrapped: handle };
  }

  async decrypt(wrapped: Buffer, context: SecretContext) {
    this.decryptCalls.push({ ...context });
    const entry = this.keys.get(wrapped.toString('hex'));
    if (!entry || (!this.ignoreContext && entry.context !== JSON.stringify(context))) {
      throw Object.assign(new Error('InvalidCiphertextException'), { code: 'InvalidCiphertextException' });
    }
    return Buffer.from(entry.key);
  }
}

export function makeDb() {
  const dynamo = new InMemoryDynamo({
    [LLM_CONNECTIONS_TABLE]: {
      hash: 'connectionId',
      indexes: {
        [LLM_CONNECTIONS_OWNER_INDEX]: { hash: 'ownerUserId', range: 'createdAt' },
        [LLM_CONNECTIONS_ORG_INDEX]: { hash: 'orgId', range: 'createdAt' },
        [LLM_CONNECTIONS_PROVIDER_INDEX]: { hash: 'provider', range: 'createdAt' },
      },
    },
  });
  const Client = dynamo.documentClient;
  // listByOwner/listSharedWithOrg/listByProvider all query a GSI, so a slot-counter row
  // (which carries none of those indexes' key attributes) is naturally excluded --
  // `rows()` goes straight at the table and would otherwise show it as a phantom row.
  return {
    dynamo,
    db: new LlmConnectionDb(new Client() as any),
    rows: () => dynamo.items(LLM_CONNECTIONS_TABLE).filter((r) => r.connectionId !== undefined && !r.connectionId.startsWith('limit#')),
  };
}
