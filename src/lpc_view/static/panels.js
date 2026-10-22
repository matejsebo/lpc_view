// lpc_view: the page's panels. The DOM handles, the status line, the file list,
// the class list (and the class colour texture), the five tabs on the right
// (point, stats, header, VLRs, CRS) and the metadata they show.

import { apiUrl, fetchJson } from "./api.js";
import { classColor, setClassColor } from "./classes.js";

export const $ = (id) => document.getElementById(id);
export const ui = {
  fileList: $("file-list"),
  filesCount: $("files-count"),
  metaFile: $("meta-file"),
  budgetSelect: $("budget-select"),
  loadBtn: $("load-btn"),
  stopBtn: $("stop-btn"),
  progress: $("progress-bar"),
  status: $("status"),
  mode: $("mode-select"),
  size: $("size-range"),
  sizeOut: $("size-out"),
  adaptive: $("adaptive-check"),
  occlude: $("occlude-check"),
  bounds: $("bounds-check"),
  zrange: $("zrange-select"),
  hideWithheld: $("hide-withheld"),
  hideOverlap: $("hide-overlap"),
  hideSynthetic: $("hide-synthetic"),
  classList: $("class-list"),
  speed: $("speed-range"),
  speedOut: $("speed-out"),
  hudPos: $("hud-pos"),
  hudLook: $("hud-look"),
  hudPts: $("hud-pts"),
  hudDraw: $("hud-draw"),
  hudFps: $("hud-fps"),
  crosshair: $("crosshair"),
};

export const fmtInt = (n) => Number(n).toLocaleString("en-US");
export const fmt = (v, d = 2) => (v === null || v === undefined ? "-" : Number(v).toFixed(d));
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function setStatus(text) { ui.status.textContent = text; }
export function setProgress(frac) { ui.progress.style.width = `${Math.round(100 * frac)}%`; }

// ---------------------------------------------------------------------------
// Metadata tables
// ---------------------------------------------------------------------------

function kvTable(pairs) {
  return `<table class="kv">${pairs.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join("")}</table>`;
}

function renderHeader(meta, fileId) {
  const h = meta.header, f = meta.file, pf = meta.point_format, ge = h.global_encoding;
  const html = [];
  html.push("<h4>File</h4>", kvTable([
    ["name", esc(f.name)], ["path", esc(f.path)], ["size", `${fmtInt(f.size_bytes)} bytes (${(f.size_bytes / 1048576).toFixed(1)} MB)`],
    ["modified", esc(f.modified)], ["compressed", f.compressed ? "yes (LAZ)" : "no (LAS)"],
    ["sha256", `<button class="mini" id="sha-btn">compute</button> <span id="sha-out"></span>`],
    ["download", `<a href="${apiUrl(`/api/meta?file=${fileId}`)}" download="${esc(f.name)}.meta.json">metadata JSON</a>`],
  ]));
  html.push("<h4>Public header block</h4>", kvTable([
    ["version", h.version], ["file source id", h.file_source_id], ["project id (GUID)", h.project_id],
    ["system identifier", esc(h.system_identifier)], ["generating software", esc(h.generating_software)],
    ["creation date", h.creation_date ?? "-"], ["header size", h.header_size], ["offset to point data", h.offset_to_point_data],
    ["number of VLRs", h.number_of_vlrs], ["point data record format", h.point_data_record_format],
    ["point data record length", `${h.point_data_record_length} bytes`], ["number of point records", fmtInt(h.point_count)],
    ["points by return", h.number_of_points_by_return.map((n, i) => (n ? `${i + 1}: ${fmtInt(n)}` : null)).filter(Boolean).join("<br>") || "-"],
    ["scale factors", h.scales.join(", ")], ["offsets", h.offsets.join(", ")],
    ["min x y z", h.mins.map((v) => fmt(v, 2)).join(", ")], ["max x y z", h.maxs.map((v) => fmt(v, 2)).join(", ")],
    ["extent", h.extent.map((v) => fmt(v, 2)).join(" x ") + " m"], ["area", `${fmt(h.area_m2 / 1e4, 2)} ha`],
    ["density (header)", h.points_per_m2 ? `${fmt(h.points_per_m2, 2)} pts/m2` : "-"],
    ["start of waveform data", h.start_of_waveform_data_packet_record], ["start of first EVLR", h.start_of_first_evlr],
    ["number of EVLRs", h.number_of_evlrs], ["extra header bytes", h.extra_header_bytes], ["extra VLR bytes", h.extra_vlr_bytes],
  ]));
  html.push("<h4>Global encoding</h4>", kvTable([
    ["value", `${ge.value} (0b${ge.value.toString(2).padStart(5, "0")})`], ["GPS time type", ge.gps_time_type === "standard" ? "adjusted standard GPS time" : "GPS week time"],
    ["waveform packets internal", ge.waveform_data_packets_internal], ["waveform packets external", ge.waveform_data_packets_external],
    ["synthetic return numbers", ge.synthetic_return_numbers], ["WKT CRS", ge.wkt],
  ]));
  html.push(`<h4>Point format ${pf.id} (${pf.size} bytes)</h4>`);
  html.push(kvTable([["gps time", pf.has_gps_time], ["rgb", pf.has_rgb], ["nir", pf.has_nir], ["waveform", pf.has_waveform], ["extra dimensions", pf.extra_dimensions.join(", ") || "none"]]));
  html.push(`<table class="grid"><tr><th>dimension</th><th>kind</th><th>bits</th><th>dtype</th></tr>${pf.dimensions.map((d) => `<tr><td class="nm">${esc(d.name)}${d.extra ? " (extra)" : ""}</td><td>${esc(d.kind)}</td><td>${d.bits}</td><td>${d.dtype ?? "bitfield"}</td></tr>`).join("")}</table>`);
  $("tab-header").innerHTML = html.join("");
  $("sha-btn").addEventListener("click", async () => {
    $("sha-out").textContent = "hashing...";
    try { const r = await fetchJson(`/api/sha256?file=${fileId}`); $("sha-out").textContent = r.sha256; } catch (e) { $("sha-out").textContent = e.message; }
  });
}

