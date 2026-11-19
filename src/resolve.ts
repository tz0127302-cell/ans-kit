import { buildDnsRecordSet } from "./dns.js";
import { AnsError } from "./errors.js";
import { samePublicKey } from "./keys.js";
import { parseAnsName } from "./name.js";
import type { LocalRegistry } from "./registry.js";
import { fetchRemoteResolve } from "./remote.js";
import { verifyRegistrationSignature } from "./sign.js";
import type { ResolveResult } from "./types.js";

export interface ResolveOptions {
  remote?: { enabled: boolean; url: string | null };
  fetchImpl?: typeof fetch;
  badgeBaseUrl?: string;
  publicKeyPin?: string;
  verify?: boolean;
}

export async function resolveName(
  registry: LocalRegistry,
  name: string,
  options: ResolveOptions = {},
): Promise<ResolveResult> {
  const parsed = parseAnsName(name);
  const local = await registry.get(parsed.ansName);
  if (local === undefined) {
    const remote = options.remote;
    if (remote?.enabled && remote.url) {
      return fetchRemoteResolve({
        baseUrl: remote.url,
        ansName: parsed.ansName,
        fetchImpl: options.fetchImpl,
        badgeBaseUrl: options.badgeBaseUrl,
        publicKeyPin: options.publicKeyPin,
      });
    }
    throw new AnsError("NOT_FOUND", `No registration for ${parsed.ansName}.`, {
      hint: "Run `ans list` to see local names, or `ans init --demo` for sample agents. Remote lookup is off.",
    });
  }
  if (options.verify !== false) {
    verifyRegistrationSignature(local);
  }
  if (
    options.publicKeyPin !== undefined &&
    !pinMatches(local.document.publicKey.x, options.publicKeyPin)
  ) {
    throw new AnsError("PIN_MISMATCH", "Registered key does not match the pin.", {
      hint: "The pin is the Ed25519 public key (JWK x, a public PEM, or a public JSON file) you expected.",
    });
  }
  const logEntry = registry.snapshot().log[local.logIndex];
  return {
    source: "local",
    verified: true,
    record: local,
    dns: buildDnsRecordSet(local.document, { badgeBaseUrl: options.badgeBaseUrl }),
    logEntry,
  };
}

function pinMatches(actual: string, pin: string): boolean {
  try {
    return samePublicKey(
      { kty: "OKP", crv: "Ed25519", x: actual },
      { kty: "OKP", crv: "Ed25519", x: pin },
    );
  } catch {
    return false;
  }
}
