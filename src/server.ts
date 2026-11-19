import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AnsError, isAnsError } from "./errors.js";
import { renderHome } from "./page.js";
import { TOOLKIT } from "./profile.js";
import type { LocalRegistry } from "./registry.js";
import { resolveName } from "./resolve.js";
import { verifyAssertion, verifyRegistrationSignature } from "./sign.js";
import type { SignedRegistration } from "./types.js";
import { packageVersion } from "./version.js";

export interface RunningServer {
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export async function startRegistryServer(options: {
  registry: LocalRegistry;
  host?: string;
  port?: number;
  accessLog?: (line: string) => void;
}): Promise<RunningServer> {
  const host = options.host ?? TOOLKIT.defaultHost;
  const port = options.port ?? TOOLKIT.defaultPort;
  const base = { url: boundUrl(host, port) };
  const server = createServer((req, res) => {
    void handle(req, res, options.registry, base.url, options.accessLog);
  });
  const url = await new Promise<string>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      if (error.code === "EADDRINUSE") {
        reject(
          new AnsError("IO", `Port ${port} on ${host} is already in use.`, {
            hint: "Pass --port with a free port. The default is 4080.",
          }),
        );
        return;
      }
      reject(new AnsError("IO", `Could not listen on ${host}:${port}.`, { cause: error }));
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      const address = server.address();
      const actualPort = address && typeof address === "object" ? address.port : port;
      const listening = boundUrl(host, actualPort);
      base.url = listening;
      resolve(listening);
    });
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    options.accessLog?.(`server ${error.code ?? ""} ${error.message}`.trim());
  });
  const actualPort = Number(new URL(url).port);
  return {
    host,
    port: actualPort,
    url,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  registry: LocalRegistry,
  selfUrl: string,
  accessLog?: (line: string) => void,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", selfUrl);
  try {
    const result = await route(method, url, req, registry, selfUrl);
    accessLog?.(`${method} ${url.pathname} ${result.status}`);
    send(res, result.status, result.body, result.contentType);
  } catch (error) {
    const ans = isAnsError(error)
      ? error
      : new AnsError("INTERNAL", error instanceof Error ? error.message : "Request failed.", {
          cause: error,
        });
    const status = statusFor(ans);
    accessLog?.(`${method} ${url.pathname} ${status}`);
    send(res, status, { ok: false, error: ans.toJSON() }, "application/json; charset=utf-8");
  }
}

