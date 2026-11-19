import type { ListedAgent } from "./types.js";

export function renderHome(options: {
  version: string;
  agents: ListedAgent[];
  url: string;
}): string {
  const shown = options.agents.slice(0, 200);
  const extra =
    options.agents.length > shown.length
      ? `<p class="meta">Showing 200 of ${options.agents.length} agents. The JSON API returns the full list.</p>`
      : "";
  const cards =
    shown.length === 0
      ? `<article class="empty"><h2>No agents yet</h2><p>From the project directory, run <code>ans init --demo</code> or <code>ans register --help</code>.</p></article>`
      : shown.map((agent) => agentCard(agent)).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ans-kit local registry</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; background: #f3efe4; color: #1c1915; font-family: "Iowan Old Style", Palatino, Georgia, serif; }
    .wrap { max-width: 860px; margin: 0 auto; padding: 36px 20px 72px; }
    .kicker { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: 0.08em; text-transform: uppercase; font-size: 12px; }
    h1 { font-weight: 560; font-size: 42px; letter-spacing: -0.03em; margin: 8px 0 12px; }
    .banner { border: 1px solid #1c1915; background: #fff6e4; padding: 12px 14px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; line-height: 1.45; }
    .meta, .name { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .meta { color: #5e584e; font-size: 13px; }
    article { margin-top: 16px; background: #fffdf8; border: 1px solid #ddd4c4; padding: 14px 16px 16px; }
    h2 { margin: 0 0 6px; font-size: 22px; font-weight: 560; }
    .name { font-size: 14px; margin: 0 0 8px; word-break: break-all; }
    a { color: inherit; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; }
    footer { margin-top: 28px; }
    @media (max-width: 640px) { h1 { font-size: 32px; } .wrap { padding-top: 24px; } }
    @media (prefers-color-scheme: dark) {
      body { background: #141210; color: #f4ecdf; }
      .banner { background: #2a2218; border-color: #f4ecdf; }
      article { background: #1c1916; border-color: #3c342b; }
      .meta { color: #c3b8a6; }
    }
  </style>
</head>
<body>
  <main class="wrap">
    <p class="kicker">ans-kit ${escapeHtml(options.version)} · unofficial</p>
    <h1>Local agent registry</h1>
    <p class="banner">Independent dev toolkit inspired by the public Agent Name Service announcement. Not affiliated with the Linux Foundation, Cisco, Salesforce, or Cloudflare. Names use ans://v{version}.{host}. Signatures are Ed25519, checked on resolve.</p>
    ${cards}
    ${extra}
    <footer class="meta">
      <p>${shown.length} shown · listening on ${escapeHtml(options.url)}</p>
      <p>JSON: <a href="/health">/health</a> · <a href="/v0/agents">/v0/agents</a> · <a href="/v0/log">/v0/log</a></p>
    </footer>
  </main>
</body>
</html>
`;
}

function agentCard(agent: ListedAgent): string {
  const check = agent.verified ? "Ed25519 signature ok" : "signature failed";
  return `<article>
  <h2>${escapeHtml(agent.agentDisplayName)}</h2>
  <p class="name">${escapeHtml(agent.ansName)}</p>
  <p class="meta">${escapeHtml(agent.protocol)} · ${escapeHtml(agent.endpoint)} · ${check} · log #${agent.logIndex}</p>
</article>`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
