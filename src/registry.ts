import { AnsError } from "./errors.js";
import { atomicWrite, readText, statSafe, withFileLock } from "./fsutil.js";
import { parseAnsName } from "./name.js";
import { TOOLKIT } from "./profile.js";
import { type ResolveOptions, resolveName } from "./resolve.js";
import {
  hashLogEntry,
  parseRegistrationDocument,
  registrationPayloadHash,
  verifyRegistrationSignature,
} from "./sign.js";
import type {
  ListedAgent,
  LogEntry,
  RegistrationDocument,
  ResolveResult,
  SignedRegistration,
  StoredAgent,
} from "./types.js";

interface RegistryFile {
  format: typeof TOOLKIT.registryFormat;
  createdAt: string;
  agents: StoredAgent[];
  log: LogEntry[];
}

export class LocalRegistry {
  private data: RegistryFile;

  private constructor(
    readonly filePath: string,
    data: RegistryFile,
  ) {
    this.data = data;
  }

  static async open(filePath: string): Promise<LocalRegistry> {
    const data = await readRegistry(filePath);
    return new LocalRegistry(filePath, data);
  }

  static async create(filePath: string, now = new Date()): Promise<LocalRegistry> {
    const data: RegistryFile = {
      format: TOOLKIT.registryFormat,
      createdAt: now.toISOString(),
      agents: [],
      log: [],
    };
    await atomicWrite(filePath, serialize(data));
    return LocalRegistry.open(filePath);
  }

  async reload(): Promise<void> {
    this.data = await readRegistry(this.filePath);
  }

  async list(): Promise<ListedAgent[]> {
    await this.reload();
    return this.data.agents
      .map((agent) => toListed(agent))
      .sort((a, b) => a.ansName.localeCompare(b.ansName));
  }

  async resolve(name: string, options?: ResolveOptions): Promise<ResolveResult> {
    return resolveName(this, name, options);
  }

  async get(name: string): Promise<StoredAgent | undefined> {
    const parsed = parseAnsName(name);
    await this.reload();
    return this.data.agents.find((agent) => agent.document.ansName === parsed.ansName);
  }

  async register(signed: SignedRegistration): Promise<StoredAgent> {
    const document = parseRegistrationDocument(signed.document);
    verifyRegistrationSignature({ document, signature: signed.signature });
    return withFileLock(this.filePath, async () => {
      await this.reload();
      const existing = this.data.agents.find(
        (agent) => agent.document.ansName === document.ansName,
      );
      if (existing) {
        throw new AnsError(
          "ALREADY_REGISTERED",
          `${signed.document.ansName} is already registered.`,
          {
            hint: "ANS-2 consumes a version permanently. Register the next version, for example a patch bump, under the same host.",
          },
        );
      }
      const payloadHash = registrationPayloadHash(document);
      const previous = this.data.log.at(-1);
      const previousHash = previous?.hash ?? TOOLKIT.genesisHash;
      const index = this.data.log.length;
      const unsigned = {
        index,
        type: "AGENT_REGISTERED" as const,
        ansName: document.ansName,
        payloadHash,
        previousHash,
      };
      const entry: LogEntry = { ...unsigned, hash: hashLogEntry(unsigned) };
      const stored: StoredAgent = {
        document,
        signature: signed.signature,
        status: "ACTIVE",
        logIndex: index,
      };
      this.data.agents.push(stored);
      this.data.log.push(entry);
      verifyRegistry(this.data);
      await atomicWrite(this.filePath, serialize(this.data));
      return stored;
    });
  }

  snapshot(): RegistryFile {
    return structuredClone(this.data);
  }
}

