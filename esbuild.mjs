import * as esbuild from "esbuild";

const isWatch = process.argv.includes("--watch");

/** Shared options */
const common = {
  bundle: true,
  platform: "node",
  target: "node18",
  sourcemap: true,
  format: "cjs",
  minify: false,
};

// Standalone MCP server — bundle JS dependencies; ship sqlite3's native binding separately
const standaloneBuild = esbuild.build({
  ...common,
  entryPoints: ["src/mcp/standalone.ts"],
  outfile: "out/mcp/standalone.js",
  external: ["sqlite3"],
});

const doctorBuild = esbuild.build({
  ...common,
  entryPoints: ["src/mcp/doctor.ts"],
  outfile: "out/mcp/doctor.js",
  external: ["sqlite3"],
});

await Promise.all([standaloneBuild, doctorBuild]);
console.log("Build complete");
