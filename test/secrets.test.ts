import { describe, expect, test } from "bun:test";
import { createSecretCipher, parseHubSecretKey } from "../src/secrets.ts";

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 8);
const PLAINTEXT = "sk-test-value-that-must-stay-secret";

describe("Hub secret key parsing", () => {
  test("accepts canonical base64 for exactly 32 bytes", () => {
    expect(parseHubSecretKey(KEY.toString("base64"))).toEqual(KEY);
  });

  test.each([undefined, ""])("allows missing input", (value) => {
    expect(parseHubSecretKey(value)).toBeUndefined();
  });

  test.each(["not base64", Buffer.alloc(31).toString("base64"), `${KEY.toString("base64")}\n`])(
    "rejects malformed input without echoing it",
    (value) => {
      expect(() => parseHubSecretKey(value)).toThrow("HUB_SECRET_KEY");
      try {
        parseHubSecretKey(value);
      } catch (error) {
        expect(String(error)).not.toContain(PLAINTEXT);
      }
    },
  );
});

describe("AES-256-GCM secret cipher", () => {
  test("round-trips with the correct row identity", () => {
    const cipher = createSecretCipher(KEY);
    const encrypted = cipher.encrypt("org-a", "openai", PLAINTEXT);
    expect(cipher.decrypt("org-a", "openai", encrypted)).toBe(PLAINTEXT);
    expect(encrypted.ciphertext.toString("utf8")).not.toContain(PLAINTEXT);
  });

  test("uses a fresh nonce and ciphertext for every write", () => {
    const cipher = createSecretCipher(KEY);
    const first = cipher.encrypt("org-a", "openai", PLAINTEXT);
    const second = cipher.encrypt("org-a", "openai", PLAINTEXT);
    expect(first.nonce).not.toEqual(second.nonce);
    expect(first.ciphertext).not.toEqual(second.ciphertext);
  });

  test("fails closed for the wrong key, row AAD, or modified data", () => {
    const cipher = createSecretCipher(KEY);
    const encrypted = cipher.encrypt("org-a", "openai", PLAINTEXT);
    const modified = { ...encrypted, authTag: Buffer.from(encrypted.authTag) };
    modified.authTag[0] = modified.authTag[0]! ^ 1;
    for (const decrypt of [
      () => createSecretCipher(OTHER_KEY).decrypt("org-a", "openai", encrypted),
      () => cipher.decrypt("org-b", "openai", encrypted),
      () => cipher.decrypt("org-a", "gemini", encrypted),
      () => cipher.decrypt("org-a", "openai", modified),
    ]) {
      expect(decrypt).toThrow("could not be decrypted");
      try { decrypt(); } catch (error) { expect(String(error)).not.toContain(PLAINTEXT); }
    }
  });
});
