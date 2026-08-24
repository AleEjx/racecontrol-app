/* =========================================================
   PARTY MODE — effects engine
   All effects are cosmetic and scoped to this renderer window.
   Nothing here dispatches real OS-level keyboard/mouse input, and
   nothing here uses discrete/high-contrast flashing (photosensitive
   seizure risk) — the rainbow effect is a smooth continuous hue
   sweep. See party-mode.css for the safety notes on that.
   ========================================================= */

let _rcPartyActive = false;
let _rcPartyTimers = [];      // interval/timeout ids to clear on stop
let _rcPartyAudioCtx = null;
let _rcPartyFloatTargets = []; // { el, original } for letter-float cleanup
let _rcPartyLiveBadge = null;

const RC_PARTY_LETTER_KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const RC_PARTY_POPUP_LINES = [
  "🏆 YOU'RE TODAY'S WINNER!",
  "⚠️ YOUR TIRES ARE 1 CLICK AWAY",
  "🔥 CONGRATULATIONS, PIT CREW",
  "💾 SYSTEM NEEDS MORE CONFETTI",
  "🎉 PARTY MODE APPROVES OF YOU",
  "🚨 SUSPICIOUSLY FAST LAP DETECTED",
  "📉 YOUR APEX HAS LEFT THE CHAT",
  "🍕 PIT CREW ORDERED PIZZA, BRB",
  "🎯 BRAKE CHECK IN 3... 2...",
  "🛞 ONE OF YOUR TIRES IS A DECOY",
  "📡 SIGNAL LOST, VIBES FOUND",
  "🐢 TURTLE MODE UNLOCKED",
  "🎪 WELCOME TO THE CIRCUS TRACK",
  "🧭 STEERING WHEEL IS NOW SUGGESTIVE"
];
// Local image/gif popups — drop files at these paths (relative to
// renderer.html's folder, e.g. assets/party/party-1.gif) to have them
// rotate in with the text popups. Missing files fail silently.
// Local image/gif popups — drop files at these paths (resolved from
// this file's own folder, src/, so they live one level up at the
// project's shared assets/party/ folder) and they'll rotate in
// alongside the text popups. Missing files are skipped silently.
const RC_PARTY_IMAGE_FILES = [
  "../assets/party/party-1.gif",
  "../assets/party/party-2.gif",
  "../assets/party/party-3.gif",
  "../assets/party/party-4.gif",
  "../assets/party/party-5.gif",
  "../assets/party/party-6.gif",
  "../assets/party/party-7.png"
];
const RC_PARTY_EDGE_LINES = ["👀 INCOMING", "🚧 CAUTION", "🎉 SURPRISE", "📣 HEADS UP", "🌀 CHAOS"];
let _rcPartyDecoyCursor = null;

/* ---------------- Settings toggle wiring ---------------- */

function loadPartyModePref() {
  // Party Mode is a live "turn it on right now" switch, not a
  // persisted preference — it always starts OFF on launch so nobody
  // opens the app to a screen already mid-chaos.
  _rcPartyActive = false;
  updatePartyModeToggleBtn();
}

function updatePartyModeToggleBtn() {
  const btn = document.getElementById("party-mode-toggle-btn");
  if (!btn) return;
  const on = _rcPartyActive;
  btn.textContent = on ? "ON" : "OFF";
  btn.style.background = on ? "rgba(0,230,118,0.15)" : "rgba(255,23,68,0.15)";
  btn.style.borderColor = on ? "var(--green)" : "var(--red)";
  btn.style.color = on ? "var(--green)" : "var(--red)";
}

function togglePartyModePref() {
  if (_rcPartyActive) {
    stopPartyMode();
    return;
  }
  const ok = confirm(
    "🎉 Party Mode\n\n" +
    "This throws the app into full chaos — color sweeps, shaking, glitches, " +
    "sounds, fake popups, and floating text — until you turn it off.\n\n" +
    "⚠️ Contains rapid motion and color effects. If you're photosensitive or " +
    "prone to motion sickness, skip this.\n\n" +
    "Press Esc anytime to kill it instantly.\n\nStart Party Mode?"
  );
  if (!ok) return;
  startPartyMode();
}

/* ---------------- Engine start/stop ---------------- */