async function route(
  method: string,
  url: URL,
  req: IncomingMessage,
  registry: LocalRegistry,
  selfUrl: string,
): Promise<{ status: number; body: unknown; contentType: string }> {
  const path = url.pathname;
  if (method === "GET" && path === "/") {
    const accept = req.headers.accept ?? "";
    if (accept.includes("application/json") && !accept.includes("text/html")) {
      return json(200, await overview(registry, selfUrl));
    }
    const agents = await registry.list();
    return {
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: renderHome({ version: packageVersion(), agents, url: selfUrl }),
    };
  }
  if (method === "GET" && path === "/health") {
    return json(200, await overview(registry, selfUrl));
  }
  if (method === "GET" && path === "/v0/agents") {
    return json(200, { agents: await registry.list() });
  }
  if (method === "GET" && path === "/v0/log") {
    await registry.reload();
    return json(200, { log: registry.snapshot().log });
  }
  if (path === "/v0/resolve" && (method === "GET" || method === "POST")) {
    const name = method === "GET" ? url.searchParams.get("name") : readName(await readJson(req));
    if (name === null || name.trim() === "") {
      throw new AnsError("INVALID_ARGUMENT", "Missing name.", {
        hint: "GET /v0/resolve?name=ans://v1.4.2.travel.example.com",
      });
    }
    const resolved = await resolveName(registry, name, { badgeBaseUrl: `${selfUrl}/v0/badges` });
    return json(200, resolved);
  }
  if (method === "GET" && path === "/v0/dns") {
    const name = url.searchParams.get("name");
    if (name === null || name.trim() === "") {
      throw new AnsError("INVALID_ARGUMENT", "Missing name.", {
        hint: "GET /v0/dns?name=ans://v1.4.2.travel.example.com",
      });
    }
    const resolved = await resolveName(registry, name, { badgeBaseUrl: `${selfUrl}/v0/badges` });
    return json(200, resolved.dns);
  }
  if (method === "POST" && path === "/v0/agents") {
    const body = await readJson(req);
    if (!isRecord(body) || !isRecord(body.document) || typeof body.signature !== "string") {
      throw new AnsError("INVALID_ARGUMENT", "POST /v0/agents expects { document, signature }.", {
        hint: "Sign the registration locally. The server never sees a private key.",
      });
    }
    const signed: SignedRegistration = {
      document: body.document as unknown as SignedRegistration["document"],
      signature: body.signature,
    };
    verifyRegistrationSignature(signed);
    const stored = await registry.register(signed);
    return json(201, stored);
  }
  if (method === "POST" && path === "/v0/auth/verify") {
    const body = await readJson(req);
    if (!isRecord(body) || body.assertion === undefined) {
      throw new AnsError("INVALID_ARGUMENT", "POST /v0/auth/verify expects { assertion }.");
    }
    const audience = typeof body.audience === "string" ? body.audience : undefined;
    const assertionName = readAssertionName(body.assertion);
    const record = assertionName ? await registry.get(assertionName) : undefined;
    const check = verifyAssertion(body.assertion, {
      audience,
      registryRecord: record,
      allowUnregistered: body.allowUnregistered === true && record === undefined,
    });
    return json(200, check);
  }
  if (method === "GET" && path.startsWith("/v0/badges/")) {
    const raw = path.slice("/v0/badges/".length);
    let name: string;
    try {
      name = decodeURIComponent(raw);
    } catch {
      throw new AnsError("INVALID_NAME", "Badge path is not URL-encoded correctly.");
    }
    const resolved = await resolveName(registry, name, { badgeBaseUrl: `${selfUrl}/v0/badges` });
    return json(200, {
      status: resolved.record.status,
      ansName: resolved.record.document.ansName,
      version: resolved.record.document.version,
      publicKey: resolved.record.document.publicKey,
      payloadHash: resolved.logEntry?.payloadHash,
      logIndex: resolved.record.logIndex,
      hash: resolved.logEntry?.hash,
      previousHash: resolved.logEntry?.previousHash,
      note: "Local hash-chain entry. This is not a SCITT receipt or a Linux Foundation transparency log.",
    });
  }
  if (path.startsWith("/v0/") || path === "/health") {
    throw new AnsError("USAGE", `Method ${method} is not allowed for ${path}.`, { exitCode: 1 });
  }
  throw new AnsError("NOT_FOUND", `No route for ${path}.`, {
    hint: "Try /, /health, /v0/agents, or /v0/resolve?name=",
  });
}

async function overview(
  registry: LocalRegistry,
  selfUrl: string,
): Promise<Record<string, unknown>> {
  const agents = await registry.list();
  return {
    service: "ans-kit",
    version: packageVersion(),
    unofficial: true,
    role: "local-registry",
    signatureProfile: TOOLKIT.signatureProfile,
    ansName: TOOLKIT.ansNamePattern,
    url: selfUrl,
    agents: agents.length,
    publicRegistryEnabled: false,
  };
}

function json(
  status: number,
  data: unknown,
): { status: number; body: unknown; contentType: string } {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    body: { ok: true, data },
  };
}

function send(res: ServerResponse, status: number, body: unknown, contentType: string): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    server: "ans-kit",
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 256 * 1024) {
      throw new AnsError("INVALID_ARGUMENT", "JSON body exceeds 256 KiB.", { exitCode: 1 });
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) {
    return {};
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AnsError("INVALID_ARGUMENT", "Request body is not JSON.");
  }
}

function readName(body: unknown): string | null {
  if (!isRecord(body) || typeof body.name !== "string") {
    return null;
  }
  return body.name;
}

function readAssertionName(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.ansName !== "string") {
    return undefined;
  }
  return value.ansName;
}

function statusFor(error: AnsError): number {
  switch (error.code) {
    case "NOT_FOUND":
      return 404;
    case "ALREADY_REGISTERED":
    case "ALREADY_EXISTS":
      return 409;
    case "SIGNATURE_INVALID":
    case "ASSERTION_INVALID":
    case "EXPIRED":
    case "AUDIENCE_MISMATCH":
    case "KEY_MISMATCH":
    case "PIN_MISMATCH":
      return 422;
    case "USAGE":
      return 405;
    default:
      return 400;
  }
}

function boundUrl(host: string, port: number): string {
  const shown = host.includes(":") ? `[${host}]` : host;
  return `http://${shown}:${port}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
