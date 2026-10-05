/* proximity-chat.js — Proximity Chat for the RaceLeague driver panel.
 *
 * Hold the mic button (or your push-to-talk key) and the 2 cars closest to you on the
 * leaderboard hear you. Audio is Opus (WebCodecs) over a WebSocket to the bot's /voice relay.
 *
 * Loaded from renderer.html right after party-mode.js. Hooks the app calls:
 *   ProximityChat.mountUI()          after the driver template is cloned
 *   ProximityChat.ensureConnected()  on every driver-state poll (cheap no-op when already connected)
 *   ProximityChat.onTabChange(tab)   from setDriverTab()
 */
(function () {
  "use strict";

  const SAMPLE_RATE  = 48000;
  const FRAME_US     = 20000;       // 20 ms Opus frames
  const JITTER_S     = 0.08;        // playback buffer before the first packet plays
  const MAX_LAG_S    = 0.45;        // if playback falls this far behind, drop packets to catch up
  const MIC_IDLE_MS  = 8000;        // keep the mic warm this long after release (no clipped first word)
  const PEEK_EVERY   = 2500;

  const LS = { mode: "pc.mode", key: "pc.pttKey", vol: "pc.volume" };

  const supported =
    typeof AudioEncoder === "function" && typeof AudioDecoder === "function" &&
    typeof AudioData === "function" && typeof EncodedAudioChunk === "function" &&
    typeof AudioWorkletNode === "function";

  const S = {
    ws: null, wsKey: null, status: supported ? "offline" : "unsupported", fatalReason: "", fatalKey: null,
    enabled: true, reconnectTimer: null, backoff: 3000,
    seq: 0,
    tx: { active: false, confirmed: false, sent: false, seq: 0, targets: [], encoder: null, ts: 0, sendFrames: false },
    rx: new Map(),                      // sid -> { from, rel, decoder, ts, nextTime }
    neighbours: [],
    ctx: null, master: null,
    mic: { stream: null, src: null, node: null, mute: null, idleTimer: null },
    workletReady: null,
    peekTimer: null,
    capturingKey: false,
  };

  // ── small helpers ──────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (_) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  const mode   = () => (lsGet(LS.mode, "hold") === "toggle" ? "toggle" : "hold");
  const volume = () => { const v = parseFloat(lsGet(LS.vol, "1")); return isFinite(v) ? Math.min(1, Math.max(0, v)) : 1; };
  const pttKey = () => lsGet(LS.key, "None");
  const toast  = (msg, type) => { if (typeof showToast === "function") showToast(msg, type || ""); else console.log("[Voice]", msg); };
  const esc    = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function appCtx() {
    return {
      api: typeof apiUrl !== "undefined" ? apiUrl : "",
      uid: typeof user !== "undefined" && user ? user.id : "",
      drv: typeof config !== "undefined" && config ? config.driver : "",
      eng: typeof isEngineer !== "undefined" ? !!isEngineer : false,
    };
  }

  function teamColor(callsign) {
    try {
      const team = typeof getTeamFromCallsign === "function" ? getTeamFromCallsign(callsign) : null;
      return team && typeof TEAM_COLORS !== "undefined" && TEAM_COLORS[team] ? TEAM_COLORS[team] : null;
    } catch (_) { return null; }
  }

  // ── connection ─────────────────────────────────────────────────────────
  function ensureConnected() {
    if (!supported) return;
    const c = appCtx();
    if (!c.api || !c.uid || !c.drv || c.eng) { if (S.ws || S.status !== "offline") disconnect(); return; }
    const key = c.api + "|" + c.uid + "|" + c.drv;
    if (S.fatalKey === key) return;                                   // refused for this identity; don't hammer
    if (S.ws && S.wsKey === key && S.ws.readyState <= 1) return;     // connecting or open
    if (S.reconnectTimer && S.wsKey === key) return;                 // backing off
    connect(key, c);
  }

  function connect(key, c) {
    disconnect(true);
    S.wsKey = key;
    setStatus("connecting");
    const url = c.api.replace(/^http/i, "ws") + "/voice?id=" + encodeURIComponent(c.uid) + "&driver=" + encodeURIComponent(c.drv);
    let ws;
    try { ws = new WebSocket(url); } catch (_) { scheduleReconnect(); return; }
    ws.binaryType = "arraybuffer";
    S.ws = ws;

    ws.onopen = () => { S.backoff = 3000; };
    ws.onmessage = (e) => {
      if (S.ws !== ws) return;
      if (typeof e.data === "string") { try { onText(JSON.parse(e.data)); } catch (_) {} }
      else onAudio(new Uint8Array(e.data));
    };
    ws.onclose = (e) => {
      if (S.ws !== ws) return;
      S.ws = null;
      hardStopAll();
      if (e.code === 4003) {
        S.fatalKey = key; S.fatalReason = e.reason || "Voice connection refused.";
        setStatus("fatal");
      } else if (e.code === 4001) {
        S.fatalKey = key; S.fatalReason = "Proximity Chat is open in another window.";
        setStatus("fatal");
      } else {
        scheduleReconnect();
      }
    };
    ws.onerror = () => {};
  }

  function scheduleReconnect() {
    clearTimeout(S.reconnectTimer);
    setStatus("connecting");
    S.reconnectTimer = setTimeout(() => { S.reconnectTimer = null; ensureConnected(); }, S.backoff);
    S.backoff = Math.min(S.backoff * 1.5, 15000);
  }

  function disconnect(keepStatus) {
    clearTimeout(S.reconnectTimer); S.reconnectTimer = null;
    const ws = S.ws; S.ws = null;
    if (ws) { ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null; try { ws.close(); } catch (_) {} }
    hardStopAll();
    S.neighbours = [];
    if (!keepStatus) { S.wsKey = null; setStatus("offline"); }
  }

  function setStatus(s) { S.status = s; render(); }

  // ── server messages ────────────────────────────────────────────────────
  function onText(m) {
    switch (m.t) {
      case "hello":
        S.enabled = m.enabled !== false;
        setStatus("ready");
        startPeekLoop();
        peek();
        break;
      case "enabled":
        S.enabled = !!m.on;
        if (!S.enabled) stopTx(true);
        render();
        break;
      case "neighbours":
        S.neighbours = m.targets || [];
        renderTargets();
        break;
      case "talk_ok":
        if (m.seq !== S.tx.seq) return;
        S.tx.confirmed = true; S.tx.targets = m.targets || [];
        render(); renderTargets();
        break;
      case "talk_denied":
        if (m.seq !== S.tx.seq) return;
        stopTx(true);
        toast(m.reason === "disabled" ? "Race control has turned Proximity Chat off." : "Nobody in range to hear you.", "err");
        break;
      case "talk_ended":
        if (m.seq !== S.tx.seq) return;          // reply to an earlier press
        if (S.tx.active) { stopTx(true); if (m.reason === "timeout") toast("Transmission cut after 20 seconds.", "err"); }
        break;
      case "talk_start": rxStart(m); break;
      case "talk_end":   rxEnd(m.sid); break;
    }
  }

  function send(obj) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj)); }
  function peek() { send({ t: "peek" }); }
  function startPeekLoop() {
    clearInterval(S.peekTimer);
    S.peekTimer = setInterval(() => {
      const tab = $("d-tab-voice");
      if (tab && tab.classList.contains("active") && !S.tx.active) peek();
    }, PEEK_EVERY);
  }

  // ── audio context ──────────────────────────────────────────────────────
  function getCtx() {
    if (!S.ctx) {
      S.ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
      S.master = S.ctx.createGain();
      S.master.gain.value = volume();
      S.master.connect(S.ctx.destination);
    }
    if (S.ctx.state === "suspended") S.ctx.resume().catch(() => {});
    return S.ctx;
  }

  function ensureWorklet(ctx) {
    if (!S.workletReady) {
      const code = `
        class PcCapture extends AudioWorkletProcessor {
          constructor() {
            super();
            this.buf = new Float32Array(${SAMPLE_RATE / 50});
            this.n = 0; this.on = false;
            this.port.onmessage = (e) => { this.on = !!e.data; this.n = 0; };
          }
          process(inputs) {
            const ch = inputs[0] && inputs[0][0];
            if (!ch || !this.on) return true;
            let i = 0;
            while (i < ch.length) {
              const take = Math.min(ch.length - i, this.buf.length - this.n);
              this.buf.set(ch.subarray(i, i + take), this.n);
              this.n += take; i += take;
              if (this.n === this.buf.length) {
                const out = this.buf.slice(0);
                this.port.postMessage(out, [out.buffer]);
                this.n = 0;
              }
            }
            return true;
          }
        }
        registerProcessor("pc-capture", PcCapture);`;
      const url = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
      S.workletReady = ctx.audioWorklet.addModule(url).then(
        () => URL.revokeObjectURL(url),
        (err) => { URL.revokeObjectURL(url); S.workletReady = null; throw err; }
      );
    }
    return S.workletReady;
  }

  // ── microphone ─────────────────────────────────────────────────────────
  async function ensureMic() {
    clearTimeout(S.mic.idleTimer);
    if (S.mic.node) return true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      toast("Microphone unavailable. Allow mic access in Windows Settings → Privacy → Microphone.", "err");
      return false;
    }
    try {
      const ctx = getCtx();
      await ensureWorklet(ctx);
      const src  = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "pc-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const mute = ctx.createGain(); mute.gain.value = 0;      // keeps the node pulled without playing the mic back
      src.connect(node); node.connect(mute); mute.connect(ctx.destination);
      node.port.onmessage = onCaptureFrame;
      S.mic = { stream, src, node, mute, idleTimer: null };
      return true;
    } catch (err) {
      console.error("[Voice] mic setup failed", err);
      stream.getTracks().forEach((t) => t.stop());
      toast("Couldn't start the microphone pipeline.", "err");
      return false;
    }
  }

  function releaseMicSoon() {
    clearTimeout(S.mic.idleTimer);
    S.mic.idleTimer = setTimeout(closeMic, MIC_IDLE_MS);
  }

  function closeMic() {
    clearTimeout(S.mic.idleTimer);
    const m = S.mic;
    try { m.src && m.src.disconnect(); } catch (_) {}
    try { m.node && m.node.disconnect(); } catch (_) {}
    try { m.mute && m.mute.disconnect(); } catch (_) {}
    try { m.stream && m.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    S.mic = { stream: null, src: null, node: null, mute: null, idleTimer: null };
  }

  function onCaptureFrame(e) {
    const tx = S.tx;
    if (!tx.active || !tx.encoder) return;
    const f32 = e.data;
    try {
      const ad = new AudioData({
        format: "f32-planar", sampleRate: SAMPLE_RATE, numberOfFrames: f32.length,
        numberOfChannels: 1, timestamp: tx.ts, data: f32,
      });
      tx.ts += FRAME_US;
      tx.encoder.encode(ad);
      ad.close();
    } catch (err) { console.warn("[Voice] encode failed", err); }
  }

  // ── transmit ───────────────────────────────────────────────────────────
  async function startTx() {
    if (S.tx.active || S.status !== "ready" || !S.enabled) return;
    const tx = S.tx = { active: true, confirmed: false, sent: false, seq: ++S.seq, targets: [], encoder: null, ts: 0, sendFrames: false };
    render();
    getCtx();

    if (!(await ensureMic())) { if (S.tx === tx) { tx.active = false; render(); } return; }
    if (S.tx !== tx || !tx.active) return;                      // released while the mic was opening

    try {
      tx.encoder = new AudioEncoder({
        output: (chunk) => {
          if (!tx.sendFrames || !S.ws || S.ws.readyState !== 1) return;
          const u8 = new Uint8Array(chunk.byteLength);
          chunk.copyTo(u8);
          S.ws.send(u8);
        },
        error: (err) => { console.error("[Voice] encoder error", err); if (S.tx === tx) stopTx(true); },
      });
      tx.encoder.configure({
        codec: "opus", sampleRate: SAMPLE_RATE, numberOfChannels: 1, bitrate: 24000,
        opus: { application: "voip", signal: "voice", frameDuration: FRAME_US },
      });
    } catch (err) {
      console.error("[Voice] encoder setup failed", err);
      tx.active = false; render();
      toast("This app version can't encode voice. Update the app.", "err");
      return;
    }

    tx.sent = true; tx.sendFrames = true;
    send({ t: "ptt", on: true, seq: tx.seq });
    S.mic.node.port.postMessage(true);
  }

  async function stopTx(serverInitiated) {
    const tx = S.tx;
    if (!tx.active) return;
    tx.active = false;
    if (S.mic.node) S.mic.node.port.postMessage(false);
    releaseMicSoon();
    render(); renderTargets();
    if (tx.encoder) {
      try { await tx.encoder.flush(); } catch (_) {}
      try { tx.encoder.close(); } catch (_) {}
    }
    tx.sendFrames = false;
    if (tx.sent && !serverInitiated) send({ t: "ptt", on: false, seq: tx.seq });
  }

  // ── receive ────────────────────────────────────────────────────────────
  function rxStart(m) {
    if (!supported) return;
    rxEnd(m.sid, true);
    const entry = { sid: m.sid, from: m.from || {}, rel: m.rel, decoder: null, ts: 0, nextTime: 0 };
    try {
      entry.decoder = new AudioDecoder({
        output: (ad) => playAudioData(entry, ad),
        error: (err) => console.warn("[Voice] decoder error", err),
      });
      entry.decoder.configure({ codec: "opus", sampleRate: SAMPLE_RATE, numberOfChannels: 1 });
    } catch (err) { console.warn("[Voice] decoder setup failed", err); return; }
    S.rx.set(m.sid, entry);
    getCtx();
    chirp(true);
    render();
  }

  function onAudio(u8) {
    if (u8.length < 3) return;
    const entry = S.rx.get((u8[0] << 8) | u8[1]);
    if (!entry || entry.decoder.state !== "configured") return;
    try {
      entry.decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: entry.ts, data: u8.subarray(2) }));
      entry.ts += FRAME_US;
    } catch (err) { console.warn("[Voice] decode failed", err); }
  }

  function rxEnd(sid, silent) {
    const entry = S.rx.get(sid);
    if (!entry) return;
    S.rx.delete(sid);
    const dec = entry.decoder;
    dec.flush().catch(() => {}).then(() => { try { dec.close(); } catch (_) {} });
    if (!silent) { chirp(false); render(); }
  }

  function playAudioData(entry, ad) {
    try {
      const ctx = getCtx();
      const n = ad.numberOfFrames;
      const f32 = new Float32Array(n);
      ad.copyTo(f32, { planeIndex: 0, format: "f32-planar" });
      const now = ctx.currentTime, dur = n / ad.sampleRate;
      if (entry.nextTime < now + 0.02) entry.nextTime = now + JITTER_S;   // first packet, or we underran
      else if (entry.nextTime - now > MAX_LAG_S) return;                  // too far behind: skip ahead to stay live
      const buf = ctx.createBuffer(1, n, ad.sampleRate);
      buf.copyToChannel(f32, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf; src.connect(S.master);
      src.start(entry.nextTime);
      entry.nextTime += dur;
    } catch (err) { /* ignore a bad packet */ }
    finally { try { ad.close(); } catch (_) {} }
  }

  function chirp(start) {
    try {
      const ctx = getCtx(), t = ctx.currentTime;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = start ? 1100 : 760;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      o.connect(g); g.connect(S.master);
      o.start(t); o.stop(t + 0.08);
    } catch (_) {}
  }

  function hardStopAll() {
    if (S.tx.active) { S.tx.active = false; S.tx.sendFrames = false; try { S.tx.encoder && S.tx.encoder.close(); } catch (_) {} }
    if (S.mic.node) S.mic.node.port.postMessage(false);
    for (const sid of [...S.rx.keys()]) rxEnd(sid, true);
    clearInterval(S.peekTimer);
    render();
  }

  // ── push-to-talk input (button + hotkey share this) ────────────────────
  function pttDown() {
    if (S.capturingKey) return;
    if (mode() === "toggle") { S.tx.active ? stopTx() : startTx(); }
    else startTx();
  }
  function pttUp() { if (mode() === "hold") stopTx(); }

  // ── UI ─────────────────────────────────────────────────────────────────
  const MIC_SVG = '<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5 11.5a7 7 0 0 0 14 0"/><path d="M12 18.5V22"/></svg>';

  const TEMPLATE = `
    <div class="rc-block-title">Proximity Chat</div>
    <div class="pc-status" id="pc-status"></div>

    <div class="pc-stage">
      <div class="pc-mic-wrap" id="pc-mic-wrap">
        <div class="pc-ring"></div>
        <button type="button" class="pc-mic" id="pc-mic" aria-label="Push to talk">${MIC_SVG}</button>
      </div>
      <div class="pc-caption" id="pc-caption"></div>
    </div>

    <div class="rc-block-title">In range</div>
    <div class="pc-targets" id="pc-targets"></div>

    <div class="rc-block-title">Settings</div>
    <div class="pc-settings">
      <div class="pc-row">
        <span class="pc-label">Mic button</span>
        <div class="pc-seg" role="group" aria-label="Mic button mode">
          <button type="button" id="pc-mode-hold">Hold to talk</button>
          <button type="button" id="pc-mode-toggle">Click on / off</button>
        </div>
      </div>
      <div class="pc-row">
        <span class="pc-label">Push-to-talk key</span>
        <div class="pc-keyrow">
          <button type="button" class="pc-keybtn" id="pc-key-btn"></button>
          <button type="button" class="pc-clear" id="pc-key-clear" title="Remove this key">Clear</button>
        </div>
      </div>
      <div class="pc-row">
        <span class="pc-label">Volume</span>
        <input type="range" id="pc-vol" min="0" max="100" step="1" aria-label="Incoming volume" />
      </div>
      <div class="pc-note">Your voice goes to the 2 cars nearest you on the leaderboard. Nothing is recorded.</div>
    </div>`;

  function injectStyles() {
    if ($("pc-styles")) return;
    const st = document.createElement("style");
    st.id = "pc-styles";
    st.textContent = `
      #d-tab-voice { padding-bottom: 12px; }
      .pc-status { font-family:'Oxanium',sans-serif; font-size:12px; color:var(--muted); margin:6px 0 2px; min-height:16px; }
      .pc-status.bad { color:var(--red); }
      .pc-stage { display:flex; flex-direction:column; align-items:center; gap:10px; padding:16px 0 18px; }
      .pc-mic-wrap { position:relative; isolation:isolate; width:148px; height:148px; --pc-edge:var(--border); --pc-glow:transparent; }
      .pc-ring, .pc-mic { clip-path:polygon(30% 0,70% 0,100% 30%,100% 70%,70% 100%,30% 100%,0 70%,0 30%); }
      .pc-ring { position:absolute; inset:0; background:var(--pc-edge); transition:background .15s; }
      .pc-mic {
        position:absolute; top:3px; left:3px; width:calc(100% - 6px); height:calc(100% - 6px); border:none; cursor:pointer; display:flex; align-items:center; justify-content:center;
        background:var(--surface); color:var(--muted); touch-action:none; user-select:none; -webkit-user-select:none;
        transition:color .15s, background .15s;
      }
      .pc-mic:hover { color:var(--text); }
      .pc-mic:focus-visible { outline:2px solid var(--blue); outline-offset:-6px; }
      .pc-mic:disabled { cursor:not-allowed; opacity:.55; }
      .pc-mic-wrap.tx   { --pc-edge:var(--red);   --pc-glow:rgba(255,45,85,.35); }
      .pc-mic-wrap.tx .pc-mic { color:var(--red); background:rgba(255,45,85,.10); }
      .pc-mic-wrap.rx   { --pc-edge:var(--green); --pc-glow:rgba(16,229,138,.30); }
      .pc-mic-wrap.rx .pc-mic { color:var(--green); background:rgba(16,229,138,.08); }
      .pc-mic-wrap.tx::after, .pc-mic-wrap.rx::after {
        content:""; position:absolute; inset:-6px; pointer-events:none; opacity:.0;
        clip-path:polygon(30% 0,70% 0,100% 30%,100% 70%,70% 100%,30% 100%,0 70%,0 30%);
        background:var(--pc-glow); animation:pc-pulse 1.1s ease-out infinite; z-index:-1;
      }
      @keyframes pc-pulse { 0% { opacity:.9; transform:scale(.96); } 100% { opacity:0; transform:scale(1.08); } }
      @media (prefers-reduced-motion: reduce) { .pc-mic-wrap.tx::after, .pc-mic-wrap.rx::after { animation:none; opacity:.35; } }
      .pc-caption { font-family:'Oxanium',sans-serif; font-size:15px; font-weight:700; color:var(--text); text-align:center; min-height:20px; }
      .pc-caption small { display:block; font-size:11px; font-weight:500; color:var(--muted); margin-top:2px; }

      .pc-targets { display:flex; flex-direction:column; gap:6px; margin-top:6px; }
      .pc-empty { font-family:'Oxanium',sans-serif; font-size:12px; color:var(--muted); padding:8px 2px; }
      .pc-t { display:flex; align-items:center; gap:10px; padding:8px 10px; background:var(--surface); border:1px solid var(--border);
              clip-path:polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px); }
      .pc-t.live { border-color:var(--red); }
      .pc-t-rel { font-size:13px; width:16px; text-align:center; color:var(--muted); }
      .pc-t-pos { font-family:'Oxanium',sans-serif; font-weight:800; font-size:12px; color:var(--muted); width:26px; }
      .pc-t-num { font-family:'Oxanium',sans-serif; font-weight:800; font-size:13px; min-width:30px; text-align:center; padding:2px 6px; background:var(--surface-2); }
      .pc-t-body { flex:1; min-width:0; }
      .pc-t-name { font-family:'Oxanium',sans-serif; font-weight:700; font-size:13px; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .pc-t-call { font-family:'Oxanium',sans-serif; font-size:11px; color:var(--muted); }

      .pc-settings { display:flex; flex-direction:column; gap:12px; margin-top:8px; }
      .pc-row { display:flex; align-items:center; justify-content:space-between; gap:12px; }
      .pc-label { font-family:'Oxanium',sans-serif; font-size:12px; color:var(--text); }
      .pc-seg { display:flex; }
      .pc-seg button { font-family:'Oxanium',sans-serif; font-size:11px; font-weight:700; padding:6px 10px; border:1px solid var(--border);
                       background:var(--surface); color:var(--muted); cursor:pointer; }
      .pc-seg button + button { border-left:none; }
      .pc-seg button.on { color:var(--text); background:rgba(255,45,85,.10); border-color:var(--red); }
      .pc-seg button.on + button { border-left:1px solid var(--border); }
      .pc-keyrow { display:flex; gap:6px; }
      .pc-keybtn, .pc-clear { font-family:'Oxanium',sans-serif; font-size:11px; font-weight:700; padding:6px 10px; border:1px solid var(--border);
                              background:var(--surface); color:var(--text); cursor:pointer; }
      .pc-keybtn { min-width:84px; }
      .pc-keybtn.listening { border-color:var(--blue); color:var(--blue); }
      .pc-clear { color:var(--muted); }
      .pc-keybtn:focus-visible, .pc-clear:focus-visible, .pc-seg button:focus-visible { outline:2px solid var(--blue); outline-offset:1px; }
      #pc-vol { width:130px; accent-color:var(--red); }
      .pc-note { font-family:'Oxanium',sans-serif; font-size:11px; color:var(--muted); line-height:1.4; }
    `;
    document.head.appendChild(st);
  }

  function mountUI() {
    const c = appCtx();
    const btn = $("d-tab-btn-voice");
    if (btn && c.eng) btn.style.display = "none";
    const root = $("d-tab-voice");
    if (!root) return;
    injectStyles();
    root.innerHTML = TEMPLATE;

    const mic = $("pc-mic");
    mic.addEventListener("pointerdown", (e) => { if (e.button !== 0) return; try { mic.setPointerCapture(e.pointerId); } catch (_) {} pttDown(); });
    mic.addEventListener("pointerup", pttUp);
    mic.addEventListener("pointercancel", pttUp);
    mic.addEventListener("lostpointercapture", pttUp);
    mic.addEventListener("contextmenu", (e) => e.preventDefault());

    $("pc-mode-hold").onclick   = () => { lsSet(LS.mode, "hold");   if (S.tx.active) stopTx(); render(); };
    $("pc-mode-toggle").onclick = () => { lsSet(LS.mode, "toggle"); if (S.tx.active) stopTx(); render(); };
    $("pc-key-btn").onclick     = capturePttKey;
    $("pc-key-clear").onclick   = () => applyPttKey("None");
    const vol = $("pc-vol");
    vol.value = Math.round(volume() * 100);
    vol.oninput = () => { const v = vol.value / 100; lsSet(LS.vol, String(v)); if (S.master) S.master.gain.value = v; };

    render(); renderTargets();
  }

  function render() {
    const wrap = $("pc-mic-wrap");
    if (!wrap) return;
    const mic = $("pc-mic"), status = $("pc-status"), cap = $("pc-caption");
    const ready = S.status === "ready";
    const txOn = S.tx.active, rxOn = S.rx.size > 0;

    wrap.classList.toggle("tx", txOn);
    wrap.classList.toggle("rx", !txOn && rxOn);
    mic.disabled = !ready || !S.enabled;
    mic.setAttribute("aria-pressed", txOn ? "true" : "false");

    let st = "", bad = false;
    const c = appCtx();
    if (!supported)                  { st = "Voice isn't supported in this version of the app. Update to the latest release."; bad = true; }
    else if (c.eng)                  { st = "Proximity Chat is for drivers. Engineers can't transmit."; }
    else if (!c.drv)                 { st = "Pick your driver in Settings to use Proximity Chat."; }
    else if (S.status === "fatal")   { st = S.fatalReason; bad = true; }
    else if (S.status === "connecting" || S.status === "offline") { st = "Connecting…"; }
    else if (!S.enabled)             { st = "Race control has turned Proximity Chat off."; bad = true; }
    else                             { st = "Connected"; }
    status.textContent = st;
    status.classList.toggle("bad", bad);

    if (txOn) {
      const n = S.tx.targets.length;
      cap.innerHTML = S.tx.confirmed ? `Transmitting<small>${n === 1 ? "1 car can hear you" : n + " cars can hear you"}</small>` : "Opening mic…";
    } else if (rxOn) {
      const e = [...S.rx.values()][0];
      const who = [e.from.number ? "#" + esc(e.from.number) : "", esc(e.from.callsign || e.from.name || "")].filter(Boolean).join(" ");
      cap.innerHTML = `${who}<small>${e.rel === "ahead" ? "Car ahead is talking" : "Car behind is talking"}</small>`;
    } else if (ready && S.enabled) {
      cap.innerHTML = mode() === "hold" ? "Hold to talk" : "Click to talk";
    } else {
      cap.textContent = "";
    }

    $("pc-mode-hold").classList.toggle("on", mode() === "hold");
    $("pc-mode-toggle").classList.toggle("on", mode() === "toggle");
    updateKeyBtn();
  }

  function renderTargets() {
    const el = $("pc-targets");
    if (!el) return;
    const list = S.tx.active && S.tx.confirmed ? S.tx.targets : S.neighbours;
    if (S.status !== "ready") { el.innerHTML = ""; return; }
    if (!list.length) { el.innerHTML = '<div class="pc-empty">Nobody in range right now. Cars within 3 places of you who are connected will show here.</div>'; return; }
    el.innerHTML = list.map((t) => {
      const tc = teamColor(t.callsign);
      const numStyle = tc ? ` style="background:${tc}22;color:${tc};"` : "";
      return `<div class="pc-t${S.tx.active ? " live" : ""}">
        <span class="pc-t-rel" title="${t.rel === "ahead" ? "Ahead of you" : "Behind you"}">${t.rel === "ahead" ? "▲" : "▼"}</span>
        <span class="pc-t-pos">P${esc(t.position)}</span>
        <span class="pc-t-num"${numStyle}>${esc(t.number)}</span>
        <div class="pc-t-body"><div class="pc-t-name">${esc(t.name)}</div><div class="pc-t-call">${esc(t.callsign)}</div></div>
      </div>`;
    }).join("");
  }

  // ── push-to-talk key binding ───────────────────────────────────────────
  function updateKeyBtn() {
    const b = $("pc-key-btn");
    if (!b || S.capturingKey) return;
    const k = pttKey();
    b.textContent = k === "None" ? "Not set" : k;
    b.classList.remove("listening");
  }

  function keyNameFromEvent(e) {
    const code = e.code || "";
    if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
    if (/^Numpad/.test(code)) return code;
    if (["CapsLock", "ScrollLock", "Pause", "Insert", "Delete", "Home", "End", "PageUp", "PageDown"].indexOf(code) !== -1) return code;
    return null;
  }

  function capturePttKey() {
    if (S.capturingKey) return;
    S.capturingKey = true;
    const b = $("pc-key-btn");
    b.textContent = "Press a key…"; b.classList.add("listening");

    const done = () => {
      S.capturingKey = false;
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onMouse, true);
      updateKeyBtn();
    };
    const onKey = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") return done();
      const name = keyNameFromEvent(e);
      done();
      if (!name) return toast("Use an F-key, numpad key, or a mouse side button.", "err");
      applyPttKey(name);
    };
    const onMouse = (e) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault(); e.stopPropagation();
      done();
      applyPttKey(e.button === 3 ? "Mouse4" : "Mouse5");
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onMouse, true);
  }

  async function applyPttKey(name) {
    if (name !== "None") {
      const taken = typeof config !== "undefined" && config && config.keybinds
        ? Object.keys(config.keybinds).find((a) => config.keybinds[a] === name) : null;
      if (taken) return toast(name + " is already used for another action. Pick a different key.", "err");
    }
    try {
      const r = window.api && window.api.setVoicePttKey ? await window.api.setVoicePttKey(name) : { ok: false, reason: "Hotkeys unavailable." };
      if (!r || !r.ok) return toast((r && r.reason) || "Couldn't set that key.", "err");
      lsSet(LS.key, name);
      updateKeyBtn();
      toast(name === "None" ? "Push-to-talk key removed." : "Push-to-talk key set to " + name + ".", "ok");
    } catch (err) { toast("Couldn't set that key.", "err"); }
  }

  function onTabChange(tab) {
    if (tab !== "voice") return;
    if (S.status === "fatal") S.fatalKey = null;      // opening the tab is an explicit retry
    ensureConnected(); peek(); render(); renderTargets();
  }

  // ── boot ───────────────────────────────────────────────────────────────
  function init() {
    if (window.api && window.api.onVoicePtt) window.api.onVoicePtt((down) => { down ? pttDown() : pttUp(); });
    const saved = pttKey();
    if (saved !== "None" && window.api && window.api.setVoicePttKey) {
      window.api.setVoicePttKey(saved).then((r) => { if (r && !r.ok) lsSet(LS.key, "None"); }).catch(() => {});
    }
    window.addEventListener("beforeunload", () => disconnect());
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();

  window.ProximityChat = { mountUI, ensureConnected, onTabChange, disconnect, isSupported: supported };
})();
