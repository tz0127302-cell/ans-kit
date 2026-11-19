import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.js";
import { AnsError } from "./errors.js";
import {
  assertPublicKey,
  publicKeyFromPrivatePem,
  randomNonce,
  samePublicKey,
  signMessage,
  verifyMessage,
} from "./keys.js";
import { parseAnsName } from "./name.js";
import { TOOLKIT } from "./profile.js";
import type {
  AssertionCheck,
  AssertionDocument,
  Ed25519PublicKey,
  RegistrationDocument,
  SignedAssertion,
  SignedRegistration,
  StoredAgent,
} from "./types.js";

const BIDI = /[\u202a-\u202e\u2066-\u2069]/;
const PROTOCOL = /^[a-z][a-z0-9-]{0,31}$/;
const CAPABILITY = /^[a-z0-9][a-z0-9._:-]{0,31}$/;
const AUDIENCE = /^[A-Za-z0-9._:/@+-]{1,200}$/;

export interface RegistrationInput {
  ansName: string;
  agentDisplayName: string;
  agentDescription?: string;
  endpoint: {
    protocol?: string;
    url: string;
    mode?: "direct" | "fetch";
  };
  capabilities?: string[];
  registeredAt?: string | Date;
  publicKey?: Ed25519PublicKey;
}

export function signRegistration(
  input: RegistrationInput,
  privateKeyPem: string,
  options?: { now?: Date },
): SignedRegistration {
  const derived = publicKeyFromPrivatePem(privateKeyPem);
  if (input.publicKey !== undefined && !samePublicKey(input.publicKey, derived)) {
    throw new AnsError("KEY_MISMATCH", "The provided public key does not match the private key.", {
      hint: "Omit publicKey and let ans-kit derive it, or pass the matching public JWK.",
    });
  }
  const document = buildRegistrationDocument(input, derived, options?.now ?? new Date());
  const signature = signMessage(privateKeyPem, canonicalJson(document));
  return { document, signature };
}

export function verifyRegistrationSignature(signed: SignedRegistration): void {
  const document = parseRegistrationDocument(signed.document);
  if (!verifyMessage(document.publicKey, canonicalJson(document), signed.signature)) {
    throw new AnsError("SIGNATURE_INVALID", `Signature check failed for ${document.ansName}.`, {
      hint: "The document was edited, or it was signed by a different key than the one embedded in it.",
    });
  }
}

export function registrationPayloadHash(document: RegistrationDocument): string {
  return createHash("sha256").update(canonicalJson(document)).digest("hex");
}

export function hashLogEntry(entry: {
  index: number;
  type: "AGENT_REGISTERED";
  ansName: string;
  payloadHash: string;
  previousHash: string;
}): string {
  return createHash("sha256").update(canonicalJson(entry)).digest("hex");
}

export function issueAssertion(options: {
  ansName: string;
  privateKeyPem: string;
  audience?: string;
  ttlSeconds?: number;
  now?: Date;
  nonce?: string;
}): SignedAssertion {
  const parsed = parseAnsName(options.ansName);
  const publicKey = publicKeyFromPrivatePem(options.privateKeyPem);
  const ttl = options.ttlSeconds ?? TOOLKIT.defaultAssertionTtlSeconds;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > TOOLKIT.maxAssertionTtlSeconds) {
    throw new AnsError(
      "INVALID_ARGUMENT",
      `Assertion TTL must be an integer from 1 to ${TOOLKIT.maxAssertionTtlSeconds} seconds.`,
    );
  }
  const audience = options.audience?.trim();
  if (audience !== undefined && audience.length > 0 && !AUDIENCE.test(audience)) {
    throw new AnsError("INVALID_ARGUMENT", "Audience contains unsupported characters.", {
      hint: "Use a hostname or URL made of letters, digits, and . _ : / @ + -",
    });
  }
  const now = options.now ?? new Date();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
  const nonce = options.nonce ?? randomNonce();
  decodeNonce(nonce);
  const document: AssertionDocument = {
    typ: TOOLKIT.assertionType,
    alg: "Ed25519",
    ansName: parsed.ansName,
    publicKey,
    nonce,
    issuedAt,
    expiresAt,
  };
  if (audience !== undefined && audience.length > 0) {
    document.audience = audience;
  }
  const signature = signMessage(options.privateKeyPem, canonicalJson(document));
  return { ...document, signature };
}

