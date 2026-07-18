import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const MAX_MESSAGE_BYTES = 64 * 1024;

export interface ApprovalBrokerIpcLocator {
  version: 1;
  pid: number;
  endpoint: string;
  transportSecret: string;
}

export interface ApprovalBrokerIpcServer {
  endpoint: string;
  locatorFile: string;
  close(): Promise<void>;
}

export interface InteractiveApprovalClient {
  pid: number;
  challengeId: string;
  presenceEndpoint: string;
  presenceDigest: string;
}

export function approvalBrokerStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.JLINK_MCP_APPROVAL_ROOT) return join(resolve(env.JLINK_MCP_APPROVAL_ROOT), "approval-broker");
  if (process.platform === "win32") return join(env.LOCALAPPDATA ?? env.APPDATA ?? tmpdir(), "jlink-mcp", "approval-broker");
  const uid = typeof process.getuid === "function" ? process.getuid() : process.pid;
  return join(env.XDG_RUNTIME_DIR ?? tmpdir(), `jlink-mcp-${uid}`, "approval-broker");
}

export function approvalBrokerLocatorFile(cwd: string, stateRoot = approvalBrokerStateRoot()): string {
  return join(stateRoot, `${projectKey(cwd)}.json`);
}

export function approvalBrokerEndpoint(cwd = process.cwd(), stateRoot = approvalBrokerStateRoot()): string {
  const id = `${projectKey(cwd)}-${process.pid}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\jlink-mcp-r4-${id}` : join(stateRoot, `${id}.sock`);
}

export async function startProtectedApprovalBrokerIpc(input: {
  endpoint: string;
  cwd: string;
  stateRoot?: string;
  handle(request: Record<string, unknown>): Promise<Record<string, unknown>>;
}): Promise<ApprovalBrokerIpcServer> {
  const stateRoot = await privateStateRoot(input.stateRoot ?? approvalBrokerStateRoot());
  const locatorFile = approvalBrokerLocatorFile(input.cwd, stateRoot);
  const transportSecret = randomBytes(32).toString("base64url");
  const server = createServer((socket) => {
    let request = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      request += chunk;
      if (Buffer.byteLength(request, "utf8") > MAX_MESSAGE_BYTES) {
        socket.destroy(new Error("approval broker request is too large"));
        return;
      }
      const newline = request.indexOf("\n");
      if (newline < 0) return;
      const line = request.slice(0, newline);
      request = "";
      void dispatch(line, transportSecret, input.handle).then(
        (response) => socket.end(JSON.stringify({ ok: true, ...response }) + "\n"),
        (error) => socket.end(JSON.stringify({ ok: false, error: ipcError(error) }) + "\n"),
      );
    });
  });
  await listen(server, input.endpoint);
  try {
    const locator: ApprovalBrokerIpcLocator = { version: 1, pid: process.pid, endpoint: input.endpoint, transportSecret };
    await atomicPrivateWrite(locatorFile, `${JSON.stringify(locator)}\n`);
  } catch (error) {
    await closeServer(server);
    throw error;
  }
  return {
    endpoint: input.endpoint,
    locatorFile,
    close: async () => {
      await closeServer(server);
      await removeOwnedLocator(locatorFile, transportSecret);
      if (process.platform !== "win32") await rm(input.endpoint, { force: true });
    },
  };
}

export async function requestApprovalBroker(
  cwd: string,
  request: Record<string, unknown>,
  stateRoot = approvalBrokerStateRoot(),
): Promise<Record<string, unknown>> {
  const locator = await readPrivateLocator(approvalBrokerLocatorFile(cwd, stateRoot));
  const response = await exchange(locator.endpoint, { ...request, transportSecret: locator.transportSecret });
  if (response.ok === true) return response;
  const error = response.error as { code?: unknown; message?: unknown } | undefined;
  throw Object.assign(new Error(typeof error?.message === "string" ? error.message : "approval broker rejected the request"), {
    code: typeof error?.code === "string" ? error.code : "approval_required",
  });
}

