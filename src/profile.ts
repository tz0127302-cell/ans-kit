/**
 * Public profile of this toolkit.
 *
 * Naming follows ANS-2 (`ans://v{major}.{minor}.{patch}.{agentHost}`).
 * DNS text follows the published `_ans` / `_ans-badge` shapes.
 * Signatures are an ans-kit developer profile, not ANS-6 mTLS certificates.
 */
export const TOOLKIT = {
  name: "ans-kit",
  unofficial: true,
  signatureProfile: "ans-kit-ed25519-v0",
  assertionType: "ans-kit-assertion-v0",
  registryFormat: "ans-kit-registry-v0",
  ansNamePattern: "ans://v{major}.{minor}.{patch}.{agentHost}",
  defaultHost: "127.0.0.1",
  defaultPort: 4080,
  defaultAssertionTtlSeconds: 300,
  maxAssertionTtlSeconds: 24 * 60 * 60,
  clockSkewMs: 5_000,
  genesisHash: "0".repeat(64),
  alignedWith: [
    "ANS-2 versioned names, draft 0.3.0 (2026-11-03)",
    "ANS-3 record families: _ans TXT (v=ans1), _ans-badge TXT (v=ans-badge1), SVCB projection",
  ],
} as const;
