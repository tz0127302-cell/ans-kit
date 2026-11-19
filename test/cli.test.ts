import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { packageVersion } from "../src/version.js";
import { removeDir, runCli, tempDir } from "./helpers.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => removeDir(dir)));
});

describe("CLI", () => {
  it("documents the quickstart in the README", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("npx ans init --demo");
    expect(readme).toContain("npx ans resolve ans://v1.4.2.travel.example.com");
    expect(readme).toContain("npx ans auth verify --name ans://v1.4.2.travel.example.com");
    expect(readme).toContain("not a Linux Foundation");
  });

  it("prints help and version", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const help = await runCli(dir, ["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("unofficial");
    expect(help.stdout).toContain("ans init --demo");
    expect(help.stdout).toContain("Linux Foundation");
    const version = await runCli(dir, ["--version"]);
    expect(version.stdout.trim()).toBe(packageVersion());
    const registerHelp = await runCli(dir, ["register", "--help"]);
    expect(registerHelp.stdout).toContain("ans://v1.0.0.dispatch.example.com");
    const unknown = await runCli(dir, ["nope"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("Unknown command");
  });

  it("runs the offline quickstart", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const init = await runCli(dir, ["init", "--demo"]);
    expect(init.code).toBe(0);
    expect(init.stdout).toContain("ans://v1.4.2.travel.example.com");
    const again = await runCli(dir, ["init", "--demo"]);
    expect(again.code).toBe(4);

    const list = await runCli(dir, ["list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("Travel Concierge");
    expect(list.stdout).toContain("Billing Desk");
    expect(list.stdout).toContain("Acme Support Triage");

    const resolved = await runCli(dir, ["resolve", "ans://v1.4.2.travel.example.com"]);
    expect(resolved.code).toBe(0);
    expect(resolved.stdout).toContain("signature");
    expect(resolved.stdout).toContain("v=ans1");

    const asJson = await runCli(dir, ["resolve", "ans://v1.4.2.travel.example.com", "--json"]);
    const body = JSON.parse(asJson.stdout) as {
      ok: boolean;
      data: { verified: boolean; record: { document: { agentDisplayName: string } } };
    };
    expect(body.ok).toBe(true);
    expect(body.data.verified).toBe(true);
    expect(body.data.record.document.agentDisplayName).toBe("Travel Concierge");

    const verified = await runCli(dir, [
      "auth",
      "verify",
      "--name",
      "ans://v1.4.2.travel.example.com",
    ]);
    expect(verified.code).toBe(0);
    expect(verified.stdout).toContain("Verified registration");

    const zone = await runCli(dir, ["resolve", "ans://v1.4.2.travel.example.com", "--zone"]);
    expect(zone.stdout).toContain("_ans-badge.travel.example.com.");
    expect(zone.stdout).toContain("v=ans-badge1");

    expect((await runCli(dir, ["auth", "keygen", "--out", ".ans/keys/dispatch"])).code).toBe(0);
    const registered = await runCli(dir, [
      "register",
      "--name",
      "ans://v1.0.0.dispatch.example.com",
      "--display-name",
      "Dispatch",
      "--description",
      "Routes work between travel and billing agents.",
      "--protocol",
      "a2a",
      "--endpoint",
      "https://dispatch.example.com/a2a",
      "--key",
      ".ans/keys/dispatch.private.pem",
    ]);
    expect(registered.code).toBe(0);
    expect(registered.stdout).toContain("Registered ans://v1.0.0.dispatch.example.com");

    const duplicate = await runCli(dir, [
      "register",
      "--name",
      "ans://v1.0.0.dispatch.example.com",
      "--display-name",
      "Dispatch",
      "--endpoint",
      "https://dispatch.example.com/a2a",
      "--key",
      ".ans/keys/dispatch.private.pem",
      "--json",
    ]);
    expect(duplicate.code).toBe(4);
    expect(JSON.parse(duplicate.stdout).error.code).toBe("ALREADY_REGISTERED");

    expect(
      (
        await runCli(dir, [
          "auth",
          "issue",
          "--name",
          "ans://v1.0.0.dispatch.example.com",
          "--key",
          ".ans/keys/dispatch.private.pem",
          "--audience",
          "billing.example.com",
          "--out",
          ".ans/dispatch-assertion.json",
        ])
      ).code,
    ).toBe(0);
    const assertion = await runCli(dir, [
      "auth",
      "verify",
      "--assertion",
      ".ans/dispatch-assertion.json",
      "--audience",
      "billing.example.com",
    ]);
    expect(assertion.code).toBe(0);
    expect(assertion.stdout).toContain("matched");

    const wrongAudience = await runCli(dir, [
      "auth",
      "verify",
      "--assertion",
      ".ans/dispatch-assertion.json",
      "--audience",
      "payroll.example.com",
      "--json",
    ]);
    expect(wrongAudience.code).toBe(3);
    expect(JSON.parse(wrongAudience.stdout).error.code).toBe("AUDIENCE_MISMATCH");

    const missing = await runCli(dir, ["resolve", "ans://v9.9.9.missing.example", "--json"]);
    expect(missing.code).toBe(2);
    expect(JSON.parse(missing.stdout).error.code).toBe("NOT_FOUND");

    const bare = await runCli(dir, ["resolve", "travel.example.com"]);
    expect(bare.code).toBe(1);
    expect(bare.stderr).toContain("INVALID_NAME");
  });

  it("reports a tampered demo signature as a verification failure", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    expect((await runCli(dir, ["init", "--demo"])).code).toBe(0);
    const file = join(dir, ".ans", "registry.json");
    const raw = JSON.parse(await readFile(file, "utf8")) as {
      agents: Array<{ signature: string }>;
    };
    const signedAgent = raw.agents[0];
    if (signedAgent === undefined) {
      throw new Error("expected a stored agent");
    }
    signedAgent.signature = Buffer.alloc(64, 3).toString("base64url");
    await writeFile(file, JSON.stringify(raw));
    const resolved = await runCli(dir, ["resolve", "ans://v1.4.2.travel.example.com", "--json"]);
    expect(resolved.code).toBe(3);
    expect(JSON.parse(resolved.stdout).error.code).toBe("SIGNATURE_INVALID");
  });

  it("runs the built binary", () => {
    const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const result = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0.1.0");
    const help = spawnSync(process.execPath, [cli, "serve", "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("4080");
  });
});
