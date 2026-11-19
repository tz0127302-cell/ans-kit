import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Io, main } from "../src/cli/run.js";

export async function tempDir(prefix = "ans-kit-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export function cliIo(
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): {
  io: Io;
  stdout: () => string;
  stderr: () => string;
} {
  let out = "";
  let err = "";
  const io: Io = {
    cwd,
    env,
    color: false,
    json: false,
    stdout: {
      write(chunk: string) {
        out += chunk;
      },
    },
    stderr: {
      write(chunk: string) {
        err += chunk;
      },
    },
  };
  return {
    io,
    stdout: () => out,
    stderr: () => err,
  };
}

export async function runCli(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const captured = cliIo(cwd, env);
  const code = await main(args, captured.io);
  return { code, stdout: captured.stdout(), stderr: captured.stderr() };
}