function startPartyMode() {
  if (_rcPartyActive) return;
  _rcPartyActive = true;
  updatePartyModeToggleBtn();
  showToast?.("🎉 Party Mode ON — press Esc to stop", "ok");

  document.documentElement.classList.add("rc-party-hue-active");
  _rcPartyHueSpeedLoop();

  window.api?.partyOverlay?.start?.();

  _rcPartyLiveBadge = document.createElement("div");
  _rcPartyLiveBadge.className = "rc-party-live-badge";
  _rcPartyLiveBadge.textContent = "🎉 PARTY MODE — Esc to stop";
  document.body.appendChild(_rcPartyLiveBadge);

  _rcPartyFloatify(document.querySelector(".tl-logo"));

  _rcPartySchedule(_rcPartyMotionTick, 480, 1150);
  _rcPartySchedule(_rcPartyGlitchTick, 1200, 3000);
  _rcPartySchedule(_rcPartySoundTick, 850, 2200);
  _rcPartySchedule(_rcPartyKeyflashTick, 1500, 4000);
  _rcPartySchedule(_rcPartyPopupTick, 1700, 4500);
  _rcPartySchedule(_rcPartyAltTabTick, 4500, 10500);
  _rcPartySchedule(_rcPartyEdgeTick, 1700, 4000);
  _rcPartySchedule(_rcPartyBlackoutTick, 175000, 185000); // ~once every 3 minutes
  _rcPartySchedule(_rcPartyCountdownTick, 2800, 6500);
  _rcPartySchedule(_rcPartyBombTick, 13000, 24000);

  _rcPartyDecoyCursor = document.createElement("div");
  _rcPartyDecoyCursor.className = "rc-party-decoy-cursor";
  _rcPartyDecoyCursor.textContent = "🖱️";
  _rcPartyDecoyCursor.style.left = "50%";
  _rcPartyDecoyCursor.style.top = "50%";
  document.body.appendChild(_rcPartyDecoyCursor);
  _rcPartySchedule(_rcPartyDecoyCursorTick, 1100, 2800);
}

function stopPartyMode() {
  if (!_rcPartyActive) return;
  _rcPartyActive = false;
  updatePartyModeToggleBtn();

  window.api?.partyOverlay?.stop?.();

  document.documentElement.classList.remove("rc-party-hue-active");
  document.documentElement.style.animationDuration = "";
  document.body.style.animation = "";

  _rcPartyTimers.forEach(id => { clearTimeout(id); clearInterval(id); });
  _rcPartyTimers = [];

  document.querySelectorAll(".rc-party-keyflash, .rc-party-alttab, .rc-party-popup, .rc-party-edge, .rc-party-surge, .rc-party-blackout, .rc-party-countdown, .rc-party-bomb")
    .forEach(el => el.remove());
  _rcPartyActivePopups = [];

  _rcPartyFloatTargets.forEach(({ el, original }) => { if (el) el.innerHTML = original; });
  _rcPartyFloatTargets = [];

  if (_rcPartyLiveBadge) { _rcPartyLiveBadge.remove(); _rcPartyLiveBadge = null; }
  if (_rcPartyDecoyCursor) { _rcPartyDecoyCursor.remove(); _rcPartyDecoyCursor = null; }

  if (_rcPartyBombAudio) {
    try { _rcPartyBombAudio.pause(); _rcPartyBombAudio.currentTime = 0; } catch {}
    _rcPartyBombAudio = null;
  }
  _rcPartyBombActive = false;

  showToast?.("Party Mode off", "");
}

// Kill switch — works regardless of which screen is open.
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && _rcPartyActive) stopPartyMode();
});

// The main process also owns a global (OS-level) Escape shortcut for the
// desktop overlay, since that overlay can be killed even while this
// window isn't focused. When that fires, sync our local state/UI.
window.api?.onPartyOverlayKilled?.(() => { if (_rcPartyActive) stopPartyMode(); });

/* ---------------- Scheduling helper ---------------- */
// Reschedules itself with a new random delay each time, so effects
// fire at irregular (not periodic/strobe-like) intervals.
function _rcPartySchedule(fn, minMs, maxMs) {
  const delay = minMs + Math.random() * (maxMs - minMs);
  const id = setTimeout(() => {
    if (!_rcPartyActive) return;
    fn();
    _rcPartySchedule(fn, minMs, maxMs);
  }, delay);
  _rcPartyTimers.push(id);
}

/* ---------------- Individual effects ---------------- */