export function verifyAssertion(
  value: unknown,
  options?: {
    now?: Date;
    audience?: string;
    registryRecord?: StoredAgent;
    allowUnregistered?: boolean;
  },
): AssertionCheck {
  const signed = parseSignedAssertion(value);
  const { signature, ...document } = signed;
  if (!verifyMessage(document.publicKey, canonicalJson(document), signature)) {
    throw new AnsError("ASSERTION_INVALID", "Assertion signature does not match its public key.", {
      hint: "Issue a new assertion with the agent's private key.",
    });
  }
  const nowMs = (options?.now ?? new Date()).getTime();
  const issued = Date.parse(document.issuedAt);
  const expires = Date.parse(document.expiresAt);
  if (nowMs + TOOLKIT.clockSkewMs < issued) {
    throw new AnsError("ASSERTION_INVALID", "Assertion is not valid yet.", {
      hint: `It becomes valid at ${document.issuedAt}.`,
    });
  }
  if (nowMs - TOOLKIT.clockSkewMs > expires) {
    throw new AnsError("EXPIRED", "Assertion has expired.", {
      hint: "Issue a fresh one with `ans auth issue`. Default lifetime is 5 minutes.",
    });
  }
  if (options?.audience !== undefined && document.audience !== options.audience) {
    throw new AnsError("AUDIENCE_MISMATCH", "Assertion audience does not match.", {
      hint: `Expected ${options.audience}. The assertion audience is ${document.audience ?? "(none)"}.`,
    });
  }
  let registry: AssertionCheck["registry"] = "unchecked";
  if (options?.registryRecord !== undefined) {
    verifyRegistrationSignature(options.registryRecord);
    if (options.registryRecord.document.ansName !== document.ansName) {
      throw new AnsError("KEY_MISMATCH", "Assertion name does not match the registry record.");
    }
    if (!samePublicKey(options.registryRecord.document.publicKey, document.publicKey)) {
      throw new AnsError("KEY_MISMATCH", "Assertion key does not match the registered key.", {
        hint: "The local registry has a different Ed25519 key for this ANSName.",
      });
    }
    registry = "matched";
  } else if (options?.allowUnregistered !== true) {
    throw new AnsError("NOT_FOUND", "No registry record was provided for this assertion.", {
      hint: "Resolve the ANSName locally first, or pass allowUnregistered to check the signature only.",
    });
  }
  return {
    ansName: document.ansName,
    audience: document.audience ?? null,
    issuedAt: document.issuedAt,
    expiresAt: document.expiresAt,
    registry,
  };
}

export function buildRegistrationDocument(
  input: RegistrationInput,
  publicKey: Ed25519PublicKey,
  now: Date,
): RegistrationDocument {
  const parsed = parseAnsName(input.ansName);
  const agentDisplayName = cleanText(input.agentDisplayName, "Display name", 1, 64);
  const description = optionalText(input.agentDescription, "Description", 150);
  const endpoint = normalizeEndpoint(input.endpoint);
  const capabilities = normalizeCapabilities(input.capabilities);
  const registeredAt = normalizeTimestamp(input.registeredAt ?? now, now);
  const document: RegistrationDocument = {
    alg: "Ed25519",
    ansName: parsed.ansName,
    agentHost: parsed.agentHost,
    version: parsed.version,
    agentDisplayName,
    endpoint,
    publicKey: assertPublicKey(publicKey),
    registeredAt,
  };
  if (description !== undefined) {
    document.agentDescription = description;
  }
  if (capabilities !== undefined) {
    document.capabilities = capabilities;
  }
  return document;
}

