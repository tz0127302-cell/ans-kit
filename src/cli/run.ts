import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AnsError, isAnsError } from "../errors.js";
import { pathExists, readText } from "../fsutil.js";
import {
  assertPublicKey,
  generateKeyPair,
  publicKeyFromPem,
  publicKeyFromPrivatePem,
  samePublicKey,
  writeKeyPairFiles,
} from "../keys.js";
import { TOOLKIT } from "../profile.js";
import { initProject, loadContext, openRegistry } from "../project.js";
import { resolveName } from "../resolve.js";
import { startRegistryServer } from "../server.js";
import { issueAssertion, signRegistration, verifyAssertion } from "../sign.js";
import type { SignedAssertion } from "../types.js";
import { packageVersion } from "../version.js";
import { flagBool, flagString, type ParsedArgs, parseArgs, requireFlag } from "./args.js";
import { commandHelp, rootHelp } from "./help.js";
import {
  displayPath,
  formatAssertion,
  formatInit,
  formatIssued,
  formatKeys,
  formatList,
  formatRegister,
  formatResolve,
  formatServe,
  formatVerifyName,
  type Paint,
  paint,
} from "./text.js";

export interface Io {
  stdout: { write(chunk: string): void; isTTY?: boolean };
  stderr: { write(chunk: string): void; isTTY?: boolean };
  env: NodeJS.ProcessEnv;
  cwd: string;
  color: boolean;
  json: boolean;
}

interface CommandOutput {
  exitCode?: number;
  data?: unknown;
  text?: string;
  error?: AnsError;
  silent?: boolean;
}

const COMMANDS = new Set([
  "init",
  "register",
  "resolve",
  "list",
  "auth",
  "serve",
  "help",
  "version",
]);

export async function main(argv: string[], partial?: Partial<Io>): Promise<number> {
  const io = createIo(partial);
  try {
    return await dispatch(argv, io);
  } catch (error) {
    if (isAnsError(error)) {
      return renderError(io, error);
    }
    if (io.env.ANS_DEBUG === "1" && error instanceof Error && error.stack !== undefined) {
      io.stderr.write(`${error.stack}\n`);
    }
    const message = error instanceof Error ? error.message : "Unexpected failure.";
    return renderError(io, new AnsError("INTERNAL", message, { cause: error }));
  }
}

async function dispatch(argv: string[], io: Io): Promise<number> {
  if (argv.includes("--json") || argv.includes("--json=true")) {
    io.json = true;
  }
  const parsed = parseArgs(argv);
  io.json = flagBool(parsed.flags, "json");
  const [command, sub] = parsed.positional;
  if (flagBool(parsed.flags, "version")) {
    if (command !== undefined) {
      throw new AnsError("USAGE", "--version does not take a command.", {
        hint: "Run `ans --version`.",
      });
    }
    io.stdout.write(`${packageVersion()}\n`);
    return 0;
  }
  if (command === undefined || (command === "help" && sub === undefined)) {
    if (command === undefined && parsed.positional.length > 0) {
      throw new AnsError("USAGE", "Missing command.", { hint: "Run `ans --help`." });
    }
    io.stdout.write(rootHelp());
    return 0;
  }
  if (command === "help") {
    io.stdout.write(helpFor(sub, parsed.positional[2]));
    return 0;
  }
  if (command === "version") {
    io.stdout.write(`${packageVersion()}\n`);
    return 0;
  }
  if (!COMMANDS.has(command)) {
    throw new AnsError("USAGE", `Unknown command "${command}".`, {
      hint: "Run `ans --help` to see init, register, resolve, list, auth, and serve.",
    });
  }
  if (flagBool(parsed.flags, "help")) {
    io.stdout.write(helpFor(command, command === "auth" ? sub : undefined));
    return 0;
  }
  assertAllowed(parsed, command, sub);
  const color = paint(io.color);
  const output = await runCommand(command, sub, parsed, io, color);
  return present(io, output);
}

async function runCommand(
  command: string,
  sub: string | undefined,
  parsed: ParsedArgs,
  io: Io,
  color: Paint,
): Promise<CommandOutput> {
  switch (command) {
    case "init":
      return runInit(parsed, io, color);
    case "register":
      return runRegister(parsed, io, color);
    case "resolve":
      return runResolve(parsed, io, color);
    case "list":
      return runList(parsed, io, color);
    case "serve":
      return runServe(parsed, io, color);
    case "auth":
      return runAuth(sub, parsed, io, color);
    default:
      throw new AnsError("USAGE", `Unknown command "${command}".`);
  }
}