export async function verifyInteractiveApprovalClient(client: InteractiveApprovalClient): Promise<boolean> {
  if (!Number.isSafeInteger(client.pid) || client.pid <= 0 || client.pid === process.pid) return false;
  if (!/^[0-9a-f]{64}$/i.test(client.presenceDigest)) return false;
  let secret: string | undefined;
  if (process.platform === "win32") {
    if (!verifyWindowsConsoleClient(client)) return false;
    secret = readWindowsPresenceSecret(client);
  } else if (process.platform === "linux") try {
    const [command, stdin, stdout] = await Promise.all([
      readFile(`/proc/${client.pid}/cmdline`, "utf8"),
      readlink(`/proc/${client.pid}/fd/0`),
      readlink(`/proc/${client.pid}/fd/1`),
    ]);
    const args = command.split("\0").filter(Boolean);
    if (!(args.length === 4
      && resolve(args[0]) === resolve(process.execPath)
      && /(?:^|[\\/])standalone\.js$/i.test(args[1])
      && args[2] === "approve"
      && args[3] === client.challengeId
      && stdin === stdout
      && /^\/dev\/(?:console|tty\w*|pts\/\d+)$/.test(stdin)
      && await linuxSocketBelongsToProcess(client.presenceEndpoint, client.pid))) return false;
    secret = await readPresenceSecret(client.presenceEndpoint);
  } catch {
    return false;
  } else return false;
  if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return false;
  const expected = Buffer.from(client.presenceDigest, "hex");
  const actual = createHash("sha256").update(secret).digest();
  return timingSafeEqual(actual, expected);
}

async function dispatch(
  line: string,
  transportSecret: string,
  handle: (request: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  let request: Record<string, unknown>;
  try { request = JSON.parse(line) as Record<string, unknown>; }
  catch { throw Object.assign(new Error("approval broker request is not valid JSON"), { code: "approval_required" }); }
  if (request.transportSecret !== transportSecret) {
    throw Object.assign(new Error("approval broker is restricted to the owning local OS user"), { code: "approval_nonlocal" });
  }
  delete request.transportSecret;
  return handle(request);
}

async function readPrivateLocator(file: string): Promise<ApprovalBrokerIpcLocator> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw Object.assign(new Error("approval broker locator is not a regular file"), { code: "approval_nonlocal" });
  if (process.platform !== "win32") {
    const uid = typeof process.getuid === "function" ? process.getuid() : info.uid;
    if (info.uid !== uid || (info.mode & 0o077) !== 0) throw Object.assign(new Error("approval broker locator permissions are not private"), { code: "approval_nonlocal" });
  }
  const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<ApprovalBrokerIpcLocator>;
  if (parsed.version !== 1 || !Number.isSafeInteger(parsed.pid) || typeof parsed.endpoint !== "string"
      || typeof parsed.transportSecret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(parsed.transportSecret)) {
    throw Object.assign(new Error("approval broker locator is invalid"), { code: "approval_required" });
  }
  try { process.kill(Number(parsed.pid), 0); }
  catch { throw Object.assign(new Error("approval broker process is not running"), { code: "approval_required" }); }
  return parsed as ApprovalBrokerIpcLocator;
}

async function privateStateRoot(input: string): Promise<string> {
  if (basename(resolve(input)).toLowerCase() !== "approval-broker") throw new Error("approval broker state root must use a dedicated approval-broker directory");
  await mkdir(input, { recursive: true, mode: 0o700 });
  const info = await lstat(input);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("approval broker state root must be a private directory");
  const canonical = await realpath(input);
  if (process.platform === "win32") protectWindowsDirectory(canonical);
  else {
    await chmod(canonical, 0o700);
    const secured = await lstat(canonical);
    const uid = typeof process.getuid === "function" ? process.getuid() : secured.uid;
    if (secured.uid !== uid || (secured.mode & 0o077) !== 0) throw new Error("approval broker state root permissions are not private");
  }
  return canonical;
}

function protectWindowsDirectory(directory: string): void {
  const whoami = spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
  const sid = whoami.status === 0 ? whoami.stdout.match(/"(S-[0-9-]+)"/)?.[1] : undefined;
  if (!sid) throw new Error("cannot resolve the current Windows user SID for approval broker ACL");
  const reset = spawnSync("icacls.exe", [directory, "/reset"], { encoding: "utf8", windowsHide: true });
  if (reset.status !== 0) throw new Error(`cannot reset approval broker state root ACL: ${reset.stderr || reset.stdout}`);
  const acl = spawnSync("icacls.exe", [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], { encoding: "utf8", windowsHide: true });
  if (acl.status !== 0) throw new Error(`cannot protect approval broker state root: ${acl.stderr || acl.stdout}`);
}

async function atomicPrivateWrite(file: string, contents: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") await chmod(temporary, 0o600);
  await rm(file, { force: true });
  await rename(temporary, file);
}

async function removeOwnedLocator(file: string, transportSecret: string): Promise<void> {
  try {
    const current = JSON.parse(await readFile(file, "utf8")) as Partial<ApprovalBrokerIpcLocator>;
    if (current.pid === process.pid && current.transportSecret === transportSecret) await rm(file, { force: true });
  } catch { /* stale or already removed */ }
}

