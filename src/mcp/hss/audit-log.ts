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
  await appendFile(file, JSON.stringify(auditRecord(sessionId, operation, input, output)) + "\n", "utf8");
  return file;
}

function auditRecord(sessionId: string, operation: HssToolOperation, input: unknown, output: unknown): Record<string, unknown> {
  const data = objectField(output, "data");
  const error = objectField(output, "error");
  const details = objectField(error, "details");
  const risk = objectField(output, "risk");
  return {
    ts: new Date().toISOString(),
    timeUs: Date.now() * 1000,
    sessionId,
    captureId: field(input, "captureId") ?? field(data, "captureId") ?? field(details, "captureId"),
    operation,
    target: field(input, "target") ?? field(data, "canonicalTarget") ?? field(details, "canonicalTarget"),
    canonicalTarget: field(data, "canonicalTarget") ?? field(details, "canonicalTarget"),
    targetRef: field(input, "targetRef") ?? field(data, "targetRef") ?? field(details, "targetRef"),
    risk: field(risk, "level"),
    ok: field(output, "ok"),
    errorCode: field(error, "code") ?? field(details, "errorCode"),
    writeId: field(data, "writeId") ?? field(details, "writeId"),
    eventId: field(data, "eventId") ?? field(details, "eventId"),
    policyHash: field(data, "policyHash") ?? field(details, "policyHash"),
    symbolLayoutHash: field(data, "symbolLayoutHash") ?? field(details, "symbolLayoutHash"),
    input,
    output,
  };
}

function objectField(source: unknown, name: string): Record<string, unknown> | undefined {
  const value = field(source, name);
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function field(source: unknown, name: string): unknown {
  return source && typeof source === "object" ? (source as Record<string, unknown>)[name] : undefined;
}