async function runInit(parsed: ParsedArgs, io: Io, color: Paint): Promise<CommandOutput> {
  rejectExtra(parsed, 1);
  const result = await initProject({
    cwd: io.cwd,
    env: io.env,
    home: flagString(parsed.flags, "home"),
    force: flagBool(parsed.flags, "force"),
    demo: flagBool(parsed.flags, "demo"),
  });
  return {
    data: {
      home: result.home,
      registryPath: result.registryPath,
      replaced: result.replaced,
      demoAgents: result.demoAgents,
      remote: { enabled: false, url: null },
    },
    text: formatInit({ cwd: io.cwd, ...result, color }),
  };
}

async function runRegister(parsed: ParsedArgs, io: Io, color: Paint): Promise<CommandOutput> {
  rejectExtra(parsed, 1);
  const context = await loadContext({
    cwd: io.cwd,
    env: io.env,
    home: flagString(parsed.flags, "home"),
    registry: flagString(parsed.flags, "registry"),
    offline: true,
  });
  const registry = await openRegistry(context.registryPath, true);
  const keyPath = resolve(
    io.cwd,
    requireFlag(
      parsed.flags,
      "key",
      "Generate one with `ans auth keygen --out .ans/keys/my-agent`.",
    ),
  );
  const privateKeyPem = await readText(keyPath);
  const mode = flagString(parsed.flags, "mode");
  const signed = signRegistration(
    {
      ansName: requireFlag(
        parsed.flags,
        "name",
        "Example: --name ans://v1.0.0.dispatch.example.com",
      ),
      agentDisplayName: requireFlag(
        parsed.flags,
        "display-name",
        "Human label, up to 64 characters.",
      ),
      agentDescription: flagString(parsed.flags, "description"),
      endpoint: {
        protocol: flagString(parsed.flags, "protocol"),
        url: requireFlag(
          parsed.flags,
          "endpoint",
          "Example: --endpoint https://dispatch.example.com/a2a",
        ),
        mode: mode === undefined ? undefined : parseMode(mode),
      },
      capabilities: splitCapabilities(flagString(parsed.flags, "capabilities")),
      registeredAt: flagString(parsed.flags, "registered-at"),
    },
    privateKeyPem,
  );
  const stored = await registry.register(signed);
  return { data: stored, text: formatRegister(stored, color) };
}

async function runResolve(parsed: ParsedArgs, io: Io, color: Paint): Promise<CommandOutput> {
  const name = resolveNameArg(parsed);
  const context = await loadContext({
    cwd: io.cwd,
    env: io.env,
    home: flagString(parsed.flags, "home"),
    registry: flagString(parsed.flags, "registry"),
    publicRegistry: flagString(parsed.flags, "public-registry"),
    offline: flagBool(parsed.flags, "offline"),
  });
  const registry = await openRegistry(context.registryPath, false);
  const pinFlag = flagString(parsed.flags, "pin");
  const result = await resolveName(registry, name, {
    remote: context.remote,
    publicKeyPin: pinFlag === undefined ? undefined : await readPin(io.cwd, pinFlag),
  });
  if (flagBool(parsed.flags, "zone")) {
    return {
      data: { zone: result.dns.zone, ansName: result.dns.ansName },
      text: result.dns.zone.endsWith("\n") ? result.dns.zone : `${result.dns.zone}\n`,
    };
  }
  return { data: result, text: formatResolve(result, color) };
}

async function runList(parsed: ParsedArgs, io: Io, color: Paint): Promise<CommandOutput> {
  rejectExtra(parsed, 1);
  const context = await loadContext({
    cwd: io.cwd,
    env: io.env,
    home: flagString(parsed.flags, "home"),
    registry: flagString(parsed.flags, "registry"),
    offline: true,
  });
  const registry = await openRegistry(context.registryPath, false);
  const agents = await registry.list();
  const text = formatList(agents, context.registryPath, io.cwd, color);
  const bad = agents.filter((agent) => !agent.verified);
  if (bad.length > 0) {
    return {
      data: { agents },
      text,
      error: new AnsError(
        "SIGNATURE_INVALID",
        `${bad.length} registration(s) failed signature checks.`,
        { hint: bad.map((agent) => agent.ansName).join(", ") },
      ),
    };
  }
  return { data: { agents }, text };
}

