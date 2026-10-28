(function () {
  "use strict";
  console.log("[SessionWatcher] v1 - proactive session check + settings scroll fix");

  var SESSION_CHECK_MS = 60000;
  var SOON_MS = 30 * 60 * 1000; // warn when < 30 min left, before it expires
  var bannerShownFor = ""; // "" | "expired" | "soon" — toast only once per state
  var fetchWrapped = false;

  function getApiBase() {
    try { if (typeof window.apiUrl === "string" && window.apiUrl) return window.apiUrl; } catch (e) {}
    try { if (typeof apiUrl === "string" && apiUrl) return apiUrl; } catch (e) {}
    return "";
  }
  function getUser() {
    try { if (typeof window.user !== "undefined" && window.user) return window.user; } catch (e) {}
    try { if (typeof user !== "undefined" && user) return user; } catch (e) {}
    return null;
  }
  function isLoginScreen() {
    var el = document.getElementById("screen-login");
    return !!(el && el.classList.contains("active"));
  }
  function toast(msg, kind) {
    try { if (typeof showToast === "function") { showToast(msg, kind || "err"); return; } } catch (e) {}
    try { if (typeof showAppNotification === "function") showAppNotification(msg, kind || "err"); } catch (e) {}
  }

  // ── Global banner (all screens, not just driver/marshal) ─────────────
  function ensureBanner() {
    var existing = document.getElementById("rc-global-session-banner");
    if (existing) return existing;
    var style = document.createElement("style");
    style.id = "rc-session-watcher-css";
    style.textContent = [
      "html, body { overflow-x: hidden !important; max-width: 100vw !important; }",
      ".screen { width: 100% !important; max-width: 100vw !important; overflow-x: hidden !important; box-sizing: border-box !important; }",
      "#screen-settings .scroll-body { overflow-x: hidden !important; }",
      "#settings-tabs-row { overscroll-behavior-x: contain !important; }",
      ".stab-panel, .s-card { max-width: 100% !important; min-width: 0 !important; box-sizing: border-box !important; }",
      ".stab-panel input, .stab-panel select, .stab-panel button { max-width: 100% !important; }",
      "#rc-global-session-banner { display: none; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 14px; background: rgba(255,160,0,0.14); border-bottom: 1px solid rgba(255,160,0,0.4); color: #ffa000; font-family: 'Oxanium', sans-serif; font-size: 12px; font-weight: 700; letter-spacing: 0.2px; position: relative; z-index: 900; }",
      "#rc-global-session-banner a { color: #ffd54f; text-decoration: underline; cursor: pointer; white-space: nowrap; font-weight: 800; }",
      "#rc-global-session-banner a:hover { color: #fff; }",
      "#rc-global-session-banner.soon { background: rgba(255,193,7,0.10); }",
    ].join("\n");
    document.head.appendChild(style);

    var banner = document.createElement("div");
    banner.id = "rc-global-session-banner";
    banner.innerHTML =
      '<span id="rc-session-banner-text"></span>' +
      '<a id="rc-session-banner-link">Re-login in Settings → Account →</a>';
    var titlebar = document.querySelector(".titlebar");
    if (titlebar && titlebar.parentNode) {
      titlebar.parentNode.insertBefore(banner, titlebar.nextSibling);
    } else {
      document.body.insertBefore(banner, document.body.firstChild);
    }
    document.getElementById("rc-session-banner-link").addEventListener("click", function (e) {
      e.preventDefault();
      goToReLoginSafe();
    });
    return banner;
  }

  function goToReLoginSafe() {
    try {
      if (typeof goToReLogin === "function") { goToReLogin(); return; }
    } catch (e) {}
    try {
      if (typeof switchPanel === "function") switchPanel("settings");
      if (typeof openSettingsTab === "function") openSettingsTab("account");
    } catch (e) {}
  }

  function showBanner(mode) {
    if (isLoginScreen()) return;
    var banner = ensureBanner();
    var textEl = document.getElementById("rc-session-banner-text");
    if (mode === "soon") {
      if (textEl) textEl.textContent = "⏰ Your session expires soon — re-login before you lose race data.";
      banner.classList.add("soon");
    } else {
      if (textEl) textEl.textContent = "⚠️ Your session has expired — you may lose race data.";
      banner.classList.remove("soon");
    }
    banner.style.display = "flex";
    if (bannerShownFor !== mode) {
      bannerShownFor = mode;
      toast(
        mode === "soon"
          ? "⏰ Session expires soon — re-login in Settings → Account"
          : "⚠️ Session expired — re-login in Settings → Account",
        "err"
      );
    }
  }
  function hideBanner() {
    var banner = document.getElementById("rc-global-session-banner");
    if (banner) banner.style.display = "none";
    bannerShownFor = "";
  }

  // ── Proactive check ───────────────────────────────────────────────────
  async function checkSession() {
    if (isLoginScreen()) return;
    var u = getUser();
    var base = getApiBase();
    if (!u || !base) return;
    if (!u.token) {
      if (document.getElementById("screen-driver")?.classList.contains("active") ||
          document.getElementById("screen-marshal")?.classList.contains("active")) {
        showBanner("expired");
      }
      return;
    }
    try {
      var res = await fetch(base + "/session/status", {
        cache: "no-store",
        headers: { "x-discord-id": u.id, "x-discord-token": u.token },
      });
      if (res.status === 401) { showBanner("expired"); return; }
      if (!res.ok) return; // bot unreachable etc. is NOT session expiry
      var data = await res.json().catch(function () { return {}; });
      var remaining = typeof data.msRemaining === "number" ? data.msRemaining : null;
      if (remaining !== null && remaining < SOON_MS) {
        showBanner("soon");
      } else {
        hideBanner();
      }
    } catch (e) {
      return;
    }
  }

  // ── Fetch wrapper: any 401 session error, from any action, shows it ───
  function wrapFetch() {
    if (fetchWrapped || typeof window.fetch !== "function") return;
    fetchWrapped = true;
    var origFetch = window.fetch;
    window.fetch = async function () {
      var res = await origFetch.apply(this, arguments);
      try {
        var url = "";
        if (typeof arguments[0] === "string") url = arguments[0];
        else if (arguments[0] && arguments[0].url) url = arguments[0].url;
        var base = getApiBase();
        if (res && res.status === 401 && base && url.indexOf(base) === 0 &&
            url.indexOf("/session/status") === -1 && url.indexOf("/auth") === -1 &&
            !isLoginScreen() && getUser()) {
          var clone = null;
          try { clone = res.clone(); } catch (e) {}
          if (clone) {
            var data = await clone.json().catch(function () { return {}; });
            var msg = String(data.error || "");
            if (/session|expired|not logged|invalid/i.test(msg) || msg === "") {
              showBanner("expired");
            }
          } else {
            showBanner("expired");
          }
        }
      } catch (e) {}
      return res;
    };
  }

  // ── Settings sizing fix: scroll ONLY the tab row ──────────────────────
  function patchSettingsScroll() {
    // Replace openSettingsTab with a version that does NOT call
    // scrollIntoView({ inline: "center" }) on the button. That call
    // scrolls every scrollable ancestor, which is what shoved the
    // whole app left when Account (the last tab) was clicked.
    try {
      window.openSettingsTab = function (tab) {
        document.querySelectorAll(".stab").forEach(function (b) {
          b.classList.toggle("active", b.dataset.tab === tab);
        });
        document.querySelectorAll(".stab-panel").forEach(function (p) {
          p.classList.toggle("active", p.id === "stab-" + tab);
        });
        var row = document.getElementById("settings-tabs-row");
        var activeBtn = document.querySelector('.stab[data-tab="' + tab + '"]');
        if (row && activeBtn) {
          var target = activeBtn.offsetLeft - (row.clientWidth - activeBtn.offsetWidth) / 2;
          row.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
        }
        try { if (typeof syncSettingsTabsScrollSlider === "function") syncSettingsTabsScrollSlider(); } catch (e) {}
        try { if (typeof positionSettingsTabIndicator === "function") positionSettingsTabIndicator(); } catch (e) {}
        try {
          requestAnimationFrame(function () {
            try { if (typeof syncSettingsTabsScrollSlider === "function") syncSettingsTabsScrollSlider(); } catch (e) {}
            try { if (typeof positionSettingsTabIndicator === "function") positionSettingsTabIndicator(); } catch (e) {}
          });
        } catch (e) {}
      };
    } catch (e) {}

    // goToReLogin: same horizontal-shift guard for the Re-Login button.
    try {
      var origGoTo = window.goToReLogin;
      if (typeof origGoTo === "function" && !window._rcGoToPatched) {
        window._rcGoToPatched = true;
        window.goToReLogin = function () {
          try { if (typeof switchPanel === "function") switchPanel("settings"); } catch (e) {}
          try { if (typeof openSettingsTab === "function") openSettingsTab("account"); } catch (e) {}
          setTimeout(function () {
            var btn = document.querySelector('[onclick="reLogin()"]');
            if (!btn) return;
            // inline:"nearest" = never shove the page sideways.
            btn.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
            btn.classList.add("relogin-highlight");
            setTimeout(function () { btn.classList.remove("relogin-highlight"); }, 2200);
          }, 160);
        };
      }
    } catch (e) {}
  }

  // ── Start ─────────────────────────────────────────────────────────────
  ensureBanner();
  patchSettingsScroll();
  wrapFetch();
  setTimeout(checkSession, 5000);
  setTimeout(checkSession, 15000);
  setInterval(checkSession, SESSION_CHECK_MS);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") checkSession();
  });
  window.addEventListener("focus", function () { checkSession(); });

  window.SessionWatcher = {
    version: "1",
    checkSession: checkSession,
    showBanner: showBanner,
    hideBanner: hideBanner,
  };
})();
