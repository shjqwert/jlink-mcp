import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { CaptureIpcMessage, decodeCaptureIpc, encodeCaptureIpc } from "./capture-contract";

test("native helper IPC fails closed and shuts down cleanly", async () => {
  const executable = join(process.cwd(), "native", "capture-helper", "build", "Release", "jlink-capture-helper.exe");
  const child = spawn(executable, ["--parent-pid", String(process.pid)], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  const messages: CaptureIpcMessage[] = [];
  lines.on("line", (line) => messages.push(decodeCaptureIpc(line)));

  await waitFor(() => messages.some((message) => message.type === "ready"));
  child.stdin.write("{bad json}\n");
  await waitFor(() => messages.some((message) => message.type === "error" && message.id === "unknown"));
  assert.equal(child.exitCode, null);

  child.stdin.write(encodeCaptureIpc({ version: 1, id: "hello", type: "hello", payload: {} }));
  await waitFor(() => messages.some((message) => message.id === "hello" && message.type === "result"));
  child.stdin.write(encodeCaptureIpc({ version: 1, id: "shutdown", type: "shutdown", payload: {} }));
  const [code] = await once(child, "exit") as [number];
  assert.equal(code, 0);
  assert.ok(messages.some((message) => message.id === "shutdown" && message.type === "result"));
});

test("native self-test covers parent loss and stop/reset routing", async () => {
  const executable = join(process.cwd(), "native", "capture-helper", "build", "Release", "jlink-capture-helper.exe");
  const child = spawn(executable, ["--self-test"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
  child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
  const [code] = await once(child, "exit") as [number];
  assert.equal(code, 0, output);
  assert.match(output, /self-test: ok/);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for helper IPC");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
