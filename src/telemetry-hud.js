// ── Telemetry HUD v1.1 — follow/trails, flag readability, pit window ─────
// Load in renderer__3.html, after session-watcher.js:
//   <script src="telemetry-hud.js?v=2"></script>
//
// v1.1 changes, per user 2026-10-28:
//  - REMOVED: Timing Tower (original Field leaderboard is back, untouched,
//    never hidden), Relative box (duplicate of the existing Nearby panel),
//    and Cockpit HUD.
//  - KEPT: derived est. speed, track progress, battle detection, pit
//    window, map Follow + Trails, flag pattern / colourblind / flash.
//    Battles + pit window now live in a small info bar above the
//    original Field leaderboard, instead of replacing it.
//  - Still excluded: stewarding, spoken cues, sectors. Flag audio cues
//    already exist in the app and are not duplicated.
//
// PRC only sends LocationX/LocationZ, so speed is derived from position
// change over time (studs/s -> est. mph, smoothed, teleport-filtered)
// and labelled "est." on purpose. Track progress projects each live car
// onto the published drawn track from /tracks.

(function () {
  "use strict";
  console.log("[TelemetryHUD] v1.2 - follow/trails THICKER, flag readability, pit window (tower/relative/HUD removed)");

  var state = {
    colorblind: false,
    trailsOn: true,
    followName: null,
    trackPoints: null, trackClosed: false, trackName: "", trackFetchedAt: 0,
    speed: {},
    trails: {},
    progress: {},
    lastFlag: null,
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>\"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
    });
  }
  function getRace() {
    try { if (typeof _lastRaceState !== "undefined" && _lastRaceState) return _lastRaceState; } catch (e) {}
    try { if (typeof window._lastRaceState !== "undefined" && window._lastRaceState) return window._lastRaceState; } catch (e) {}
    return null;
  }
  function getDrivers() {
    var r = getRace();
    return (r && Array.isArray(r.drivers)) ? r.drivers : [];
  }
  function getCars() {
    try { if (typeof _trackMapCars !== "undefined" && Array.isArray(_trackMapCars)) return _trackMapCars; } catch (e) {}
    try { if (Array.isArray(window._trackMapCars)) return window._trackMapCars; } catch (e) {}
    return [];
  }
  function getMeName() {
    try { if (typeof config !== "undefined" && config && config.driver) return config.driver; } catch (e) {}
    try { if (typeof config !== "undefined" && config && config.driver2) return config.driver2; } catch (e) {}
    return "";
  }
  function getDelta(name) {
    try { if (typeof _deltaSeconds !== "undefined" && _deltaSeconds && typeof _deltaSeconds[name] === "number") return _deltaSeconds[name]; } catch (e) {}
    return null;
  }
  function getApiBase() {
    try { if (typeof window.apiUrl === "string" && window.apiUrl) return window.apiUrl; } catch (e) {}
    try { if (typeof apiUrl === "string" && apiUrl) return apiUrl; } catch (e) {}
    return "";
  }
  function getUserHeaders() {
    var h = {};
    try {
      var u = null;
      if (typeof window.user !== "undefined" && window.user) u = window.user;
      else if (typeof user !== "undefined" && user) u = user;
      if (u && u.id) h["x-discord-id"] = u.id;
      if (u && u.token) h["x-discord-token"] = u.token;
    } catch (e) {}
    return h;
  }

  // ── Pure helpers ──────────────────────────────────────────────────────────
  function speedMph(distStuds, dtSec) {
    if (!dtSec || dtSec <= 0) return 0;
    return (distStuds / dtSec) * 0.28 * 2.23694;
  }
  function dist2(a, b) {
    var dx = a.u - b.u, dy = a.v - b.v;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function projectProgress(points, car, closedOverride) {
    if (!points || points.length < 3 || !car) return null;
    var total = 0, cum = [0];
    for (var i = 1; i < points.length; i++) { total += dist2(points[i - 1], points[i]); cum.push(total); }
    var closed = closedOverride === true || dist2(points[0], points[points.length - 1]) < 0.08;
    if (closed) { total += dist2(points[points.length - 1], points[0]); }
    if (total <= 0) return null;
    var best = null, bestD = Infinity;
    var segCount = closed ? points.length : points.length - 1;
    for (var s = 0; s < segCount; s++) {
      var a = points[s], b = points[(s + 1) % points.length];
      var abx = b.u - a.u, aby = b.v - a.v;
      var len2 = abx * abx + aby * aby || 1;
      var t = ((car.x - a.u) * abx + (car.y - a.v) * aby) / len2;
      t = Math.max(0, Math.min(1, t));
      var px = a.u + abx * t, py = a.v + aby * t;
      var d = Math.sqrt((car.x - px) * (car.x - px) + (car.y - py) * (car.y - py));
      if (d < bestD) {
        bestD = d;
        var segLen = Math.sqrt(len2);
        var before = s === 0 ? 0 : cum[s];
        best = (before + segLen * t) / total;
      }
    }
    return best;
  }

  // ── CSS ───────────────────────────────────────────────────────────────────
  function ensureCss() {
    if (document.getElementById("th-css")) return;
    var s = document.createElement("style");
    s.id = "th-css";
    s.textContent = [
      "#th-info-wrap { margin-bottom: 10px; }",
      "#th-info-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:6px; }",
      "#th-info-head .th-title { font-size:10px; font-weight:800; letter-spacing:2px; text-transform:uppercase; color:var(--text); }",
      "#th-info-head button { font-family:'Oxanium',sans-serif; font-size:9px; font-weight:800; letter-spacing:.5px; text-transform:uppercase; padding:5px 10px; border-radius:99px; border:1px solid var(--border); background:rgba(255,255,255,.04); color:var(--muted); cursor:pointer; }",
      "#th-info-head button.on { color:#fff; border-color:var(--red); background:rgba(255,46,77,.16); }",
      ".th-battle-banner { padding:6px 10px; border-radius:10px; background:rgba(255,200,0,.12); border:1px solid rgba(255,200,0,.45); color:var(--yellow); font-size:10px; font-weight:800; letter-spacing:.5px; text-align:center; margin-bottom:8px; }",
      "#th-pitwindow { padding:10px; background:var(--surface); border:1px solid var(--border); border-radius:12px; font-variant-numeric:tabular-nums; }",
      "#th-pitwindow .th-pw-bar { height:8px; border-radius:99px; background:rgba(255,255,255,.08); overflow:hidden; margin:6px 0; }",
      "#th-pitwindow .th-pw-bar > div { height:100%; background:linear-gradient(90deg,var(--red),var(--yellow),var(--green)); }",
      "#th-myline { margin-top:8px; font-size:10px; color:var(--muted); font-variant-numeric:tabular-nums; }",
      "#th-flag-flash { display:none; position:fixed; left:50%; top:52px; transform:translateX(-50%); z-index:9000; padding:14px 28px; border-radius:14px; font-size:20px; font-weight:900; letter-spacing:2px; text-transform:uppercase; text-align:center; box-shadow:0 18px 50px rgba(0,0,0,.6); cursor:pointer; }",
      "#th-flag-flash.show { display:block; animation:thFlash 2.6s ease forwards; }",
      "@keyframes thFlash { 0% { opacity:0; transform:translateX(-50%) scale(.92); } 8% { opacity:1; transform:translateX(-50%) scale(1); } 80% { opacity:1; } 100% { opacity:0; } }",
      ".flag-card { font-weight:800; }",
      ".flag-card.green { background-image:repeating-linear-gradient(45deg, rgba(18,224,122,.10) 0 10px, transparent 10px 20px) !important; }",
      ".flag-card.yellow { background-image:repeating-linear-gradient(0deg, rgba(255,200,0,.12) 0 8px, transparent 8px 16px) !important; }",
      ".flag-card.red { background-image:repeating-linear-gradient(-45deg, rgba(255,46,77,.12) 0 10px, transparent 10px 20px) !important; }",
      ".flag-card.blue { background-image:radial-gradient(rgba(77,159,255,.18) 1.5px, transparent 1.5px) !important; background-size:12px 12px !important; }",
      ".flag-card.orange { background-image:repeating-linear-gradient(90deg, rgba(255,138,30,.12) 0 8px, transparent 8px 16px) !important; }",
      ".flag-card.white { background-image:repeating-conic-gradient(rgba(255,255,255,.14) 0% 25%, transparent 0% 50%) !important; background-size:14px 14px !important; }",
      "body.th-colorblind .flag-card.green { border-style:double !important; border-width:3px !important; }",
      "body.th-colorblind .flag-card.yellow { border-style:dashed !important; border-width:3px !important; }",
      "body.th-colorblind .flag-card.red { border-style:solid !important; border-width:3px !important; }",
      "body.th-colorblind .flag-card.blue { border-style:dotted !important; border-width:3px !important; }",
      "#th-trails polyline { fill:none; stroke-linejoin:round; stroke-linecap:round; opacity:.95; }",
      "#th-trails .th-trail-outline { opacity:.85; }",
      "#th-trails .th-trail-core { opacity:.98; }",
      ".tm-zoom-ctl button.th-on { background:rgba(255,46,77,.20) !important; border-color:var(--red) !important; color:#fff !important; }",
    ].join("\n");
    document.head.appendChild(s);
  }

  // ── Published track ───────────────────────────────────────────────────────
  async function fetchTrack() {
    var now = Date.now();
    if (now - state.trackFetchedAt < 30000 && state.trackPoints) return;
    state.trackFetchedAt = now;
    var base = getApiBase();
    if (!base) return;
    try {
      var res = await fetch(base + "/tracks", { headers: getUserHeaders() });
      if (!res.ok) return;
      var data = await res.json();
      var tracks = data.tracks || [];
      var t = tracks.find(function (x) { return x.status === "published"; }) || tracks[0];
      if (!t) { state.trackPoints = null; return; }
      var pts = null;
      if (t.smoothedPoints && t.smoothedPoints.length >= 3) pts = t.smoothedPoints;
      else if (window.TrackEditor && typeof window.TrackEditor.beautifyTrack === "function") pts = window.TrackEditor.beautifyTrack(t.trackPoints || []);
      else pts = t.trackPoints || [];
      if (t.closed && pts.length >= 3 && dist2(pts[0], pts[pts.length - 1]) > 0.001) pts.push({ u: pts[0].u, v: pts[0].v });
      state.trackPoints = pts;
      state.trackClosed = !!t.closed;
      state.trackName = t.name || "";
    } catch (e) {}
  }

  // ── Telemetry loop ────────────────────────────────────────────────────────
  function updateTelemetry() {
    try {
      var cars = getCars();
      var now = Date.now();
      cars.forEach(function (car) {
        if (car.rawX == null || car.rawZ == null) return;
        var prev = state.speed[car.name];
        if (prev && prev.rawX != null) {
          var dt = (now - prev.at) / 1000;
          if (dt >= 0.5 && dt <= 12) {
            var d = Math.sqrt(Math.pow(car.rawX - prev.rawX, 2) + Math.pow(car.rawZ - prev.rawZ, 2));
            if (d < 500) {
              var mph = speedMph(d, dt);
              var old = (prev.mph || 0);
              state.speed[car.name] = { mph: old ? old * 0.6 + mph * 0.4 : mph, at: now, rawX: car.rawX, rawZ: car.rawZ };
            } else {
              state.speed[car.name] = { mph: prev.mph || 0, at: now, rawX: car.rawX, rawZ: car.rawZ };
            }
          } else {
            state.speed[car.name] = { mph: prev.mph || 0, at: now, rawX: car.rawX, rawZ: car.rawZ };
          }
        } else {
          state.speed[car.name] = { mph: 0, at: now, rawX: car.rawX, rawZ: car.rawZ };
        }
        if (state.trailsOn) {
          var tr = state.trails[car.name] || (state.trails[car.name] = []);
          var last = tr[tr.length - 1];
          if (!last || Math.abs(last.x - car.x) + Math.abs(last.y - car.y) > 0.002) {
            tr.push({ x: car.x, y: car.y });
            if (tr.length > 70) tr.shift();
          }
        }
        if (state.trackPoints) {
          var p = projectProgress(state.trackPoints, car, state.trackClosed);
          if (p != null) state.progress[car.name] = p;
        }
      });
    } catch (e) {}
  }

  // ── Info bar (battles + pit window + your speed/progress) ────────────────
  function gapText(d, i, drivers) {
    if (d.dnf) return "DNF";
    if (d.finished) return "Finished";
    if (i === 0) return "Leader";
    var delta = getDelta(d.name);
    if (typeof delta === "number") return "+" + delta.toFixed(3) + "s";
    var leaderLap = drivers[0] ? (drivers[0].lap || 1) : 1;
    var lapDiff = leaderLap - (d.lap || 1);
    if (lapDiff > 0) return "+" + lapDiff + " LAP" + (lapDiff > 1 ? "S" : "");
    return d.gap && d.gap !== "Leader" ? d.gap : "–";
  }
  function isBattle(i, drivers) {
    if (i === 0) return false;
    var prev = drivers[i - 1], cur = drivers[i];
    var dPrev = getDelta(prev.name), dCur = getDelta(cur.name);
    if (typeof dPrev === "number" && typeof dCur === "number" && (dCur - dPrev) < 1.5) return true;
    var pPrev = state.progress[prev.name], pCur = state.progress[cur.name];
    if (typeof pPrev === "number" && typeof pCur === "number") {
      var diff = Math.abs(pCur - pPrev);
      if (diff > 0.5) diff = 1 - diff;
      if (diff < 0.02) return true;
    }
    return false;
  }
  function renderInfoBar() {
    var drivers = getDrivers();
    var banner = document.getElementById("th-battle-banner");
    var pw = document.getElementById("th-pitwindow");
    var myline = document.getElementById("th-myline");
    if (!banner && !pw) return;
    if (!drivers.length) {
      if (banner) banner.style.display = "none";
      if (pw) pw.innerHTML = '<div style="font-size:10px;color:var(--muted);">Waiting for race…</div>';
      return;
    }
    var battles = [];
    drivers.forEach(function (d, i) { if (isBattle(i, drivers)) battles.push(i + 1); });
    if (banner) {
      banner.style.display = battles.length ? "" : "none";
      banner.textContent = battles.length ? "⚔️ BATTLE " + battles.map(function (p) { return "for P" + p; }).join(" · ") : "";
    }
    if (pw) {
      var race = getRace();
      var total = race && race.totalLaps ? race.totalLaps : 0;
      var curLap = Math.max.apply(null, drivers.map(function (d) { return d.lap || 1; }));
      var pct = total ? Math.min(100, Math.round((curLap / total) * 100)) : 0;
      var me = getMeName();
      var meDriver = drivers.find(function (d) { return d.name === me; });
      var pitted = drivers.filter(function (d) { return d.pitted; }).length;
      var warn = "";
      if (race && race.mandatoryPits && meDriver && !meDriver.pitted) warn = '<div style="color:var(--yellow);font-weight:800;margin-top:6px;">⚠️ Mandatory pit not yet done</div>';
      else if (race && race.mandatoryPits && meDriver && meDriver.pitted) warn = '<div style="color:var(--green);font-weight:800;margin-top:6px;">✓ Mandatory pit done</div>';
      pw.innerHTML =
        '<div style="font-size:9px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:var(--muted);">Pit Window' + (state.trackName ? ' · ' + esc(state.trackName) : '') + '</div>' +
        '<div style="margin-top:6px;font-variant-numeric:tabular-nums;font-size:11px;">' +
        (total ? 'Lap ' + curLap + ' / ' + total + ' · ' + (total - curLap) + ' laps left · ' + pct + '% done' : 'Lap ' + curLap) +
        ' · ' + pitted + ' / ' + drivers.length + ' pitted</div>' +
        '<div class="th-pw-bar"><div style="width:' + pct + '%"></div></div>' +
        '<div style="font-size:10px;color:var(--muted);">' + drivers.map(function (d) { return esc(d.callsign || d.name) + (d.pitted ? ' ✓' : (d.inPits ? ' 🔧' : ' —')); }).join(' · ') + '</div>' + warn;
    }
    if (myline) {
      var me2 = getMeName();
      var spd = me2 ? state.speed[me2] : null;
      var prog = me2 ? state.progress[me2] : null;
      myline.textContent = me2
        ? "You: " + (spd && spd.mph ? Math.round(spd.mph) + " mph est." : "speed —") + (typeof prog === "number" ? " · " + Math.round(prog * 100) + "% lap" : "")
        : "";
    }
  }

  // ── Injection ─────────────────────────────────────────────────────────────
  function injectInfoBar() {
    var lb = document.getElementById("d-leaderboard");
    if (!lb || document.getElementById("th-info-wrap")) return;
    // Original field leaderboard is NEVER hidden in v1.1 — this sits above it.
    var wrap = document.createElement("div");
    wrap.id = "th-info-wrap";
    wrap.innerHTML =
      '<div id="th-info-head"><span class="th-title">🏎️ Race Info</span>' +
      '<button type="button" id="th-btn-colorblind">Colourblind</button></div>' +
      '<div id="th-battle-banner" class="th-battle-banner" style="display:none;"></div>' +
      '<div id="th-pitwindow"></div><div id="th-myline"></div>';
    lb.parentNode.insertBefore(wrap, lb);
    document.getElementById("th-btn-colorblind").addEventListener("click", function () {
      state.colorblind = !state.colorblind;
      document.body.classList.toggle("th-colorblind", state.colorblind);
      this.classList.toggle("on", state.colorblind);
    });
  }
  function injectFlash() {
    if (document.getElementById("th-flag-flash")) return;
    var flash = document.createElement("div");
    flash.id = "th-flag-flash";
    flash.addEventListener("click", function () { flash.classList.remove("show"); });
    document.body.appendChild(flash);
  }
  function injectMapButtons() {
    var ctl = document.querySelector(".tm-zoom-ctl");
    if (!ctl) return;
    if (!document.getElementById("th-btn-follow")) {
      var f = document.createElement("button");
      f.type = "button"; f.id = "th-btn-follow"; f.title = "Follow your car (click a car dot to follow it)";
      f.textContent = "◎";
      f.addEventListener("click", function () {
        if (state.followName) { state.followName = null; }
        else { state.followName = getMeName() || (getCars()[0] && getCars()[0].name) || null; }
        syncMapButtons();
      });
      ctl.appendChild(f);
    }
    if (!document.getElementById("th-btn-trails")) {
      var tr = document.createElement("button");
      tr.type = "button"; tr.id = "th-btn-trails"; tr.title = "Toggle car trails";
      tr.textContent = "〰";
      tr.classList.add("th-on");
      tr.addEventListener("click", function () {
        state.trailsOn = !state.trailsOn;
        if (!state.trailsOn) state.trails = {};
        syncMapButtons();
      });
      ctl.appendChild(tr);
    }
    syncMapButtons();
  }
  function syncMapButtons() {
    var f = document.getElementById("th-btn-follow");
    if (f) { f.classList.toggle("th-on", !!state.followName); f.title = state.followName ? "Following " + state.followName + " — click to stop (or drag the map)" : "Follow your car (click a car dot to follow it)"; }
    var tr = document.getElementById("th-btn-trails");
    if (tr) tr.classList.toggle("th-on", state.trailsOn);
  }
  function renderTrails() {
    var svg = document.getElementById("track-map-svg");
    var img = document.getElementById("track-map-img");
    if (!svg || !img || !img.naturalWidth) return;
    var g = document.getElementById("th-trails");
    if (!g) {
      g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("id", "th-trails");
      svg.insertBefore(g, svg.firstChild);
    }
    if (!state.trailsOn) { g.innerHTML = ""; return; }
    var W = img.naturalWidth, H = img.naturalHeight;
    var cars = getCars();
    g.innerHTML = Object.keys(state.trails).map(function (name) {
      var pts = state.trails[name];
      if (!pts || pts.length < 2) return "";
      var car = cars.find(function (c) { return c.name === name; });
      var color = car ? car.color : "#8b91a9";
      var d = pts.map(function (p) { return (p.x * W).toFixed(1) + "," + (p.y * H).toFixed(1); }).join(" ");
      var core = Math.max(10, W * 0.006);
      var outline = (core * 1.9).toFixed(1);
      // Outline first (dark, wider, so the line pops on light and dark map
      // areas), then the bright team-colour core on top.
      return '<polyline class="th-trail-outline" points="' + d + '" stroke="#000000" stroke-width="' + outline + '"/>' +
             '<polyline class="th-trail-core" points="' + d + '" stroke="' + color + '" stroke-width="' + core.toFixed(1) + '"/>';
    }).join("");
  }
  function followCar() {
    if (!state.followName) return;
    if (!document.getElementById("d-tab-track") || !document.getElementById("d-tab-track").classList.contains("active")) return;
    var car = getCars().find(function (c) { return c.name === state.followName; });
    if (!car) return;
    try {
      var vp = document.getElementById("track-map-viewport");
      var stage = document.getElementById("track-map-stage");
      if (!vp || !stage) return;
      if (typeof _tmZoom !== "undefined" && _tmZoom < 2.5) _tmZoom = 2.5;
      var zoom = (typeof _tmZoom !== "undefined" ? _tmZoom : 2.5);
      var px = car.x * stage.offsetWidth, py = car.y * stage.offsetHeight;
      if (typeof _tmPanX !== "undefined") _tmPanX = vp.clientWidth / 2 - px * zoom;
      if (typeof _tmPanY !== "undefined") _tmPanY = vp.clientHeight / 2 - py * zoom;
      if (typeof _tmApplyView === "function") _tmApplyView();
    } catch (e) {}
  }
  function bindMapClicks() {
    if (window._thMapBound) return;
    window._thMapBound = true;
    document.addEventListener("click", function (e) {
      var dot = e.target && e.target.closest ? e.target.closest(".track-map-dot") : null;
      if (!dot) return;
      var g = document.getElementById("track-map-dots");
      if (!g) return;
      var idx = Array.prototype.indexOf.call(g.children, dot);
      var car = getCars()[idx];
      if (car) { state.followName = car.name; syncMapButtons(); }
    });
    document.addEventListener("pointerdown", function (e) {
      if (!state.followName) return;
      var vp = document.getElementById("track-map-viewport");
      if (vp && vp.contains(e.target) && !(e.target.closest && e.target.closest(".tm-zoom-ctl"))) {
        state.followName = null; syncMapButtons();
      }
    });
  }
  function bindFlagFlash() {
    if (window._thFlagBound) return;
    window._thFlagBound = true;
    function scan(container) {
      if (!container) return;
      var card = container.querySelector(".flag-card");
      if (!card) return;
      var titleEl = card.querySelector(".fc-title");
      var title = titleEl ? titleEl.textContent.trim() : card.textContent.trim().slice(0, 60);
      var cls = ["green", "yellow", "red", "blue", "orange", "white"].find(function (c) { return card.classList.contains(c); }) || "blue";
      var colors = { green: "#12e07a", yellow: "#ffc800", red: "#ff2e4d", blue: "#4d9fff", orange: "#ff8a1e", white: "#ffffff" };
      var key = cls + "|" + title;
      if (state.lastFlag && state.lastFlag.key === key) return;
      state.lastFlag = { key: key, title: title, color: colors[cls] || "#4d9fff", cls: cls };
      var flash = document.getElementById("th-flag-flash");
      if (flash) {
        flash.textContent = "🏁 " + title;
        flash.style.background = colors[cls] || "#4d9fff";
        flash.style.color = cls === "yellow" || cls === "white" ? "#000" : "#fff";
        flash.style.border = "2px solid rgba(255,255,255,.35)";
        flash.classList.remove("show"); void flash.offsetWidth; flash.classList.add("show");
        setTimeout(function () { flash.classList.remove("show"); }, 2700);
      }
    }
    ["flag-notif-driver", "flag-notif-marshal"].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      new MutationObserver(function () { scan(el); }).observe(el, { childList: true, subtree: true });
    });
  }

  // ── Start ───────────────────────────────────────────────────────────────────
  ensureCss();
  injectFlash();
  bindMapClicks();
  bindFlagFlash();
  new MutationObserver(function () { injectInfoBar(); injectMapButtons(); }).observe(document.body, { childList: true, subtree: true });
  setInterval(function () { injectInfoBar(); injectMapButtons(); }, 2000);
  setInterval(function () {
    try { updateTelemetry(); } catch (e) {}
    try { renderInfoBar(); } catch (e) {}
    try { renderTrails(); followCar(); } catch (e) {}
  }, 1000);
  setInterval(fetchTrack, 30000);
  fetchTrack();

  window.TelemetryHUD = {
    version: "1.2-thicktrails",
    speedMph: speedMph,
    projectProgress: projectProgress,
    getState: function () { return state; },
  };
})();