function renderVlrs(meta) {
  const card = (v, kind) => {
    const parts = [`<div class="vlr"><div class="t">${kind} ${esc(v.user_id)} / ${v.record_id} <span class="d">${esc(v.kind)}, ${fmtInt(v.size_bytes)} bytes</span></div><div class="d">${esc(v.description || "(no description)")}</div>`];
    const p = v.parsed;
    if (p) {
      if (p.lookups) parts.push(`<table class="grid"><tr><th>code</th><th>name</th></tr>${p.lookups.filter((l) => l.name.trim()).map((l) => `<tr><td>${l.code}</td><td class="nm">${esc(l.name)}</td></tr>`).join("")}</table>`);
      else if (p.wkt) parts.push(`<details><summary>WKT</summary><pre>${esc(p.wkt)}</pre></details>`);
      else if (p.items) parts.push(kvTable([["compressor", esc(p.compressor)], ["coder", esc(p.coder)], ["version", esc(p.version)], ["chunk size", fmtInt(p.chunk_size)], ["items", p.items.map((it) => `${esc(it.type)} v${it.version} (${it.size} B)`).join(", ")]]));
      else if (p.keys) parts.push(`<table class="grid"><tr><th>key</th><th>tag loc</th><th>count</th><th>value</th></tr>${p.keys.map((k) => `<tr><td>${k.id}</td><td>${k.tiff_tag_location}</td><td>${k.count}</td><td>${k.value_offset}</td></tr>`).join("")}</table>`);
      else parts.push(`<pre>${esc(JSON.stringify(p, null, 1))}</pre>`);
    }
    if (v.raw && v.raw.length) parts.push(`<details><summary>raw bytes${v.raw.truncated ? " (first 64)" : ""}</summary><pre>${esc(v.raw.hex)}\n${esc(v.raw.ascii)}</pre></details>`);
    parts.push("</div>");
    return parts.join("");
  };
  const html = [`<h4>${meta.vlrs.length} VLR${meta.vlrs.length === 1 ? "" : "s"}</h4>`, ...meta.vlrs.map((v) => card(v, "VLR")),
    `<h4>${meta.evlrs.length} EVLR${meta.evlrs.length === 1 ? "" : "s"}</h4>`, ...meta.evlrs.map((v) => card(v, "EVLR"))];
  $("tab-vlrs").innerHTML = html.join("") || "<em>none</em>";
}

