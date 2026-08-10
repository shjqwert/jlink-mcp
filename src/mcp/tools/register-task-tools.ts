import { z } from "zod";
import type { OperationEnvelope } from "../runtime/operation-envelope";
import { TaskOperations } from "../runtime/task-operations";
import type { RegisterTaskTool } from "./task-tool-contract";

const params = z.record(z.string(), z.unknown()).optional()
  .describe("Action parameters; use only fields named in the selected action description.");

export interface TaskToolRegistration {
  operations: TaskOperations;
  getProjectRoot(): string;
  project(
    action: string,
    projectRoot: string | undefined,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<OperationEnvelope>;
}

export function registerTaskTools(
  register: RegisterTaskTool,
  services: TaskToolRegistration,
  includeRaw: boolean,
): void {
  register("project", {
    action: z.enum(["bind", "devices", "configure", "status", "verify", "artifacts"]).default("bind"),
    projectRoot: z.string().min(1).optional().describe("Explicit workspace root. Omit only when the MCP client declares exactly one file root."),
    params,
  }, (input, signal) => services.project(
    String(input.action),
    typeof input.projectRoot === "string" ? input.projectRoot : undefined,
    taskParams(input.params),
    signal,
  ));

  register("inspect", {
    action: z.enum(["symbol_search", "symbol_resolve", "variable", "memory", "core", "peripheral"]),
    params,
  }, (input) => services.operations.inspect(services.getProjectRoot(), String(input.action), taskParams(input.params)));

  register("write", {
    action: z.enum(["variable", "memory", "core", "peripheral"]),
    params,
  }, (input) => services.operations.write(services.getProjectRoot(), String(input.action), taskParams(input.params)));

  register("control", {
    action: z.enum(["halt", "resume", "reset", "reset_halt"]),
  }, (input) => services.operations.control(services.getProjectRoot(), String(input.action)));

  register("program", {
    action: z.enum(["flash", "erase"]),
    params,
  }, (input) => services.operations.program(services.getProjectRoot(), String(input.action), taskParams(input.params)));

  register("debug", {
    action: z.enum(["open", "run_to", "breakpoints", "delete_breakpoint", "wait", "backtrace", "close"]),
    params,
  }, (input) => services.operations.debug(services.getProjectRoot(), String(input.action), taskParams(input.params)));

  register("trace", {
    action: z.enum([
      "rtt_window", "rtt_open", "rtt_read", "rtt_search", "rtt_clear", "rtt_close",
      "hss_window", "hss_start", "hss_status", "hss_stop", "hss_recover",
    ]),
    params,
  }, (input, signal) => services.operations.trace(
    services.getProjectRoot(),
    String(input.action),
    taskParams(input.params),
    signal,
  ));

  register("capture", {
    action: z.enum(["list", "summary", "series", "event_window", "export_csv"]),
    params,
  }, (input) => services.operations.capture(String(input.action), taskParams(input.params)));

  register("diagnose_crash", {}, () => services.operations.diagnoseCrash(services.getProjectRoot()));

  if (includeRaw) {
    register("raw", {
      action: z.enum(["gdb", "probe"]),
      params,
    }, (input) => services.operations.raw(services.getProjectRoot(), String(input.action), taskParams(input.params)));
  }
}

function taskParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = value as Record<string, unknown>;
  for (const forbidden of ["projectRoot", "runId"]) {
    if (Object.hasOwn(result, forbidden)) {
      throw new Error(`task.params.${forbidden} is not supported; use project binding and the acceptance profile instead`);
    }
  }
  return result;
}
