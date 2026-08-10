import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("HSS release builds require Windows x64.");
}

const workspace = resolve(process.cwd());
const sourceDir = resolve(workspace, "native", "hss-helper");
const buildDir = resolve(workspace, ".tmp", "jlink-mcp", "hss-release-build");
const tempDir = resolve(workspace, ".tmp", "jlink-mcp", "hss-release-temp");
const outputDir = resolve(sourceDir, "bin");
const output = resolve(outputDir, "hss_helper.exe");
const hashFile = `${output}.sha256`;
const packageJson = JSON.parse(readFileSync(resolve(workspace, "package.json"), "utf8"));
const helperRelease = packageJson.jlinkMcp?.hssHelper;
const helperVersion = String(helperRelease?.version ?? "");
const helperSha256 = String(helperRelease?.sha256 ?? "");
const prebuilt = resolve(sourceDir, "prebuilt", "windows-x64", "hss_helper.exe");
const sourceBuild = process.argv.slice(2).includes("--source");

if (!/^\d+\.\d+\.\d+$/.test(helperVersion)
    || helperRelease?.protocolVersion !== 3
    || helperRelease?.architecture !== "x64"
    || !/^[0-9a-f]{64}$/.test(helperSha256)) {
  throw new Error("package.json contains an invalid pinned HSS Helper declaration");
}

mkdirSync(outputDir, { recursive: true });
if (sourceBuild) buildFromSource();
else installVerifiedPrebuilt();

function installVerifiedPrebuilt() {
  if (!existsSync(prebuilt) || !statSync(prebuilt).isFile()) {
    throw new Error(`pinned HSS Helper was not found: ${prebuilt}`);
  }
  const actual = sha256(prebuilt);
  if (actual !== helperSha256) throw new Error(`pinned HSS Helper SHA-256 mismatch: ${actual}`);
  copyFileSync(prebuilt, output);
  writeFileSync(hashFile, `${actual}  hss_helper.exe\r\n`, "utf8");
  process.stdout.write(`HSS Helper ${helperVersion} installed from verified prebuilt\n${output}\nSHA-256 ${actual}\n`);
}

function buildFromSource() {
  const visualStudio = findVisualStudio();
  const cmake = findCmake(visualStudio.installationPath);
  const generator = generatorForVersion(visualStudio.installationVersion);
  const cmakeHelp = run(cmake, ["--help"], { capture: true }).stdout;
  if (!cmakeHelp.includes(generator)) {
    throw new Error(`CMake does not support the required generator: ${generator}`);
  }
  removeControlledBuildDirectory(buildDir);
  mkdirSync(buildDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  const env = { ...process.env, TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir };
  run(cmake, [
    "--fresh",
    "-S", sourceDir,
    "-B", buildDir,
    "-G", generator,
    "-A", "x64",
    `-DHSS_HELPER_VERSION=${helperVersion}`,
    "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded",
  ], { env });
  run(cmake, ["--build", buildDir, "--config", "Release"], { env });
  const built = resolve(buildDir, "Release", "hss_helper.exe");
  if (!existsSync(built) || !statSync(built).isFile()) {
    throw new Error(`HSS build did not produce ${built}`);
  }
  copyFileSync(built, output);
  const digest = sha256(output);
  writeFileSync(hashFile, `${digest}  hss_helper.exe\r\n`, "utf8");
  process.stdout.write(`HSS Helper ${helperVersion} built with ${generator}\n${output}\nSHA-256 ${digest}\n`);
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function findVisualStudio() {
  const vswhere = resolve(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  if (!existsSync(vswhere)) {
    throw new Error("Visual Studio Installer vswhere.exe was not found.");
  }
  const result = run(vswhere, [
    "-latest",
    "-products", "*",
    "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-format", "json",
  ], { capture: true });
  const instances = JSON.parse(result.stdout);
  const instance = instances?.[0];
  if (!instance?.installationPath || !instance?.installationVersion) {
    throw new Error("No Visual Studio installation with the x64 C++ toolchain was found.");
  }
  return {
    installationPath: String(instance.installationPath),
    installationVersion: String(instance.installationVersion),
  };
}

function findCmake(installationPath) {
  const candidates = [
    resolve(installationPath, "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake", "CMake", "bin", "cmake.exe"),
    resolve(installationPath, "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake", "Ninja", "cmake.exe"),
  ];
  const candidate = candidates.find((path) => existsSync(path));
  if (!candidate) {
    throw new Error("The selected Visual Studio installation does not include CMake.");
  }
  return candidate;
}

function generatorForVersion(version) {
  const major = Number(version.split(".")[0]);
  if (major === 18) return "Visual Studio 18 2026";
  if (major === 17) return "Visual Studio 17 2022";
  if (major === 16) return "Visual Studio 16 2019";
  throw new Error(`Unsupported Visual Studio major version: ${String(major)}`);
}

function removeControlledBuildDirectory(target) {
  const expectedParent = resolve(workspace, ".tmp", "jlink-mcp");
  if (dirname(target) !== expectedParent || basename(target) !== "hss-release-build") {
    throw new Error(`refusing to remove unexpected HSS build directory: ${target}`);
  }
  rmSync(target, { recursive: true, force: true });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: options.env,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited ${String(result.status)}${result.stderr ? `: ${result.stderr}` : ""}`);
  }
  return result;
}
