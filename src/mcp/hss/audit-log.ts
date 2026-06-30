import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { hssProjectPaths } from "./project-paths";
import type { HssToolOperation } from "./hss-contract";

export async function appendHssAudit(
  sessionId: string,
  operation: HssToolOperation,
  input: unknown,
  output: unknown,
  cwd = process.cwd(),
): Promise<string> {
  const file = join(hssProjectPaths(cwd).auditDir, sessionId, "audit.jsonl");
  await mkdir(join(hssProjectPaths(cwd).auditDir, sessionId), { recursive: true });
  await appendFile(file, JSON.stringify({ ts: new Date().toISOString(), operation, input, output }) + "\n", "utf8");
  return file;
}
