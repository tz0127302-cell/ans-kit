# Changelog

## 0.1.0

- Local file registry with an append-only hash chain.
- CLI: `init`, `register`, `resolve`, `list`, `auth`, `serve`.
- ANS-2 style names (`ans://v{major}.{minor}.{patch}.{host}`).
- Ed25519 signed registrations and short-lived assertions.
- DNS projection for `_ans` TXT, `_ans-badge` TXT, and an illustrative SVCB row.
- Optional remote client for another ans-kit server, disabled by default.
- Demo agents and an offline quickstart.
