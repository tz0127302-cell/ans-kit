# ans-kit protocol v0

This is the on-disk and on-the-wire profile implemented by ans-kit 0.1. It is a
developer profile inspired by the public Agent Name Service documents. It is
not the ANS specification.

Aligned with, as published:

- ANS-2 versioned names, draft 0.3.0 (2026-11-03): `ans://v{major}.{minor}.{patch}.{agentHost}`
- ANS-3 record families: `_ans` TXT (`v=ans1`), `_ans-badge` TXT (`v=ans-badge1`), plus an illustrative SVCB row for the default DNS-AID profile

Where this profile is narrower:

- Signatures are Ed25519 over canonical JSON (`ans-kit-ed25519-v0`). Public ANS agent authentication (ANS-6) uses Identity Certificates (URI SAN + DNS SAN) with mTLS, and DPoP as another caller method.
- There is no proof-of-control challenge for `agentHost` (ANS-0) and no private CA.
- The transparency log is a local hash chain, not a SCITT receipt (ANS-4).
- The SVCB line is a readable projection, not DNS-AID wire format, and there is no TLSA record.
- The optional remote client speaks this same HTTP API. It is off by default and it is not a root registry.

## ANSName

```text
ans://v{major}.{minor}.{patch}.{agentHost}
```

Example: `ans://v1.4.2.travel.example.com`

| Piece | Rule |
| --- | --- |
| Scheme | Lowercase `ans` |
| Version | Numeric `major.minor.patch` only. No pre-release or build suffix. No leading zeros. |
| agentHost | LDH FQDN, at least two labels, each 1–63 characters, total at most 253. A trailing root dot is stripped. |
| Badge name | `_ans-badge.{agentHost}` must also fit in 253 characters. |

A host such as `agent.example.ans` is only an FQDN that happens to end in the label `ans`. The scheme is `ans://`. There is no special `.ans` suffix.

The display name (max 64 characters) and description (max 150) are metadata. They are not part of the ANSName. Versions of the same host coexist. A version string is consumed once.

## Canonical JSON

The signed message is UTF-8 canonical JSON:

- Objects have keys sorted lexicographically.
- `undefined` fields are omitted.
- Arrays keep their order.
- Strings and booleans use `JSON.stringify`.
- No whitespace.

Registration signatures and assertion signatures both use this function. The `signature` field is not part of the message.

## Registration document

```json
{
  "alg": "Ed25519",
  "ansName": "ans://v1.0.0.dispatch.example.com",
  "agentHost": "dispatch.example.com",
  "version": "1.0.0",
  "agentDisplayName": "Dispatch",
  "agentDescription": "Routes work between travel and billing agents.",
  "endpoint": {
    "protocol": "a2a",
    "url": "https://dispatch.example.com/a2a",
    "mode": "direct"
  },
  "capabilities": ["routing"],
  "publicKey": { "kty": "OKP", "crv": "Ed25519", "x": "<32-byte base64url>" },
  "registeredAt": "2026-11-16T12:00:00.000Z"
}
```

`agentHost` and `version` are derived from `ansName`. The signature is the Ed25519 signature of the canonical document, encoded base64url (64 bytes). The public key inside the document is the key that verifies it, which is proof of possession at registration time.

`endpoint.mode` is `direct` or `fetch`. `endpoint.url` is `http` or `https` without userinfo. Capabilities are optional, at most 8 tokens.

## Local registry file

`.ans/registry.json`:

```json
{
  "format": "ans-kit-registry-v0",
  "createdAt": "2026-11-16T12:00:00.000Z",
  "agents": [
    {
      "document": {},
      "signature": "<base64url>",
      "status": "ACTIVE",
      "logIndex": 0
    }
  ],
  "log": [
    {
      "index": 0,
      "type": "AGENT_REGISTERED",
      "ansName": "ans://v1.0.0.dispatch.example.com",
      "payloadHash": "<sha256 hex of the canonical document>",
      "previousHash": "<64 zero hex chars for the first entry>",
      "hash": "<sha256 hex of the canonical log entry without the hash field>"
    }
  ]
}
```

