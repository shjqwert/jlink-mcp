export const UI_STYLE = `
:root { color-scheme: dark; font: 14px system-ui, sans-serif; background: #101418; color: #e8eef2; }
* { box-sizing: border-box; }
body { margin: 0; min-width: 760px; }
header { display: flex; gap: 1rem; align-items: center; padding: .75rem 1rem; border-bottom: 1px solid #34404a; }
h1, h2 { margin: 0; font-size: 1rem; }
main { display: grid; grid-template-columns: 16rem minmax(30rem, 1fr) 18rem; grid-template-rows: minmax(24rem, 1fr) 14rem; min-height: calc(100vh - 3.5rem); }
nav, aside, section { padding: .75rem; border: 1px solid #2b343c; overflow: auto; }
#timeline { display: grid; grid-template-rows: auto minmax(18rem, 1fr) auto; gap: .5rem; }
#evidence { grid-column: 1 / 4; display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
canvas { width: 100%; height: 100%; min-height: 18rem; border: 1px solid #52606b; background: #0a0d10; }
button, input, select { font: inherit; margin: .2rem; }
button, select, input[type=text], input[type=number] { background: #182028; color: inherit; border: 1px solid #667786; padding: .35rem; }
button:focus, input:focus, select:focus, canvas:focus { outline: 2px solid #65b7ff; outline-offset: 1px; }
label { display: block; margin: .25rem 0; }
.capture { display: block; width: 100%; text-align: left; }
.variable { display: grid; grid-template-columns: auto 1fr 7rem; align-items: center; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: .25rem; }
.range { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; }
.range input { width: 100%; }
#error { color: #ffd2d2; white-space: pre-wrap; }
#quality, #canvasAlt, #status { white-space: pre-wrap; }
pre { white-space: pre-wrap; margin: .4rem 0; }
`;

