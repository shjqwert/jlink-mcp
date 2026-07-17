import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hssProjectPaths } from "./hss/project-paths";
import { JCAP_V0_ANALYSIS } from "./jcap/golden-corpus";
import { rebuildJcapV0Index, writeJcapV0Raw } from "./jcap/jcap-v0";
import { parseUiArgs, startJcapUi, UI_TOKEN_HEADER, type RunningUi } from "./ui";
import { UI_HTML, UI_SCRIPT } from "./ui-page";

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function workspace(): string {
  return mkdtempSync(path.join(os.tmpdir(), "jcap-ui-"));
}

async function capture(root: string): Promise<{ capturesDir: string; packageDir: string; captureId: string }> {
  const captureId = JCAP_V0_ANALYSIS.provenance.captureId;
  const capturesDir = path.join(root, "captures");
  const packageDir = path.join(capturesDir, `${captureId}.jcap`);
  writeJcapV0Raw({ packageDir, ...JCAP_V0_ANALYSIS });
  await rebuildJcapV0Index(packageDir);
  return { capturesDir, packageDir, captureId };
}

function sha(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function request(ui: RunningUi, route: string, options: { method?: string; host?: string; token?: string } = {}): Promise<HttpResult> {
  const address = ui.server.address();
  assert.ok(address && typeof address !== "string");
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port: address.port,
      path: route,
      method: options.method ?? "GET",
      headers: {
        Host: options.host ?? `127.0.0.1:${address.port}`,
        ...(options.token === undefined ? {} : { [UI_TOKEN_HEADER]: options.token }),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
}

test("UI CLI requires exactly one validated project or absolute capture selection", async () => {
  const root = workspace();
  try {
    const project = path.join(root, "project");
    mkdirSync(project);
    assert.deepEqual(parseUiArgs(["--project", project]), { capturesDir: hssProjectPaths(project).capturesDir });

    const fixture = await capture(root);
    assert.deepEqual(parseUiArgs(["--open", fixture.packageDir]), { capturesDir: fixture.capturesDir, initialCaptureId: fixture.captureId });
    assert.throws(() => parseUiArgs([]), /usage/);
    assert.throws(() => parseUiArgs(["--project", project, "--open", fixture.packageDir]), /usage/);
    assert.throws(() => parseUiArgs(["--open", path.basename(fixture.packageDir)]), /absolute/);
    assert.throws(() => parseUiArgs(["--open", path.join(root, "missing.jcap")]), /existing/);
    assert.throws(() => parseUiArgs(["--project", path.join(root, "missing")]), /existing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loopback listener enforces Host, token, methods, security headers, and closed routes", async () => {
  const root = workspace();
  let ui: RunningUi | undefined;
  try {
    const fixture = await capture(root);
    const sampleFile = path.join(fixture.packageDir, "raw", "samples.bin");
    const eventFile = path.join(fixture.packageDir, "raw", "events.bin");
    const databaseFile = path.join(fixture.packageDir, "capture.db");
    const before = [sha(sampleFile), sha(eventFile), sha(databaseFile)];
    ui = await startJcapUi({ capturesDir: fixture.capturesDir, initialCaptureId: fixture.captureId });
    const address = ui.server.address();
    assert.ok(address && typeof address !== "string");
    assert.equal(address.address, "127.0.0.1");
    assert.ok(address.port > 0);

    const page = await request(ui, `/?captureId=${fixture.captureId}`);
    assert.equal(page.status, 200);
    assert.match(String(page.headers["content-security-policy"] ?? ""), /default-src 'none'/);
    assert.match(String(page.headers["content-security-policy"] ?? ""), /script-src 'sha256-/);
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    assert.equal(page.headers["cache-control"], "no-store");
    assert.equal(page.headers["access-control-allow-origin"], undefined);
    assert.equal((await request(ui, "/", { method: "HEAD" })).body, "");

    assert.equal((await request(ui, "/api/list")).status, 401);
    assert.equal((await request(ui, "/api/list", { token: "wrong" })).status, 401);
    assert.equal((await request(ui, "/api/list", { token: ui.token, host: "localhost" })).status, 421);
    assert.equal((await request(ui, "/api/list", { token: ui.token, method: "POST" })).status, 405);
    assert.equal((await request(ui, "/api/list", { token: ui.token })).status, 200);
    for (const route of ["/api/raw", "/api/rebuild", "/api/export", "/probe", "/capture", "/file"]) {
      assert.equal((await request(ui, route, { token: ui.token })).status, 404, route);
    }
    assert.deepEqual([sha(sampleFile), sha(eventFile), sha(databaseFile)], before);
  } finally {
    if (ui) await ui.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser APIs expose only bounded JCAP queries and deterministic analysis", async () => {
  const root = workspace();
  let ui: RunningUi | undefined;
  try {
    const fixture = await capture(root);
    ui = await startJcapUi({ capturesDir: fixture.capturesDir });
    const token = ui.token;
    const call = async (route: string) => request(ui!, route, { token });
    const list = await call("/api/list?limit=10");
    assert.equal(list.status, 200);
    assert.equal(JSON.parse(list.body).captures[0].name, `${fixture.captureId}.jcap`);

    const summary = await call(`/api/summary?captureId=${fixture.captureId}`);
    assert.equal(summary.status, 200);
    assert.equal(JSON.parse(summary.body).indexStatus, "ready");

    const series = await call(`/api/series?captureId=${fixture.captureId}&variable=command&variable=feedback&startTick=0&endTick=100000000&bucketCount=64`);
    assert.equal(series.status, 200);
    const bucket = JSON.parse(series.body).series[0];
    assert.deepEqual(Object.keys(bucket).filter((key) => ["min", "max", "average", "last", "count", "statusFlags"].includes(key)).sort(), ["average", "count", "last", "max", "min", "statusFlags"]);
    assert.equal((await call(`/api/series?captureId=${fixture.captureId}&variable=command&startTick=0&endTick=100000000&bucketCount=5000`)).status, 400);

    const eventId = "30000000-0000-4000-8000-000000000002";
    assert.equal((await call(`/api/event-window?captureId=${fixture.captureId}&eventId=${eventId}&variable=command&beforeMs=20&afterMs=80&bucketCount=64`)).status, 200);
    assert.equal((await call(`/api/event-window?captureId=${fixture.captureId}&eventId=${eventId}&beforeMs=60001&afterMs=0&bucketCount=1`)).status, 400);

    const roles = [encodeURIComponent(JSON.stringify(["command", "command"])), encodeURIComponent(JSON.stringify(["feedback", "feedback"]))];
    const analysis = await call(`/api/analysis?captureId=${fixture.captureId}&profile=generic_control&role=${roles[0]}&role=${roles[1]}&startTick=0&endTick=100000000`);
    assert.equal(analysis.status, 200);
    assert.match(JSON.parse(analysis.body).analysisRunId, /^[0-9a-f]{64}$/);
    const analysisBounds = await call(`/api/analysis?captureId=${fixture.captureId}&profile=generic_control&role=${roles[0]}&role=${roles[1]}&startTick=01&endTick=100000000`);
    assert.equal(analysisBounds.status, 400);
    assert.equal(JSON.parse(analysisBounds.body).error.code, "JCAP_BOUNDS");
  } finally {
    if (ui) await ui.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("static page is accessible and references only the five read-only query routes", () => {
  assert.match(UI_HTML, /<canvas[^>]+role="img"/);
  assert.match(UI_HTML, /<canvas[^>]+tabindex="0"/);
  assert.match(UI_HTML, /id="canvasAlt">No series loaded/);
  assert.match(UI_HTML, /<label[^>]*>/);
  for (const route of ["/api/list", "/api/summary", "/api/series", "/api/event-window", "/api/analysis"]) assert.match(UI_SCRIPT, new RegExp(route.replace("/", "\\/")));
  for (const route of ["/api/raw", "/api/rebuild", "/api/export", "/api/probe", "/api/capture", "/api/write", "/api/flash", "/api/broker", "/api/approval", "/api/file"]) assert.doesNotMatch(UI_SCRIPT, new RegExp(route.replace("/", "\\/")));
  for (const field of ["min", "max", "average", "last", "count", "statusFlags"]) assert.match(UI_SCRIPT, new RegExp(`\\.${field}\\b`));
  assert.doesNotMatch(UI_HTML, /\b(?:probe|flash|approval|raw command|raw parser)\b/i);
  assert.doesNotMatch(UI_HTML, /webview|puppeteer|playwright/i);
});