export function parseRegistrationDocument(value: unknown): RegistrationDocument {
  const record = expectRecord(value, "Registration document");
  assertExactKeys(
    record,
    [
      "alg",
      "ansName",
      "agentHost",
      "version",
      "agentDisplayName",
      "endpoint",
      "publicKey",
      "registeredAt",
    ],
    ["agentDescription", "capabilities"],
    "registration document",
  );
  if (record.alg !== "Ed25519") {
    throw new AnsError("INVALID_ARGUMENT", "Registration alg must be Ed25519.");
  }
  const parsed = parseAnsName(requireString(record.ansName, "ansName"));
  if (record.agentHost !== parsed.agentHost || record.version !== parsed.version) {
    throw new AnsError("INVALID_NAME", "agentHost or version does not match the ANSName.", {
      hint: "Those fields are derived from the ANSName. Do not set them independently.",
    });
  }
  const endpoint = parseEndpoint(record.endpoint);
  const publicKey = assertPublicKey(record.publicKey);
  const registeredAt = requireString(record.registeredAt, "registeredAt");
  if (normalizeTimestamp(registeredAt, new Date(registeredAt)) !== registeredAt) {
    throw new AnsError("INVALID_ARGUMENT", "registeredAt must be an ISO-8601 UTC timestamp.");
  }
  const document: RegistrationDocument = {
    alg: "Ed25519",
    ansName: parsed.ansName,
    agentHost: parsed.agentHost,
    version: parsed.version,
    agentDisplayName: cleanText(
      requireString(record.agentDisplayName, "agentDisplayName"),
      "Display name",
      1,
      64,
    ),
    endpoint,
    publicKey,
    registeredAt,
  };
  if (record.agentDescription !== undefined) {
    const description = optionalText(
      requireString(record.agentDescription, "agentDescription"),
      "Description",
      150,
    );
    if (description !== undefined) {
      document.agentDescription = description;
    }
  }
  if (record.capabilities !== undefined) {
    if (!Array.isArray(record.capabilities)) {
      throw new AnsError("INVALID_ARGUMENT", "capabilities must be an array of strings.");
    }
    const capabilities = normalizeCapabilities(
      record.capabilities.map((item) => requireString(item, "capability")),
    );
    if (capabilities !== undefined) {
      document.capabilities = capabilities;
    }
  }
  return document;
}

function parseSignedAssertion(value: unknown): SignedAssertion {
  const record = expectRecord(value, "Assertion");
  assertExactKeys(
    record,
    ["typ", "alg", "ansName", "publicKey", "nonce", "issuedAt", "expiresAt", "signature"],
    ["audience"],
    "assertion",
  );
  if (record.typ !== TOOLKIT.assertionType) {
    throw new AnsError("ASSERTION_INVALID", `Assertion typ must be ${TOOLKIT.assertionType}.`);
  }
  if (record.alg !== "Ed25519") {
    throw new AnsError("ASSERTION_INVALID", "Assertion alg must be Ed25519.");
  }
  const parsed = parseAnsName(requireString(record.ansName, "ansName"));
  const nonce = requireString(record.nonce, "nonce");
  decodeNonce(nonce);
  const issuedAt = requireIso(requireString(record.issuedAt, "issuedAt"), "issuedAt");
  const expiresAt = requireIso(requireString(record.expiresAt, "expiresAt"), "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    throw new AnsError("ASSERTION_INVALID", "Assertion expiry is not after issuedAt.");
  }
  const document: SignedAssertion = {
    typ: TOOLKIT.assertionType,
    alg: "Ed25519",
    ansName: parsed.ansName,
    publicKey: assertPublicKey(record.publicKey),
    nonce,
    issuedAt,
    expiresAt,
    signature: requireString(record.signature, "signature"),
  };
  if (record.audience !== undefined) {
    const audience = requireString(record.audience, "audience");
    if (!AUDIENCE.test(audience)) {
      throw new AnsError("ASSERTION_INVALID", "Assertion audience is not usable.");
    }
    document.audience = audience;
  }
  return document;
}

function normalizeEndpoint(input: RegistrationInput["endpoint"]): RegistrationDocument["endpoint"] {
  const protocol = (input.protocol ?? "https").trim().toLowerCase();
  if (!PROTOCOL.test(protocol)) {
    throw new AnsError("INVALID_ARGUMENT", `Protocol "${protocol}" is not a short token.`, {
      hint: "Examples: https, mcp, a2a.",
    });
  }
  const mode = input.mode ?? "direct";
  if (mode !== "direct" && mode !== "fetch") {
    throw new AnsError("INVALID_ARGUMENT", "Endpoint mode must be direct or fetch.");
  }
  const url = normalizeUrl(input.url);
  return { protocol, url, mode };
}