// Varies the rainbow sweep speed over time — irregular but always
// smooth (never below 0.6s per full cycle).
function _rcPartyHueSpeedLoop() {
  if (!_rcPartyActive) return;
  const dur = (0.7 + Math.random() * 1.6).toFixed(2) + "s";
  document.documentElement.style.animationDuration = dur;
  const id = setTimeout(_rcPartyHueSpeedLoop, 1800 + Math.random() * 2200);
  _rcPartyTimers.push(id);
}

// Bounce / distort — transient transform effects on <body>.
function _rcPartyMotionTick() {
  const picks = ["rc-party-bounce-v 0.5s ease-in-out", "rc-party-bounce-h 0.5s ease-in-out", "rc-party-distort 0.6s ease-in-out"];
  const anim = picks[Math.floor(Math.random() * picks.length)];
  document.body.style.animation = anim;
  const onEnd = () => { document.body.style.animation = ""; document.body.removeEventListener("animationend", onEnd); };
  document.body.addEventListener("animationend", onEnd);
}

function _rcPartyGlitchTick() {
  // Occasionally go big: bigger displacement plus a brief full-screen
  // color surge, for the "more coverage" chaos beats. Each is a single
  // smooth animation — no repeating strobe.
  const big = Math.random() < 0.35;
  document.body.style.animation = (big ? "rc-party-glitch-big" : "rc-party-glitch") + " 0.35s linear";
  const onEnd = () => { document.body.style.animation = ""; document.body.removeEventListener("animationend", onEnd); };
  document.body.addEventListener("animationend", onEnd);

  if (big) {
    const surge = document.createElement("div");
    surge.className = "rc-party-surge";
    document.body.appendChild(surge);
    const id = setTimeout(() => surge.remove(), 1350);
    _rcPartyTimers.push(id);
  }
}

// Slides a short banner in from a random screen edge and back out.
function _rcPartyEdgeTick() {
  const edges = ["top", "bottom", "left", "right"];
  const edge = edges[Math.floor(Math.random() * edges.length)];
  const el = document.createElement("div");
  el.className = "rc-party-edge";
  el.textContent = RC_PARTY_EDGE_LINES[Math.floor(Math.random() * RC_PARTY_EDGE_LINES.length)];
  const offsets = {
    top:    { ex: "0", ey: "-120px", css: "top:0; left:" + (10 + Math.random() * 70) + "%;" },
    bottom: { ex: "0", ey: "120px",  css: "bottom:0; left:" + (10 + Math.random() * 70) + "%;" },
    left:   { ex: "-160px", ey: "0", css: "left:0; top:" + (10 + Math.random() * 70) + "%;" },
    right:  { ex: "160px", ey: "0",  css: "right:0; top:" + (10 + Math.random() * 70) + "%;" },
  }[edge];
  el.style.cssText = offsets.css;
  el.style.setProperty("--rc-ex", offsets.ex);
  el.style.setProperty("--rc-ey", offsets.ey);
  document.body.appendChild(el);
  const id = setTimeout(() => el.remove(), 1850);
  _rcPartyTimers.push(id);
}

// Full-screen dim to black and back — one smooth fade per occurrence,
// never a repeating strobe.
function _rcPartyBlackoutTick() {
  const el = document.createElement("div");
  el.className = "rc-party-blackout";
  const dur = (4.6 + Math.random() * 0.8).toFixed(2) + "s";
  el.style.setProperty("--rc-bo-dur", dur);
  document.body.appendChild(el);
  const id = setTimeout(() => el.remove(), parseFloat(dur) * 1000 + 50);
  _rcPartyTimers.push(id);
}

// Countdown that ticks down to nothing and vanishes, for no reason.
function _rcPartyCountdownTick() {
  let n = 3 + Math.floor(Math.random() * 13); // 3–15
  const el = document.createElement("div");
  el.className = "rc-party-countdown";
  el.textContent = n;
  const maxLeft = Math.max(20, window.innerWidth - 120);
  const maxTop = Math.max(20, window.innerHeight - 80);
  el.style.left = (20 + Math.random() * maxLeft) + "px";
  el.style.top = (20 + Math.random() * maxTop) + "px";
  document.body.appendChild(el);
  const interval = setInterval(() => {
    n--;
    if (n < 0) { clearInterval(interval); el.remove(); return; }
    el.textContent = n;
  }, 850 + Math.random() * 300);
  _rcPartyTimers.push(interval);
}

