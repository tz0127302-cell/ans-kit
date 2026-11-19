import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPair } from "../src/keys.js";
import { LocalRegistry } from "../src/registry.js";
import { resolveName } from "../src/resolve.js";
import { startRegistryServer } from "../src/server.js";
import { signRegistration } from "../src/sign.js";
import { removeDir, tempDir } from "./helpers.js";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(dirs.splice(0).map((dir) => removeDir(dir)));
});

describe("remote registry and HTTP server", () => {
  it("does not touch the network when the remote client is off", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const keys = generateKeyPair();
    const now = new Date("2026-11-16T12:00:00.000Z");
    const registry = await LocalRegistry.create(join(dir, "registry.json"));
    const signed = signRegistration(
      {
        ansName: "ans://v1.4.2.travel.example.com",
        agentDisplayName: "Travel Concierge",
        endpoint: { protocol: "mcp", url: "https://travel.example.com/mcp", mode: "direct" },
        registeredAt: now,
      },
      keys.privateKeyPem,
      { now },
    );
    await registry.register(signed);
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new Error("network");
    }) as typeof fetch;
    const resolved = await resolveName(registry, signed.document.ansName, {
      fetchImpl,
      remote: { enabled: true, url: "http://127.0.0.1:9" },
    });
    expect(resolved.source).toBe("local");
    expect(calls).toBe(0);
    await expect(
      resolveName(registry, "ans://v9.9.9.missing.example", {
        fetchImpl,
        remote: { enabled: false, url: "http://127.0.0.1:9" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls).toBe(0);
  });

  it("verifies a record fetched from another ans-kit server", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const keys = generateKeyPair();
    const now = new Date("2026-11-16T12:00:00.000Z");
    const source = await LocalRegistry.create(join(dir, "source.json"));
    const signed = signRegistration(
      {
        ansName: "ans://v2.1.0.billing.example.com",
        agentDisplayName: "Billing Desk",
        agentDescription: "Issues invoices and matches purchase orders.",
        endpoint: { protocol: "a2a", url: "https://billing.example.com/a2a", mode: "direct" },
        registeredAt: now,
      },
      keys.privateKeyPem,
      { now },
    );
    await source.register(signed);
    const running = await startRegistryServer({ registry: source, host: "127.0.0.1", port: 0 });
    closers.push(running.close);
    const empty = await LocalRegistry.create(join(dir, "empty.json"));
    const resolved = await resolveName(empty, signed.document.ansName, {
      remote: { enabled: true, url: running.url },
    });
    expect(resolved.source).toBe("remote");
    expect(resolved.verified).toBe(true);
    expect(resolved.record.document.agentDisplayName).toBe("Billing Desk");

    const health = await fetch(`${running.url}/health`);
    const healthBody = (await health.json()) as { data: { unofficial: boolean; agents: number } };
    expect(healthBody.data.unofficial).toBe(true);
    expect(healthBody.data.agents).toBe(1);

    const page = await fetch(running.url);
    const html = await page.text();
    expect(html).toContain("Billing Desk");
    expect(html).toContain("unofficial");
    expect(html).toContain("Linux Foundation");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");

    const badge = await fetch(
      `${running.url}/v0/badges/${encodeURIComponent(signed.document.ansName)}`,
    );
    const badgeBody = (await badge.json()) as { data: { note: string; ansName: string } };
    expect(badgeBody.data.ansName).toBe(signed.document.ansName);
    expect(badgeBody.data.note).toContain("not a SCITT receipt");

    const dns = await fetch(
      `${running.url}/v0/dns?name=${encodeURIComponent(signed.document.ansName)}`,
    );
    const dnsBody = (await dns.json()) as { data: { zone: string } };
    expect(dnsBody.data.zone).toContain("v=ans1");

    const missing = await fetch(
      `${running.url}/v0/resolve?name=${encodeURIComponent("ans://v0.0.1.missing.example")}`,
    );
    expect(missing.status).toBe(404);

    const bad = await fetch(`${running.url}/v0/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ document: signed.document, signature: "aa" }),
    });
    expect(bad.status).toBe(422);

    const created = await fetch(`${running.url}/v0/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        signRegistration(
          {
            ansName: "ans://v1.0.0.dispatch.example.com",
            agentDisplayName: "Dispatch",
            endpoint: { protocol: "https", url: "https://dispatch.example.com/a2a" },
            registeredAt: now,
          },
          keys.privateKeyPem,
          { now },
        ),
      ),
    });
    expect(created.status).toBe(201);
  });

  it("reports a down remote without pretending it is authoritative", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const registry = await LocalRegistry.create(join(dir, "registry.json"));
    await expect(
      resolveName(registry, "ans://v1.0.0.dispatch.example.com", {
        remote: { enabled: true, url: "http://127.0.0.1:9" },
      }),
    ).rejects.toMatchObject({ code: "PUBLIC_REGISTRY_UNAVAILABLE" });
  });
});
