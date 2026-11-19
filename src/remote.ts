import { buildDnsRecordSet } from "./dns.js";
import { AnsError, isAnsError } from "./errors.js";
import { samePublicKey } from "./keys.js";
import { TOOLKIT } from "./profile.js";
import { hashLogEntry, parseRegistrationDocument, verifyRegistrationSignature } from "./sign.js";
import type { LogEntry, ResolveResult, StoredAgent } from "./types.js";
import { packageVersion } from "./version.js";

export async function fetchRemoteResolve(options: {
  baseUrl: string;
  ansName: string;
  fetchImpl?: typeof fetch;
  badgeBaseUrl?: string;
  publicKeyPin?: string;
}): Promise<ResolveResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const target = `${options.baseUrl.replace(/\/$/, "")}/v0/resolve?name=${encodeURIComponent(options.ansName)}`;
  let response: Response;
  try {
    response = await fetchImpl(target, {
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/json",
        "user-agent": `ans-kit/${packageVersion()} (unofficial local toolkit)`,
      },
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw new AnsError(
      "PUBLIC_REGISTRY_UNAVAILABLE",
      `Could not reach the remote registry at ${options.baseUrl}.`,
      {
        hint: "Remote lookup speaks the ans-kit HTTP API and is off unless you set a URL. It is not a Linux Foundation root. Unset ANS_PUBLIC_REGISTRY_URL for fully offline use.",
        cause: error,
      },
    );
  }
  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch (error) {
    throw new AnsError("REMOTE_REJECTED", "Remote registry did not return JSON.", {
      cause: error,
    });
  }
  if (!response.ok) {
    const remoteError = readError(body);
    if (response.status === 404 || remoteError?.code === "NOT_FOUND") {
      throw new AnsError(
        "NOT_FOUND",
        `Remote registry has no registration for ${options.ansName}.`,
        {
          hint: `Asked ${options.baseUrl}.`,
        },
      );
    }
    throw new AnsError(
      "REMOTE_REJECTED",
      remoteError?.message ?? `Remote registry returned HTTP ${response.status}.`,
      { hint: remoteError?.hint },
    );
  }
  const record = readRecord(body);
  try {
    verifyRegistrationSignature(record);
  } catch (error) {
    if (isAnsError(error)) {
      throw new AnsError(
        "SIGNATURE_INVALID",
        `Remote record for ${options.ansName} failed local signature checks.`,
        {
          hint: "ans-kit verifies the Ed25519 signature itself and does not trust the remote server's verified flag.",
          cause: error,
        },
      );
    }
    throw error;
  }
  if (options.publicKeyPin !== undefined) {
    let matches = false;
    try {
      matches = samePublicKey(record.document.publicKey, {
        kty: "OKP",
        crv: "Ed25519",
        x: options.publicKeyPin,
      });
    } catch {
      matches = false;
    }
    if (!matches) {
      throw new AnsError("PIN_MISMATCH", "Remote key does not match the pin.");
    }
  }
  return {
    source: "remote",
    verified: true,
    record,
    dns: buildDnsRecordSet(record.document, { badgeBaseUrl: options.badgeBaseUrl }),
    logEntry: readLogEntry(body, record),
    remoteUrl: options.baseUrl,
  };
}

function readRecord(body: unknown): StoredAgent {
  const data = envelopeData(body);
  const record = isRecord(data.record) ? data.record : undefined;
  if (record === undefined || !isRecord(record.document) || typeof record.signature !== "string") {
    throw new AnsError("REMOTE_REJECTED", "Remote registry JSON is missing a signed record.", {
      hint: `Expected an ans-kit envelope with data.record. This client talks to other ans-kit registries, format ${TOOLKIT.registryFormat}.`,
    });
  }
  const document = parseRegistrationDocument(record.document);
  return {
    document,
    signature: record.signature,
    status: "ACTIVE",
    logIndex: typeof record.logIndex === "number" ? record.logIndex : 0,
  };
}

function readLogEntry(body: unknown, record: StoredAgent): LogEntry | undefined {
  const data = envelopeData(body);
  const entry = data.logEntry;
  if (!isRecord(entry)) {
    return undefined;
  }
  if (
    entry.type !== "AGENT_REGISTERED" ||
    entry.ansName !== record.document.ansName ||
    typeof entry.index !== "number" ||
    typeof entry.payloadHash !== "string" ||
    typeof entry.previousHash !== "string" ||
    typeof entry.hash !== "string"
  ) {
    return undefined;
  }
  const logEntry: LogEntry = {
    index: entry.index,
    type: "AGENT_REGISTERED",
    ansName: entry.ansName,
    payloadHash: entry.payloadHash,
    previousHash: entry.previousHash,
    hash: entry.hash,
  };
  const expected = hashLogEntry({
    index: logEntry.index,
    type: logEntry.type,
    ansName: logEntry.ansName,
    payloadHash: logEntry.payloadHash,
    previousHash: logEntry.previousHash,
  });
  if (logEntry.hash !== expected) {
    return undefined;
  }
  return logEntry;
}

function envelopeData(body: unknown): Record<string, unknown> {
  if (!isRecord(body) || body.ok !== true || !isRecord(body.data)) {
    throw new AnsError("REMOTE_REJECTED", "Remote registry returned an unexpected JSON envelope.");
  }
  return body.data;
}

function readError(body: unknown): { code?: string; message?: string; hint?: string } | undefined {
  if (!isRecord(body) || !isRecord(body.error)) {
    return undefined;
  }
  return {
    code: typeof body.error.code === "string" ? body.error.code : undefined,
    message: typeof body.error.message === "string" ? body.error.message : undefined,
    hint: typeof body.error.hint === "string" ? body.error.hint : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
