
const fs = require("fs");
const command = process.argv[2];
if (command === "preflight") { console.log(JSON.stringify({ status: "ok", exportsFound: true })); process.exit(0); }
if (command === "connect-preflight") { console.log(JSON.stringify({ status: "ok", targetWasHalted: false, targetWasHaltedRaw: 0, targetReset: false, targetWritten: false, flashIssued: false, resetIssued: false, haltIssued: false, resumeIssued: false })); process.exit(0); }
if (command === "getcaps") { console.log(JSON.stringify({ status: "ok", caps: { maxBlocks: 16, maxFreq: 1000 } })); process.exit(0); }
const plan = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
const records = [];
for (let i = 0; i < plan.requestedRateHz * plan.durationSec; i++) {
  const record = Buffer.alloc(28);
  record.writeBigUInt64LE(BigInt(i), 0);
  record.writeBigInt64LE(BigInt(Math.round(i * 1000000000 / plan.requestedRateHz)), 8);
  record.writeUInt32LE(1, 16);
  record.writeUInt32LE(0, 20);
  record.writeUInt32LE(i, 24);
  records.push(record);
}
fs.writeFileSync(plan.outputFile, Buffer.concat(records));
let valueHex = "00000000";
let targetWritten = false;
function handleWriteRequest() {
  if (!plan.writeRequestFile || !plan.writeResponseFile || !fs.existsSync(plan.writeRequestFile)) return;
  const request = JSON.parse(fs.readFileSync(plan.writeRequestFile, "utf8"));
  fs.rmSync(plan.writeRequestFile, { force: true });
  if (request.op === "read") fs.writeFileSync(plan.writeResponseFile, JSON.stringify({ requestId: request.requestId, status: "ok", bytesHex: valueHex }));
  else if (request.op === "write") { valueHex = request.bytesHex; targetWritten = true; fs.writeFileSync(plan.writeResponseFile, JSON.stringify({ requestId: request.requestId, status: "ok", writeIssued: true })); }
  else fs.writeFileSync(plan.writeResponseFile, JSON.stringify({ requestId: request.requestId, status: "error", reason: "bad op" }));
}
const timer = setInterval(handleWriteRequest, 5);
setTimeout(() => { clearInterval(timer); console.log(JSON.stringify({ status: "ok", captureId: plan.captureId, requestedRateHz: plan.requestedRateHz, actualRateHz: plan.requestedRateHz, durationSec: plan.durationSec, sampleCount: records.length, validSamples: records.length, readErrors: 0, timeouts: 0, overflows: 0, droppedSamples: 0, readMode: plan.readMode, resumeBeforeStart: false, resumeIssued: false, targetWasHaltedBeforeResume: false, targetWasHaltedRaw: 0, targetWasHaltedAfterResume: false, targetReset: false, targetWritten, flashIssued: false, resetIssued: false, haltIssued: false, hssSampleHeaderBytes: 4, hssSampleStrideBytes: 8, bytesPerSample: 4, hssBlockCount: 1, readBufferBytes: 4096, firstChangedOffset: 0, firstChangedBytes: "00000000", headerChangedRatio: 1, payloadChangedRatio: 1, payloadFirstChangedOffset: 4, payloadFirstChangedBytes: "01000000" })); }, 1000);
