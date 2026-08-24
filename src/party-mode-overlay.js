/* =========================================================
   PARTY MODE — standalone desktop overlay effects
   Runs inside a transparent, click-through, always-on-top window
   loaded per-display by main.js. No app UI to reference, no real
   input simulation, no discrete flashing — same rules as the in-app
   version in party-mode.js.

   The main process shows/hides this whole overlay by opening/closing
   the BrowserWindow, so this script just runs continuously from load
   until the window is destroyed. Escape is a global OS-level
   shortcut owned by main.js, not handled here.
   ========================================================= */

const params = new URLSearchParams(window.location.search);
const isPrimary = params.get("primary") === "1";

const RC_LETTER_KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const RC_POPUP_LINES = [
  "🏆 YOU'RE TODAY'S WINNER!",
  "⚠️ YOUR TIRES ARE 1 CLICK AWAY",
  "🔥 CONGRATULATIONS, PIT CREW",
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
// Local image/gif popups — drop files at these paths (relative to this
// overlay's folder, e.g. assets/party/party-1.gif) and they'll rotate
// in alongside the text popups. Missing files are skipped silently.
const RC_IMAGE_FILES = [
  "assets/party/party-1.gif",
  "assets/party/party-2.gif",
  "assets/party/party-3.gif",
  "assets/party/party-4.gif",
  "assets/party/party-5.gif",
  "assets/party/party-6.gif",
  "assets/party/party-7.png"
];
const RC_EDGE_LINES = ["👀 INCOMING", "🚧 CAUTION", "🎉 SURPRISE", "📣 HEADS UP", "🌀 CHAOS"];

const wash = document.getElementById("rc-wash");

// Only the primary display gets the badge, audio, keyflash, and
// alt-tab illusion — avoids duplicate sound and duplicate "centered"
// overlays across a multi-monitor setup. Every display gets the
// wash/shake/glitch/popups.
if (isPrimary) {
  const badge = document.createElement("div");
  badge.className = "rc-badge";
  badge.textContent = "🎉 PARTY MODE — Esc to stop";
  document.body.appendChild(badge);
}

function schedule(fn, minMs, maxMs) {
  const delay = minMs + Math.random() * (maxMs - minMs);
  setTimeout(() => { fn(); schedule(fn, minMs, maxMs); }, delay);
}

function appendWashAnim(name, rule) {
  wash.style.animation = wash.style.animation.replace(new RegExp(",?\\s*" + name + "[^,]*"), "");
  wash.style.animation += ", " + rule;
}
function removeWashAnim(name, rule) {
  wash.style.animation = wash.style.animation.replace(", " + rule, "");
}

function hueSpeedLoop() {
  const dur = (0.8 + Math.random() * 1.6).toFixed(2) + "s";
  wash.style.animationDuration = dur + ", 6s";
  setTimeout(hueSpeedLoop, 1800 + Math.random() * 2200);
}
hueSpeedLoop();

function motionTick() {
  const picks = ["rc-shake-v 0.5s ease-in-out", "rc-shake-h 0.5s ease-in-out", "rc-distort 0.6s ease-in-out"];
  const anim = picks[Math.floor(Math.random() * picks.length)];
  wash.style.animation = wash.style.animation.replace(/,\s*(rc-shake-v|rc-shake-h|rc-distort)[^,]*/, "") ;
  wash.style.animation += ", " + anim;
  const onEnd = (e) => {
    if (e.animationName !== anim.split(" ")[0]) return;
    wash.style.animation = wash.style.animation.replace(", " + anim, "");
    wash.removeEventListener("animationend", onEnd);
  };
  wash.addEventListener("animationend", onEnd);
}
schedule(motionTick, 650, 1600);

function glitchTick() {
  // Occasionally go big: bigger displacement plus a full-viewport
  // color surge, for the "more screen coverage" chaos beats. Still a
  // single smooth animation each — no repeating strobe.
  const big = Math.random() < 0.35;
  const animName = big ? "rc-glitch-big" : "rc-glitch";
  const anim = animName + " 0.35s linear";
  wash.style.animation += ", " + anim;
  const onEnd = (e) => {
    if (e.animationName !== animName) return;
    wash.style.animation = wash.style.animation.replace(", " + anim, "");
    wash.removeEventListener("animationend", onEnd);
  };
  wash.addEventListener("animationend", onEnd);

  if (big) {
    const surge = document.createElement("div");
    surge.className = "rc-wash-surge-el";
    surge.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:999996;background:linear-gradient(120deg,#ff2d55,#7c4dff,#3d8bff,#10e58a);background-size:300% 300%;opacity:0;animation:rc-wash-surge-flat 1.3s ease-in-out forwards;";
    document.body.appendChild(surge);
    setTimeout(() => surge.remove(), 1350);
  }
}
schedule(glitchTick, 1600, 4000);

function edgeIntrudeTick() {
  const edges = ["top", "bottom", "left", "right"];
  const edge = edges[Math.floor(Math.random() * edges.length)];
  const el = document.createElement("div");
  el.className = "rc-edge";
  el.textContent = RC_EDGE_LINES[Math.floor(Math.random() * RC_EDGE_LINES.length)];
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
  setTimeout(() => el.remove(), 1850);
}
schedule(edgeIntrudeTick, 2200, 5200);

if (isPrimary) {
  const cursor = document.createElement("div");
  cursor.className = "rc-cursor";
  cursor.textContent = "🖱️";
  cursor.style.left = "50%";
  cursor.style.top = "50%";
  document.body.appendChild(cursor);
  function decoyCursorTick() {
    const x = 5 + Math.random() * 90;
    const y = 5 + Math.random() * 90;
    cursor.style.left = x + "%";
    cursor.style.top = y + "%";
  }
  schedule(decoyCursorTick, 1100, 2800);
}

if (isPrimary) {
  let audioCtx = null;
  function soundTick() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      const types = ["sine", "square", "triangle", "sawtooth"];
      osc.type = types[Math.floor(Math.random() * types.length)];
      osc.frequency.value = 220 + Math.random() * 660;
      gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.06, audioCtx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.26);
    } catch { /* audio not available — skip silently */ }
  }
  schedule(soundTick, 1100, 3000);

  function keyflashTick() {
    const letter = RC_LETTER_KEYS[Math.floor(Math.random() * RC_LETTER_KEYS.length)];
    const el = document.createElement("div");
    el.className = "rc-keyflash";
    el.textContent = letter;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 750);
  }
  schedule(keyflashTick, 2000, 5500);

  function altTabTick() {
    const el = document.createElement("div");
    el.className = "rc-alttab";
    const icons = ["🏁", "🎮", "💬", "🌐", "🎉"];
    const activeIdx = Math.floor(Math.random() * icons.length);
    icons.forEach((icon, i) => {
      const tile = document.createElement("div");
      tile.className = "rc-alttab-tile" + (i === activeIdx ? " rc-active" : "");
      tile.textContent = icon;
      el.appendChild(tile);
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1150);
  }
  schedule(altTabTick, 6000, 14000);
}

