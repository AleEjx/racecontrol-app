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
  "🚨 SUSPICIOUSLY FAST LAP DETECTED"
];

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
schedule(motionTick, 1000, 2400);

function glitchTick() {
  const anim = "rc-glitch 0.35s linear";
  wash.style.animation += ", " + anim;
  const onEnd = (e) => {
    if (e.animationName !== "rc-glitch") return;
    wash.style.animation = wash.style.animation.replace(", " + anim, "");
    wash.removeEventListener("animationend", onEnd);
  };
  wash.addEventListener("animationend", onEnd);
}
schedule(glitchTick, 2800, 6500);

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
  schedule(soundTick, 1500, 4000);

  function keyflashTick() {
    const letter = RC_LETTER_KEYS[Math.floor(Math.random() * RC_LETTER_KEYS.length)];
    const el = document.createElement("div");
    el.className = "rc-keyflash";
    el.textContent = letter;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 750);
  }
  schedule(keyflashTick, 3200, 8500);

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
  schedule(altTabTick, 9500, 21000);
}

// Every display gets popups.
function popupTick() {
  const el = document.createElement("div");
  const variant = ["", "rc-alt2", "rc-alt3"][Math.floor(Math.random() * 3)];
  el.className = "rc-popup " + variant;
  const maxLeft = Math.max(20, window.innerWidth - 270);
  const maxTop = Math.max(20, window.innerHeight - 170);
  el.style.left = (20 + Math.random() * maxLeft) + "px";
  el.style.top = (40 + Math.random() * maxTop) + "px";
  el.textContent = RC_POPUP_LINES[Math.floor(Math.random() * RC_POPUP_LINES.length)];

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
  closeBtn.addEventListener("click", () => { el.remove(); window.api?.setClickThrough?.(true); });
  el.appendChild(closeBtn);

  document.body.appendChild(el);
  el.addEventListener("mouseenter", () => window.api?.setClickThrough?.(false));
  el.addEventListener("mouseleave", () => window.api?.setClickThrough?.(true));
  setTimeout(() => { el.remove(); window.api?.setClickThrough?.(true); }, 6000);
}
schedule(popupTick, 4200, 11000);
