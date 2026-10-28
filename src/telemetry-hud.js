
(function () {
  "use strict";
  console.log("[TelemetryHUD] v1 - tower, relative, speed, progress, battles, pit window, follow/trails, flag readability, cockpit HUD");

  var state = {
    towerOn: true,
    colorblind: false,
    hudOn: false,
    trailsOn: true,
    followName: null,
    trackPoints: null, trackClosed: false, trackName: "", trackFetchedAt: 0,
    speed: {}, // name -> { mph, at, rawX, rawZ }
    trails: {}, // name -> [{x,y}]
    progress: {}, // name -> 0..1
    lastFlag: null,
    lastFlagAt: 0,
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
  function teamColor(callsign, name) {
    try {
      if (typeof getTeamFromCallsign === "function" && typeof TEAM_COLORS !== "undefined") {
        var team = getTeamFromCallsign(callsign);
        if (team && TEAM_COLORS[team]) return TEAM_COLORS[team];
      }
    } catch (e) {}
    var cars = getCars();
    var car = cars.find(function (c) { return c.name === name; });
    return car ? car.color : "#8b91a9";
  }

  // ── Pure helpers (also exposed for testing) ─────────────────────────────
  // studs/s -> est. mph. 1 Roblox stud ≈ 0.28 m, 1 m/s ≈ 2.237 mph.
  function speedMph(distStuds, dtSec) {
    if (!dtSec || dtSec <= 0) return 0;
    return (distStuds / dtSec) * 0.28 * 2.23694;
  }
  function dist2(a, b) {
    var dx = a.u - b.u, dy = a.v - b.v;
    return Math.sqrt(dx * dx + dy * dy);
  }
  // Project a car (u/v fractions) onto a track polyline. Returns
  // progress 0..1 around the track, or null if no track / no points.
  function projectProgress(points, car, closedOverride) {
    if (!points || points.length < 3 || !car) return null;
    var total = 0, cum = [0];
    for (var i = 1; i < points.length; i++) { total += dist2(points[i - 1], points[i]); cum.push(total); }
    // Closed loop: close the last segment back to the start.
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
      "#th-tower-wrap { margin-bottom: 10px; }",
      "#th-tower-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:6px; }",
      "#th-tower-head .th-title { font-size:10px; font-weight:800; letter-spacing:2px; text-transform:uppercase; color:var(--text); }",
      "#th-tower-head button, #th-hud-toggle { font-family:'Oxanium',sans-serif; font-size:9px; font-weight:800; letter-spacing:.5px; text-transform:uppercase; padding:5px 10px; border-radius:99px; border:1px solid var(--border); background:rgba(255,255,255,.04); color:var(--muted); cursor:pointer; }",
      "#th-tower-head button.on, #th-hud-toggle.on { color:#fff; border-color:var(--red); background:rgba(255,46,77,.16); }",
      "#th-tower { display:flex; flex-direction:column; gap:4px; font-variant-numeric:tabular-nums; }",
      ".th-row { display:grid; grid-template-columns:28px 34px 1fr 72px 52px 58px 44px; gap:6px; align-items:center; padding:6px 8px; background:var(--surface); border:1px solid var(--border); border-left:4px solid var(--tc,#242a3d); border-radius:10px; }",
      ".th-row.you { border-color:rgba(77,159,255,.55); box-shadow:0 0 14px rgba(77,159,255,.22); }",
      ".th-row.battle { border-color:rgba(255,200,0,.55); }",
      ".th-pos { font-weight:900; font-style:italic; font-size:13px; text-align:center; }",
      ".th-pos.p1 { color:#ffd700; } .th-pos.p2 { color:#e8e8f0; } .th-pos.p3 { color:#ff9a5a; }",
      ".th-num { font-weight:900; font-style:italic; font-size:11px; text-align:center; padding:4px 2px; border-radius:7px; background:rgba(255,255,255,.06); }",
      ".th-name { font-weight:800; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }",
      ".th-call { font-size:8px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }",
      ".th-gap, .th-lap, .th-speed { font-size:10px; font-weight:700; text-align:right; white-space:nowrap; }",
      ".th-pit { font-size:8px; font-weight:800; text-align:center; padding:3px 4px; border-radius:99px; }",
      ".th-pit.in { background:rgba(255,200,0,.15); color:var(--yellow); border:1px solid rgba(255,200,0,.4); }",
      ".th-pit.done { background:rgba(18,224,122,.12); color:var(--green); border:1px solid rgba(18,224,122,.35); }",
      ".th-progress { height:4px; border-radius:99px; background:rgba(255,255,255,.08); overflow:hidden; margin-top:3px; }",
      ".th-progress > div { height:100%; background:linear-gradient(90deg,var(--blue),var(--green)); }",
      ".th-battle-banner { padding:6px 10px; border-radius:10px; background:rgba(255,200,0,.12); border:1px solid rgba(255,200,0,.45); color:var(--yellow); font-size:10px; font-weight:800; letter-spacing:.5px; text-align:center; }",
      "#th-relative { margin:10px 0; padding:10px; background:var(--surface); border:1px solid var(--border); border-radius:12px; }",
      "#th-relative .th-rel-title { font-size:9px; font-weight:800; letter-spacing:2px; text-transform:uppercase; color:var(--muted); margin-bottom:6px; }",
      ".th-rel-row { display:flex; gap:8px; align-items:center; padding:5px 0; font-size:11px; font-variant-numeric:tabular-nums; }",
      ".th-rel-row.you { font-weight:900; color:#fff; }",
      "#th-pitwindow { margin-top:8px; padding:10px; background:var(--surface); border:1px solid var(--border); border-radius:12px; }",
      "#th-pitwindow .th-pw-bar { height:8px; border-radius:99px; background:rgba(255,255,255,.08); overflow:hidden; margin:6px 0; }",
      "#th-pitwindow .th-pw-bar > div { height:100%; background:linear-gradient(90deg,var(--red),var(--yellow),var(--green)); }",
      "#th-hud { display:none; position:fixed; left:50%; top:64px; transform:translateX(-50%); z-index:8000; min-width:420px; max-width:92vw; padding:18px 22px; background:rgba(8,9,14,.92); border:2px solid var(--border); border-radius:18px; box-shadow:0 24px 60px rgba(0,0,0,.6); text-align:center; backdrop-filter:blur(8px); }",
      "#th-hud.show { display:block; }",
      "#th-hud .th-hud-pos { font-size:64px; font-weight:900; font-style:italic; line-height:1; }",
      "#th-hud .th-hud-name { font-size:16px; font-weight:800; margin-top:4px; }",
      "#th-hud .th-hud-grid { display:flex; gap:18px; justify-content:center; margin-top:12px; font-variant-numeric:tabular-nums; }",
      "#th-hud .th-hud-cell b { display:block; font-size:22px; }",
      "#th-hud .th-hud-cell span { font-size:9px; letter-spacing:1.5px; text-transform:uppercase; color:var(--muted); }",
      "#th-hud .th-hud-flag { margin-top:12px; font-size:14px; font-weight:900; letter-spacing:2px; text-transform:uppercase; }",
      "#th-hud-toggle { position:fixed; right:14px; bottom:14px; z-index:8001; }",
      "#th-flag-flash { display:none; position:fixed; left:50%; top:52px; transform:translateX(-50%); z-index:9000; padding:14px 28px; border-radius:14px; font-size:20px; font-weight:900; letter-spacing:2px; text-transform:uppercase; text-align:center; box-shadow:0 18px 50px rgba(0,0,0,.6); cursor:pointer; }",
      "#th-flag-flash.show { display:block; animation:thFlash 2.6s ease forwards; }",
      "@keyframes thFlash { 0% { opacity:0; transform:translateX(-50%) scale(.92); } 8% { opacity:1; transform:translateX(-50%) scale(1); } 80% { opacity:1; } 100% { opacity:0; } }",
      /* Flag readability: pattern + weight, not colour alone */
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
      "#th-trails polyline { fill:none; stroke-linejoin:round; stroke-linecap:round; opacity:.55; }",
      ".tm-zoom-ctl button.th-on { background:rgba(255,46,77,.20) !important; border-color:var(--red) !important; color:#fff !important; }",
    ].join("\n");
    document.head.appendChild(s);
  }

  // ── Published track (for progress) ────────────────────────────────────────
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
            // Teleport / respawn filter: >500 studs in one poll is not driving.
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
        // Trails
        if (state.trailsOn) {
          var tr = state.trails[car.name] || (state.trails[car.name] = []);
          var last = tr[tr.length - 1];
          if (!last || Math.abs(last.x - car.x) + Math.abs(last.y - car.y) > 0.002) {
            tr.push({ x: car.x, y: car.y });
            if (tr.length > 45) tr.shift();
          }
        }
        // Progress
        if (state.trackPoints) {
          var p = projectProgress(state.trackPoints, car, state.trackClosed);
          if (p != null) state.progress[car.name] = p;
        }
      });
    } catch (e) {}
  }

  // ── Tower / Relative / Pit window ─────────────────────────────────────────
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
      if (diff > 0.5) diff = 1 - diff; // wrapped around start/finish
      if (diff < 0.02) return true;
    }
    return false;
  }
  function renderTower() {
    var wrap = document.getElementById("th-tower");
    if (!wrap) return;
    var drivers = getDrivers();
    if (!drivers.length) {
      wrap.innerHTML = '<div class="placeholder-text">Waiting for race… (Tower shows here once drivers are on track)</div>';
      return;
    }
    var me = getMeName();
    var battles = [];
    var rows = drivers.map(function (d, i) {
      var pos = i + 1;
      var pc = pos === 1 ? "p1" : pos === 2 ? "p2" : pos === 3 ? "p3" : "";
      var battle = isBattle(i, drivers);
      if (battle) battles.push(pos);
      var tc = teamColor(d.callsign, d.name);
      var spd = state.speed[d.name];
      var spdTxt = spd && spd.mph ? Math.round(spd.mph) + " mph" : "–";
      var prog = state.progress[d.name];
      var progPct = typeof prog === "number" ? Math.round(prog * 100) : null;
      var pitCls = d.inPits ? "in" : (d.pitted ? "done" : "");
      var pitTxt = d.inPits ? "🔧 PIT" : (d.pitted ? "✓ Pitted" : "—");
      var cls = ["th-row"];
      if (d.name === me) cls.push("you");
      if (battle) cls.push("battle");
      if (d.dnf) cls.push("dnf");
      return '<div class="' + cls.join(" ") + '" style="--tc:' + tc + '">' +
        '<div class="th-pos ' + pc + '">' + pos + '</div>' +
        '<div class="th-num">#' + esc(d.number) + '</div>' +
        '<div><div class="th-name">' + esc(d.name) + '</div><div class="th-call">' + esc(d.callsign || "") + (progPct != null ? ' · ' + progPct + '% lap' : '') + '</div>' +
        (progPct != null ? '<div class="th-progress"><div style="width:' + progPct + '%"></div></div>' : '') + '</div>' +
        '<div class="th-gap">' + esc(gapText(d, i, drivers)) + '</div>' +
        '<div class="th-lap">Lap ' + (d.lap || 1) + '</div>' +
        '<div class="th-speed">' + spdTxt + '</div>' +
        '<div class="th-pit ' + pitCls + '">' + pitTxt + '</div></div>';
    }).join("");
    var banner = battles.length
      ? '<div class="th-battle-banner">⚔️ BATTLE ' + battles.map(function (p) { return "for P" + p; }).join(" · ") + '</div>'
      : "";
    wrap.innerHTML = banner + rows;
    renderPitWindow(drivers);
  }
  function renderPitWindow(drivers) {
    var el = document.getElementById("th-pitwindow");
    if (!el) return;
    var race = getRace();
    var total = race && race.totalLaps ? race.totalLaps : 0;
    var curLap = drivers.length ? Math.max.apply(null, drivers.map(function (d) { return d.lap || 1; })) : 0;
    var pct = total ? Math.min(100, Math.round((curLap / total) * 100)) : 0;
    var me = getMeName();
    var meDriver = drivers.find(function (d) { return d.name === me; });
    var pitted = drivers.filter(function (d) { return d.pitted; }).length;
    var warn = "";
    if (race && race.mandatoryPits && meDriver && !meDriver.pitted) warn = '<div style="color:var(--yellow);font-weight:800;margin-top:6px;">⚠️ Mandatory pit not yet done</div>';
    else if (race && race.mandatoryPits && meDriver && meDriver.pitted) warn = '<div style="color:var(--green);font-weight:800;margin-top:6px;">✓ Mandatory pit done</div>';
    el.innerHTML =
      '<div style="font-size:9px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:var(--muted);">Pit Window' + (state.trackName ? ' · ' + esc(state.trackName) : '') + '</div>' +
      '<div style="margin-top:6px;font-variant-numeric:tabular-nums;font-size:11px;">' +
      (total ? 'Lap ' + curLap + ' / ' + total + ' · ' + (total - curLap) + ' laps left · ' + pct + '% done' : 'Lap ' + curLap) +
      ' · ' + pitted + ' / ' + drivers.length + ' pitted</div>' +
      '<div class="th-pw-bar"><div style="width:' + pct + '%"></div></div>' +
      '<div style="font-size:10px;color:var(--muted);">' + drivers.map(function (d) { return esc(d.callsign || d.name) + (d.pitted ? ' ✓' : (d.inPits ? ' 🔧' : ' —')); }).join(' · ') + '</div>' + warn;
  }
  function renderRelative() {
    var el = document.getElementById("th-relative");
    if (!el) return;
    var drivers = getDrivers();
    var me = getMeName();
    if (!drivers.length || !me) {
      el.innerHTML = '<div class="th-rel-title">Relative</div><div class="placeholder-text">Waiting for race…</div>';
      return;
    }
    var idx = drivers.findIndex(function (d) { return d.name === me; });
    if (idx === -1) {
      el.innerHTML = '<div class="th-rel-title">Relative</div><div class="placeholder-text">Not currently on track.</div>';
      return;
    }
    var slice = [];
    for (var k = Math.max(0, idx - 2); k <= Math.min(drivers.length - 1, idx + 2); k++) slice.push({ d: drivers[k], i: k });
    el.innerHTML = '<div class="th-rel-title">Relative — around you</div>' + slice.map(function (s) {
      var arrow = s.i < idx ? "▲" : s.i > idx ? "▼" : "●";
      var spd = state.speed[s.d.name];
      return '<div class="th-rel-row ' + (s.i === idx ? "you" : "") + '">' +
        '<span>' + arrow + '</span><b>P' + (s.i + 1) + '</b><span>#' + esc(s.d.number) + '</span>' +
        '<span style="flex:1;">' + esc(s.d.name) + '</span>' +
        '<span>' + esc(gapText(s.d, s.i, drivers)) + '</span>' +
        '<span style="color:var(--muted);">' + (spd && spd.mph ? Math.round(spd.mph) + " mph" : "") + '</span>' +
        (s.d.inPits ? '<span>🔧</span>' : '') + '</div>';
    }).join("");
  }
  function renderHud() {
    var hud = document.getElementById("th-hud");
    if (!hud || !state.hudOn) return;
    var drivers = getDrivers();
    var me = getMeName();
    var idx = drivers.findIndex(function (d) { return d.name === me; });
    var d = idx >= 0 ? drivers[idx] : null;
    var ahead = idx > 0 ? drivers[idx - 1] : null;
    var behind = idx >= 0 && idx < drivers.length - 1 ? drivers[idx + 1] : null;
    var spd = me ? state.speed[me] : null;
    var flagTxt = state.lastFlag ? state.lastFlag.title : "—";
    var flagColor = state.lastFlag ? state.lastFlag.color : "var(--muted)";
    hud.innerHTML =
      '<div class="th-hud-pos">' + (idx >= 0 ? "P" + (idx + 1) : "—") + '</div>' +
      '<div class="th-hud-name">' + esc(d ? d.name : (me || "No driver selected")) + '</div>' +
      '<div class="th-hud-grid">' +
      '<div class="th-hud-cell"><b>' + esc(ahead ? gapText(ahead, idx - 1, drivers) : "—") + '</b><span>Ahead</span></div>' +
      '<div class="th-hud-cell"><b>' + esc(behind ? gapText(behind, idx + 1, drivers) : "—") + '</b><span>Behind</span></div>' +
      '<div class="th-hud-cell"><b>' + (spd && spd.mph ? Math.round(spd.mph) + " mph" : "—") + '</b><span>Speed (est.)</span></div>' +
      '<div class="th-hud-cell"><b>' + (d ? "Lap " + (d.lap || 1) : "—") + '</b><span>Lap</span></div>' +
      '<div class="th-hud-cell"><b>' + (d && d.inPits ? "🔧 PIT" : (d && d.pitted ? "✓ Pitted" : "—")) + '</b><span>Pit</span></div>' +
      '</div>' +
      '<div class="th-hud-flag" style="color:' + flagColor + ';">' + esc(flagTxt) + '</div>' +
      '<div style="margin-top:10px;font-size:10px;color:var(--muted);">Click HUD button again to hide · drag the app, HUD stays on top</div>';
  }

  // ── Injection ─────────────────────────────────────────────────────────────
  function injectTower() {
    var field = document.getElementById("d-tab-field");
    var lb = document.getElementById("d-leaderboard");
    if (!field || !lb || document.getElementById("th-tower-wrap")) return;
    var wrap = document.createElement("div");
    wrap.id = "th-tower-wrap";
    wrap.innerHTML =
      '<div id="th-tower-head"><span class="th-title">🏎️ Timing Tower</span><span style="display:flex;gap:6px;">' +
      '<button type="button" id="th-btn-tower" class="on">Tower</button>' +
      '<button type="button" id="th-btn-colorblind">Colourblind</button>' +
      '<button type="button" id="th-btn-hud">Cockpit HUD</button></span></div>' +
      '<div id="th-tower"></div><div id="th-pitwindow"></div>';
    lb.parentNode.insertBefore(wrap, lb);
    document.getElementById("th-btn-tower").addEventListener("click", function () {
      state.towerOn = !state.towerOn;
      this.classList.toggle("on", state.towerOn);
      document.getElementById("th-tower").style.display = state.towerOn ? "" : "none";
      document.getElementById("th-pitwindow").style.display = state.towerOn ? "" : "none";
      lb.style.display = state.towerOn ? "none" : "";
      this.textContent = state.towerOn ? "Tower" : "Field";
    });
    // Default: tower on, original field hidden (toggle back any time).
    lb.style.display = "none";
    document.getElementById("th-btn-colorblind").addEventListener("click", function () {
      state.colorblind = !state.colorblind;
      document.body.classList.toggle("th-colorblind", state.colorblind);
      this.classList.toggle("on", state.colorblind);
    });
    document.getElementById("th-btn-hud").addEventListener("click", toggleHud);
  }
  function injectRelative() {
    var nearby = document.getElementById("d-nearby");
    if (!nearby || document.getElementById("th-relative")) return;
    var el = document.createElement("div");
    el.id = "th-relative";
    nearby.parentNode.insertBefore(el, nearby.nextSibling);
  }
  function injectHud() {
    if (document.getElementById("th-hud")) return;
    var hud = document.createElement("div");
    hud.id = "th-hud";
    document.body.appendChild(hud);
    var btn = document.createElement("button");
    btn.id = "th-hud-toggle";
    btn.type = "button";
    btn.textContent = "🏎️ HUD";
    btn.addEventListener("click", toggleHud);
    document.body.appendChild(btn);
    var flash = document.createElement("div");
    flash.id = "th-flag-flash";
    flash.addEventListener("click", function () { flash.classList.remove("show"); });
    document.body.appendChild(flash);
  }
  function toggleHud() {
    state.hudOn = !state.hudOn;
    var hud = document.getElementById("th-hud");
    if (hud) hud.classList.toggle("show", state.hudOn);
    var b1 = document.getElementById("th-hud-toggle");
    if (b1) b1.classList.toggle("on", state.hudOn);
    var b2 = document.getElementById("th-btn-hud");
    if (b2) b2.classList.toggle("on", state.hudOn);
    if (state.hudOn) renderHud();
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
      return '<polyline points="' + d + '" stroke="' + color + '" stroke-width="' + Math.max(3, W * 0.0015).toFixed(1) + '"/>';
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
      var sw = stage.offsetWidth * zoom, sh = stage.offsetHeight * zoom;
      var px = car.x * stage.offsetWidth, py = car.y * stage.offsetHeight;
      if (typeof _tmPanX !== "undefined") _tmPanX = vp.clientWidth / 2 - px * zoom;
      if (typeof _tmPanY !== "undefined") _tmPanY = vp.clientHeight / 2 - py * zoom;
      if (typeof _tmApplyView === "function") _tmApplyView();
      void sw; void sh;
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
        // Manual drag breaks Follow — standard follow-cam behaviour.
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
      state.lastFlagAt = Date.now();
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
  injectHud();
  bindMapClicks();
  bindFlagFlash();
  // Template-cloned panels: re-inject whenever they re-render.
  new MutationObserver(function () { injectTower(); injectRelative(); injectMapButtons(); }).observe(document.body, { childList: true, subtree: true });
  setInterval(function () { injectTower(); injectRelative(); injectMapButtons(); }, 2000);
  setInterval(function () {
    try { updateTelemetry(); } catch (e) {}
    try { renderTower(); renderRelative(); renderHud(); } catch (e) {}
    try { renderTrails(); followCar(); } catch (e) {}
  }, 1000);
  setInterval(fetchTrack, 30000);
  fetchTrack();

  window.TelemetryHUD = {
    version: "1",
    speedMph: speedMph,
    projectProgress: projectProgress,
    toggleHud: toggleHud,
    getState: function () { return state; },
  };
})();