function renderCrs(meta) {
  const c = meta.crs;
  if (!c) { $("tab-crs").innerHTML = "<em>the file carries no coordinate reference system</em>"; return; }
  if (c.error) { $("tab-crs").innerHTML = `<em>${esc(c.error)}</em>`; return; }
  const one = (x) => kvTable([["name", esc(x.name)], ["type", esc(x.type)], ["EPSG", x.epsg ?? "-"], ["datum", esc(x.datum ?? "-")],
    ["axes", (x.axes || []).map((a) => `${esc(a.name)}${a.abbrev ? ` (${esc(a.abbrev)})` : ""}: ${esc(a.direction)}, ${esc(a.unit)}`).join("<br>") || "-"], ["area of use", esc(x.area_of_use ?? "-")]]);
  const html = ["<h4>Coordinate reference system</h4>", one(c)];
  c.components.forEach((s, i) => { html.push(`<h4>Component ${i + 1}</h4>`, one(s)); });
  if (c.wkt) html.push(`<details open><summary>WKT2</summary><pre>${esc(c.wkt)}</pre></details>`);
  $("tab-crs").innerHTML = html.join("");
}

function histSvg(hist, label, fmtEdge = (v) => fmt(v, 0)) {
  const { edges, counts } = hist;
  const w = 360, h = 56, pad = 2;
  const max = Math.max(...counts, 1);
  const bw = (w - 2 * pad) / counts.length;
  const bars = counts.map((c, i) => `<rect x="${(pad + i * bw).toFixed(1)}" y="${(h - 12 - ((h - 14) * c) / max).toFixed(1)}" width="${Math.max(bw - 0.5, 0.5).toFixed(1)}" height="${(((h - 14) * c) / max).toFixed(1)}"/>`).join("");
  return `<svg class="hist" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><title>${esc(label)}</title>${bars}<text x="${pad}" y="${h - 2}">${esc(fmtEdge(edges[0]))}</text><text x="${w - pad}" y="${h - 2}" text-anchor="end">${esc(fmtEdge(edges[edges.length - 1]))}</text></svg>`;
}

export function renderStats(s) {
  const html = [];
  const ranged = (r, digits = 2) => kvTable([["min / max", `${fmt(r.min, digits)} / ${fmt(r.max, digits)}`], ["mean / std", `${fmt(r.mean, digits)} / ${fmt(r.std, digits)}`],
    ["percentiles", Object.entries(r.percentiles || {}).map(([p, v]) => `p${p} ${fmt(v, digits)}`).join(", ") + (r.percentiles_note ? ` <span class="d">(${esc(r.percentiles_note)})</span>` : "")]]);
  if (s.files) html.push("<h4>Files</h4>", `<table class="grid"><tr><th>file</th><th>points</th></tr>${s.files.map((f) => `<tr><td class="nm">${esc(f.name)}</td><td>${fmtInt(f.count)}</td></tr>`).join("")}</table>`);
  html.push("<h4>Points</h4>", kvTable([["count", fmtInt(s.point_count)], ["density", s.density_per_m2 ? `${fmt(s.density_per_m2, 2)} pts/m2${s.density_note ? ` (${esc(s.density_note)})` : ""}` : "-"],
    ["ground points", `${fmtInt(s.ground_points)} (${s.ground_density_per_m2 ? fmt(s.ground_density_per_m2, 2) : "-"} pts/m2)`],
    ["bounds min", s.bounds.min.map((v) => fmt(v, 2)).join(", ")], ["bounds max", s.bounds.max.map((v) => fmt(v, 2)).join(", ")]]));
  html.push("<h4>Classification</h4>", `<table class="grid"><tr><th>code</th><th>name</th><th>count</th><th>%</th></tr>${s.classification.map((r) => `<tr><td><span class="sw" style="background:rgb(${r.color.join(",")})"></span>${r.value}</td><td class="nm">${esc(r.name)}</td><td>${fmtInt(r.count)}</td><td>${(100 * r.fraction).toFixed(2)}</td></tr>`).join("")}</table>`);
  html.push("<h4>Elevation (z)</h4>", ranged(s.z), histSvg(s.z.histogram, "z"));
  html.push("<h4>Intensity</h4>", ranged(s.intensity, 0), histSvg(s.intensity.histogram, "intensity"));
  const countTable = (rows, head) => `<table class="grid"><tr><th>${head}</th><th>count</th><th>%</th></tr>${rows.map((r) => `<tr><td>${r.value}</td><td>${fmtInt(r.count)}</td><td>${(100 * r.fraction).toFixed(2)}</td></tr>`).join("")}</table>`;
  html.push("<h4>Returns</h4>", countTable(s.return_number, "return number"), countTable(s.number_of_returns, "number of returns"));
  if (s.gps_time) {
    const g = s.gps_time;
    html.push("<h4>GPS time</h4>", kvTable([["type", g.type === "standard" ? "adjusted standard GPS time" : "GPS week time"], ["min / max", `${fmt(g.min, 3)} / ${fmt(g.max, 3)}`], ["span", `${fmt(g.span_seconds, 1)} s (${fmt(g.span_seconds / 60, 1)} min)`],
      ["UTC", g.min_utc ? `${esc(g.min_utc)}<br>${esc(g.max_utc)}<br><span class="d">(${g.leap_seconds_assumed} leap seconds assumed)</span>` : "week time, no date"]]), histSvg(g.histogram, "gps time", (v) => fmt(v - g.min, 0) + " s"));
  }
  html.push("<h4>Scan angle (deg)</h4>", ranged(s.scan_angle_deg, 2), histSvg(s.scan_angle_deg.histogram, "scan angle", (v) => fmt(v, 1)));
  html.push("<h4>Point source ids</h4>", kvTable([["distinct", s.point_source_id_unique]]), countTable(s.point_source_id, "point source id"));
  if (s.scanner_channel) html.push("<h4>Scanner channel</h4>", countTable(s.scanner_channel, "channel"));
  html.push("<h4>Flags</h4>", kvTable(Object.entries(s.flags).map(([k, v]) => [k.replace(/_/g, " "), fmtInt(v)])));
  html.push("<h4>User data</h4>", countTable(s.user_data, "value"));
  if (s.rgb) html.push("<h4>RGB</h4>", ...Object.entries(s.rgb).map(([k, r]) => `<div class="d">${k}</div>` + ranged(r, 0)));
  if (s.nir) html.push("<h4>NIR</h4>", ranged(s.nir, 0));
  $("tab-stats").innerHTML = html.join("");
}

