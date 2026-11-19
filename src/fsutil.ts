import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { AnsError, isAnsError } from "./errors.js";

export async function statSafe(filePath: string): Promise<{ size: number } | undefined> {
  try {
    const info = await stat(filePath);
    return { size: info.size };
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return undefined;
    }
    throw ioError(error, filePath);
  }
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return false;
    }
    throw ioError(error, filePath);
  }
}

export async function readText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    throw ioError(error, filePath);
  }
}

export async function atomicWrite(filePath: string, contents: string, mode = 0o600): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tmp, contents, { mode });
    await chmod(tmp, mode);
    await rename(tmp, filePath);
  } catch (error) {
    await rm(tmp, { force: true });
    throw ioError(error, filePath);
  }
}

export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${filePath}.lock`;
  const started = Date.now();
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        return await fn();
      } finally {
        await handle.close();
        await rm(lockPath, { force: true });
      }
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw ioError(error, lockPath);
      }
      let stale = false;
      try {
        const info = await stat(lockPath);
        stale = Date.now() - info.mtimeMs > 5_000;
      } catch {
        stale = false;
      }
      if (stale) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() - started > 3_000) {
        throw new AnsError("REGISTRY_BUSY", `Registry is locked: ${filePath}`, {
          hint: "Another ans process is writing the registry. Retry in a moment.",
        });
      }
      await delay(25);
    }
  }
}

export function ioError(error: unknown, filePath: string): AnsError {
  if (isAnsError(error)) {
    return error;
  }
  const code = isErrno(error) ? error.code : undefined;
  const suffix = code ? ` (${code})` : "";
  return new AnsError("IO", `Could not access ${filePath}${suffix}.`, { cause: error });
}

function isErrno(error: unknown, expected?: string): error is NodeJS.ErrnoException {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }
  return expected === undefined || (error as NodeJS.ErrnoException).code === expected;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