// Every display gets popups. Randomly picks between a text line and a
// local image/gif (if any RC_IMAGE_FILES exist) — missing image files
// just fail their <img> silently and the popup closes itself.
// Popups stay on screen until closed by hand; MAX_POPUPS caps how many
// can pile up at once so a long session doesn't flood the DOM.
const MAX_POPUPS = 14;
let activePopups = [];

function popupTick() {
  if (activePopups.length >= MAX_POPUPS) {
    const oldest = activePopups.shift();
    oldest?.remove();
  }

  const el = document.createElement("div");
  const variant = ["", "rc-alt2", "rc-alt3"][Math.floor(Math.random() * 3)];
  el.className = "rc-popup " + variant;
  const maxLeft = Math.max(20, window.innerWidth - 270);
  const maxTop = Math.max(20, window.innerHeight - 170);
  el.style.left = (20 + Math.random() * maxLeft) + "px";
  el.style.top = (40 + Math.random() * maxTop) + "px";

  const useImage = RC_IMAGE_FILES.length && Math.random() < 0.4;
  const label = document.createElement("div");
  label.textContent = RC_POPUP_LINES[Math.floor(Math.random() * RC_POPUP_LINES.length)];
  el.appendChild(label);

  const removePopup = () => {
    el.remove();
    activePopups = activePopups.filter(p => p !== el);
    window.api?.setClickThrough?.(true);
  };

  if (useImage) {
    const img = document.createElement("img");
    img.src = RC_IMAGE_FILES[Math.floor(Math.random() * RC_IMAGE_FILES.length)];
    img.alt = "";
    img.onerror = removePopup;
    el.appendChild(img);
  }

  const closeBtn = document.createElement("button");
  closeBtn.className = "rc-popup-close";
  closeBtn.textContent = "✕";
  closeBtn.style.top = "6px";
  closeBtn.style.right = "6px";
  let dodges = 0;
  closeBtn.addEventListener("mouseenter", () => {
    if (dodges >= 2) return; // always closable after a couple of hops
    dodges++;
    closeBtn.style.top = (2 + Math.random() * 22) + "px";
    closeBtn.style.right = (2 + Math.random() * 22) + "px";
  });
  closeBtn.addEventListener("click", removePopup);
  el.appendChild(closeBtn);

  document.body.appendChild(el);
  activePopups.push(el);
  el.addEventListener("mouseenter", () => window.api?.setClickThrough?.(false));
  el.addEventListener("mouseleave", () => window.api?.setClickThrough?.(true));
}
schedule(popupTick, 2200, 6000);
