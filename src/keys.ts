import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  generateKeyPairSync,
  type JsonWebKey,
  type KeyObject,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AnsError } from "./errors.js";
import { pathExists } from "./fsutil.js";
import type { Ed25519PublicKey } from "./types.js";

export interface GeneratedKeyPair {
  publicKey: Ed25519PublicKey;
  publicKeyPem: string;
  privateKeyPem: string;
}

export function generateKeyPair(): GeneratedKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicJwk(publicKey),
    publicKeyPem: exportPem(publicKey, "spki"),
    privateKeyPem: exportPem(privateKey, "pkcs8"),
  };
}

export function randomNonce(): string {
  return randomBytes(16).toString("base64url");
}

export function signMessage(privateKeyPem: string, message: string): string {
  const key = loadPrivate(privateKeyPem);
  return cryptoSign(null, Buffer.from(message, "utf8"), key).toString("base64url");
}

export function verifyMessage(
  publicKey: Ed25519PublicKey,
  message: string,
  signature: string,
): boolean {
  const key = importPublic(publicKey);
  let sig: Buffer;
  try {
    sig = decodeFixed(signature, 64, "signature");
  } catch {
    return false;
  }
  return cryptoVerify(null, Buffer.from(message, "utf8"), key, sig);
}

export function publicKeyFromPrivatePem(privateKeyPem: string): Ed25519PublicKey {
  return publicJwk(createPublicKey(loadPrivate(privateKeyPem)));
}

export function publicKeyFromPem(pem: string): Ed25519PublicKey {
  if (pem.includes("PRIVATE KEY")) {
    return publicKeyFromPrivatePem(pem);
  }
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch (error) {
    throw new AnsError("INVALID_KEY", "Could not read an Ed25519 public key.", {
      hint: "Expected an SPKI PEM from `ans auth keygen`, or a PKCS#8 private PEM.",
      cause: error,
    });
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new AnsError(
      "INVALID_KEY",
      `Expected an Ed25519 public key, got ${key.asymmetricKeyType ?? "unknown"}.`,
    );
  }
  return publicJwk(key);
}

export function samePublicKey(left: Ed25519PublicKey, right: Ed25519PublicKey): boolean {
  const a = decodeFixed(left.x, 32, "public key");
  const b = decodeFixed(right.x, 32, "public key");
  return timingSafeEqual(a, b);
}

export function assertPublicKey(value: unknown): Ed25519PublicKey {
  if (!isRecord(value)) {
    throw new AnsError("INVALID_KEY", "Public key must be an Ed25519 JWK object.");
  }
  const keys = Object.keys(value);
  for (const key of keys) {
    if (key !== "kty" && key !== "crv" && key !== "x") {
      throw new AnsError("INVALID_KEY", `Unexpected public key field "${key}".`, {
        hint: 'Use { kty: "OKP", crv: "Ed25519", x: "..." }.',
      });
    }
  }
  if (value.kty !== "OKP" || value.crv !== "Ed25519" || typeof value.x !== "string") {
    throw new AnsError("INVALID_KEY", "Public key must be an Ed25519 OKP JWK.", {
      hint: "kty is OKP, crv is Ed25519, and x is the 32-byte raw key in base64url.",
    });
  }
  decodeFixed(value.x, 32, "public key");
  return { kty: "OKP", crv: "Ed25519", x: value.x };
}

export async function writeKeyPairFiles(
  prefix: string,
  pair: GeneratedKeyPair,
  force: boolean,
): Promise<{ privatePath: string; publicPath: string; jwkPath: string }> {
  const privatePath = `${prefix}.private.pem`;
  const publicPath = `${prefix}.public.pem`;
  const jwkPath = `${prefix}.public.json`;
  await mkdir(dirname(privatePath), { recursive: true });
  for (const filePath of [privatePath, publicPath, jwkPath]) {
    if (!force && (await pathExists(filePath))) {
      throw new AnsError("ALREADY_EXISTS", `Refusing to overwrite ${filePath}.`, {
        hint: "Pass --force to replace the key files, or choose a different --out prefix.",
      });
    }
  }
  await writeFile(privatePath, pair.privateKeyPem, { mode: 0o600 });
  await chmod(privatePath, 0o600);
  await writeFile(publicPath, pair.publicKeyPem, { mode: 0o644 });
  await writeFile(jwkPath, `${JSON.stringify(pair.publicKey, null, 2)}\n`, { mode: 0o644 });
  return { privatePath, publicPath, jwkPath };
}

export function shortKey(x: string): string {
  if (x.length <= 14) {
    return x;
  }
  return `${x.slice(0, 6)}…${x.slice(-4)}`;
}

function loadPrivate(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch (error) {
    throw new AnsError("INVALID_KEY", "Could not read an Ed25519 private key.", {
      hint: "Use a PKCS#8 PEM from `ans auth keygen`. Encrypted PEMs are not supported.",
      cause: error,
    });
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new AnsError(
      "INVALID_KEY",
      `Expected an Ed25519 private key, got ${key.asymmetricKeyType ?? "unknown"}.`,
    );
  }
  return key;
}

function importPublic(publicKey: Ed25519PublicKey): KeyObject {
  try {
    const key = createPublicKey({ key: publicKey as JsonWebKey, format: "jwk" });
    if (key.asymmetricKeyType !== "ed25519") {
      throw new AnsError("INVALID_KEY", "JWK is not an Ed25519 public key.");
    }
    return key;
  } catch (error) {
    if (error instanceof AnsError) {
      throw error;
    }
    throw new AnsError("INVALID_KEY", "Could not import the Ed25519 public key.", { cause: error });
  }
}

function publicJwk(key: KeyObject): Ed25519PublicKey {
  const jwk = key.export({ format: "jwk" });
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new AnsError("INVALID_KEY", "Key export was not an Ed25519 OKP JWK.");
  }
  return assertPublicKey({ kty: "OKP", crv: "Ed25519", x: jwk.x });
}

function exportPem(key: KeyObject, type: "spki" | "pkcs8"): string {
  const out = key.export({ type, format: "pem" });
  return typeof out === "string" ? out : out.toString("utf8");
}

function decodeFixed(value: string, bytes: number, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new AnsError("INVALID_KEY", `The ${label} is not base64url.`);
  }
  const buf = Buffer.from(value, "base64url");
  if (buf.length !== bytes) {
    throw new AnsError("INVALID_KEY", `The ${label} must be ${bytes} bytes.`);
  }
  return buf;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