Resolve checks the hash chain and the Ed25519 signature. A mismatch is an error. The chain detects edits. The signature detects a rebuilt chain made with a different key. The file itself is the local trust anchor: anyone who can write the file and who holds some Ed25519 key can register a new name.

## Assertion

```json
{
  "typ": "ans-kit-assertion-v0",
  "alg": "Ed25519",
  "ansName": "ans://v1.0.0.dispatch.example.com",
  "publicKey": { "kty": "OKP", "crv": "Ed25519", "x": "..." },
  "audience": "billing.example.com",
  "nonce": "<base64url, at least 16 bytes>",
  "issuedAt": "2026-11-16T12:00:00.000Z",
  "expiresAt": "2026-11-16T12:05:00.000Z",
  "signature": "<base64url>"
}
```

The signature covers every field except `signature`. Default lifetime is 300 seconds, maximum 86400. Verification checks the signature, the time window (5 seconds of skew), the audience if you pass one, and, unless `--allow-unregistered` is set, that the public key matches the local registration.

## DNS projection

For `ans://v1.4.2.travel.example.com` with an `mcp` endpoint:

```text
_ans.travel.example.com. 3600 IN TXT "v=ans1; version=v1.4.2; p=mcp; mode=direct; url=https://travel.example.com/mcp"
_ans-badge.travel.example.com. 3600 IN TXT "v=ans-badge1; version=v1.4.2; url=ans-local://v0/badges/..."
travel.example.com. 3600 IN SVCB 1 . alpn="mcp,h2"
```

The TXT shapes match the published `v=ans1` and `v=ans-badge1` records. The badge URL is `ans-local://...` when you resolve on disk, and `http://127.0.0.1:<port>/v0/badges/<ansName>` when the local server answers. Neither is an HTTPS transparency-log URL. The SVCB row is marked illustrative in JSON (`"illustrative": true`).

`ans resolve <name> --zone` prints this projection.

## HTTP API

`ans serve` listens on `127.0.0.1:4080` by default.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | HTML status page. JSON if `Accept` is only `application/json`. |
| GET | `/health` | Service description, including `unofficial: true`. |
| GET | `/v0/agents` | Local agents. |
| GET | `/v0/log` | Hash chain. |
| GET | `/v0/resolve?name=` | Verify and return one registration. |
| POST | `/v0/resolve` | Body `{ "name": "ans://..." }`. |
| GET | `/v0/dns?name=` | DNS projection. |
| GET | `/v0/badges/:ansName` | Local badge JSON. Not a SCITT receipt. |
| POST | `/v0/agents` | Body `{ "document", "signature" }`. Private keys stay with the client. |
| POST | `/v0/auth/verify` | Body `{ "assertion", "audience"?, "allowUnregistered"? }`. |

Success:

```json
{ "ok": true, "data": {} }
```

Failure:

```json
{ "ok": false, "error": { "code": "NOT_FOUND", "message": "...", "hint": "..." } }
```

Status codes: 400 invalid input, 404 missing, 409 already registered, 422 signature or assertion failure, 405 wrong method.

## Remote client

Set `ANS_PUBLIC_REGISTRY_URL` or pass `--public-registry http://127.0.0.1:4080`.

Resolve order:

1. Local registry. A local hit never contacts the network, even if a remote URL is configured.
2. If the name is missing and a remote URL is enabled, `GET {url}/v0/resolve?name=...`.
3. The client checks the Ed25519 signature itself. Redirects are rejected. Timeout is 5 seconds.

`--offline` skips step 2. With no remote configured, a missing name is `NOT_FOUND`.

## Config

`.ans/config.json`:

```json
{
  "version": 1,
  "registryPath": "registry.json",
  "publicRegistry": { "enabled": false, "url": null }
}
```

`ans init` writes `enabled: false`. Leave it that way for fully offline use.
