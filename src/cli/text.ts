import { relative } from "node:path";
import { shortKey } from "../keys.js";
import type { AssertionCheck, ListedAgent, ResolveResult, StoredAgent } from "../types.js";

export interface Paint {
  bold: (value: string) => string;
  dim: (value: string) => string;
  red: (value: string) => string;
  green: (value: string) => string;
  cyan: (value: string) => string;
}

export function paint(enabled: boolean): Paint {
  const wrap = (code: string) => (value: string) =>
    enabled ? `\u001b[${code}m${value}\u001b[0m` : value;
  return {
    bold: wrap("1"),
    dim: wrap("2"),
    red: wrap("31"),
    green: wrap("32"),
    cyan: wrap("36"),
  };
}

export function displayPath(cwd: string, target: string): string {
  const rel = relative(cwd, target);
  if (rel === "") {
    return ".";
  }
  return rel.startsWith("..") ? target : rel;
}

export function formatInit(options: {
  cwd: string;
  home: string;
  registryPath: string;
  replaced: boolean;
  demoAgents: string[];
  color: Paint;
}): string {
  const lines = [
    options.replaced
      ? "Replaced the local ans-kit registry."
      : "Initialized a local ans-kit registry.",
    `  registry  ${displayPath(options.cwd, options.registryPath)}`,
    `  config    ${displayPath(options.cwd, `${options.home}/config.json`)}`,
    "  remote    off",
    "",
  ];
  if (options.demoAgents.length > 0) {
    lines.push("Demo agents (signatures verify offline):");
    for (const name of options.demoAgents) {
      lines.push(`  ${options.color.cyan(name)}`);
    }
    lines.push("Demo private keys are in .ans/keys/. They are disposable and local.", "");
    lines.push("Next:");
    lines.push(`  ans resolve ${options.demoAgents[0]}`);
  } else {
    lines.push("Add .ans/ to .gitignore. Private keys stay on this machine.", "");
    lines.push("Next:");
    lines.push("  ans init --demo");
    lines.push("  ans auth keygen --out .ans/keys/my-agent");
    lines.push("  ans register --help");
  }
  return `${lines.join("\n")}\n`;
}

export function formatRegister(record: StoredAgent, color: Paint): string {
  const doc = record.document;
  const lines = [
    `Registered ${color.cyan(doc.ansName)}`,
    `  display    ${doc.agentDisplayName}`,
    `  endpoint   ${doc.endpoint.protocol} ${doc.endpoint.mode} ${doc.endpoint.url}`,
    `  key        ed25519 ${shortKey(doc.publicKey.x)}`,
    `  log        #${record.logIndex}`,
    `  signature  ${color.green("ok")}`,
  ];
  return `${lines.join("\n")}\n`;
}

export function formatResolve(result: ResolveResult, color: Paint): string {
  const doc = result.record.document;
  const lines = [
    color.bold(doc.agentDisplayName),
    `  name         ${doc.ansName}`,
    `  host         ${doc.agentHost}`,
    `  version      ${doc.version}`,
    `  status       ${result.record.status}`,
    `  endpoint     ${doc.endpoint.protocol} ${doc.endpoint.mode} ${doc.endpoint.url}`,
  ];
  if (doc.agentDescription !== undefined) {
    lines.push(`  description  ${doc.agentDescription}`);
  }
  if (doc.capabilities !== undefined) {
    lines.push(`  capabilities ${doc.capabilities.join(", ")}`);
  }
  lines.push(`  key          ed25519 ${shortKey(doc.publicKey.x)}`);
  lines.push(`  signature    ${color.green("ok")}`);
  if (result.logEntry !== undefined) {
    lines.push(`  log          #${result.logEntry.index}  ${result.logEntry.hash.slice(0, 12)}`);
  }
  lines.push(`  source       ${result.source}`);
  lines.push("", "DNS projection");
  for (const record of result.dns.records) {
    const note = record.illustrative ? "  (illustrative)" : "";
    const body = record.type === "TXT" ? `TXT "${record.value}"` : `SVCB ${record.value}`;
    lines.push(`  ${record.name}. ${body}${note}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatList(
  agents: ListedAgent[],
  registryPath: string,
  cwd: string,
  color: Paint,
): string {
  if (agents.length === 0) {
    return [
      "No agents registered.",
      "Run `ans init --demo` for sample names, or `ans register --help`.",
      "",
    ].join("\n");
  }
  const lines = [
    `${agents.length} agent${agents.length === 1 ? "" : "s"} in ${displayPath(cwd, registryPath)}`,
    "",
  ];
  for (const agent of agents) {
    const check = agent.verified ? color.green("signature ok") : color.red("signature failed");
    lines.push(color.cyan(agent.ansName));
    lines.push(`  ${agent.agentDisplayName} · v${agent.version} · ${agent.status} · ${check}`);
    lines.push(`  ${agent.protocol}  ${agent.endpoint}`);
    lines.push("");
  }
  return `${lines.join("\n")}`;
}

export function formatKeys(paths: {
  cwd: string;
  privatePath: string;
  publicPath: string;
  jwkPath: string;
}): string {
  return [
    "Created an Ed25519 key pair",
    `  private  ${displayPath(paths.cwd, paths.privatePath)}`,
    `  public   ${displayPath(paths.cwd, paths.publicPath)}`,
    `  jwk      ${displayPath(paths.cwd, paths.jwkPath)}`,
    "",
    "The private key signs registrations. ans-kit does not upload it.",
    "",
  ].join("\n");
}

export function formatVerifyName(result: ResolveResult, color: Paint): string {
  const doc = result.record.document;
  return [
    color.green("Verified registration"),
    `  name       ${doc.ansName}`,
    `  key        ed25519 ${shortKey(doc.publicKey.x)}`,
    `  signature  ok`,
    `  source     ${result.source}`,
    "",
  ].join("\n");
}

export function formatAssertion(check: AssertionCheck, color: Paint, file?: string): string {
  const lines = [
    color.green("Verified assertion"),
    `  name      ${check.ansName}`,
    `  audience  ${check.audience ?? "(none)"}`,
    `  expires   ${check.expiresAt}`,
    `  registry  ${check.registry}`,
  ];
  if (file !== undefined) {
    lines.splice(1, 0, `  file      ${file}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatIssued(
  check: { ansName: string; expiresAt: string; audience: string | null },
  file: string,
): string {
  return [
    "Issued an assertion",
    `  name      ${check.ansName}`,
    `  audience  ${check.audience ?? "(none)"}`,
    `  expires   ${check.expiresAt}`,
    `  file      ${file}`,
    "",
  ].join("\n");
}

export function formatServe(options: { url: string; host: string; color: Paint }): string {
  return [
    options.color.bold(`ans-kit local registry listening on ${options.url}`),
    "Unofficial dev registry. Not a Linux Foundation service. Ctrl+C to stop.",
    options.host === "127.0.0.1" || options.host === "localhost" || options.host === "::1"
      ? "Bound to loopback."
      : "Bound beyond loopback. Anyone who can reach this port can submit a signed registration.",
    "",
  ].join("\n");
}
