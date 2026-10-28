
(function () {
  "use strict";

  // ── State ─────────────────────────────────────────────────────────────
  var editOn = false;
  var tool = "track"; // "track" | "pits"
  var draftTrack = []; // [{u,v}] raw, as drawn
  var draftPits = [];
  var drawing = null; // { tool, moved }
  var allTracks = [];
  var editingId = null;
  var editingStatus = "draft";
  var injected = false;

  function getApiBase() {
    try { if (typeof window.apiUrl === "string" && window.apiUrl) return window.apiUrl; } catch (e) {}
    try { if (typeof apiUrl === "string" && apiUrl) return apiUrl; } catch (e) {}
    return "";
  }
  function getCurrentUser() {
    try { if (typeof window.user !== "undefined" && window.user) return window.user; } catch (e) {}
    try { if (typeof user !== "undefined" && user) return user; } catch (e) {}
    return null;
  }

  var DEV_USER_ID_FALLBACK = "790254318389166111";
  function isCommittee() {
    var u = getCurrentUser();
    if (u && u.id === DEV_USER_ID_FALLBACK) return true;
    try { if (typeof DEV_USER_ID !== "undefined" && u && u.id === DEV_USER_ID) return true; } catch (e) {}
    try { if (typeof window._committeeAccess !== "undefined" && window._committeeAccess) return true; } catch (e) {}
    try { if (typeof _committeeAccess !== "undefined" && _committeeAccess) return true; } catch (e) {}
    return false;
  }
  function toast(msg, kind) {
    try {
      if (typeof showToast === "function") { showToast(msg, kind || "ok"); return; }
    } catch (e) {}
    var el = document.getElementById("track-editor-status");
    if (el) el.textContent = msg;
  }
  function headers() {
    var u = getCurrentUser();
    var h = { "Content-Type": "application/json" };
    if (u && u.id) h["x-discord-id"] = u.id;
    if (u && u.token) h["x-discord-token"] = u.token;
    return h;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ── Beautify: rough hand drawing -> smooth professional path ──────────
  function dist(a, b) {
    var dx = a.u - b.u, dy = a.v - b.v;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function clean(points) {
    var out = [];
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      var last = out[out.length - 1];
      if (last && dist(last, p) < 0.0008) continue;
      out.push({ u: p.u, v: p.v });
    }
    return out;
  }
  function isClosed(points) {
    if (points.length < 4) return false;
    return dist(points[0], points[points.length - 1]) < 0.08;
  }
  function resample(points, closed, target) {
    var pts = points.slice();
    if (closed && dist(pts[0], pts[pts.length - 1]) > 0.0008) pts.push({ u: pts[0].u, v: pts[0].v });
    if (pts.length < 2) return pts;
    var cum = [0];
    for (var i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
    if (closed) cum.push(cum[cum.length - 1] + dist(pts[pts.length - 1], pts[0]));
    var total = cum[cum.length - 1];
    if (total <= 0) return pts;
    var out = [];
    var seg = 0;
    for (var k = 0; k < target; k++) {
      var d = (k / target) * total;
      while (seg < cum.length - 2 && cum[seg + 1] < d) seg++;
      var a = pts[seg % pts.length];
      var b = pts[(seg + 1) % pts.length];
      var span = cum[seg + 1] - cum[seg] || 1;
      var t = (d - cum[seg]) / span;
      out.push({ u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t });
    }
    return out;
  }
  function chaikin(points, closed) {
    var out = [];
    var n = points.length;
    for (var i = 0; i < n; i++) {
      var a = points[i];
      var b = points[(i + 1) % n];
      if (!closed && i === n - 1) { out.push(a); break; }
      if (!closed && i === 0) out.push(a);
      out.push({ u: a.u * 0.75 + b.u * 0.25, v: a.v * 0.75 + b.v * 0.25 });
      out.push({ u: a.u * 0.25 + b.u * 0.75, v: a.v * 0.25 + b.v * 0.75 });
      if (!closed && i === n - 2) out.push(b);
    }
    return out;
  }
  function beautifyTrack(points) {
    var pts = clean(points);
    if (pts.length < 3) return pts;
    var closed = isClosed(pts);
    if (closed) pts.pop();
    var sampled = resample(pts, closed, closed ? 240 : 180);
    var s1 = chaikin(sampled, closed);
    var s2 = chaikin(s1, closed);
    if (closed) return s2;
    // Keep the exact start/end the committee drew for an open line.
    s2[0] = { u: pts[0].u, v: pts[0].v };
    s2[s2.length - 1] = { u: pts[pts.length - 1].u, v: pts[pts.length - 1].v };
    return s2;
  }

  // ── SVG rendering ─────────────────────────────────────────────────────
  function svgEl() { return document.getElementById("track-map-svg"); }
  function imgEl() { return document.getElementById("track-map-img"); }
  function pathD(points, closed) {
    var img = imgEl();
    var W = (img && img.naturalWidth) || 1000, H = (img && img.naturalHeight) || 1000;
    if (!points.length) return "";
    var d = points.map(function (p, i) {
      return (i === 0 ? "M" : "L") + (p.u * W).toFixed(1) + " " + (p.v * H).toFixed(1);
    }).join(" ");
    return closed ? d + " Z" : d;
  }
  function ensureSvgGroups() {
    var svg = svgEl();
    if (!svg || svg.querySelector("#track-map-tracks")) return;
    var defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.innerHTML =
      '<marker id="te-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
      '<path d="M 0 0 L 10 5 L 0 10 z" fill="#ffd60a"/></marker>';
    svg.appendChild(defs);
    var g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("id", "track-map-tracks");
    svg.appendChild(g);
    var d = document.createElementNS("http://www.w3.org/2000/svg", "g");
    d.setAttribute("id", "track-map-draft");
    svg.appendChild(d);
  }
  function renderOneTrack(g, track, isDraftView) {
    var img = imgEl();
    var W = (img && img.naturalWidth) || 1000;
    var pts = (track.smoothedPoints && track.smoothedPoints.length >= 3)
      ? track.smoothedPoints : beautifyTrack(track.trackPoints || []);
    if (pts.length < 2) return;
    var closed = track.closed !== undefined ? !!track.closed : isClosed(track.trackPoints || []);
    var d = pathD(pts, closed);
    var edge = (W * 0.016).toFixed(1), asphalt = (W * 0.011).toFixed(1), line = (W * 0.0028).toFixed(1);
    var group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.setAttribute("data-track-id", track.id || "");
    if (isDraftView) group.setAttribute("opacity", "0.75");
    var mk = function (stroke, width, extra) {
      var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", d);
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", stroke);
      p.setAttribute("stroke-width", width);
      p.setAttribute("stroke-linejoin", "round");
      p.setAttribute("stroke-linecap", "round");
      if (extra) Object.keys(extra).forEach(function (k) { p.setAttribute(k, extra[k]); });
      return p;
    };
    group.appendChild(mk("#ffffff", edge, { opacity: "0.95" }));
    group.appendChild(mk("#23262d", asphalt, isDraftView ? { "stroke-dasharray": "18 10" } : {}));
    group.appendChild(mk("#ffd60a", line, { "marker-mid": "url(#te-arrow)" }));
    // Start / finish: short perpendicular tick at the first smoothed point.
    if (pts.length >= 2) {
      var a = pts[0], b = pts[1];
      var dx = b.u - a.u, dy = b.v - a.v, len = Math.sqrt(dx * dx + dy * dy) || 1;
      var nx = -dy / len, ny = dx / len, half = W * 0.008;
      var H = (img && img.naturalHeight) || 1000;
      var tick = document.createElementNS("http://www.w3.org/2000/svg", "line");
      tick.setAttribute("x1", (a.u * W - nx * half).toFixed(1));
      tick.setAttribute("y1", (a.v * H - ny * half).toFixed(1));
      tick.setAttribute("x2", (a.u * W + nx * half).toFixed(1));
      tick.setAttribute("y2", (a.v * H + ny * half).toFixed(1));
      tick.setAttribute("stroke", "#ffffff");
      tick.setAttribute("stroke-width", (W * 0.004).toFixed(1));
      tick.setAttribute("stroke-dasharray", "6 6");
      group.appendChild(tick);
      var label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", (a.u * W + 14).toFixed(1));
      label.setAttribute("y", (a.v * H - 12).toFixed(1));
      label.setAttribute("fill", "#ffffff");
      label.setAttribute("font-size", Math.max(18, W * 0.016).toFixed(0));
      label.setAttribute("font-family", "Oxanium, sans-serif");
      label.setAttribute("font-weight", "700");
      label.setAttribute("paint-order", "stroke");
      label.setAttribute("stroke", "#000000");
      label.setAttribute("stroke-width", "4");
      label.textContent = track.name + (track.status === "draft" ? "  [DRAFT]" : "");
      group.appendChild(label);
    }
    // Pits: orange, dashed, thinner — clearly separate from the race line.
    var pitPts = (track.smoothedPitPoints && track.smoothedPitPoints.length >= 2)
      ? track.smoothedPitPoints : beautifyTrack(track.pitPoints || []);
    if (pitPts.length >= 2) {
      var pd = pathD(pitPts, false);
      var pit = document.createElementNS("http://www.w3.org/2000/svg", "path");
      pit.setAttribute("d", pd);
      pit.setAttribute("fill", "none");
      pit.setAttribute("stroke", "#ff6b1a");
      pit.setAttribute("stroke-width", (W * 0.006).toFixed(1));
      pit.setAttribute("stroke-linejoin", "round");
      pit.setAttribute("stroke-linecap", "round");
      pit.setAttribute("stroke-dasharray", "16 10");
      group.appendChild(pit);
    }
    g.appendChild(group);
  }
  function renderAllTracks() {
    ensureSvgGroups();
    var g = document.getElementById("track-map-tracks");
    if (!g) return;
    g.innerHTML = "";
    allTracks.forEach(function (t) { renderOneTrack(g, t, t.status === "draft"); });
    renderDraftPreview();
  }
  function renderDraftPreview() {
    var g = document.getElementById("track-map-draft");
    if (!g) return;
    g.innerHTML = "";
    if (!editOn) return;
    if (draftTrack.length >= 2) {
      renderOneTrack(g, {
        id: "draft", name: "(drawing)", status: "draft",
        trackPoints: draftTrack, pitPoints: [], closed: isClosed(draftTrack),
        smoothedPoints: beautifyTrack(draftTrack),
      }, true);
    }
    if (draftPits.length >= 2) {
      var pit = document.createElementNS("http://www.w3.org/2000/svg", "path");
      pit.setAttribute("d", pathD(beautifyTrack(draftPits), false));
      pit.setAttribute("fill", "none");
      pit.setAttribute("stroke", "#ff6b1a");
      pit.setAttribute("stroke-width", "6");
      pit.setAttribute("stroke-dasharray", "14 8");
      pit.setAttribute("stroke-linejoin", "round");
      g.appendChild(pit);
    } else if (draftPits.length === 1) {
      // Show the single pit point as a dot so the committee sees the stroke started.
      var img = imgEl(), W = (img && img.naturalWidth) || 1000, H = (img && img.naturalHeight) || 1000;
      var c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("cx", (draftPits[0].u * W).toFixed(1));
      c.setAttribute("cy", (draftPits[0].v * H).toFixed(1));
      c.setAttribute("r", "8");
      c.setAttribute("fill", "#ff6b1a");
      g.appendChild(c);
    }
  }

  // ── Loading / saving ──────────────────────────────────────────────────
  async function loadTracks() {
    var base = getApiBase();
    if (!base) return;
    try {
      var include = isCommittee() ? "?includeDrafts=1" : "";
      var res = await fetch(base + "/tracks" + include, { headers: headers() });
      if (!res.ok) throw new Error("HTTP " + res.status);
      var data = await res.json();
      allTracks = data.tracks || [];
      renderAllTracks();
      refreshTrackSelect();
    } catch (e) {
      toast("Could not load tracks: " + e.message, "err");
    }
  }
  function currentDraftPayload() {
    var nameEl = document.getElementById("te-name");
    var name = nameEl ? nameEl.value.trim() : "";
    var closed = isClosed(draftTrack);
    return {
      name: name,
      trackPoints: draftTrack,
      pitPoints: draftPits,
      smoothedPoints: beautifyTrack(draftTrack),
      smoothedPitPoints: draftPits.length >= 2 ? beautifyTrack(draftPits) : [],
      closed: closed,
    };
  }
  async function saveDraft() {
    var payload = currentDraftPayload();
    if (!payload.name) { toast("Type a track name first.", "err"); return; }
    if (payload.trackPoints.length < 3) { toast("Draw the track first (at least 3 points).", "err"); return; }
    var base = getApiBase();
    try {
      var res, url = base + "/committee/tracks" + (editingId ? "/" + editingId : "");
      res = await fetch(url, {
        method: editingId ? "PUT" : "POST",
        headers: headers(),
        body: JSON.stringify(payload),
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
      editingId = data.track.id;
      editingStatus = data.track.status;
      toast(editingId ? "Draft saved." : "Draft saved.");
      await loadTracks();
      selectTrack(editingId);
    } catch (e) { toast("Save failed: " + e.message, "err"); }
  }
  async function publishTrack() {
    if (!editingId) {
      await saveDraft();
      if (!editingId) return;
    } else {
      await saveDraft();
    }
    try {
      var res = await fetch(getApiBase() + "/committee/tracks/" + editingId + "/publish", {
        method: "POST", headers: headers(), body: "{}",
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
      editingStatus = "published";
      toast("Published — now visible to everyone.");
      await loadTracks();
      selectTrack(editingId);
    } catch (e) { toast("Publish failed: " + e.message, "err"); }
  }
  async function unpublishTrack() {
    if (!editingId) return;
    try {
      var res = await fetch(getApiBase() + "/committee/tracks/" + editingId + "/unpublish", {
        method: "POST", headers: headers(), body: "{}",
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
      editingStatus = "draft";
      toast("Unpublished — committee only again.");
      await loadTracks();
      selectTrack(editingId);
    } catch (e) { toast("Unpublish failed: " + e.message, "err"); }
  }
  async function deleteTrack() {
    if (!editingId) return;
    if (!window.confirm("Delete this track? This cannot be undone.")) return;
    try {
      var res = await fetch(getApiBase() + "/committee/tracks/" + editingId, {
        method: "DELETE", headers: headers(),
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
      newTrack();
      toast("Track deleted.");
      await loadTracks();
    } catch (e) { toast("Delete failed: " + e.message, "err"); }
  }
  function selectTrack(id) {
    var t = allTracks.find(function (x) { return x.id === id; });
    if (!t) return;
    editingId = t.id;
    editingStatus = t.status;
    draftTrack = (t.trackPoints || []).slice();
    draftPits = (t.pitPoints || []).slice();
    var nameEl = document.getElementById("te-name");
    if (nameEl) nameEl.value = t.name;
    var sel = document.getElementById("te-select");
    if (sel) sel.value = id;
    updatePublishButton();
    renderAllTracks();
  }
  function newTrack() {
    editingId = null;
    editingStatus = "draft";
    draftTrack = [];
    draftPits = [];
    var nameEl = document.getElementById("te-name");
    if (nameEl) nameEl.value = "";
    var sel = document.getElementById("te-select");
    if (sel) sel.value = "";
    updatePublishButton();
    renderAllTracks();
  }
  function refreshTrackSelect() {
    var sel = document.getElementById("te-select");
    if (!sel) return;
    var prev = sel.value;
    sel.innerHTML = '<option value="">— Select a track to edit —</option>' +
      allTracks.map(function (t) {
        return '<option value="' + esc(t.id) + '">' + esc(t.name) +
          (t.status === "draft" ? "  [DRAFT]" : "") + "</option>";
      }).join("");
    if (prev && allTracks.some(function (t) { return t.id === prev; })) sel.value = prev;
  }
  function updatePublishButton() {
    var btn = document.getElementById("te-publish");
    if (btn) btn.textContent = editingStatus === "published" ? "Unpublish" : "Publish";
    var del = document.getElementById("te-delete");
    if (del) del.style.display = editingId ? "" : "none";
  }

  // ── Drawing ───────────────────────────────────────────────────────────
  function pointerToUV(e) {
    var img = imgEl();
    if (!img || !img.naturalWidth) return null;
    var r = img.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    var u = (e.clientX - r.left) / r.width;
    var v = (e.clientY - r.top) / r.height;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    return { u: Math.round(u * 10000) / 10000, v: Math.round(v * 10000) / 10000 };
  }
  function bindDrawing() {
    var vp = document.getElementById("track-map-viewport");
    if (!vp || vp._teBound) return;
    vp._teBound = true;
    vp.addEventListener("pointerdown", function (e) {
      if (!editOn) return;
      if (e.target && e.target.closest && e.target.closest(".tm-zoom-ctl")) return;
      if (e.button !== 0) return;
      var p = pointerToUV(e);
      if (!p) return;
      drawing = { tool: tool };
      var arr = tool === "pits" ? draftPits : draftTrack;
      // Start a fresh stroke for pits; for the track, continue the same
      // loop unless the user pressed New / selected another track.
      arr.push(p);
      try { vp.setPointerCapture(e.pointerId); } catch (err) {}
      renderDraftPreview();
    });
    vp.addEventListener("pointermove", function (e) {
      if (!editOn || !drawing) return;
      var p = pointerToUV(e);
      if (!p) return;
      var arr = drawing.tool === "pits" ? draftPits : draftTrack;
      var last = arr[arr.length - 1];
      if (last && dist(last, p) < 0.003) return;
      arr.push(p);
      renderDraftPreview();
    });
    var end = function () { drawing = null; renderDraftPreview(); };
    vp.addEventListener("pointerup", end);
    vp.addEventListener("pointercancel", end);
  }

  // ── Editor UI (injected into the Track tab) ────────────────────────────
  function injectUI() {

    if (document.getElementById("track-editor-bar")) { bindDrawing(); updateVisibility(); return true; }
    injected = false;
    var controls = document.querySelector("#d-tab-track .tm-controls");
    var svg = svgEl();
    if (!controls || !svg) return;
    injected = true;
    ensureSvgGroups();
    var bar = document.createElement("div");
    bar.id = "track-editor-bar";
    bar.style.cssText = "display:none;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0;padding:8px;border:1px solid var(--border);border-radius:8px;background:rgba(255,214,10,0.06);";
    bar.innerHTML =
      '<button type="button" id="te-pencil" style="padding:6px 10px;cursor:pointer;background:transparent;color:var(--text);border:1px solid var(--border);border-radius:6px;font-family:inherit;">✏️ Pencil: OFF</button>' +
      '<span id="te-edit-controls" style="display:none;flex-wrap:wrap;gap:6px;align-items:center;">' +
      '<select id="te-select" style="padding:6px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:6px;font-family:inherit;"></select>' +
      '<input id="te-name" placeholder="Track name" maxlength="80" style="padding:6px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:6px;font-family:inherit;" />' +
      '<button type="button" id="te-tool-track" style="padding:6px 10px;cursor:pointer;background:#ffd60a;color:#111;border:1px solid #ffd60a;border-radius:6px;font-family:inherit;font-weight:700;">Track</button>' +
      '<button type="button" id="te-tool-pits" style="padding:6px 10px;cursor:pointer;background:transparent;color:var(--text);border:1px solid var(--border);border-radius:6px;font-family:inherit;">Pits</button>' +
      '<button type="button" id="te-undo" style="padding:6px 10px;cursor:pointer;background:transparent;color:var(--text);border:1px solid var(--border);border-radius:6px;font-family:inherit;">Undo</button>' +
      '<button type="button" id="te-clear" style="padding:6px 10px;cursor:pointer;background:transparent;color:var(--text);border:1px solid var(--border);border-radius:6px;font-family:inherit;">Clear stroke</button>' +
      '<button type="button" id="te-new" style="padding:6px 10px;cursor:pointer;background:transparent;color:var(--text);border:1px solid var(--border);border-radius:6px;font-family:inherit;">New</button>' +
      '<button type="button" id="te-save" style="padding:6px 10px;cursor:pointer;background:transparent;color:var(--text);border:1px solid var(--border);border-radius:6px;font-family:inherit;">Save draft</button>' +
      '<button type="button" id="te-publish" style="padding:6px 10px;cursor:pointer;background:rgba(0,230,118,0.15);color:var(--green,#00e676);border:1px solid var(--green,#00e676);border-radius:6px;font-family:inherit;font-weight:700;">Publish</button>' +
      '<button type="button" id="te-delete" style="padding:6px 10px;cursor:pointer;background:transparent;color:#ff5252;border:1px solid #ff5252;border-radius:6px;font-family:inherit;display:none;">Delete</button>' +
      "</span>" +
      '<span id="track-editor-status" style="font-size:11px;opacity:0.75;"></span>';
    controls.parentNode.insertBefore(bar, controls.nextSibling);
    var hint = document.createElement("div");
    hint.id = "track-editor-hint";
    hint.style.cssText = "display:none;font-size:11px;opacity:0.6;margin:4px 0 8px;line-height:1.4;";
    hint.textContent = "Pencil on: drag on the map to draw. Track = the loop, Pits = pit lane. Save draft to keep it committee-only, Publish to show it to everyone.";
    bar.parentNode.insertBefore(hint, bar.nextSibling);

    document.getElementById("te-pencil").addEventListener("click", function () {
      if (!isCommittee()) { toast("You need the Race Committee role to draw tracks.", "err"); return; }
      editOn = !editOn;
      window._trackEditOn = editOn;
      this.textContent = editOn ? "✏️ Pencil: ON" : "✏️ Pencil: OFF";
      document.getElementById("te-edit-controls").style.display = editOn ? "flex" : "none";
      document.getElementById("track-editor-hint").style.display = editOn ? "block" : "none";
      var vp = document.getElementById("track-map-viewport");
      if (vp) vp.style.cursor = editOn ? "crosshair" : "";
      if (editOn) loadTracks();
      renderAllTracks();
    });
    document.getElementById("te-select").addEventListener("change", function () {
      if (this.value) selectTrack(this.value); else newTrack();
    });
    document.getElementById("te-tool-track").addEventListener("click", function () {
      tool = "track";
      this.style.background = "#ffd60a"; this.style.color = "#111";
      var p = document.getElementById("te-tool-pits");
      p.style.background = "transparent"; p.style.color = "var(--text)";
    });
    document.getElementById("te-tool-pits").addEventListener("click", function () {
      tool = "pits";
      this.style.background = "#ff6b1a"; this.style.color = "#fff";
      var t = document.getElementById("te-tool-track");
      t.style.background = "transparent"; t.style.color = "var(--text)";
    });
    document.getElementById("te-undo").addEventListener("click", function () {
      var arr = tool === "pits" ? draftPits : draftTrack;
      arr.pop();
      renderAllTracks();
    });
    document.getElementById("te-clear").addEventListener("click", function () {
      if (tool === "pits") draftPits = []; else draftTrack = [];
      renderAllTracks();
    });
    document.getElementById("te-new").addEventListener("click", newTrack);
    document.getElementById("te-save").addEventListener("click", saveDraft);
    document.getElementById("te-publish").addEventListener("click", function () {
      if (editingStatus === "published") unpublishTrack(); else publishTrack();
    });
    document.getElementById("te-delete").addEventListener("click", deleteTrack);
    bindDrawing();
    updateVisibility();
    injected = true;
    return true;
  }
  function updateVisibility() {
    var bar = document.getElementById("track-editor-bar");
    if (!bar) return;

    bar.style.display = isCommittee() ? "flex" : "none";
  }
  function tryInit() {
    var trackTab = document.getElementById("d-tab-track");
    if (!trackTab) return false;
    if (!document.querySelector("#d-tab-track .tm-controls")) return false;
    return !!injectUI();
  }
  function init() {
    if (tryInit()) {

      loadTracks();
    }
  }

  if (typeof MutationObserver !== "undefined" && document.documentElement) {
    var teObserver = new MutationObserver(function () { tryInit(); });
    teObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  setInterval(function () { tryInit(); }, 2000);

  document.addEventListener("click", function (e) {
    if (e.target && e.target.closest && e.target.closest("#d-tab-btn-track")) {
      setTimeout(function () { updateVisibility(); loadTracks(); }, 300);
    }
  });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
  window.TrackEditor = {
    loadTracks: loadTracks, renderAllTracks: renderAllTracks,
    beautifyTrack: beautifyTrack, isClosed: isClosed,
  };
})();
