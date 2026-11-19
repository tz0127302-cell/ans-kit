# Security

ans-kit is a local development toolkit. The registry file on disk is the trust
anchor for names you register on this machine.

## What a signature proves

An Ed25519 signature proves that the holder of the matching private key produced
that registration document or assertion. It does not prove control of the DNS
zone for `agentHost`. The public ANS design uses a proof-of-control step and a
registration authority. This toolkit does not.

## What to keep private

- `*.private.pem` files under `.ans/keys/`
- Assertion files. They are bearer credentials until they expire.
- Do not commit `.ans/`.

Demo keys created by `ans init --demo` are generated on your machine. They are
disposable fixtures. Do not reuse them anywhere you need a real identity.

## The HTTP server

`ans serve` binds to `127.0.0.1` unless you pass `--host`. The HTTP API has no
password. A client that can reach the port can submit a registration if it also
holds a valid signature. Do not expose the server to a network you do not trust.

## Remote lookup

Remote lookup is off by default. When you set `--public-registry` or
`ANS_PUBLIC_REGISTRY_URL`, ans-kit sends the ANSName to that URL and checks the
Ed25519 signature locally. That URL is another ans-kit server you choose. It is
not a Linux Foundation root.

## Reporting

This is not the ANS project's security contact. Issues in this toolkit can be
reported through the repository you cloned. Please do not include private keys
in the report.
