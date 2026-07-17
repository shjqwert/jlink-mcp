import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { hssProjectPaths } from "./hss/project-paths";
import { JcapV0QueryService, type AnalysisV0RunRequest } from "./jcap/jcap-v0";
import { UI_HTML, UI_SCRIPT, UI_STYLE } from "./ui-page";

export const UI_TOKEN_HEADER = "x-jlink-mcp-ui-token";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CSP = `default-src 'none'; script-src 'sha256-${digest(UI_SCRIPT)}'; style-src 'sha256-${digest(UI_STYLE)}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

export interface UiSelection {
  capturesDir: string;
  initialCaptureId?: string;
}

export interface RunningUi {
  server: Server;
  origin: string;
  url: string;
  token: string;
  close(): Promise<void>;
}

class UiRequestError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
  }
}

export function parseUiArgs(args: string[], cwd = process.cwd()): UiSelection {
  if (args.length !== 2 || !["--project", "--open"].includes(args[0]) || !args[1]) {
    throw new Error("usage: npm run ui -- --project <root> | --open <absolute captureId.jcap>");
  }
  if (args[0] === "--project") {
    const projectRoot = path.resolve(cwd, args[1]);
    if (!existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) throw new Error("--project must name an existing directory");
    return { capturesDir: hssProjectPaths(projectRoot).capturesDir };
  }
  if (!path.isAbsolute(args[1])) throw new Error("--open requires an absolute .jcap directory");
  const packageDir = existsSync(args[1]) ? realpathSync.native(args[1]) : args[1];
  const name = path.basename(packageDir);
  const captureId = name.endsWith(".jcap") ? name.slice(0, -5) : "";
  if (!existsSync(packageDir) || !statSync(packageDir).isDirectory() || !UUID.test(captureId)) throw new Error("--open must name an existing absolute <captureId>.jcap directory");
  return { capturesDir: path.dirname(packageDir), initialCaptureId: captureId };
}

export async function startJcapUi(selection: UiSelection): Promise<RunningUi> {
  const query = new JcapV0QueryService(selection.capturesDir);
  const token = randomBytes(32).toString("hex");
  let expectedHost = "";
  const server = createServer((request, response) => void handleRequest(request, response, query, token, expectedHost));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("loopback UI did not receive a TCP address");
  }
  expectedHost = `127.0.0.1:${address.port}`;
  const origin = `http://${expectedHost}`;
  const initial = selection.initialCaptureId ? `?captureId=${encodeURIComponent(selection.initialCaptureId)}` : "";
  return {
    server,
    origin,
    url: `${origin}/${initial}#${encodeURIComponent(token)}`,
    token,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, query: JcapV0QueryService, token: string, expectedHost: string): Promise<void> {
  securityHeaders(response);
  try {
    if (request.headers.host !== expectedHost) throw new UiRequestError("UI_HOST_REJECTED", 421, "Host header does not match the loopback listener");
    if (request.method !== "GET" && request.method !== "HEAD") throw new UiRequestError("UI_METHOD_REJECTED", 405, "Only GET and HEAD are allowed");
    const url = new URL(request.url ?? "/", `http://${expectedHost}`);
    if (url.pathname === "/") {
      assertParams(url, ["captureId"]);
      const captureId = optional(url, "captureId");
      if (captureId && !UUID.test(captureId)) throw new UiRequestError("UI_INPUT_INVALID", 400, "captureId must be a UUID");
      return send(response, request.method, 200, UI_HTML, "text/html; charset=utf-8");
    }
    if (!url.pathname.startsWith("/api/")) throw new UiRequestError("UI_ROUTE_NOT_FOUND", 404, "Route not found");
    if (!validToken(request.headers[UI_TOKEN_HEADER], token)) throw new UiRequestError("UI_TOKEN_REJECTED", 401, "API header token is missing or invalid");
    const result = await routeApi(url, query);
    send(response, request.method, 200, JSON.stringify(result), "application/json; charset=utf-8");
  } catch (error) {
    const known = error as { code?: unknown; status?: unknown; message?: unknown };
    const code = typeof known.code === "string" ? known.code : "UI_REQUEST_FAILED";
    const status = typeof known.status === "number" ? known.status : code === "JCAP_BOUNDS" ? 400 : code === "JCAP_CAPTURE_NOT_FOUND" ? 404 : 500;
    send(response, request.method, status, JSON.stringify({ error: { code, message: typeof known.message === "string" ? known.message : String(error) } }), "application/json; charset=utf-8");
  }
}

