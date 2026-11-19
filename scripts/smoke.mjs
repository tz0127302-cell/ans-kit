import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.js");
const work = await mkdtemp(join(tmpdir(), "ans-kit-smoke-"));
const env = { ...process.env, NO_COLOR: "1" };
delete env.ANS_HOME;
delete env.ANS_PUBLIC_REGISTRY_URL;
delete env.ANS_JSON;

function run(args, status = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: work,
    encoding: "utf8",
    env,
  });
  if (result.status !== status) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`ans ${args.join(" ")} exited ${result.status}`);
  }
  return result;
}

try {
  run(["init", "--demo"]);
  const listed = run(["list"]);
  if (!listed.stdout.includes("ans://v1.4.2.travel.example.com")) {
    throw new Error("demo list did not include the travel agent");
  }
  const resolved = run(["resolve", "ans://v1.4.2.travel.example.com"]);
  if (!resolved.stdout.includes("Travel Concierge") || !resolved.stdout.includes("signature")) {
    throw new Error("resolve did not verify the travel agent");
  }
  run(["auth", "verify", "--name", "ans://v1.4.2.travel.example.com"]);
  const zone = run(["resolve", "ans://v1.4.2.travel.example.com", "--zone"]);
  if (!zone.stdout.includes("v=ans-badge1")) {
    throw new Error("zone projection missing badge");
  }
  run(["auth", "keygen", "--out", ".ans/keys/dispatch"]);
  run([
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
  run([
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
  ]);
  run([
    "auth",
    "verify",
    "--assertion",
    ".ans/dispatch-assertion.json",
    "--audience",
    "billing.example.com",
  ]);
  const missing = run(["resolve", "ans://v9.9.9.missing.example", "--json"], 2);
  const missingBody = JSON.parse(missing.stdout);
  if (missingBody.ok !== false || missingBody.error.code !== "NOT_FOUND") {
    throw new Error("expected NOT_FOUND");
  }

  const server = spawn(process.execPath, [cli, "serve", "--port", "0", "--json"], {
    cwd: work,
    env,
  });
  const started = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      reject(new Error(`server did not start\n${buf}`));
    }, 8_000);
    server.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      try {
        const parsed = JSON.parse(buf);
        clearTimeout(timer);
        resolve(parsed);
      } catch {
        // Keep reading until the startup JSON object is complete.
      }
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (${code})`));
    });
  });
  const url = started.data.url;
  const health = await fetch(`${url}/health`);
  const healthBody = await health.json();
  if (healthBody.data?.unofficial !== true) {
    throw new Error("health payload is missing the unofficial flag");
  }
  const page = await fetch(url);
  const html = await page.text();
  if (!html.includes("Travel Concierge") || !html.toLowerCase().includes("unofficial")) {
    throw new Error("status page did not render the demo agent");
  }
  server.kill("SIGTERM");
  await new Promise((resolve) => {
    server.once("exit", resolve);
  });
  process.stdout.write("smoke ok\n");
} finally {
  await rm(work, { recursive: true, force: true });
}