export const UI_SCRIPT = `
(() => {
  "use strict";
  const token = decodeURIComponent(location.hash.slice(1));
  history.replaceState(null, "", location.pathname + location.search);
  const byId = (id) => document.getElementById(id);
  const state = { captureId: "", summary: null, series: null };
  const colors = ["#65b7ff", "#ffba69", "#7ee0a3", "#ef88d5", "#d4dd75", "#a7a0ff"];

  async function api(route, params) {
    const url = new URL(route, location.origin);
    Object.entries(params || {}).forEach(([key, value]) => {
      if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, item));
      else if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    });
    const response = await fetch(url, { headers: { "x-jlink-mcp-ui-token": token }, cache: "no-store" });
    const body = await response.json();
    if (!response.ok) {
      const error = new Error((body.error && body.error.message) || "Request failed");
      error.code = body.error && body.error.code;
      throw error;
    }
    return body;
  }

  function report(error) {
    byId("error").textContent = (error.code ? error.code + ": " : "") + error.message;
  }

  function selectedVariables() {
    return [...document.querySelectorAll("#variables input[type=checkbox]:checked")].map((input) => input.value);
  }

  function renderCaptures(captures) {
    const list = byId("captures");
    list.replaceChildren();
    captures.forEach((capture) => {
      const button = document.createElement("button");
      button.className = "capture";
      button.type = "button";
      button.textContent = capture.name + " — " + capture.captureState + "/" + capture.indexStatus;
      button.addEventListener("click", () => selectCapture(capture.name.slice(0, -5)));
      list.append(button);
    });
  }

  function renderVariables(variables) {
    const root = byId("variables");
    root.replaceChildren();
    variables.forEach((variable, index) => {
      const row = document.createElement("label");
      row.className = "variable";
      const visible = document.createElement("input");
      visible.type = "checkbox";
      visible.value = variable;
      visible.checked = index < 4;
      visible.addEventListener("change", refreshSeries);
      const name = document.createElement("span");
      name.textContent = variable;
      const role = document.createElement("select");
      role.dataset.variable = variable;
      role.setAttribute("aria-label", variable + " analysis role");
      ["ignored", "command", "feedback", "state"].forEach((value) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        role.append(option);
      });
      role.value = index === 0 ? "command" : index === 1 ? "feedback" : "ignored";
      row.append(visible, name, role);
      root.append(row);
    });
  }

  async function selectCapture(captureId) {
    try {
      byId("error").textContent = "";
      state.captureId = captureId;
      state.summary = await api("/api/summary", { captureId });
      const summary = state.summary;
      const provenance = summary.provenance || {};
      byId("session").textContent = "Session: " + (provenance.sessionName || "Ungrouped");
      byId("status").textContent = "Capture " + captureId + " — " + summary.captureState + "/" + summary.indexStatus;
      byId("quality").textContent = JSON.stringify({ captureState: summary.captureState, indexStatus: summary.indexStatus, warnings: provenance.warnings || [], sources: summary.sources || [] }, null, 2);
      renderVariables(summary.variables || []);
      if (summary.indexStatus === "ready" && ["completed", "stopped"].includes(summary.captureState)) await refreshSeries();
    } catch (error) { report(error); }
  }

  async function refreshSeries() {
    if (!state.captureId) return;
    const variables = selectedVariables();
    if (!variables.length) {
      state.series = { series: [] };
      drawChart();
      return;
    }
    try {
      byId("error").textContent = "";
      state.series = await api("/api/series", {
        captureId: state.captureId,
        variable: variables,
        startTick: byId("startTick").value,
        endTick: byId("endTick").value,
        bucketCount: 512,
      });
      drawChart();
    } catch (error) { report(error); }
  }

  function drawChart() {
    const canvas = byId("chart");
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
    canvas.height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
    const context = canvas.getContext("2d");
    context.scale(ratio, ratio);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    context.clearRect(0, 0, width, height);
    const entries = (state.series && state.series.series) || [];
    const variables = [...new Set(entries.map((entry) => entry.variable))];
    let qualityFlags = 0;
    let totalCount = 0;
    variables.forEach((variable, variableIndex) => {
      const points = entries.filter((entry) => entry.variable === variable).sort((a, b) => a.bucket - b.bucket);
      if (!points.length) return;
      const low = Math.min(...points.map((point) => point.min));
      const high = Math.max(...points.map((point) => point.max));
      const span = high === low ? 1 : high - low;
      context.strokeStyle = colors[variableIndex % colors.length];
      context.beginPath();
      points.forEach((point, index) => {
        const x = points.length === 1 ? width / 2 : index * (width - 1) / (points.length - 1);
        const y = height - (point.average - low) / span * height;
        if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
        context.moveTo(x, height - (point.min - low) / span * height);
        context.lineTo(x, height - (point.max - low) / span * height);
        qualityFlags |= point.statusFlags;
        totalCount += point.count;
        void point.last;
      });
      context.stroke();
    });
    const alternative = variables.length
      ? "Chart for " + variables.join(", ") + "; " + totalCount + " indexed values; combined quality flags " + qualityFlags + "."
      : "No visible series data in the selected window.";
    byId("canvasAlt").textContent = alternative;
    canvas.setAttribute("aria-label", alternative);
    byId("qualityFlags").textContent = "Series quality flags: " + qualityFlags + ". Counts, min, max, average and last values are retained per bucket.";
  }

  function zoomToBrush() {
    try {
      const start = BigInt(byId("startTick").value);
      const end = BigInt(byId("endTick").value);
      const span = end - start;
      const left = BigInt(byId("brushStart").value);
      const right = BigInt(byId("brushEnd").value);
      if (span < 0n || left >= right) throw new Error("Brush start must be before brush end");
      byId("startTick").value = String(start + span * left / 1000n);
      byId("endTick").value = String(start + span * right / 1000n);
      byId("brushStart").value = "0";
      byId("brushEnd").value = "1000";
      refreshSeries();
    } catch (error) { report(error); }
  }

  async function selectEvent() {
    try {
      const result = await api("/api/event-window", {
        captureId: state.captureId,
        eventId: byId("eventId").value,
        variable: selectedVariables(),
        beforeMs: Number(byId("beforeMs").value),
        afterMs: Number(byId("afterMs").value),
        bucketCount: 256,
      });
      byId("eventResult").textContent = JSON.stringify({ event: result.event, relatedEvents: result.relatedEvents, nearestSample: result.nearestSample }, null, 2);
      state.series = result.series;
      drawChart();
    } catch (error) { report(error); }
  }

  async function runAnalysis() {
    try {
      const roles = [...document.querySelectorAll("#variables select")]
        .filter((select) => select.value !== "ignored")
        .map((select) => JSON.stringify([select.dataset.variable, select.value]));
      const result = await api("/api/analysis", {
        captureId: state.captureId,
        profile: byId("profile").value,
        role: roles,
        startTick: byId("startTick").value,
        endTick: byId("endTick").value,
      });
      byId("analysisResult").textContent = JSON.stringify(result, null, 2);
    } catch (error) { report(error); }
  }

  byId("zoom").addEventListener("click", zoomToBrush);
  byId("refresh").addEventListener("click", refreshSeries);
  byId("autoFit").addEventListener("click", drawChart);
  byId("selectEvent").addEventListener("click", selectEvent);
  byId("runAnalysis").addEventListener("click", runAnalysis);
  window.addEventListener("resize", drawChart);

  api("/api/list", { limit: 100 }).then((result) => {
    renderCaptures(result.captures || []);
    const requested = new URLSearchParams(location.search).get("captureId");
    const first = requested || (result.captures && result.captures[0] && result.captures[0].name.slice(0, -5));
    if (first) selectCapture(first);
  }).catch(report);
})();
`;