function parseEndpoint(value: unknown): RegistrationDocument["endpoint"] {
  const record = expectRecord(value, "endpoint");
  assertExactKeys(record, ["protocol", "url", "mode"], [], "endpoint");
  return normalizeEndpoint({
    protocol: requireString(record.protocol, "protocol"),
    url: requireString(record.url, "url"),
    mode: requireString(record.mode, "mode") as "direct" | "fetch",
  });
}

function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AnsError("INVALID_ARGUMENT", `Endpoint URL "${truncate(raw)}" is not a URL.`, {
      hint: "Use an http or https URL, for example https://travel.example.com/mcp.",
    });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AnsError("INVALID_ARGUMENT", "Endpoint URL must be http or https.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new AnsError("INVALID_ARGUMENT", "Endpoint URL must not include userinfo.");
  }
  if (/[;"\\\s]/.test(url.href)) {
    throw new AnsError(
      "INVALID_ARGUMENT",
      "Endpoint URL cannot contain spaces, quotes, or semicolons.",
      {
        hint: "Those characters would break the DNS TXT projection.",
      },
    );
  }
  return url.href;
}

function normalizeCapabilities(values: string[] | undefined): string[] | undefined {
  if (values === undefined) {
    return undefined;
  }
  const cleaned = values.map((value) => value.trim()).filter((value) => value.length > 0);
  if (cleaned.length === 0) {
    return undefined;
  }
  if (cleaned.length > 8) {
    throw new AnsError("INVALID_ARGUMENT", "At most 8 capabilities are allowed.");
  }
  const seen = new Set<string>();
  for (const value of cleaned) {
    if (!CAPABILITY.test(value)) {
      throw new AnsError(
        "INVALID_ARGUMENT",
        `Capability "${truncate(value)}" is not a short token.`,
        {
          hint: "Use 1–32 characters: lowercase letters, digits, and . _ : -",
        },
      );
    }
    if (seen.has(value)) {
      throw new AnsError("INVALID_ARGUMENT", `Capability "${value}" is repeated.`);
    }
    seen.add(value);
  }
  return cleaned;
}

function cleanText(value: string, label: string, min: number, max: number): string {
  const text = value.trim();
  if (hasControlCharacter(text) || BIDI.test(text)) {
    throw new AnsError("INVALID_ARGUMENT", `${label} contains control or bidi characters.`);
  }
  const length = [...text].length;
  if (length < min || length > max) {
    throw new AnsError("INVALID_ARGUMENT", `${label} must be ${min}–${max} characters.`, {
      hint:
        label === "Display name"
          ? "ANS-2 limits agentDisplayName to 64 characters."
          : "ANS-2 limits agentDescription to 150 characters.",
    });
  }
  return text;
}

function optionalText(value: string | undefined, label: string, max: number): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  return cleanText(value, label, 1, max);
}

function normalizeTimestamp(value: string | Date, now: Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AnsError("INVALID_ARGUMENT", "registeredAt is not a valid timestamp.");
  }
  const iso = date.toISOString();
  const min = Date.parse("2020-01-01T00:00:00.000Z");
  const max = now.getTime() + 24 * 60 * 60 * 1000;
  if (date.getTime() < min || date.getTime() > max) {
    throw new AnsError("INVALID_ARGUMENT", `registeredAt ${iso} is outside the accepted window.`, {
      hint: "Use a UTC time between 2020 and 24 hours from now.",
    });
  }
  return iso;
}

function requireIso(value: string, label: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new AnsError("ASSERTION_INVALID", `${label} must be an ISO-8601 UTC timestamp.`);
  }
  return value;
}

function decodeNonce(nonce: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(nonce)) {
    throw new AnsError("ASSERTION_INVALID", "Nonce is not base64url.");
  }
  const bytes = Buffer.from(nonce, "base64url");
  if (bytes.length < 16) {
    throw new AnsError("ASSERTION_INVALID", "Nonce must be at least 16 bytes.");
  }
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AnsError("INVALID_ARGUMENT", `${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  required: string[],
  optional: string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new AnsError("INVALID_ARGUMENT", `Unexpected ${label} field "${key}".`);
    }
  }
  for (const key of required) {
    if (record[key] === undefined) {
      throw new AnsError("INVALID_ARGUMENT", `Missing ${label} field "${key}".`);
    }
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AnsError("INVALID_ARGUMENT", `${label} must be a non-empty string.`);
  }
  return value;
}

function truncate(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}
