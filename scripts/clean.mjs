import { rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const workspace = resolve(process.cwd());
const output = resolve(workspace, "out");
if (dirname(output) !== workspace || basename(output) !== "out") {
  throw new Error(`refusing to clean unexpected output path: ${output}`);
}

rmSync(output, { recursive: true, force: true });
