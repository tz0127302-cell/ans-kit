import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { seedDemoRegistry } from "./demo.js";
import { AnsError } from "./errors.js";
import { pathExists } from "./fsutil.js";
import { LocalRegistry } from "./registry.js";

export interface AnsConfig {
  version: 1;
  registryPath: string;
  publicRegistry: {
    enabled: boolean;
    url: string | null;
  };
}

export interface AnsProject {
  root: string;
  home: string;
  config: AnsConfig;
  registryPath: string;
}

export interface LoadedContext {
  project?: AnsProject;
  registryPath: string;
  remote: { enabled: boolean; url: string | null };
}

export async function initProject(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  home?: string;
  force?: boolean;
  demo?: boolean;
  now?: Date;
}): Promise<{ home: string; registryPath: string; replaced: boolean; demoAgents: string[] }> {
  const home = explicitHome(options.cwd, options.home, options.env) ?? join(options.cwd, ".ans");
  const configPath = join(home, "config.json");
  const replaced = await pathExists(configPath);
  if (replaced && options.force !== true) {
    throw new AnsError("ALREADY_INITIALIZED", `An ans-kit project already exists at ${home}.`, {
      hint: "Pass --force to replace the local registry. That drops registrations stored there. Add --demo to load the sample agents again.",
    });
  }
  const config: AnsConfig = {
    version: 1,
    registryPath: "registry.json",
    publicRegistry: { enabled: false, url: null },
  };
  await mkdir(home, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await writeFile(join(home, "README.txt"), HOME_README, "utf8");
  const registryPath = join(home, config.registryPath);
  const now = options.now ?? new Date();
  let demoAgents: string[] = [];
  if (options.demo === true) {
    demoAgents = await seedDemoRegistry({
      registryPath,
      keysDir: join(home, "keys"),
      now,
      forceKeys: options.force === true,
    });
  } else {
    await LocalRegistry.create(registryPath, now);
  }
  return { home, registryPath, replaced, demoAgents };
}

export async function loadContext(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  home?: string;
  registry?: string;
  publicRegistry?: string;
  offline?: boolean;
}): Promise<LoadedContext> {
  const explicit = explicitHome(options.cwd, options.home, options.env);
  const project =
    explicit !== undefined ? await readProject(explicit) : await findProject(options.cwd);
  if (options.registry === undefined && project === undefined) {
    throw new AnsError("NOT_INITIALIZED", "No ans-kit project found from this directory.", {
      hint: "Run `ans init` here, or pass --registry /path/to/registry.json.",
    });
  }
  const registryPath =
    options.registry !== undefined ? resolve(options.cwd, options.registry) : project?.registryPath;
  if (registryPath === undefined) {
    throw new AnsError("NOT_INITIALIZED", "No registry path is configured.");
  }
  return {
    project,
    registryPath,
    remote: resolveRemote(options, project?.config),
  };
}

export async function openRegistry(filePath: string, create: boolean): Promise<LocalRegistry> {
  if (await pathExists(filePath)) {
    return LocalRegistry.open(filePath);
  }
  if (!create) {
    throw new AnsError("NOT_INITIALIZED", `No registry at ${filePath}.`, {
      hint: "Run `ans init` or `ans register` with --registry so the file can be created.",
    });
  }
  await mkdir(dirname(filePath), { recursive: true });
  return LocalRegistry.create(filePath);
}

export function parseRemoteUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AnsError("INVALID_ARGUMENT", `Remote registry URL "${raw}" is not a URL.`, {
      hint: "Example: http://127.0.0.1:4080",
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AnsError("INVALID_ARGUMENT", "Remote registry URL must be http or https.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new AnsError("INVALID_ARGUMENT", "Remote registry URL must not include userinfo.");
  }
  const path = url.pathname.replace(/\/$/, "");
  return `${url.origin}${path === "/" ? "" : path}`;
}

function resolveRemote(
  options: {
    publicRegistry?: string;
    offline?: boolean;
    env: NodeJS.ProcessEnv;
  },
  config: AnsConfig | undefined,
): { enabled: boolean; url: string | null } {
  if (options.offline === true) {
    return { enabled: false, url: null };
  }
  if (options.publicRegistry !== undefined) {
    return { enabled: true, url: parseRemoteUrl(options.publicRegistry) };
  }
  const fromEnv = options.env.ANS_PUBLIC_REGISTRY_URL;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return { enabled: true, url: parseRemoteUrl(fromEnv.trim()) };
  }
  if (config?.publicRegistry.enabled) {
    if (config.publicRegistry.url === null || config.publicRegistry.url.trim() === "") {
      throw new AnsError(
        "INVALID_ARGUMENT",
        "publicRegistry.enabled is true but url is empty in .ans/config.json.",
      );
    }
    return { enabled: true, url: parseRemoteUrl(config.publicRegistry.url) };
  }
  return { enabled: false, url: null };
}

function explicitHome(
  cwd: string,
  home: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (home !== undefined && home.trim() !== "") {
    return resolve(cwd, home);
  }
  if (env.ANS_HOME !== undefined && env.ANS_HOME.trim() !== "") {
    return resolve(cwd, env.ANS_HOME);
  }
  return undefined;
}

async function findProject(start: string): Promise<AnsProject | undefined> {
  let dir = resolve(start);
  for (;;) {
    const home = join(dir, ".ans");
    if (await pathExists(join(home, "config.json"))) {
      return readProject(home);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

async function readProject(home: string): Promise<AnsProject> {
  const configPath = join(home, "config.json");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    throw new AnsError("NOT_INITIALIZED", `No config at ${configPath}.`, {
      hint: "Run `ans init` to create a local registry.",
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new AnsError("REGISTRY_CORRUPT", `Could not parse ${configPath}.`, { cause: error });
  }
  const config = parseConfig(parsed);
  const registryPath = resolve(home, config.registryPath);
  return {
    root: dirname(home),
    home,
    config,
    registryPath,
  };
}

function parseConfig(value: unknown): AnsConfig {
  if (!isRecord(value) || value.version !== 1 || typeof value.registryPath !== "string") {
    throw new AnsError(
      "REGISTRY_CORRUPT",
      ".ans/config.json must be version 1 with a registryPath.",
    );
  }
  if (!isRecord(value.publicRegistry) || typeof value.publicRegistry.enabled !== "boolean") {
    throw new AnsError("REGISTRY_CORRUPT", ".ans/config.json is missing publicRegistry.enabled.");
  }
  const url = value.publicRegistry.url;
  if (url !== null && typeof url !== "string") {
    throw new AnsError("REGISTRY_CORRUPT", "publicRegistry.url must be a string or null.");
  }
  return {
    version: 1,
    registryPath: value.registryPath,
    publicRegistry: { enabled: value.publicRegistry.enabled, url },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HOME_README = `ans-kit local state

This directory is created by \`ans init\`. It holds the local registry and keys.
It is an unofficial dev registry, not an Agent Name Service registration authority,
and it is not affiliated with the Linux Foundation.

Do not commit private keys. Add .ans/ to .gitignore.
The remote registry client stays off until you set publicRegistry.enabled
or ANS_PUBLIC_REGISTRY_URL.
`;
