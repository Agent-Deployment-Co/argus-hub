import { createCipheriv, createDecipheriv, type KeyObject, createSecretKey, randomBytes } from "node:crypto";
import type { LlmProvider } from "./llm/types.ts";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AAD_VERSION = 1;

export interface EncryptedSecret {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  keyVersion: 1;
}

export interface SecretCipher {
  encrypt(orgId: string, provider: LlmProvider, plaintext: string): EncryptedSecret;
  decrypt(orgId: string, provider: LlmProvider, record: EncryptedSecret): string;
}

function additionalData(orgId: string, provider: LlmProvider): Buffer {
  return Buffer.from(JSON.stringify([AAD_VERSION, orgId, provider]), "utf8");
}

export function parseHubSecretKey(value: string | undefined): Buffer {
  if (!value) {
    throw new Error("HUB_SECRET_KEY is required and must be base64 for exactly 32 bytes.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== KEY_BYTES || decoded.toString("base64") !== value) {
    throw new Error("HUB_SECRET_KEY must be canonical base64 for exactly 32 bytes.");
  }
  return decoded;
}

export function createSecretCipher(keyBytes: Uint8Array): SecretCipher {
  if (keyBytes.byteLength !== KEY_BYTES) throw new Error("Hub secret encryption requires a 32-byte key.");
  const key: KeyObject = createSecretKey(Buffer.from(keyBytes));
  return Object.freeze({
    encrypt(orgId: string, provider: LlmProvider, plaintext: string): EncryptedSecret {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(additionalData(orgId, provider));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return { ciphertext, nonce, authTag: cipher.getAuthTag(), keyVersion: 1 };
    },
    decrypt(orgId: string, provider: LlmProvider, record: EncryptedSecret): string {
      if (record.keyVersion !== 1) throw new Error("Unsupported encrypted secret key version.");
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, record.nonce);
        decipher.setAAD(additionalData(orgId, provider));
        decipher.setAuthTag(record.authTag);
        return Buffer.concat([decipher.update(record.ciphertext), decipher.final()]).toString("utf8");
      } catch {
        throw new Error("Stored API key could not be decrypted.");
      }
    },
  });
}