// "Bomb" countdown box — bigger, tenser, ends with a local sound cue
// at full in-app volume. Purely cosmetic: no real explosive content,
// just a joke prop. Sound file is a local asset shipped with the app.
// "Bomb" countdown box — bigger, tenser, ends with a local sound cue
// at full in-app volume. Purely cosmetic: no real explosive content,
// just a joke prop. Sound file is a local asset shipped with the app.
// Only one active at a time so audio never overlaps with itself, and
// the audio reference is kept around so Escape/stop can silence it.
const RC_PARTY_BOMB_SOUND = "../assets/party/bomb.mp3";
let _rcPartyBombActive = false;
let _rcPartyBombAudio = null;

function _rcPartyBombTick() {
  if (_rcPartyBombActive) return;
  _rcPartyBombActive = true;

  let n = 29;
  const el = document.createElement("div");
  el.className = "rc-party-bomb";
  const maxLeft = Math.max(20, window.innerWidth - 240);
  const maxTop = Math.max(20, window.innerHeight - 160);
  el.style.left = (20 + Math.random() * maxLeft) + "px";
  el.style.top = (20 + Math.random() * maxTop) + "px";
  el.innerHTML =
    '<div class="rc-party-bomb-icon">💣</div>' +
    '<div class="rc-party-bomb-num">' + n + '</div>' +
    '<div class="rc-party-bomb-label">ARMED</div>';
  document.body.appendChild(el);
  const numEl = el.querySelector(".rc-party-bomb-num");
  const labelEl = el.querySelector(".rc-party-bomb-label");

  try {
    const audio = new Audio(RC_PARTY_BOMB_SOUND);
    audio.volume = 1.0;
    audio.addEventListener("error", () => {
      console.warn("[party-mode] bomb.mp3 failed to load:", audio.error);
    });
    audio.play().catch(err => console.warn("[party-mode] bomb.mp3 play() rejected:", err));
    _rcPartyBombAudio = audio;
  } catch { /* audio not available — skip silently */ }

  const interval = setInterval(() => {
    n--;
    if (n < 0) {
      clearInterval(interval);
      labelEl.textContent = "💥 BOOM";
      const id = setTimeout(() => {
        el.remove();
        _rcPartyBombActive = false;
        _rcPartyBombAudio = null;
      }, 700);
      _rcPartyTimers.push(id);
      return;
    }
    numEl.textContent = n;
  }, 1000);
  _rcPartyTimers.push(interval);
}

// Cosmetic decoy cursor — drifts to random spots. Never moves the
// real OS cursor and has pointer-events disabled, so it can't
// intercept clicks; it's purely a visual "which one is real?" gag.
function _rcPartyDecoyCursorTick() {
  if (!_rcPartyDecoyCursor) return;
  const x = 5 + Math.random() * 90;
  const y = 5 + Math.random() * 90;
  _rcPartyDecoyCursor.style.left = x + "%";
  _rcPartyDecoyCursor.style.top = y + "%";
}

// Short synthesized blips via WebAudio — no external audio assets needed.
function _rcPartySoundTick() {
  try {
    _rcPartyAudioCtx = _rcPartyAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _rcPartyAudioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const types = ["sine", "square", "triangle", "sawtooth"];
    osc.type = types[Math.floor(Math.random() * types.length)];
    osc.frequency.value = 220 + Math.random() * 660;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.26);
  } catch { /* audio not available — silently skip */ }
}

// Cosmetic-only fake keypress flash. Does not send any real input.
function _rcPartyKeyflashTick() {
  const letter = RC_PARTY_LETTER_KEYS[Math.floor(Math.random() * RC_PARTY_LETTER_KEYS.length)];
  const el = document.createElement("div");
  el.className = "rc-party-keyflash";
  el.textContent = letter;
  document.body.appendChild(el);
  const id = setTimeout(() => el.remove(), 750);
  _rcPartyTimers.push(id);
}

// Cosmetic-only fake OS app-switcher. Does not change real window focus.
function _rcPartyAltTabTick() {
  const el = document.createElement("div");
  el.className = "rc-party-alttab";
  const icons = ["🏁", "🎮", "💬", "🌐", "🎉"];
  const activeIdx = Math.floor(Math.random() * icons.length);
  icons.forEach((icon, i) => {
    const tile = document.createElement("div");
    tile.className = "rc-party-alttab-tile" + (i === activeIdx ? " rc-active" : "");
    tile.textContent = icon;
    el.appendChild(tile);
  });
  document.body.appendChild(el);
  const id = setTimeout(() => el.remove(), 1150);
  _rcPartyTimers.push(id);
}

