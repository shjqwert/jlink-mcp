import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

function findCmake() {
  const probe = spawnSync("cmake", ["--version"], { stdio: "ignore" });
  if (!probe.error && probe.status === 0) return "cmake";

  const vswhere = `${process.env["ProgramFiles(x86)"]}\\Microsoft Visual Studio\\Installer\\vswhere.exe`;
  if (existsSync(vswhere)) {
    const found = spawnSync(vswhere, ["-latest", "-products", "*", "-find", "**\\cmake.exe"], { encoding: "utf8" });
    const candidate = found.stdout?.split(/\r?\n/).find(Boolean);
    if (found.status === 0 && candidate && existsSync(candidate)) return candidate;
  }
  throw new Error("CMake is required. Install it or add cmake.exe to PATH.");
}

const cmake = findCmake();
const tempDir = join(process.cwd(), ".tmp", "jlink-mcp", "hss-native-build-temp");
mkdirSync(tempDir, { recursive: true });
const env = { ...process.env, TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir };

for (const args of [
  ["-S", "native/hss-helper", "-B", "native/hss-helper/build", "-A", "x64"],
  ["--build", "native/hss-helper/build", "--config", "Release"],
]) {
  const result = spawnSync(cmake, args, { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
mkdirSync("native/hss-helper/bin", { recursive: true });
copyFileSync("native/hss-helper/build/Release/hss_helper.exe", "native/hss-helper/bin/hss_helper.exe");