export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>J-Link MCP Offline Analysis</title>
  <style>${UI_STYLE}</style>
</head>
<body>
  <header><h1>JCAP Offline Analysis</h1><span id="status" aria-live="polite">Loading captures…</span></header>
  <main>
    <nav aria-label="Project session and capture navigation">
      <h2>Project captures</h2>
      <p id="session">Session: not selected</p>
      <div id="captures"></div>
    </nav>
    <section id="timeline" aria-labelledby="timelineTitle">
      <div class="row">
        <h2 id="timelineTitle">Timeline</h2>
        <label>Start tick <input id="startTick" type="text" inputmode="numeric" value="0"></label>
        <label>End tick <input id="endTick" type="text" inputmode="numeric" value="1000000000"></label>
        <button id="refresh" type="button">Refresh window</button>
      </div>
      <canvas id="chart" tabindex="0" role="img" aria-label="No series loaded"></canvas>
      <div>
        <div class="range">
          <label>Brush start <input id="brushStart" type="range" min="0" max="999" value="0"></label>
          <label>Brush end <input id="brushEnd" type="range" min="1" max="1000" value="1000"></label>
        </div>
        <button id="zoom" type="button">Zoom to brush</button>
        <p id="canvasAlt">No series loaded.</p>
      </div>
    </section>
    <aside aria-labelledby="variablesTitle">
      <h2 id="variablesTitle">Variables</h2>
      <div id="variables"></div>
      <button id="autoFit" type="button">Auto-fit visible Y ranges</button>
      <p id="qualityFlags">Series quality flags are not loaded.</p>
    </aside>
    <section id="evidence" aria-label="Events quality and analysis">
      <div>
        <h2>Event and quality</h2>
        <div class="row">
          <label>Event ID <input id="eventId" type="text"></label>
          <label>Before ms <input id="beforeMs" type="number" min="0" max="60000" value="100"></label>
          <label>After ms <input id="afterMs" type="number" min="0" max="60000" value="100"></label>
          <button id="selectEvent" type="button">Select event window</button>
        </div>
        <pre id="eventResult">No event selected.</pre>
        <pre id="quality">No capture selected.</pre>
      </div>
      <div>
        <h2>Deterministic analysis</h2>
        <label>Profile <select id="profile"><option value="generic_control">Generic control</option><option value="generic_state_machine">Generic state machine</option></select></label>
        <button id="runAnalysis" type="button">Run analysis</button>
        <pre id="analysisResult">No analysis run.</pre>
        <p id="error" role="alert" aria-live="assertive"></p>
      </div>
    </section>
  </main>
  <script>${UI_SCRIPT}</script>
</body>
</html>`;
