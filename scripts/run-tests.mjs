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

// The 60,000-frame JCAP ceiling test exercises sqlite3 for over a minute.
// Keep it out of Node's file-level parallel worker batch on Windows, where
// concurrent native sqlite teardown can trip libuv's closing-handle assert.
const ceilingTest = files.find((file) => /(?:^|[\\/])jcap-v1\.test\.js$/.test(file));
const batches = ceilingTest && files.length > 1
  ? [files.filter((file) => file !== ceilingTest), [ceilingTest]]
  : [files];

for (const batch of batches) {
  const result = spawnSync(process.execPath, ["--test", ...batch], {
    cwd: process.cwd(),
    env: { ...process.env, TEMP: tempRoot, TMP: tempRoot, TMPDIR: tempRoot },
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