// ---------------------------------------------------------------------------
// The panels' state and wiring
// ---------------------------------------------------------------------------

// `cloud` is the shared bookkeeping, `cam` the fly camera's pose (for the
// distance to a picked point), `marker` the picked point's sprite, `shading`
// holds the class texture the class list writes.
export function createPanels({ cloud, cam, marker, shading }) {
  let files = [];          // the server's file listing
  const classVisible = new Array(256).fill(true);

  function writeClassTexture() {
    const { classTexData, classTex } = shading;
    for (let c = 0; c < 256; c++) {
      const col = classColor(c);
      classTexData[4 * c] = col[0]; classTexData[4 * c + 1] = col[1]; classTexData[4 * c + 2] = col[2];
      classTexData[4 * c + 3] = classVisible[c] ? 255 : 0;
    }
    classTex.needsUpdate = true;
  }
  writeClassTexture();

  function buildClassList(stats) {
    const rows = stats.classification.map((r) => {
      setClassColor(r.value, r.color);
      return `<label><input type="checkbox" data-class="${r.value}" ${classVisible[r.value] ? "checked" : ""}>
        <span class="sw" style="background:rgb(${r.color.join(",")})"></span>
        <span class="nm" title="${esc(r.name)}">${r.value} ${esc(r.name)}</span>
        <span class="ct">${(100 * r.fraction).toFixed(1)}%</span></label>`;
    });
    ui.classList.innerHTML = rows.join("");
    ui.classList.querySelectorAll("input").forEach((cb) => cb.addEventListener("change", () => {
      classVisible[Number(cb.dataset.class)] = cb.checked;
      writeClassTexture();
    }));
    writeClassTexture();
  }
  $("classes-all").addEventListener("click", () => { classVisible.fill(true); ui.classList.querySelectorAll("input").forEach((cb) => (cb.checked = true)); writeClassTexture(); });
  $("classes-none").addEventListener("click", () => { classVisible.fill(false); ui.classList.querySelectorAll("input").forEach((cb) => (cb.checked = false)); writeClassTexture(); });

  // Panels and tabs
  function togglePanels() {
    const hide = !$("left").hidden;
    $("left").hidden = hide; $("right").hidden = hide;
    $("show-left").hidden = !hide; $("show-right").hidden = !hide;
  }
  $("toggle-left").addEventListener("click", () => { $("left").hidden = true; $("show-left").hidden = false; });
  $("show-left").addEventListener("click", () => { $("left").hidden = false; $("show-left").hidden = true; });
  $("toggle-right").addEventListener("click", () => { $("right").hidden = true; $("show-right").hidden = false; });
  $("show-right").addEventListener("click", () => { $("right").hidden = false; $("show-right").hidden = true; });
  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => activateTab(b.dataset.tab)));
  function activateTab(name) {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll(".tab-page").forEach((p) => (p.hidden = p.id !== `tab-${name}`));
  }

  // The point tab: null clears it, {loadingIndex} says a fetch is under way, a
  // record from /api/point fills it.
  function showPoint(rec) {
    const page = $("tab-point");
    activateTab("point");
    if (!rec) { page.innerHTML = "<em>nothing under the cursor</em>"; marker.visible = false; return; }
    if (rec.loadingIndex !== undefined) { page.innerHTML = `<em>point ${fmtInt(rec.loadingIndex)} of the stream, fetching...</em>`; return; }
    const c = cloud.center;
    const dist = Math.hypot(rec.x - c[0] - cam.pos.x, rec.y - c[1] - cam.pos.y, rec.z - c[2] - cam.pos.z);
    const rows = [];
    const add = (k, v, cls = "") => rows.push(`<tr><th>${esc(k)}</th><td class="${cls}">${v}</td></tr>`);
    add("x (east)", fmt(rec.x, 2)); add("y (north)", fmt(rec.y, 2)); add("z", fmt(rec.z, 2));
    if (rec.latitude !== undefined) add("lat / lon", `${fmt(rec.latitude, 6)}, ${fmt(rec.longitude, 6)} <a href="https://www.openstreetmap.org/?mlat=${rec.latitude}&mlon=${rec.longitude}#map=17/${rec.latitude}/${rec.longitude}" target="_blank" rel="noopener">map</a>`);
    add("raw X Y Z", `${rec.X} ${rec.Y} ${rec.Z}`);
    add("distance from camera", `${fmt(dist, 1)} m`);
    const sw = (code) => { const col = classColor(code); return `<span class="sw" style="background:rgb(${col.join(",")})"></span>`; };
    add("classification", `${sw(rec.classification)}${rec.classification} ${esc(rec.classification_name)}`);
    add("intensity", fmtInt(rec.intensity));
    add("return", `${rec.return_number} of ${rec.number_of_returns}`);
    add("point source id", rec.point_source_id);
    add("scan angle", `${fmt(rec.scan_angle_deg, 2)} deg`);
    if (rec.scanner_channel !== undefined) add("scanner channel", rec.scanner_channel);
    add("user data", rec.user_data);
    if (rec.gps_time !== undefined) { add("gps time", fmt(rec.gps_time, 6)); add("gps time (UTC)", rec.gps_time_utc ? esc(rec.gps_time_utc) : "week time, no date"); }
    if (rec.rgb) add("rgb", `<span class="sw" style="background:rgb(${rec.rgb.join(",")})"></span>${rec.rgb.join(" ")}`);
    if (rec.nir !== undefined) add("nir", rec.nir);
    const flags = ["synthetic", "key_point", "withheld", "overlap", "edge_of_flight_line"].map((f) => `<span class="${rec[f] ? "flag-on" : ""}">${f}${rec[f] ? " = 1" : " = 0"}</span>`).join(", ");
    add("flags", flags);
    add("scan direction", rec.scan_direction_flag ? "positive (1)" : "negative (0)");
    add("file", esc(rec.file_name));
    add("index in file", fmtInt(rec.file_index));
    add("index in stream", fmtInt(rec.stream_index));
    page.innerHTML = `<table class="kv">${rows.join("")}</table>
      <div class="row"><button id="copy-point" class="mini">copy as JSON</button></div>`;
    $("copy-point").addEventListener("click", () => navigator.clipboard.writeText(JSON.stringify(rec, null, 2)));
  }
  function showPointError(message) {
    $("tab-point").innerHTML = `<em>could not fetch the point: ${esc(message)}</em>`;
  }

  // Files
  function selectedIds() {
    return [...ui.fileList.querySelectorAll("input:checked")].map((cb) => Number(cb.dataset.file));
  }
  function updateFilesCount() {
    const ids = selectedIds();
    const pts = ids.reduce((n, i) => n + Math.max(0, files[i].point_count), 0);
    ui.filesCount.textContent = `${ids.length} of ${files.length}, ${fmtInt(pts)} pts`;
  }
  // (Re)list the server's files. On the first call the URL's ?files= picks the ticked
  // ones (all, by default); later calls keep the ticks and tick `select` (new files).
  async function loadFiles(select = null) {
    const before = files.length ? new Set(selectedIds()) : null;
    files = await fetchJson("/api/files");
    const params = new URLSearchParams(location.search);
    const wanted = (params.get("files") || params.get("file") || "").split(",").filter((s) => s !== "").map(Number);
    const checked = (f) => (before ? before.has(f.id) || (select || []).includes(f.id) : wanted.length ? wanted.includes(f.id) : true);
    ui.fileList.innerHTML = files.length
      ? files.map((f) => `<label title="${esc(f.path)}"><input type="checkbox" data-file="${f.id}" ${checked(f) ? "checked" : ""}>
      <span class="nm">${esc(f.name)}</span><span class="ct">${fmtInt(f.point_count)} pf${f.point_format}</span></label>`).join("")
      : "<em>no files open</em>";
    ui.fileList.querySelectorAll("input").forEach((cb) => cb.addEventListener("change", updateFilesCount));
    ui.metaFile.innerHTML = files.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join("");
    updateFilesCount();
    if (!files.length) { setStatus(window.pywebview ? "open a file (Open... or O)" : "no files; start lpc_view with some"); return; }
    const first = (select || []).find((i) => files[i]) ?? selectedIds()[0] ?? 0;
    ui.metaFile.value = String(first);
    await showMetadata(first);
  }

  // In the app (pywebview window), Open... asks Python for the native file dialog.
  let opening = false;
  async function openFiles() {
    if (opening || !window.pywebview) return;
    opening = true;
    try {
      const r = await window.pywebview.api.open_files();
      if (r.error) { setStatus(r.error); return; }
      if (r.cancelled) { if (!files.length) setStatus("no files open; Open... (or O) to pick some"); return; }
      await loadFiles(r.selected);
      if (r.added.length) setStatus(`${r.added.length} file(s) opened; press Load`);
    } catch (err) {
      setStatus(`open failed: ${err.message || err}`);
    } finally {
      opening = false;
    }
  }
  window.addEventListener("pywebviewready", () => {
    $("open-btn").hidden = false;
    if (!files.length) openFiles();
  });
  $("open-btn").addEventListener("click", openFiles);
  $("files-all").addEventListener("click", () => { ui.fileList.querySelectorAll("input").forEach((cb) => (cb.checked = true)); updateFilesCount(); });
  $("files-none").addEventListener("click", () => { ui.fileList.querySelectorAll("input").forEach((cb) => (cb.checked = false)); updateFilesCount(); });
  ui.metaFile.addEventListener("change", () => showMetadata(Number(ui.metaFile.value)));

  async function showMetadata(fileId) {
    try {
      const meta = await fetchJson(`/api/meta?file=${fileId}`);
      renderHeader(meta, fileId);
      renderVlrs(meta);
      renderCrs(meta);
      if (!cloud.stats) setStatus(`${fmtInt(meta.header.point_count)} points, ${(meta.file.size_bytes / 1048576).toFixed(1)} MB; tick files and press Load`);
    } catch (err) {
      setStatus(`metadata failed: ${err.message}`);
    }
  }

  // Show file `fileId`'s metadata in the right panel if another file's is up.
  function selectMetaFile(fileId) {
    if (String(ui.metaFile.value) !== String(fileId)) { ui.metaFile.value = String(fileId); showMetadata(fileId); }
  }

  return {
    get files() { return files; },
    fileName: (id) => (files[id] || {}).name || String(id),
    selectedIds, loadFiles, openFiles, showMetadata, selectMetaFile,
    showPoint, showPointError, renderStats, buildClassList, togglePanels, activateTab,
  };
}

