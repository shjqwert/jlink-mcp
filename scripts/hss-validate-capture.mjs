import { queryHssCapture, exportHssCapture } from "../out/mcp/hss/hss-artifact.js";

const captureId = process.argv[2];
if (!captureId) {
  console.error("usage: node scripts/hss-validate-capture.mjs <captureId>");
  process.exit(2);
}

const query = await queryHssCapture({ captureId, hmC095Profile: true, buckets: 100 }, process.cwd());
const exported = await exportHssCapture({ captureId, format: "csv" }, process.cwd());
console.log(JSON.stringify({ query, exported }, null, 2));
