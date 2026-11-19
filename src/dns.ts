import type { DnsRecordSet, RegistrationDocument } from "./types.js";

const TTL = 3600;

export function badgeUrlFor(ansName: string, base = "ans-local://v0/badges"): string {
  const trimmed = base.replace(/\/$/, "");
  return `${trimmed}/${encodeURIComponent(ansName)}`;
}

/**
 * Project a registration into the DNS record shapes described in public ANS-3 text.
 * The SVCB row is illustrative: this toolkit does not emit DNS-AID wire format.
 */
export function buildDnsRecordSet(
  document: RegistrationDocument,
  options?: { badgeBaseUrl?: string },
): DnsRecordSet {
  const version = `v${document.version}`;
  const discovery = [
    "v=ans1",
    `version=${version}`,
    `p=${document.endpoint.protocol}`,
    `mode=${document.endpoint.mode}`,
    `url=${document.endpoint.url}`,
  ].join("; ");
  const badgeUrl = badgeUrlFor(document.ansName, options?.badgeBaseUrl);
  const badge = `v=ans-badge1; version=${version}; url=${badgeUrl}`;
  const svcb = `1 . alpn="${document.endpoint.protocol},h2"`;
  const records: DnsRecordSet["records"] = [
    {
      name: `_ans.${document.agentHost}`,
      type: "TXT",
      ttl: TTL,
      profile: "ANS_TXT",
      value: discovery,
    },
    {
      name: `_ans-badge.${document.agentHost}`,
      type: "TXT",
      ttl: TTL,
      profile: "badge",
      value: badge,
    },
    {
      name: document.agentHost,
      type: "SVCB",
      ttl: TTL,
      profile: "ANS_DNSAID",
      value: svcb,
      illustrative: true,
    },
  ];
  const zone = [
    "; ans-kit DNS projection — unofficial, local, not an authoritative zone",
    `; ANSName: ${document.ansName}`,
    "; SVCB is an illustrative stand-in for the ANS_DNSAID profile, not DNS-AID wire format.",
    "$TTL 3600",
    `${records[0]?.name}. ${TTL} IN TXT "${escapeZone(discovery)}"`,
    `${records[1]?.name}. ${TTL} IN TXT "${escapeZone(badge)}"`,
    `; illustrative`,
    `${document.agentHost}. ${TTL} IN SVCB ${svcb}`,
    "",
  ].join("\n");
  return {
    ansName: document.ansName,
    agentHost: document.agentHost,
    records,
    zone,
  };
}

export function parseTxtRecord(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of value.split(";")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function escapeZone(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
