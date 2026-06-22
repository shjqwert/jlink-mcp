import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

function find(tool) {
  const pathProbe = spawnSync(tool, ["--version"], { stdio: "ignore" });
  if (!pathProbe.error && pathProbe.status === 0) return tool;
  for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean)) {
    const family = join(root, "Arm GNU Toolchain arm-none-eabi");
    if (!existsSync(family)) continue;
    const powershell = spawnSync("powershell.exe", ["-NoProfile", "-Command", `(Get-ChildItem -LiteralPath '${family.replaceAll("'", "''")}' -Filter '${tool}.exe' -Recurse | Select-Object -First 1 -ExpandProperty FullName)`], { encoding: "utf8" });
    const candidate = powershell.stdout.trim();
    if (powershell.status === 0 && existsSync(candidate)) return candidate;
  }
  throw new Error(`${tool} is required for ELF integration tests`);
}

const gcc = find("arm-none-eabi-gcc");
const gdb = find("arm-none-eabi-gdb");
const build = join("native", "capture-helper", "build", "elf-test");
mkdirSync(build, { recursive: true });
const elf = join(build, "capture-symbols.elf");
const compile = spawnSync(gcc, [
  "-mcpu=cortex-m4", "-mthumb", "-g3", "-O0", "-nostdlib",
  "-Wl,-T,src/mcp/fixtures/capture.ld",
  "src/mcp/fixtures/capture-symbols.c", "src/mcp/fixtures/capture-other.c",
  "-o", elf,
], { stdio: "inherit" });
if (compile.error) throw compile.error;
if (compile.status !== 0) process.exit(compile.status ?? 1);
const tests = spawnSync(process.execPath, ["--test", "out/mcp/elf-integration.test.js"], {
  stdio: "inherit",
  env: { ...process.env, CAPTURE_TEST_GDB: gdb, CAPTURE_TEST_ELF: join(process.cwd(), elf) },
});
if (tests.error) throw tests.error;
process.exit(tests.status ?? 1);
