import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { KeyProvider } from "./key-provider.js";

// Versioned, self-describing ciphertext envelope:
//   <version>:<keyId>:<ivBase64>:<authTagBase64>:<ciphertextBase64>
// A switch on <version> lets a future format (e.g. KMS-wrapped DEK) coexist.
// ':' never appears in base64 or our keyIds, so it is a safe delimiter.
const VERSION = "v1";
const IV_BYTES = 12; // 96-bit nonce, the recommended size for AES-GCM
const AUTH_TAG_BYTES = 16;

/**
 * Encrypts `plaintext` with AES-256-GCM using the provider's current key.
 * A random 96-bit IV is generated per call. If `aad` is given it is bound into
 * the GCM tag (we pass the tenant id, so ciphertext cannot be transplanted to
 * another tenant/row and still decrypt).
 */
export async function encryptSecret(plaintext: string, kp: KeyProvider, aad?: string): Promise<string> {
  const keyId = await kp.getCurrentKeyId();
  const key = await kp.getKey(keyId);
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad !== undefined) {
    cipher.setAAD(Buffer.from(aad, "utf8"));
  }
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    keyId,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/**
 * Decrypts an envelope produced by encryptSecret. Throws on a malformed or
 * unknown-version envelope, an unknown keyId, a wrong/ missing AAD, or any
 * tampering (the GCM auth tag verification fails on `final()`).
 */
export async function decryptSecret(envelope: string, kp: KeyProvider, aad?: string): Promise<string> {
  const parts = envelope.split(":");
  if (parts.length !== 5) {
    throw new Error("Malformed ciphertext envelope.");
  }
  const [version, keyId, ivB64, tagB64, ctB64] = parts;
  if (version !== VERSION) {
    throw new Error(`Unsupported ciphertext version '${version}'.`);
  }

  const key = await kp.getKey(keyId);
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ctB64, "base64");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag.subarray(0, AUTH_TAG_BYTES));
  if (aad !== undefined) {
    decipher.setAAD(Buffer.from(aad, "utf8"));
  }

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
