import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface TempPreflightResult {
  root: string;
  status: "ok" | "error";
  writable: boolean;
  readable: boolean;
  deletable: boolean;
  error?: {
    code?: string;
    message: string;
  };
}

export function repoTempRoot(cwd = process.cwd()): string {
  return resolve(cwd, ".tmp", "jlink-mcp");
}

export async function createRepoTempDir(prefix: string, cwd = process.cwd()): Promise<string> {
  const root = repoTempRoot(cwd);
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, prefix));
}

export async function preflightRepoTemp(cwd = process.cwd()): Promise<TempPreflightResult> {
  const root = repoTempRoot(cwd);
  const probe = join(root, `.preflight-${randomUUID()}`);
  try {
    await mkdir(root, { recursive: true });
    await writeFile(probe, "ok", { flag: "wx" });
    const readable = await readFile(probe, "utf8");
    await rm(probe);
    return {
      root,
      status: "ok",
      writable: true,
      readable: readable === "ok",
      deletable: true,
    };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    return {
      root,
      status: "error",
      writable: false,
      readable: false,
      deletable: false,
      error: {
        code: nodeError.code,
        message: nodeError.message,
      },
    };
  }
}
