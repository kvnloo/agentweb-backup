/**
 * ENG-2105 (A1): envelope encryption for customer LLM provider keys.
 *
 * Each connection gets its own data key from KMS. The provider key is encrypted
 * locally with AES-256-GCM under that data key; only the KMS-wrapped data key and the
 * ciphertext are stored. Both layers are bound to the connection: KMS by encryption
 * context, AES-GCM by additional authenticated data. A sealed secret copied onto
 * another connection's row, another owner or another provider does not decrypt.
 *
 * KMS is called as the instance role, never with the backend's static AWS keys: the
 * key policies grant the instance role only, and the SDK's default chain would pick
 * the static keys first and fail with AccessDenied.
 */

import AWS from "aws-sdk";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

export const LLM_CONNECTION_KMS_ALIAS_PROD = "alias/eng1816-customer-llm-keys";
export const LLM_CONNECTION_KMS_ALIAS_DEV = "alias/eng1816-customer-llm-keys-dev";

/**
 * Staging and production run as the same AWS role, so IAM cannot keep staging data
 * off the production key. This choice is the only thing that does: everything that
 * is not NODE_ENV=production uses the dev key.
 */
export function llmConnectionKmsAlias(nodeEnv: string | undefined = process.env.NODE_ENV): string {
  return nodeEnv === "production" ? LLM_CONNECTION_KMS_ALIAS_PROD : LLM_CONNECTION_KMS_ALIAS_DEV;
}

export interface SecretContext {
  connectionId: string;
  ownerUserId: string;
  provider: string;
  /**
   * What the sealed value is, when it is not the customer's provider key itself (e.g.
   * `openrouter_key`). Part of the context only when present, so a sealed OpenRouter key
   * can never be opened as, or swapped with, the provider key sealed for the same
   * connection. Absent for every existing ciphertext, which keeps opening unchanged.
   */
  purpose?: string;
  /** The hash of the OpenRouter key this value belongs to, binding it to that one key. */
  keyHash?: string;
}

export interface SealedSecret {
  v: 1;
  wrappedDataKey: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

export interface KmsPort {
  generateDataKey(context: SecretContext): Promise<{ plaintext: Buffer; wrapped: Buffer }>;
  decrypt(wrapped: Buffer, context: SecretContext): Promise<Buffer>;
}

function encryptionContext(context: SecretContext): Record<string, string> {
  if (!context.connectionId || !context.ownerUserId || !context.provider) {
    throw new Error("llmConnectionCrypto: incomplete secret context");
  }
  return {
    connectionId: context.connectionId,
    ownerUserId: context.ownerUserId,
    provider: context.provider,
    // Added only when present: the KMS grants require `connectionId` and tolerate extra
    // keys, and a value sealed without them must keep its original context.
    ...(context.purpose ? { purpose: context.purpose } : {}),
    ...(context.keyHash ? { keyHash: context.keyHash } : {}),
  };
}

function additionalData(context: SecretContext): Buffer {
  const ctx = encryptionContext(context);
  // The three original fields keep their exact encoding; extras are appended only when
  // present, so ciphertexts sealed before they existed still authenticate.
  const base = [ctx.connectionId, ctx.ownerUserId, ctx.provider];
  const extended = ctx.purpose || ctx.keyHash ? [...base, ctx.purpose ?? "", ctx.keyHash ?? ""] : base;
  return Buffer.from(JSON.stringify(extended), "utf8");
}

export class AwsKmsPort implements KmsPort {
  private client: AWS.KMS | null = null;

  constructor(private readonly keyAlias: string = llmConnectionKmsAlias()) {}

  private kms(): AWS.KMS {
    if (!this.client) {
      // Outside production a developer machine has no instance metadata service; this
      // opt-in lets it use its own profile against the dev key. Never honored in production.
      const useLocalProfile =
        process.env.NODE_ENV !== "production" && process.env.ENG1816_KMS_LOCAL_CREDENTIALS === "1";
      this.client = new AWS.KMS({
        region: process.env.AWS_REGION || "us-west-2",
        ...(useLocalProfile
          ? { credentials: new AWS.SharedIniFileCredentials() }
          : { credentials: new AWS.EC2MetadataCredentials({ httpOptions: { timeout: 5000 }, maxRetries: 3 }) }),
      });
    }
    return this.client;
  }

  async generateDataKey(context: SecretContext): Promise<{ plaintext: Buffer; wrapped: Buffer }> {
    const result = await this.kms()
      .generateDataKey({ KeyId: this.keyAlias, KeySpec: "AES_256", EncryptionContext: encryptionContext(context) })
      .promise();
    if (!result.Plaintext || !result.CiphertextBlob) throw new Error("llmConnectionCrypto: KMS returned no data key");
    return { plaintext: Buffer.from(result.Plaintext as Uint8Array), wrapped: Buffer.from(result.CiphertextBlob as Uint8Array) };
  }

  async decrypt(wrapped: Buffer, context: SecretContext): Promise<Buffer> {
    // No KeyId: KMS reads the key from the blob, so a row sealed before a key change still opens.
    const result = await this.kms()
      .decrypt({ CiphertextBlob: wrapped, EncryptionContext: encryptionContext(context) })
      .promise();
    if (!result.Plaintext) throw new Error("llmConnectionCrypto: KMS returned no plaintext");
    return Buffer.from(result.Plaintext as Uint8Array);
  }
}

export async function sealSecret(kms: KmsPort, secret: string, context: SecretContext): Promise<SealedSecret> {
  const { plaintext: dataKey, wrapped } = await kms.generateDataKey(context);
  try {
    if (dataKey.length !== 32) throw new Error("llmConnectionCrypto: unexpected data key length");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
    cipher.setAAD(additionalData(context));
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return {
      v: 1,
      wrappedDataKey: wrapped.toString("base64"),
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  } finally {
    dataKey.fill(0);
  }
}

export async function openSecret(kms: KmsPort, sealed: SealedSecret, context: SecretContext): Promise<string> {
  if (!sealed || sealed.v !== 1) throw new Error("llmConnectionCrypto: unsupported sealed secret");
  const dataKey = await kms.decrypt(Buffer.from(sealed.wrappedDataKey, "base64"), context);
  try {
    const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(sealed.iv, "base64"));
    decipher.setAAD(additionalData(context));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } finally {
    dataKey.fill(0);
  }
}