function exchange(endpoint: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(JSON.stringify(payload) + "\n"));
    socket.on("data", (chunk) => {
      response += chunk;
      if (Buffer.byteLength(response, "utf8") > MAX_MESSAGE_BYTES) socket.destroy(new Error("approval broker response is too large"));
    });
    socket.once("error", reject);
    socket.once("end", () => {
      try { resolve(JSON.parse(response) as Record<string, unknown>); }
      catch (error) { reject(error); }
    });
  });
}

function ipcError(error: unknown): { code: string; message: string } {
  const typed = error as { code?: unknown; message?: unknown } | undefined;
  return {
    code: typeof typed?.code === "string" ? typed.code : "approval_required",
    message: typeof typed?.message === "string" ? typed.message : String(error),
  };
}

function projectKey(cwd: string): string {
  return createHash("sha256").update(resolve(cwd).toLowerCase()).digest("hex").slice(0, 24);
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => { server.off("error", reject); resolvePromise(); });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}

function verifyWindowsConsoleClient(client: InteractiveApprovalClient): boolean {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ConsoleProbe {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint processId);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint GetConsoleProcessList(uint[] processList, uint processCount);
}
'@
[ConsoleProbe]::FreeConsole() | Out-Null
if (-not [ConsoleProbe]::AttachConsole(${client.pid})) { exit 2 }
$ids = New-Object uint32[] 256
$count = [ConsoleProbe]::GetConsoleProcessList($ids, $ids.Length)
if ($count -eq 0 -or -not ($ids[0..([Math]::Min($count, $ids.Length) - 1)] -contains [uint32]${client.pid})) { exit 3 }
(Get-CimInstance Win32_Process -Filter 'ProcessId = ${client.pid}').CommandLine
`;
  const probe = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (probe.status !== 0) return false;
  const executable = escapeRegExp(resolve(process.execPath));
  const challengeId = escapeRegExp(client.challengeId);
  return new RegExp(`^\\s*"?${executable}"?\\s+"?[^"\\r\\n]*[\\\\/]standalone\\.js"?\\s+approve\\s+"?${challengeId}"?\\s*$`, "i")
    .test(probe.stdout.trim());
}

function readWindowsPresenceSecret(client: InteractiveApprovalClient): string | undefined {
  const match = client.presenceEndpoint.match(/^\\\\\.\\pipe\\jlink-mcp-r4-presence-(\d+)-([0-9a-f]{32})$/i);
  if (!match || Number(match[1]) !== client.pid) return undefined;
  const pipeName = `jlink-mcp-r4-presence-${match[1]}-${match[2]}`;
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PipeProbe {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint processId);
}
'@
$pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', '${pipeName}', [System.IO.Pipes.PipeDirection]::In)
$pipe.Connect(5000)
[uint32]$serverPid = 0
if (-not [PipeProbe]::GetNamedPipeServerProcessId($pipe.SafePipeHandle.DangerousGetHandle(), [ref]$serverPid) -or $serverPid -ne ${client.pid}) { exit 2 }
$reader = [System.IO.StreamReader]::new($pipe)
$reader.ReadToEnd()
`;
  const proof = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  return proof.status === 0 ? proof.stdout.trim() : undefined;
}

async function linuxSocketBelongsToProcess(endpoint: string, pid: number): Promise<boolean> {
  if (!new RegExp(`(?:^|/)presence-${pid}-[0-9a-f]{32}\\.sock$`, "i").test(endpoint)) return false;
  const table = await readFile("/proc/net/unix", "utf8");
  const row = table.split("\n").find((line) => line.trimEnd().endsWith(` ${endpoint}`));
  const inode = row?.trim().split(/\s+/)[6];
  if (!inode || !/^\d+$/.test(inode)) return false;
  for (const fd of await readdir(`/proc/${pid}/fd`)) {
    try { if (await readlink(`/proc/${pid}/fd/${fd}`) === `socket:[${inode}]`) return true; }
    catch { /* descriptor closed during inspection */ }
  }
  return false;
}

function readPresenceSecret(endpoint: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(endpoint);
    let secret = "";
    socket.setEncoding("utf8");
    socket.setTimeout(5_000, () => socket.destroy(new Error("approval presence proof timed out")));
    socket.on("data", (chunk) => { secret += chunk; });
    socket.once("error", reject);
    socket.once("end", () => resolvePromise(secret.trim()));
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
