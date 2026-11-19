export interface Ed25519PublicKey {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

export interface AgentEndpoint {
  protocol: string;
  url: string;
  mode: "direct" | "fetch";
}

/** Bytes covered by the Ed25519 registration signature. */
export interface RegistrationDocument {
  alg: "Ed25519";
  ansName: string;
  agentHost: string;
  version: string;
  agentDisplayName: string;
  agentDescription?: string;
  endpoint: AgentEndpoint;
  capabilities?: string[];
  publicKey: Ed25519PublicKey;
  registeredAt: string;
}

export interface SignedRegistration {
  document: RegistrationDocument;
  signature: string;
}

export type AgentStatus = "ACTIVE";

export interface StoredAgent {
  document: RegistrationDocument;
  signature: string;
  status: AgentStatus;
  logIndex: number;
}

export interface LogEntry {
  index: number;
  type: "AGENT_REGISTERED";
  ansName: string;
  payloadHash: string;
  previousHash: string;
  hash: string;
}

export interface AssertionDocument {
  typ: "ans-kit-assertion-v0";
  alg: "Ed25519";
  ansName: string;
  publicKey: Ed25519PublicKey;
  audience?: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export interface SignedAssertion extends AssertionDocument {
  signature: string;
}

export interface AssertionCheck {
  ansName: string;
  audience: string | null;
  issuedAt: string;
  expiresAt: string;
  registry: "matched" | "unchecked";
}

export interface DnsRecord {
  name: string;
  type: "TXT" | "SVCB";
  ttl: number;
  profile: "ANS_TXT" | "ANS_DNSAID" | "badge";
  value: string;
  illustrative?: boolean;
}

export interface DnsRecordSet {
  ansName: string;
  agentHost: string;
  records: DnsRecord[];
  zone: string;
}

export interface ResolveResult {
  source: "local" | "remote";
  verified: true;
  record: StoredAgent;
  dns: DnsRecordSet;
  logEntry: LogEntry | undefined;
  remoteUrl?: string;
}

export interface ListedAgent {
  ansName: string;
  agentHost: string;
  version: string;
  agentDisplayName: string;
  status: AgentStatus;
  protocol: string;
  endpoint: string;
  verified: boolean;
  logIndex: number;
}
