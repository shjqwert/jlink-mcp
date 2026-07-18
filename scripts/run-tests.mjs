import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write("run-tests requires at least one compiled test file\n");
  process.exit(2);
}

const tempRoot = resolve("test-output", "tmp");
mkdirSync(tempRoot, { recursive: true });

const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: process.cwd(),
  env: { ...process.env, TEMP: tempRoot, TMP: tempRoot, TMPDIR: tempRoot },
  stdio: "inherit",
  windowsHide: true,
});

process.exit(result.status ?? 1);
