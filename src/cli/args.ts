import { AnsError } from "../errors.js";

export const BOOLEAN_FLAGS = new Set([
  "json",
  "force",
  "demo",
  "offline",
  "help",
  "version",
  "zone",
  "allow-unregistered",
]);

export const VALUE_FLAGS = new Set([
  "name",
  "display-name",
  "description",
  "protocol",
  "endpoint",
  "mode",
  "key",
  "out",
  "port",
  "host",
  "registry",
  "home",
  "public-registry",
  "audience",
  "assertion",
  "pin",
  "registered-at",
  "capabilities",
  "ttl",
]);

export interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    if (token === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      positional.push(token);
      continue;
    }
    const { name, inline } = splitFlag(token);
    if (flags.has(name)) {
      throw new AnsError("USAGE", `Flag --${name} was provided more than once.`);
    }
    if (!BOOLEAN_FLAGS.has(name) && !VALUE_FLAGS.has(name)) {
      throw new AnsError("USAGE", `Unknown flag --${name}.`, {
        hint: "Run `ans --help` to see commands and examples.",
      });
    }
    if (BOOLEAN_FLAGS.has(name)) {
      if (inline === undefined) {
        flags.set(name, true);
        continue;
      }
      if (inline === "true" || inline === "false") {
        flags.set(name, inline === "true");
        continue;
      }
      throw new AnsError("USAGE", `--${name} does not take a value.`);
    }
    let value = inline;
    if (value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new AnsError("USAGE", `--${name} requires a value.`);
      }
      value = next;
      index += 1;
    }
    if (value.length === 0) {
      throw new AnsError("USAGE", `--${name} requires a non-empty value.`);
    }
    flags.set(name, value);
  }
  return { positional, flags };
}

export function flagString(flags: Map<string, string | boolean>, name: string): string | undefined {
  if (!flags.has(name)) {
    return undefined;
  }
  const value = flags.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new AnsError("USAGE", `--${name} requires a non-empty value.`);
  }
  return value;
}

export function flagBool(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}

export function requireFlag(
  flags: Map<string, string | boolean>,
  name: string,
  hint: string,
): string {
  const value = flagString(flags, name);
  if (value === undefined) {
    throw new AnsError("USAGE", `Missing --${name}.`, { hint });
  }
  return value;
}

function splitFlag(token: string): { name: string; inline: string | undefined } {
  if (token === "-h") {
    return { name: "help", inline: undefined };
  }
  if (!token.startsWith("--") || token.startsWith("---")) {
    throw new AnsError("USAGE", `Unknown flag ${token}.`, {
      hint: "Long flags use two dashes, for example --json. Short help is -h.",
    });
  }
  const body = token.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  const inline = eq === -1 ? undefined : body.slice(eq + 1);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new AnsError("USAGE", `Unknown flag --${name}.`);
  }
  return { name, inline };
}
