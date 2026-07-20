import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const executable = resolve("native", "hss-helper", "bin", "hss_helper.exe");
const result = spawnSync(executable, ["self-test"], { encoding: "utf8", windowsHide: true });

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const response = parseJson(result.stdout, "HSS Helper self-test");
if (response.status !== "ok" || response.command !== "self-test") {
  throw new Error(`HSS Helper self-test failed: ${String(response.errorCode ?? response.reason ?? response.status)}`);
}

const memorySessionArgs = [
  "memory-session",
  "--dll", resolve(".tmp", "missing-JLink_x64.dll"),
  "--device", "Z20K146M",
  "--interface", "SWD",
  "--serial", "1",
  "--speed", "4000",
];

expectMemorySession("{\"op\":\"activate\"}\n", "HSS_DLL_LOAD_FAILED", "activated memory-session");
expectMemorySession("", "MEMORY_SESSION_ACTIVATION_STREAM_CLOSED", "inactive memory-session");
expectMemorySession("{\"op\":\"activate\",\"extra\":true}\n", "MEMORY_SESSION_ACTIVATION_INVALID", "invalid memory-session activation");

const timeoutResponse = await waitForActivationTimeout();
if (timeoutResponse.status !== "error" || timeoutResponse.errorCode !== "MEMORY_SESSION_ACTIVATION_TIMEOUT") {
  throw new Error(`memory-session did not time out before J-Link startup: ${String(timeoutResponse.errorCode ?? timeoutResponse.status)}`);
}

function expectMemorySession(input, expectedErrorCode, label) {
  const session = spawnSync(executable, memorySessionArgs, { encoding: "utf8", windowsHide: true, input });
  if (session.error) throw session.error;
  if (session.status !== 0) throw new Error(`${label} exited ${String(session.status)}`);
  const parsed = parseJson(session.stdout, label);
  if (parsed.status !== "error" || parsed.errorCode !== expectedErrorCode) {
    throw new Error(`${label} returned ${String(parsed.errorCode ?? parsed.status)} instead of ${expectedErrorCode}`);
  }
}

async function waitForActivationTimeout() {
  return new Promise((resolveTimeout, rejectTimeout) => {
    const child = spawn(executable, memorySessionArgs, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const watchdog = setTimeout(() => {
      child.kill();
      rejectTimeout(new Error("memory-session activation did not time out"));
    }, 12_000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => {
      clearTimeout(watchdog);
      rejectTimeout(error);
    });
    child.once("close", (status) => {
      clearTimeout(watchdog);
      if (status !== 0) {
        rejectTimeout(new Error(`memory-session activation timeout exited ${String(status)}: ${stderr}`));
        return;
      }
      try {
        resolveTimeout(parseJson(stdout, "timed-out memory-session"));
      } catch (error) {
        rejectTimeout(error);
      }
    });
  });
}

function parseJson(output, label) {
  try {
    return JSON.parse(output.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "");
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
