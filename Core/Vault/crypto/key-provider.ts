/**
 * Supplies AES-256 key material for the Vault's envelope encryption. Abstracted
 * so the local (env-based) key can later be swapped for Cloud KMS without
 * touching the encryption code or the DB schema (the envelope carries a keyId).
 */
export interface KeyProvider {
  /** Id of the key that new ciphertext should be encrypted with. */
  getCurrentKeyId(): Promise<string>;
  /** 32-byte AES-256 key for a given keyId (current or a historical/previous key). */
  getKey(keyId: string): Promise<Buffer>;
}

const AES_256_KEY_BYTES = 32;

/**
 * Loads keys from process configuration. The current key encrypts new data; any
 * additional keys (e.g. a previous key during rotation) can still decrypt older
 * ciphertext by their keyId.
 */
export class LocalKeyProvider implements KeyProvider {
  private readonly currentKeyId: string;
  private readonly keys: Map<string, Buffer>;

  constructor(config: { currentKeyId: string; keys: Record<string, Buffer> }) {
    this.currentKeyId = config.currentKeyId;
    this.keys = new Map(Object.entries(config.keys));

    for (const [id, key] of this.keys) {
      if (key.length !== AES_256_KEY_BYTES) {
        throw new Error(
          `Key '${id}' must be exactly ${AES_256_KEY_BYTES} bytes for AES-256-GCM (got ${key.length}).`,
        );
      }
    }
    if (!this.keys.has(this.currentKeyId)) {
      throw new Error(`Current key id '${this.currentKeyId}' is not present in the provided keys.`);
    }
  }

  /**
   * Builds a provider from env: FINLENS_MASTER_KEY (base64, 32 bytes) under
   * FINLENS_MASTER_KEY_ID (default "local-1"), plus an optional previous key
   * (FINLENS_MASTER_KEY_PREVIOUS / _PREVIOUS_ID) for zero-downtime rotation.
   */
  static fromEnv(env: Record<string, string | undefined> = process.env): LocalKeyProvider {
    const raw = env.FINLENS_MASTER_KEY;
    if (!raw) {
      throw new Error("FINLENS_MASTER_KEY is required (base64-encoded 32 bytes).");
    }
    const currentKeyId = env.FINLENS_MASTER_KEY_ID || "local-1";
    const keys: Record<string, Buffer> = {
      [currentKeyId]: Buffer.from(raw, "base64"),
    };

    const prev = env.FINLENS_MASTER_KEY_PREVIOUS;
    const prevId = env.FINLENS_MASTER_KEY_PREVIOUS_ID;
    if (prev && prevId) {
      keys[prevId] = Buffer.from(prev, "base64");
    }

    return new LocalKeyProvider({ currentKeyId, keys });
  }

  async getCurrentKeyId(): Promise<string> {
    return this.currentKeyId;
  }

  async getKey(keyId: string): Promise<Buffer> {
    const key = this.keys.get(keyId);
    if (!key) {
      throw new Error(`Unknown key id '${keyId}'.`);
    }
    return key;
  }
}

/**
 * Placeholder for Cloud KMS envelope encryption. When implemented, KMS wraps a
 * data-encryption key and the wrapped-DEK id becomes the envelope keyId, so no
 * schema or envelope-format change is needed to adopt it.
 */
export class KmsKeyProvider implements KeyProvider {
  async getCurrentKeyId(): Promise<string> {
    throw new Error("KmsKeyProvider not implemented");
  }

  async getKey(_keyId: string): Promise<Buffer> {
    throw new Error("KmsKeyProvider not implemented");
  }
}
