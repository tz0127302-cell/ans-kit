import { AnsError } from "./errors.js";

const ANS_NAME = /^ans:\/\/v(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(.+)$/;

const LABEL = /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])$/;

export interface ParsedAnsName {
  /** Canonical ANSName, lowercase host, numeric version without extra zeros. */
  ansName: string;
  /** `major.minor.patch` without the `v` prefix. */
  version: string;
  /** `v` + version, as carried in DNS TXT records. */
  versionLabel: string;
  agentHost: string;
  labels: string[];
}

/**
 * Parse an ANSName.
 *
 * Grammar from the public ANS-2 draft (0.3.0, 2026-11-03):
 * `ans://v{major}.{minor}.{patch}.{agentHost}`
 *
 * `agentHost` is an LDH FQDN (RFC 1123) with at least two labels.
 * A trailing DNS root dot is accepted and removed.
 * A host that ends in `.ans` is an ordinary FQDN, not a special suffix.
 */
export function parseAnsName(input: string): ParsedAnsName {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw invalidName("ANSName is empty.", nameHint());
  }
  if (!trimmed.includes("://")) {
    throw invalidName(
      `"${truncate(trimmed)}" is not an ANSName.`,
      "ANS names look like ans://v1.4.2.travel.example.com. A bare host is the agentHost, not the full name.",
    );
  }
  if (!trimmed.startsWith("ans://")) {
    throw invalidName(
      `"${truncate(trimmed)}" does not use the ans:// scheme.`,
      "The scheme is lowercase ans://. Example: ans://v1.4.2.travel.example.com.",
    );
  }
  const match = ANS_NAME.exec(trimmed);
  if (!match) {
    throw invalidName(
      `"${truncate(trimmed)}" does not match ans://v{major}.{minor}.{patch}.{host}.`,
      "Version is numeric major.minor.patch only. Pre-release tags such as -beta are rejected by ANS-2.",
    );
  }
  const major = match[1];
  const minor = match[2];
  const patch = match[3];
  const hostInput = match[4];
  if (
    major === undefined ||
    minor === undefined ||
    patch === undefined ||
    hostInput === undefined
  ) {
    throw invalidName("ANSName could not be parsed.", nameHint());
  }
  const agentHost = parseAgentHost(hostInput);
  assertBadgeNameFits(agentHost);
  const version = `${major}.${minor}.${patch}`;
  const versionLabel = `v${version}`;
  return {
    ansName: `ans://${versionLabel}.${agentHost}`,
    version,
    versionLabel,
    agentHost,
    labels: agentHost.split("."),
  };
}

export function formatAnsName(version: string, agentHost: string): string {
  return parseAnsName(`ans://v${version.replace(/^v/, "")}.${agentHost}`).ansName;
}

export function parseAgentHost(input: string): string {
  let host = input.trim().toLowerCase();
  if (host.endsWith(".")) {
    host = host.slice(0, -1);
  }
  if (host.length === 0) {
    throw invalidName("agentHost is empty.", "Use an FQDN such as travel.example.com.");
  }
  if (host.length > 253) {
    throw invalidName(
      "agentHost is longer than 253 characters.",
      "ANS-2 limits the host to the DNS name limit.",
    );
  }
  if (host.includes("..") || host.includes(" ")) {
    throw invalidName(
      `"${truncate(host)}" is not an LDH host.`,
      "Labels are letters, digits, and interior hyphens.",
    );
  }
  const labels = host.split(".");
  if (labels.length < 2) {
    throw invalidName(
      `"${host}" needs at least two labels.`,
      "ANS-2 requires an FQDN. `localhost` is a single label; `travel.example.com` is valid.",
    );
  }
  for (const label of labels) {
    if (!LABEL.test(label)) {
      const unicode = [...label].some((char) => (char.codePointAt(0) ?? 0) > 0x7f);
      throw invalidName(
        `Host label "${truncate(label)}" is not LDH.`,
        unicode
          ? "ANS-2 host labels are LDH. Encode international names as punycode (xn--)."
          : "Each label is 1–63 characters, letters, digits, or interior hyphens, and does not start or end with a hyphen.",
      );
    }
  }
  return host;
}

function assertBadgeNameFits(agentHost: string): void {
  const badge = `_ans-badge.${agentHost}`;
  if (badge.length > 253) {
    throw invalidName(
      "agentHost is too long to publish an _ans-badge DNS name.",
      "Keep the host short enough that `_ans-badge.<host>` is at most 253 characters.",
    );
  }
}

function invalidName(message: string, hint: string): AnsError {
  return new AnsError("INVALID_NAME", message, { hint });
}

function nameHint(): string {
  return "Example: ans://v1.4.2.travel.example.com";
}

function truncate(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}