async function runServe(parsed: ParsedArgs, io: Io, color: Paint): Promise<CommandOutput> {
  rejectExtra(parsed, 1);
  const context = await loadContext({
    cwd: io.cwd,
    env: io.env,
    home: flagString(parsed.flags, "home"),
    registry: flagString(parsed.flags, "registry"),
    offline: true,
  });
  const registry = await openRegistry(context.registryPath, false);
  const host = flagString(parsed.flags, "host") ?? TOOLKIT.defaultHost;
  const port = parsePort(flagString(parsed.flags, "port") ?? String(TOOLKIT.defaultPort));
  if (!isLoopback(host)) {
    io.stderr.write(
      "warning: binding beyond loopback. This dev registry has no HTTP password; registrations still need a valid signature.\n",
    );
  }
  const running = await startRegistryServer({
    registry,
    host,
    port,
    accessLog: (line) => {
      io.stderr.write(`${line}\n`);
    },
  });
  const data = { url: running.url, host: running.host, port: running.port };
  if (io.json) {
    io.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
  } else {
    io.stdout.write(formatServe({ url: running.url, host: running.host, color }));
  }
  await new Promise<void>((done) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      void running.close().finally(done);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return { silent: true, exitCode: 0, data };
}

async function runAuth(
  sub: string | undefined,
  parsed: ParsedArgs,
  io: Io,
  color: Paint,
): Promise<CommandOutput> {
  if (sub === undefined) {
    throw new AnsError("USAGE", "auth needs a subcommand: keygen, issue, or verify.", {
      hint: "Run `ans auth --help`.",
    });
  }
  switch (sub) {
    case "keygen":
      return runKeygen(parsed, io);
    case "issue":
      return runIssue(parsed, io);
    case "verify":
      return runAuthVerify(parsed, io, color);
    default:
      throw new AnsError("USAGE", `Unknown auth subcommand "${sub}".`, {
        hint: "Use keygen, issue, or verify.",
      });
  }
}

async function runKeygen(parsed: ParsedArgs, io: Io): Promise<CommandOutput> {
  rejectExtra(parsed, 2);
  const prefix = resolve(
    io.cwd,
    requireFlag(parsed.flags, "out", "Example: --out .ans/keys/dispatch"),
  );
  const pair = generateKeyPair();
  const paths = await writeKeyPairFiles(prefix, pair, flagBool(parsed.flags, "force"));
  return {
    data: { ...paths, publicKey: pair.publicKey },
    text: formatKeys({ cwd: io.cwd, ...paths }),
  };
}

async function runIssue(parsed: ParsedArgs, io: Io): Promise<CommandOutput> {
  rejectExtra(parsed, 2);
  const context = await loadContext({
    cwd: io.cwd,
    env: io.env,
    home: flagString(parsed.flags, "home"),
    registry: flagString(parsed.flags, "registry"),
    offline: true,
  });
  const registry = await openRegistry(context.registryPath, false);
  const name = requireFlag(
    parsed.flags,
    "name",
    "Example: --name ans://v1.0.0.dispatch.example.com",
  );
  const record = await registry.get(name);
  if (record === undefined) {
    throw new AnsError("NOT_FOUND", `No registration for ${name}.`, {
      hint: "Register the name before issuing an assertion.",
    });
  }
  const keyPath = resolve(
    io.cwd,
    requireFlag(parsed.flags, "key", "Pass the private PEM from `ans auth keygen`."),
  );
  const privateKeyPem = await readText(keyPath);
  const derived = publicKeyFromPrivatePem(privateKeyPem);
  if (!samePublicKey(derived, record.document.publicKey)) {
    throw new AnsError(
      "KEY_MISMATCH",
      "This private key does not match the registered public key.",
    );
  }
  const ttlRaw = flagString(parsed.flags, "ttl");
  const assertion = issueAssertion({
    ansName: record.document.ansName,
    privateKeyPem,
    audience: flagString(parsed.flags, "audience"),
    ttlSeconds: ttlRaw === undefined ? undefined : parseTtl(ttlRaw),
  });
  const out = flagString(parsed.flags, "out");
  if (out === undefined) {
    throw new AnsError("USAGE", "Missing --out.", {
      hint: "Example: --out .ans/dispatch-assertion.json",
    });
  }
  const file = resolve(io.cwd, out);
  await writeFile(file, `${JSON.stringify(assertion, null, 2)}\n`, { mode: 0o600 });
  return {
    data: assertion,
    text: formatIssued(
      {
        ansName: assertion.ansName,
        expiresAt: assertion.expiresAt,
        audience: assertion.audience ?? null,
      },
      displayPath(io.cwd, file),
    ),
  };
}

async function runAuthVerify(parsed: ParsedArgs, io: Io, color: Paint): Promise<CommandOutput> {
  rejectExtra(parsed, 2);
  const name = flagString(parsed.flags, "name");
  const assertionPath = flagString(parsed.flags, "assertion");
  if (name !== undefined && assertionPath !== undefined) {
    throw new AnsError("USAGE", "Pass either --name or --assertion, not both.");
  }
  if (name === undefined && assertionPath === undefined) {
    throw new AnsError("USAGE", "Pass --name or --assertion.", {
      hint: "Examples: `ans auth verify --name ans://v1.4.2.travel.example.com`",
    });
  }
  const context = await loadContext({
    cwd: io.cwd,
    env: io.env,
    home: flagString(parsed.flags, "home"),
    registry: flagString(parsed.flags, "registry"),
    offline: true,
  });
  const registry = await openRegistry(context.registryPath, false);
  if (name !== undefined) {
    const pinFlag = flagString(parsed.flags, "pin");
    const result = await resolveName(registry, name, {
      publicKeyPin: pinFlag === undefined ? undefined : await readPin(io.cwd, pinFlag),
    });
    return { data: result, text: formatVerifyName(result, color) };
  }
  const file = resolve(io.cwd, assertionPath ?? "");
  const assertion = await readAssertion(file);
  const record =
    typeof assertion.ansName === "string" ? await registry.get(assertion.ansName) : undefined;
  const allow = flagBool(parsed.flags, "allow-unregistered");
  if (record === undefined && !allow) {
    throw new AnsError("NOT_FOUND", "Assertion name is not in the local registry.", {
      hint: "Register it first, or pass --allow-unregistered to check the signature only.",
    });
  }
  const check = verifyAssertion(assertion, {
    audience: flagString(parsed.flags, "audience"),
    registryRecord: record,
    allowUnregistered: allow && record === undefined,
  });
  return {
    data: check,
    text: formatAssertion(check, color, displayPath(io.cwd, file)),
  };
}

function present(io: Io, output: CommandOutput): number {
  if (output.silent) {
    return output.exitCode ?? 0;
  }
  if (output.error !== undefined) {
    if (io.json) {
      const payload: { ok: false; error: ReturnType<AnsError["toJSON"]>; data?: unknown } = {
        ok: false,
        error: output.error.toJSON(),
      };
      if (output.data !== undefined) {
        payload.data = output.data;
      }
      io.stdout.write(`${JSON.stringify(payload)}\n`);
      return output.error.exitCode;
    }
    if (output.text !== undefined) {
      io.stdout.write(output.text);
    }
    return renderError(io, output.error);
  }
  if (io.json) {
    io.stdout.write(`${JSON.stringify({ ok: true, data: output.data })}\n`);
  } else if (output.text !== undefined) {
    io.stdout.write(output.text);
  }
  return output.exitCode ?? 0;
}

function renderError(io: Io, error: AnsError): number {
  if (io.json) {
    io.stdout.write(`${JSON.stringify({ ok: false, error: error.toJSON() })}\n`);
    return error.exitCode;
  }
  const color = paint(io.color);
  const lines = [`${color.red("error")}[${error.code}]: ${error.message}`];
  if (error.hint !== undefined) {
    lines.push(`  ${color.dim("hint:")} ${error.hint}`);
  }
  io.stderr.write(`${lines.join("\n")}\n`);
  return error.exitCode;
}

function createIo(partial?: Partial<Io>): Io {
  const stdout = partial?.stdout ?? process.stdout;
  const stderr = partial?.stderr ?? process.stderr;
  const env = { ...(partial?.env ?? process.env) };
  const color =
    partial?.color ??
    (Boolean(stderr.isTTY) && env.NO_COLOR === undefined && env.ANS_NO_COLOR === undefined);
  return {
    stdout,
    stderr,
    env,
    cwd: partial?.cwd ?? process.cwd(),
    color,
    json: partial?.json ?? false,
  };
}

function assertAllowed(parsed: ParsedArgs, command: string, sub: string | undefined): void {
  const allowed = allowedFlags(command, sub);
  for (const name of parsed.flags.keys()) {
    if (!allowed.has(name)) {
      throw new AnsError("USAGE", `Flag --${name} is not valid here.`, {
        hint: `Run \`ans ${command}${sub && command === "auth" ? ` ${sub}` : ""} --help\`.`,
      });
    }
  }
}

function allowedFlags(command: string, sub: string | undefined): Set<string> {
  const common = ["help", "json", "home", "registry"];
  switch (command) {
    case "init":
      return new Set(["help", "json", "force", "demo", "home"]);
    case "register":
      return new Set([
        ...common,
        "name",
        "display-name",
        "description",
        "protocol",
        "endpoint",
        "mode",
        "key",
        "capabilities",
        "registered-at",
      ]);
    case "resolve":
      return new Set([...common, "zone", "pin", "offline", "public-registry", "name"]);
    case "list":
      return new Set(common);
    case "serve":
      return new Set([...common, "port", "host"]);
    case "auth":
      if (sub === "keygen") {
        return new Set(["help", "json", "out", "force", "home"]);
      }
      if (sub === "issue") {
        return new Set([...common, "name", "key", "audience", "ttl", "out"]);
      }
      return new Set([...common, "name", "assertion", "audience", "allow-unregistered", "pin"]);
    default:
      return new Set(["help", "json"]);
  }
}

function helpFor(command: string | undefined, sub: string | undefined): string {
  if (command === undefined || command === "help") {
    return rootHelp();
  }
  if (!COMMANDS.has(command) && command !== "auth") {
    throw new AnsError("USAGE", `Unknown command "${command}".`, { hint: "Run `ans --help`." });
  }
  return commandHelp(command, sub);
}

function rejectExtra(parsed: ParsedArgs, expected: number): void {
  if (parsed.positional.length > expected) {
    const extra = parsed.positional[expected];
    throw new AnsError("USAGE", `Unexpected argument "${extra ?? ""}".`, {
      hint: "Run the command with --help to see the expected arguments.",
    });
  }
}

function resolveNameArg(parsed: ParsedArgs): string {
  const positional = parsed.positional.slice(1);
  if (positional.length > 1) {
    throw new AnsError("USAGE", "resolve accepts one ANSName.", {
      hint: "Example: ans resolve ans://v1.4.2.travel.example.com",
    });
  }
  const fromFlag = flagString(parsed.flags, "name");
  const fromPos = positional[0];
  if (fromFlag !== undefined && fromPos !== undefined && fromFlag !== fromPos) {
    throw new AnsError("USAGE", "The positional name and --name disagree.");
  }
  const name = fromFlag ?? fromPos;
  if (name === undefined) {
    throw new AnsError("USAGE", "Missing ANSName.", {
      hint: "Example: ans resolve ans://v1.4.2.travel.example.com",
    });
  }
  return name;
}

function parseMode(value: string): "direct" | "fetch" {
  if (value === "direct" || value === "fetch") {
    return value;
  }
  throw new AnsError("USAGE", "--mode must be direct or fetch.");
}

function splitCapabilities(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.split(",").map((item) => item.trim());
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new AnsError("USAGE", `Port "${value}" is not an integer.`);
  }
  const port = Number(value);
  if (port < 0 || port > 65535) {
    throw new AnsError("USAGE", "Port must be between 0 and 65535.");
  }
  return port;
}

function parseTtl(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new AnsError("USAGE", "--ttl must be a whole number of seconds.");
  }
  return Number(value);
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

async function readPin(cwd: string, input: string): Promise<string> {
  const filePath = resolve(cwd, input);
  if (await pathExists(filePath)) {
    const text = await readText(filePath);
    if (text.includes("-----BEGIN")) {
      return publicKeyFromPem(text).x;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new AnsError("INVALID_KEY", `Pin file ${filePath} is not PEM or JSON.`);
    }
    return assertPublicKey(parsed).x;
  }
  return assertPublicKey({ kty: "OKP", crv: "Ed25519", x: input }).x;
}

async function readAssertion(filePath: string): Promise<SignedAssertion> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    throw new AnsError("IO", `Could not read assertion ${filePath}.`, { cause: error });
  }
  try {
    return JSON.parse(text) as SignedAssertion;
  } catch {
    throw new AnsError("ASSERTION_INVALID", `Assertion file ${filePath} is not JSON.`);
  }
}