async function readRegistry(filePath: string): Promise<RegistryFile> {
  const info = await statSafe(filePath);
  if (info === undefined) {
    throw new AnsError("NOT_INITIALIZED", `No registry at ${filePath}.`, {
      hint: "Run `ans init` in this project, or pass --registry to point at a registry file.",
    });
  }
  if (info.size > 5 * 1024 * 1024) {
    throw new AnsError("REGISTRY_CORRUPT", `Registry ${filePath} is larger than 5 MiB.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readText(filePath)) as unknown;
  } catch (error) {
    throw new AnsError("REGISTRY_CORRUPT", `Registry ${filePath} is not JSON.`, { cause: error });
  }
  const data = parseRegistry(parsed, filePath);
  verifyRegistry(data);
  return data;
}

function parseRegistry(value: unknown, filePath: string): RegistryFile {
  if (!isRecord(value)) {
    throw new AnsError("REGISTRY_CORRUPT", `Registry ${filePath} must be a JSON object.`);
  }
  if (value.format !== TOOLKIT.registryFormat) {
    throw new AnsError(
      "REGISTRY_CORRUPT",
      `Registry format is ${String(value.format)}, expected ${TOOLKIT.registryFormat}.`,
    );
  }
  if (
    typeof value.createdAt !== "string" ||
    !Array.isArray(value.agents) ||
    !Array.isArray(value.log)
  ) {
    throw new AnsError(
      "REGISTRY_CORRUPT",
      `Registry ${filePath} is missing agents, log, or createdAt.`,
    );
  }
  const agents = value.agents.map((agent, index) => parseStoredAgent(agent, index));
  const log = value.log.map((entry, index) => parseLogEntry(entry, index));
  return {
    format: TOOLKIT.registryFormat,
    createdAt: value.createdAt,
    agents,
    log,
  };
}

function parseStoredAgent(value: unknown, index: number): StoredAgent {
  if (!isRecord(value)) {
    throw new AnsError("REGISTRY_CORRUPT", `Agent at index ${index} is not an object.`);
  }
  if (value.status !== "ACTIVE") {
    throw new AnsError("REGISTRY_CORRUPT", `Agent at index ${index} must have status ACTIVE.`);
  }
  if (typeof value.signature !== "string" || !Number.isInteger(value.logIndex)) {
    throw new AnsError(
      "REGISTRY_CORRUPT",
      `Agent at index ${index} is missing signature or logIndex.`,
    );
  }
  if (!isRecord(value.document)) {
    throw new AnsError("REGISTRY_CORRUPT", `Agent at index ${index} is missing a document.`);
  }
  let document: RegistrationDocument;
  try {
    document = parseRegistrationDocument(value.document);
  } catch (error) {
    throw new AnsError("REGISTRY_CORRUPT", `Agent at index ${index} has an invalid document.`, {
      cause: error,
    });
  }
  return {
    document,
    signature: value.signature,
    status: "ACTIVE",
    logIndex: value.logIndex as number,
  };
}

function parseLogEntry(value: unknown, index: number): LogEntry {
  if (!isRecord(value)) {
    throw new AnsError("REGISTRY_CORRUPT", `Log entry ${index} is not an object.`);
  }
  const entry = value as Partial<LogEntry>;
  if (
    entry.index !== index ||
    entry.type !== "AGENT_REGISTERED" ||
    typeof entry.ansName !== "string" ||
    typeof entry.payloadHash !== "string" ||
    typeof entry.previousHash !== "string" ||
    typeof entry.hash !== "string"
  ) {
    throw new AnsError("REGISTRY_CORRUPT", `Log entry ${index} has the wrong shape.`);
  }
  return {
    index,
    type: "AGENT_REGISTERED",
    ansName: entry.ansName,
    payloadHash: entry.payloadHash,
    previousHash: entry.previousHash,
    hash: entry.hash,
  };
}

export function verifyRegistry(data: RegistryFile): void {
  if (data.agents.length !== data.log.length) {
    throw new AnsError("REGISTRY_CORRUPT", "Registry agents and log have different lengths.", {
      hint: "Restore the registry file, or run `ans init --force` to start a new local registry.",
    });
  }
  const names = new Set<string>();
  for (const agent of data.agents) {
    if (names.has(agent.document.ansName)) {
      throw new AnsError("REGISTRY_CORRUPT", `Duplicate ANSName ${agent.document.ansName}.`);
    }
    names.add(agent.document.ansName);
    if (agent.logIndex < 0 || agent.logIndex >= data.log.length) {
      throw new AnsError("REGISTRY_CORRUPT", `Bad log index for ${agent.document.ansName}.`);
    }
    const entry = data.log[agent.logIndex];
    if (entry === undefined || entry.ansName !== agent.document.ansName) {
      throw new AnsError("REGISTRY_CORRUPT", `Log entry does not match ${agent.document.ansName}.`);
    }
    const payloadHash = registrationPayloadHash(agent.document);
    if (entry.payloadHash !== payloadHash) {
      throw new AnsError(
        "REGISTRY_CORRUPT",
        `Hash chain payload mismatch for ${agent.document.ansName}.`,
        {
          hint: "The registration document was edited after it was logged. Verification stops here.",
        },
      );
    }
  }
  let previous = TOOLKIT.genesisHash;
  for (const entry of data.log) {
    if (entry.previousHash !== previous) {
      throw new AnsError("REGISTRY_CORRUPT", `Hash chain broke at log index ${entry.index}.`, {
        hint: "Restore the registry file, or run `ans init --force` to start a new local registry.",
      });
    }
    const expected = hashLogEntry({
      index: entry.index,
      type: entry.type,
      ansName: entry.ansName,
      payloadHash: entry.payloadHash,
      previousHash: entry.previousHash,
    });
    if (entry.hash !== expected) {
      throw new AnsError("REGISTRY_CORRUPT", `Log hash mismatch at index ${entry.index}.`);
    }
    previous = entry.hash;
  }
}

function toListed(agent: StoredAgent): ListedAgent {
  let verified = false;
  try {
    verifyRegistrationSignature(agent);
    verified = true;
  } catch {
    verified = false;
  }
  return {
    ansName: agent.document.ansName,
    agentHost: agent.document.agentHost,
    version: agent.document.version,
    agentDisplayName: agent.document.agentDisplayName,
    status: agent.status,
    protocol: agent.document.endpoint.protocol,
    endpoint: agent.document.endpoint.url,
    verified,
    logIndex: agent.logIndex,
  };
}

function serialize(data: RegistryFile): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