async function routeApi(url: URL, query: JcapV0QueryService): Promise<Record<string, unknown>> {
  switch (url.pathname) {
    case "/api/list": {
      assertParams(url, ["limit", "cursor"]);
      return query.list({ limit: optionalInteger(url, "limit"), cursor: optional(url, "cursor") });
    }
    case "/api/summary": {
      assertParams(url, ["captureId"]);
      return query.summary({ captureId: required(url, "captureId") });
    }
    case "/api/series": {
      assertParams(url, ["captureId", "variable", "startTick", "endTick", "bucketCount"]);
      return query.series({
        captureId: required(url, "captureId"),
        variables: url.searchParams.getAll("variable"),
        startTick: required(url, "startTick"),
        endTick: required(url, "endTick"),
        bucketCount: integer(url, "bucketCount"),
      });
    }
    case "/api/event-window": {
      assertParams(url, ["captureId", "eventId", "variable", "beforeMs", "afterMs", "bucketCount"]);
      return query.eventWindow({
        captureId: required(url, "captureId"),
        eventId: required(url, "eventId"),
        variables: url.searchParams.getAll("variable"),
        beforeMs: integer(url, "beforeMs"),
        afterMs: integer(url, "afterMs"),
        bucketCount: integer(url, "bucketCount"),
      });
    }
    case "/api/analysis": {
      assertParams(url, ["captureId", "profile", "role", "eventId", "beforeMs", "afterMs", "startTick", "endTick"]);
      return query.analysisRun(analysisInput(url));
    }
    default:
      throw new UiRequestError("UI_ROUTE_NOT_FOUND", 404, "Route not found");
  }
}

function analysisInput(url: URL): AnalysisV0RunRequest {
  const signalRoles: AnalysisV0RunRequest["signalRoles"] = {};
  for (const encoded of url.searchParams.getAll("role")) {
    let parsed: unknown;
    try { parsed = JSON.parse(encoded); } catch { throw new UiRequestError("UI_INPUT_INVALID", 400, "role must be a JSON [variable, role] pair"); }
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || !["command", "feedback", "state"].includes(String(parsed[1])) || Object.hasOwn(signalRoles, parsed[0])) {
      throw new UiRequestError("UI_INPUT_INVALID", 400, "role must be a unique JSON [variable, command|feedback|state] pair");
    }
    signalRoles[parsed[0]] = parsed[1] as "command" | "feedback" | "state";
  }
  const profile = required(url, "profile");
  if (profile !== "generic_control" && profile !== "generic_state_machine") throw new UiRequestError("UI_INPUT_INVALID", 400, "unsupported analysis profile");
  return {
    captureId: required(url, "captureId"),
    profile,
    signalRoles,
    ...(url.searchParams.has("eventId") ? {
      eventId: required(url, "eventId"),
      beforeMs: integer(url, "beforeMs"),
      afterMs: integer(url, "afterMs"),
    } : {
      startTick: required(url, "startTick"),
      endTick: required(url, "endTick"),
    }),
  };
}

function assertParams(url: URL, allowed: string[]): void {
  const accepted = new Set(allowed);
  if ([...url.searchParams.keys()].some((key) => !accepted.has(key))) throw new UiRequestError("UI_INPUT_INVALID", 400, "unknown query parameter");
}

function required(url: URL, name: string): string {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1 || !values[0]) throw new UiRequestError("UI_INPUT_INVALID", 400, `${name} is required exactly once`);
  return values[0];
}

function optional(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) throw new UiRequestError("UI_INPUT_INVALID", 400, `${name} may appear at most once`);
  return values[0] || undefined;
}

function integer(url: URL, name: string): number {
  const value = required(url, name);
  if (!/^\d+$/.test(value)) throw new UiRequestError("UI_INPUT_INVALID", 400, `${name} must be a decimal integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new UiRequestError("UI_INPUT_INVALID", 400, `${name} exceeds the safe integer range`);
  return parsed;
}

function optionalInteger(url: URL, name: string): number | undefined {
  return url.searchParams.has(name) ? integer(url, name) : undefined;
}

function validToken(header: string | string[] | undefined, expected: string): boolean {
  if (typeof header !== "string" || header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", CSP);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), usb=()");
}

function send(response: ServerResponse, method: string | undefined, status: number, body: string, contentType: string): void {
  response.statusCode = status;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", Buffer.byteLength(body));
  if (status === 405) response.setHeader("Allow", "GET, HEAD");
  response.end(method === "HEAD" ? undefined : body);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64");
}

async function main(): Promise<void> {
  const running = await startJcapUi(parseUiArgs(process.argv.slice(2)));
  console.log(`JCAP offline UI: ${running.url}`);
}

if (require.main === module) void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