// Fake "ad" popup with a close button that gets a couple of playful
// dodges before it settles so it can always actually be closed.
// Popups stay on screen until manually closed; capped at MAX so a
// long session doesn't pile up unbounded DOM elements.
const RC_PARTY_MAX_POPUPS = 14;
let _rcPartyActivePopups = [];

function _rcPartyPopupTick() {
  if (_rcPartyActivePopups.length >= RC_PARTY_MAX_POPUPS) {
    const oldest = _rcPartyActivePopups.shift();
    oldest?.remove();
  }

  const el = document.createElement("div");
  const variant = ["", "rc-alt2", "rc-alt3"][Math.floor(Math.random() * 3)];
  el.className = "rc-party-popup " + variant;
  // Most popups land near the middle of the screen (with jitter),
  // some still spawn anywhere for variety.
  const popupW = 420, popupH = 260;
  let left, top;
  if (Math.random() < 0.7) {
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    left = cx - popupW / 2 + (Math.random() * 240 - 120);
    top = cy - popupH / 2 + (Math.random() * 160 - 80);
  } else {
    left = 20 + Math.random() * Math.max(20, window.innerWidth - popupW - 20);
    top = 60 + Math.random() * Math.max(20, window.innerHeight - popupH - 60);
  }
  left = Math.min(Math.max(20, left), window.innerWidth - popupW - 20);
  top = Math.min(Math.max(20, top), window.innerHeight - popupH - 20);
  el.style.left = left + "px";
  el.style.top = top + "px";

  const label = document.createElement("div");
  label.textContent = RC_PARTY_POPUP_LINES[Math.floor(Math.random() * RC_PARTY_POPUP_LINES.length)];
  el.appendChild(label);

  const removePopup = () => {
    el.remove();
    _rcPartyActivePopups = _rcPartyActivePopups.filter(p => p !== el);
  };

  if (RC_PARTY_IMAGE_FILES.length && Math.random() < 0.4) {
    const img = document.createElement("img");
    img.src = RC_PARTY_IMAGE_FILES[Math.floor(Math.random() * RC_PARTY_IMAGE_FILES.length)];
    img.alt = "";
    img.onerror = removePopup;
    el.appendChild(img);
  }

  const closeBtn = document.createElement("button");
  closeBtn.className = "rc-party-popup-close";
  closeBtn.textContent = "✕";
  closeBtn.style.top = "6px";
  closeBtn.style.right = "6px";
  let dodges = 0;
  closeBtn.addEventListener("mouseenter", () => {
    if (dodges >= 2) return; // always closable after a couple of hops
    dodges++;
    closeBtn.style.top = (2 + Math.random() * 20) + "px";
    closeBtn.style.right = (2 + Math.random() * 20) + "px";
  });
  closeBtn.addEventListener("click", removePopup);
  el.appendChild(closeBtn);

  document.body.appendChild(el);
  _rcPartyActivePopups.push(el);
}

// Wraps an element's visible text into per-letter spans that drift —
// reversible via the stored original innerHTML.
function _rcPartyFloatify(el) {
  if (!el || !el.textContent) return;
  const original = el.innerHTML;
  const text = el.textContent;
  el.innerHTML = "";
  [...text].forEach(ch => {
    const span = document.createElement("span");
    span.className = "rc-party-letter";
    span.textContent = ch === " " ? "\u00A0" : ch;
    span.style.setProperty("--rc-lx", (Math.random() * 8 - 4).toFixed(1) + "px");
    span.style.setProperty("--rc-ly", (-4 - Math.random() * 6).toFixed(1) + "px");
    span.style.setProperty("--rc-lr", (Math.random() * 8 - 4).toFixed(1) + "deg");
    span.style.setProperty("--rc-ldur", (1.1 + Math.random() * 1.2).toFixed(2) + "s");
    span.style.setProperty("--rc-ldelay", (Math.random() * 1.2).toFixed(2) + "s");
    el.appendChild(span);
  });
  _rcPartyFloatTargets.push({ el, original });
}
