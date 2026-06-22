import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

function findCmake() {
  const probe = spawnSync("cmake", ["--version"], { stdio: "ignore" });
  if (!probe.error && probe.status === 0) return "cmake";

  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean);
  const vswhere = `${process.env["ProgramFiles(x86)"]}\\Microsoft Visual Studio\\Installer\\vswhere.exe`;
  if (existsSync(vswhere)) {
    const found = spawnSync(vswhere, ["-latest", "-products", "*", "-find", "**\\cmake.exe"], { encoding: "utf8" });
    const candidate = found.stdout?.split(/\r?\n/).find(Boolean);
    if (found.status === 0 && candidate && existsSync(candidate)) return candidate;
  }
  for (const root of roots) {
    const candidate = `${root}\\Microsoft Visual Studio\\18\\Community\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe`;
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("CMake is required. Install it or add cmake.exe to PATH.");
}

const cmake = findCmake();
for (const args of [
  ["-S", "native/capture-helper", "-B", "native/capture-helper/build", "-A", "x64"],
  ["--build", "native/capture-helper/build", "--config", "Release"],
]) {
  const result = spawnSync(cmake, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
mkdirSync("native/capture-helper/bin", { recursive: true });
copyFileSync("native/capture-helper/build/Release/jlink-capture-helper.exe", "native/capture-helper/bin/jlink-capture-helper.exe");
