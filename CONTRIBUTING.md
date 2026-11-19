# Contributing

ans-kit is an unofficial toolkit. Changes here do not change the Agent Name
Service specification, and this repository is not a Linux Foundation project.

## Setup

Node.js 20 or newer. Clone the source repository. Do not `npm install ans-kit` from the public npm registry; that name belongs to an unrelated package.

```bash
git clone https://github.com/tz0127302-cell/ans-kit.git
cd ans-kit
npm install
npm test
npm run lint
npm run typecheck
```

`npm test` builds `dist/` and runs the unit tests. `npm run smoke` repeats the
README quickstart against the built CLI.

## Pull requests

- Keep the change focused.
- Use [conventional commits](https://www.conventionalcommits.org/) (`feat`, `fix`, `docs`, `test`, `chore`, `refactor`).
- Add or update tests for behavior you change.
- Do not commit `.ans/` directories, private keys, or real credentials.
- Keep the unofficial-project wording accurate if you touch the README or CLI help.

## Spec drift

Name parsing follows the public ANS-2 draft (0.3.0, 2026-11-03): `ans://v{major}.{minor}.{patch}.{agentHost}`. DNS text follows the published `_ans` / `_ans-badge` shapes. If those documents change, update `src/name.ts`, `src/dns.ts`, and `docs/protocol.md` together, and say so in the changelog.

Ed25519 assertions are an ans-kit profile (`ans-kit-ed25519-v0`). They are not a stand-in you should advertise as ANS-6 mTLS.
