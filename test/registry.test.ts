import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical.js";
import { buildDnsRecordSet, parseTxtRecord } from "../src/dns.js";
import { AnsError } from "../src/errors.js";
import { generateKeyPair } from "../src/keys.js";
import { LocalRegistry } from "../src/registry.js";
import { resolveName } from "../src/resolve.js";
import {
  issueAssertion,
  registrationPayloadHash,
  signRegistration,
  verifyAssertion,
} from "../src/sign.js";
import { removeDir, tempDir } from "./helpers.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => removeDir(dir)));
});

async function fresh(): Promise<string> {
  const dir = await tempDir();
  dirs.push(dir);
  return dir;
}

function sample(ansName: string, pem: string, now = new Date("2026-11-16T12:00:00.000Z")) {
  return signRegistration(
    {
      ansName,
      agentDisplayName: "Dispatch",
      agentDescription: "Routes work between travel and billing agents.",
      endpoint: {
        protocol: "a2a",
        url: "https://dispatch.example.com/a2a",
        mode: "direct",
      },
      capabilities: ["routing"],
      registeredAt: now,
    },
    pem,
    { now },
  );
}

describe("registry, signatures, and DNS projection", () => {
  it("registers, resolves, and projects DNS records", async () => {
    const dir = await fresh();
    const file = join(dir, "registry.json");
    const keys = generateKeyPair();
    const registry = await LocalRegistry.create(file);
    const signed = sample("ans://v1.0.0.dispatch.example.com", keys.privateKeyPem);
    await registry.register(signed);
    const resolved = await resolveName(registry, "ans://v1.0.0.Dispatch.Example.COM");
    expect(resolved.verified).toBe(true);
    expect(resolved.source).toBe("local");
    expect(resolved.record.document.publicKey).toEqual(keys.publicKey);
    expect(resolved.logEntry?.index).toBe(0);
    expect(resolved.logEntry?.previousHash).toBe("0".repeat(64));
    expect(resolved.logEntry?.payloadHash).toBe(registrationPayloadHash(resolved.record.document));

    const discovery = parseTxtRecord(resolved.dns.records[0]?.value ?? "");
    expect(discovery).toMatchObject({
      v: "ans1",
      version: "v1.0.0",
      p: "a2a",
      mode: "direct",
      url: "https://dispatch.example.com/a2a",
    });
    const badge = parseTxtRecord(resolved.dns.records[1]?.value ?? "");
    expect(badge.v).toBe("ans-badge1");
    expect(badge.version).toBe("v1.0.0");
    expect(resolved.dns.zone).toContain("_ans-badge.dispatch.example.com.");
    expect(resolved.dns.records[2]?.illustrative).toBe(true);
  });

  it("lets two versions of one host coexist and rejects a duplicate version", async () => {
    const dir = await fresh();
    const registry = await LocalRegistry.create(join(dir, "registry.json"));
    const keys = generateKeyPair();
    const now = new Date("2026-11-16T12:00:00.000Z");
    await registry.register(sample("ans://v1.0.0.dispatch.example.com", keys.privateKeyPem, now));
    await registry.register(sample("ans://v1.1.0.dispatch.example.com", keys.privateKeyPem, now));
    await expect(
      registry.register(sample("ans://v1.0.0.dispatch.example.com", keys.privateKeyPem, now)),
    ).rejects.toMatchObject({ code: "ALREADY_REGISTERED" });
    const names = (await registry.list()).map((agent) => agent.ansName);
    expect(names).toEqual([
      "ans://v1.0.0.dispatch.example.com",
      "ans://v1.1.0.dispatch.example.com",
    ]);
  });

  it("fails closed when the signature is replaced", async () => {
    const dir = await fresh();
    const file = join(dir, "registry.json");
    const registry = await LocalRegistry.create(file);
    const keys = generateKeyPair();
    await registry.register(sample("ans://v1.0.0.dispatch.example.com", keys.privateKeyPem));
    const raw = JSON.parse(await readFile(file, "utf8")) as {
      agents: Array<{ signature: string }>;
    };
    const signedAgent = raw.agents[0];
    if (signedAgent === undefined) {
      throw new Error("expected a stored agent");
    }
    signedAgent.signature = Buffer.alloc(64, 7).toString("base64url");
    await writeFile(file, JSON.stringify(raw));
    await expect(resolveName(registry, "ans://v1.0.0.dispatch.example.com")).rejects.toMatchObject({
      code: "SIGNATURE_INVALID",
    });
  });

  it("fails closed when the document is edited", async () => {
    const dir = await fresh();
    const file = join(dir, "registry.json");
    const registry = await LocalRegistry.create(file);
    const keys = generateKeyPair();
    await registry.register(sample("ans://v1.0.0.dispatch.example.com", keys.privateKeyPem));
    const raw = JSON.parse(await readFile(file, "utf8")) as {
      agents: Array<{ document: { agentDisplayName: string } }>;
    };
    const edited = raw.agents[0];
    if (edited === undefined) {
      throw new Error("expected a stored agent");
    }
    edited.document.agentDisplayName = "Someone else";
    await writeFile(file, JSON.stringify(raw));
    await expect(LocalRegistry.open(file)).rejects.toMatchObject({ code: "REGISTRY_CORRUPT" });
  });

  it("rejects a pin that does not match", async () => {
    const dir = await fresh();
    const registry = await LocalRegistry.create(join(dir, "registry.json"));
    const keys = generateKeyPair();
    const other = generateKeyPair();
    await registry.register(sample("ans://v1.0.0.dispatch.example.com", keys.privateKeyPem));
    await expect(
      resolveName(registry, "ans://v1.0.0.dispatch.example.com", {
        publicKeyPin: other.publicKey.x,
      }),
    ).rejects.toMatchObject({ code: "PIN_MISMATCH" });
    const ok = await resolveName(registry, "ans://v1.0.0.dispatch.example.com", {
      publicKeyPin: keys.publicKey.x,
    });
    expect(ok.verified).toBe(true);
  });

  it("rejects unsigned or mismatched keys and overlong metadata", () => {
    const keys = generateKeyPair();
    const other = generateKeyPair();
    const now = new Date("2026-11-16T12:00:00.000Z");
    expect(() =>
      signRegistration(
        {
          ansName: "ans://v1.0.0.dispatch.example.com",
          agentDisplayName: "Dispatch",
          endpoint: { url: "https://dispatch.example.com/a2a" },
          publicKey: other.publicKey,
          registeredAt: now,
        },
        keys.privateKeyPem,
        { now },
      ),
    ).toThrow(AnsError);
    expect(
      () =>
        sample("ans://v1.0.0.dispatch.example.com", keys.privateKeyPem).document.agentDisplayName,
    ).not.toThrow();
    expect(() =>
      signRegistration(
        {
          ansName: "ans://v1.0.0.dispatch.example.com",
          agentDisplayName: "D".repeat(65),
          endpoint: { url: "https://dispatch.example.com/a2a" },
          registeredAt: now,
        },
        keys.privateKeyPem,
        { now },
      ),
    ).toThrow(/64/);
    expect(() =>
      signRegistration(
        {
          ansName: "ans://v1.0.0.dispatch.example.com",
          agentDisplayName: "Dispatch",
          agentDescription: "x".repeat(151),
          endpoint: { url: "ftp://dispatch.example.com/a2a" },
          registeredAt: now,
        },
        keys.privateKeyPem,
        { now },
      ),
    ).toThrow(AnsError);
  });

  it("issues and verifies assertions, including expiry and audience", async () => {
    const dir = await fresh();
    const registry = await LocalRegistry.create(join(dir, "registry.json"));
    const keys = generateKeyPair();
    const now = new Date("2026-11-16T12:00:00.000Z");
    const signed = sample("ans://v1.0.0.dispatch.example.com", keys.privateKeyPem, now);
    const stored = await registry.register(signed);
    const assertion = issueAssertion({
      ansName: signed.document.ansName,
      privateKeyPem: keys.privateKeyPem,
      audience: "billing.example.com",
      ttlSeconds: 60,
      now,
    });
    const check = verifyAssertion(assertion, {
      now,
      audience: "billing.example.com",
      registryRecord: stored,
    });
    expect(check.registry).toBe("matched");
    expect(() =>
      verifyAssertion(assertion, { now, audience: "other.example", registryRecord: stored }),
    ).toThrow(expect.objectContaining({ code: "AUDIENCE_MISMATCH" }));
    expect(() =>
      verifyAssertion(assertion, {
        now: new Date(now.getTime() + 120_000),
        registryRecord: stored,
      }),
    ).toThrow(expect.objectContaining({ code: "EXPIRED" }));
    const tampered = { ...assertion, audience: "billing.example.com" };
    tampered.audience = "attacker.example";
    expect(() => verifyAssertion(tampered, { now, allowUnregistered: true })).toThrow(
      expect.objectContaining({ code: "ASSERTION_INVALID" }),
    );
  });

  it("canonicalizes object keys", () => {
    expect(canonicalJson({ b: "2", a: { d: "4", c: "3" } })).toBe(
      '{"a":{"c":"3","d":"4"},"b":"2"}',
    );
  });

  it("builds a zone even when called directly", () => {
    const keys = generateKeyPair();
    const signed = sample("ans://v1.0.0.dispatch.example.com", keys.privateKeyPem);
    const dns = buildDnsRecordSet(signed.document);
    expect(dns.records.map((record) => record.type)).toEqual(["TXT", "TXT", "SVCB"]);
  });
});
