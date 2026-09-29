/* =========================================================================
   JARVIS — Created by IZHAR AFRIDI
   Android WebView voice engine  ·  "pulse listener" edition

   WHY THE OLD VERSIONS FROZE ON "LISTENING..."
   Android WebView's recognizer holds the microphone for the whole life of a
   continuous session and often never delivers a result or an 'end' event.
   The UI then waits forever.

   HOW THIS VERSION AVOIDS IT
   1. continuous = false, interimResults = false. Every session is one short,
      self-terminating "pulse" that ends by itself after one utterance.
   2. Exactly ONE recognizer instance exists at any time, and it is rebuilt
      for every pulse (reusing an instance across sessions is a known freeze).
   3. A pulse is restarted (300 ms) only after the previous one has ended:
      after a result, an error, 'nomatch', or a plain 'end'.
   4. The turn has an ABSOLUTE 8-second silence deadline that survives pulse
      restarts. If no speech is detected in 8 s the app goes back to IDLE with
      "Listening timed out. Tap Orb or say Hello Jarvis" and RELEASES the mic.
   5. Once speech is detected, a separate hang guard force-flushes a session
      that never returns a result.
   6. The mic is fully released while JARVIS thinks and speaks (no echo, no
      audio-focus fights), and a stuck-state watchdog guarantees the UI can
      never stay on THINKING/SPEAKING forever.
   ========================================================================= */

(function () {
  "use strict";

  /* ======================================================================
     CONFIG
     ====================================================================== */
  const CFG = {
    LISTEN_TIMEOUT_MS: 8000,        // absolute silence deadline per listening turn
    RESTART_DELAY_MS: 300,          // gap before the next recognition pulse
    SPEECH_HANG_MS: 20000,          // max time a session may run after speech started
    STOP_GRACE_MS: 2500,            // how long stop() gets to flush a pending result
    RESUME_SETTLE_MS: 450,          // pause after TTS so the mic never hears its tail
    CAPTURE_HOLD_MS: 600,           // keep "Captured: ..." readable before "Thinking"
    CHUNK_WATCHDOG_MS: 4500,        // TTS chunk that never starts is retried / skipped
    SPEAK_MAX_MS: 45000,            // hard cap for one spoken reply
    STUCK_MS: 75000,                // THINKING/SPEAKING longer than this = recover
    API_TIMEOUT_MS: 10000,          // per-provider request timeout
    API_TOTAL_MS: 30000,            // total time budget across all providers
    MAX_TOKENS: 700,
    MIC_PREFLIGHT_MS: 3500,
    PREFLIGHT_MIC_PERMISSION: true, // request+release mic via getUserMedia before the first pulse
    IDLE_WAKE_STANDBY: false,       // true = after a timeout keep single-shot wake-word pulses running
    LANG_PRIMARY: "en-US",
    LANG_FALLBACK: "ur-PK",
    OWNER_NAME: "Izhar",
  };

  /* Model IDs live in one place. On a 400/404 (model retired) the next ID in the list is tried
     automatically, and the one that worked is remembered.
     Verified against provider deprecation pages on 28 Sep 2026:
       - gemini-2.0-flash          shut down 1 Jun 2026
       - groq llama-3.3-70b-versatile  shut down 16 Aug 2026 (free/developer tier)
       - cohere command-r-plus alias   retired 15 Sep 2025                                   */
  const MODELS = {
    gemini: ["gemini-3.5-flash", "gemini-3.1-flash-lite"],
    groq: ["openai/gpt-oss-120b", "qwen/qwen3.6-27b", "llama-3.3-70b-versatile"],
    openrouter: ["openrouter/free", "meta-llama/llama-3.3-70b-instruct:free"],
    together: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "openai/gpt-oss-120b"],
    cohere: ["command-a-03-2025", "command-r-plus-08-2024"],
  };

  const State = { DORMANT: "dormant", LISTENING: "listening", THINKING: "thinking", SPEAKING: "speaking" };

  /* Exact texts requested for the SYSTEM box */
  const MSG = {
    MIC_ACTIVE: "Mic Active: Listening for your voice...",
    CAPTURED: (t) => "Captured: " + (t.length > 160 ? t.slice(0, 160) + "…" : t),
    THINKING: "JARVIS Thinking...",
    SPEAKING: "JARVIS Speaking...",
    TIMEOUT: "Listening timed out. Tap Orb or say Hello Jarvis",
    NO_KEY: "⚠️ No API Key saved. Tap Settings (⚙️) to enter key.",
    IDLE_HINT: "Tap the orb to start voice mode",
    STARTING: "Audio unlocked. Starting microphone...",
    MIC_DENIED: "🎤 Microphone blocked (not-allowed). Enable the Microphone permission for this app in Android Settings, then tap the orb.",
    SVC_DENIED: "🎤 Speech service not available (service-not-allowed). Make sure the Google app / speech services are enabled, then tap the orb.",
    NO_SR: "Speech recognition is not available in this WebView. Try Chrome, or check the app's microphone permission.",
    NET_ERR: "Speech service could not reach the network (error: network). Retrying...",
    AUDIO_CAPTURE: "Microphone busy or unavailable (error: audio-capture). Retrying...",
    NO_TTS: "Speech synthesis is not supported on this device.",
    NO_VOICE: "Voice output unavailable on this device - showing text only.",
    NO_KEY_SPOKEN: "API key missing. Please tap the settings gear and add a key.",
    NO_KEY_SPOKEN_UR: "API key nahi mili. Settings mein gear icon dabaa kar key add karein.",
  };

  const SHORT_STATUS = {
    [State.DORMANT]: "Tap orb to start voice mode",
    [State.LISTENING]: "Listening...",
    [State.THINKING]: "Thinking...",
    [State.SPEAKING]: "JARVIS Speaking...",
  };

  const WAKE_GREETING = "Assalamualaikum " + CFG.OWNER_NAME + "! How can I help you today?";

  /* ----------------------------- STATE ------------------------------- */
  const App = {
    audioUnlocked: false,
    active: false,          // voice mode is on (a conversation is in progress)
    starting: false,        // between the orb tap and the first recognition pulse
    state: State.DORMANT,
    stateSince: Date.now(),
    flow: 0,                // bumped on every new utterance / interrupt / stop; stale async work checks it
    keyMissing: false,
    conversation: [],
    lastLang: "en",
    apiKeys: { gemini: "", groq: "", openrouter: "", together: "", cohere: "" },
    providerOrder: ["gemini", "groq", "openrouter", "together", "cohere"],
    voicePref: "auto",
    rate: 1.0,
    pitch: 1.0,
    isOnline: navigator.onLine,
  };

  /* --------------------------- DOM REFS ------------------------------ */
  const $ = (id) => document.getElementById(id);
  const el = {
    orb: $("orb"),
    orbWrap: $("orbWrap"),
    statusLine: $("statusLine"),
    glass: $("glass"),
    gEmpty: $("gEmpty"),
    netStatus: $("netStatus"),
    netStatusText: $("netStatusText"),
    settingsBtn: $("settingsBtn"),
    settingsModal: $("settingsModal"),
    saveKeysBtn: $("saveKeysBtn"),
    clearKeysBtn: $("clearKeysBtn"),
    key_gemini: $("key_gemini"),
    key_groq: $("key_groq"),
    key_openrouter: $("key_openrouter"),
    key_together: $("key_together"),
    key_cohere: $("key_cohere"),
    voicePref: $("voicePref"),
    rateRange: $("rateRange"),
    pitchRange: $("pitchRange"),
    rateBadge: $("rateBadge"),
    pitchBadge: $("pitchBadge"),
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ============================================================
     PERSISTENCE
     ============================================================ */
  const EMPTY_KEYS = () => ({ gemini: "", groq: "", openrouter: "", together: "", cohere: "" });

  const Store = {
    load() {
      try {
        App.voicePref = localStorage.getItem("jarvis_voice_pref") || "auto";
        App.rate = parseFloat(localStorage.getItem("jarvis_rate")) || 1.0;
        App.pitch = parseFloat(localStorage.getItem("jarvis_pitch")) || 1.0;
      } catch (e) { console.warn("Store.load failed", e); }
      this.hasAnyKey();
    },
    save() {
      try {
        localStorage.setItem("jarvis_api_keys", JSON.stringify(App.apiKeys));
        localStorage.setItem("jarvis_voice_pref", App.voicePref);
        localStorage.setItem("jarvis_rate", String(App.rate));
        localStorage.setItem("jarvis_pitch", String(App.pitch));
      } catch (e) { console.warn("Store.save failed", e); }
    },
    clearKeys() {
      try { localStorage.removeItem("jarvis_api_keys"); } catch (e) { /* ignore */ }
      App.apiKeys = EMPTY_KEYS();
    },
    /* Always re-reads localStorage (the source of truth) before answering. */
    hasAnyKey() {
      let parsed = {};
      try {
        const raw = localStorage.getItem("jarvis_api_keys");
        if (raw) parsed = JSON.parse(raw) || {};
      } catch (e) { parsed = {}; }
      App.apiKeys = Object.assign(EMPTY_KEYS(), parsed);
      return App.providerOrder.some((p) => !!(App.apiKeys[p] && String(App.apiKeys[p]).trim()));
    },
  };

  function refreshKeyState() {
    App.keyMissing = !Store.hasAnyKey();
    System.render();
  }

  /* ============================================================
     VIEW: orb + status line, glass box, SYSTEM row
     ============================================================ */
  const View = {
    orb(state) {
      App.state = state;
      App.stateSince = Date.now();
      el.orb.className = "orb " + state;
      el.orbWrap.classList.toggle("active", state !== State.DORMANT);
      this.status(SHORT_STATUS[state]);
    },
    status(text) {
      if (el.statusLine.textContent === text) return;
      el.statusLine.textContent = text;
      el.statusLine.classList.remove("flash");
      void el.statusLine.offsetWidth; // restart the CSS animation
      el.statusLine.classList.add("flash");
    },
  };

  /* Glass box rows, always in this order:  SYSTEM  /  YOU  /  JARVIS */
  const Glass = {
    built: false,
    rows: {},
    build() {
      if (this.built) return;
      this.built = true;
      if (el.gEmpty && el.gEmpty.parentNode) el.gEmpty.remove();
      [["sys", "sys", "System"], ["you", "you", "You"], ["jarvis", "jarvis", "JARVIS"]].forEach((d) => {
        const row = document.createElement("div");
        row.className = "g-row " + d[1];
        const tag = document.createElement("span");
        tag.className = "g-tag";
        tag.textContent = d[2];
        const text = document.createElement("div");
        text.className = "g-text";
        row.appendChild(tag);
        row.appendChild(text);
        el.glass.appendChild(row);
        this.rows[d[0]] = { row: row, text: text };
      });
      this.rows.you.row.style.display = "none";
      this.rows.jarvis.row.style.display = "none";
    },
    _set(key, text) {
      this.build();
      const r = this.rows[key];
      r.text.textContent = text;
      r.row.style.display = text ? "" : "none";
    },
    setSys(text, kind) {
      this._set("sys", text);
      const color = kind === "error" ? "#ff8fa3" : kind === "warn" ? "#ffd27f" : "#9fe9f0";
      this.rows.sys.text.style.color = color;
      this.rows.sys.text.style.fontSize = "13px";
      this.rows.sys.text.style.fontStyle = "normal";
      el.glass.scrollTop = 0;
    },
    setYou(text) { this._set("you", text ? text : ""); },
    setJarvis(text) { this._set("jarvis", text ? text : ""); },
    clearTurn() { this.setYou(""); this.setJarvis(""); },
  };

  /* The SYSTEM row = main state line + optional diagnostic line + sticky API-key warning. */
  const System = {
    main: MSG.IDLE_HINT,
    kind: "info",
    detailText: "",
    set(text, kind) { this.main = text; this.kind = kind || "info"; this.render(); },
    detail(text) { this.detailText = text || ""; this.render(); },
    render() {
      const lines = [this.main];
      if (this.detailText) lines.push(this.detailText);
      if (App.keyMissing && this.main !== MSG.NO_KEY) lines.push(MSG.NO_KEY);
      const kind = App.keyMissing && this.kind === "info" ? "warn" : this.kind;
      Glass.setSys(lines.join("\n"), kind);
    },
  };

  function setNetStatus() {
    App.isOnline = navigator.onLine;
    el.netStatus.classList.toggle("online", App.isOnline);
    el.netStatusText.textContent = App.isOnline ? "ONLINE" : "OFFLINE";
  }
  window.addEventListener("online", () => { setNetStatus(); System.detail("Connection restored - AI engines available."); });
  window.addEventListener("offline", () => { setNetStatus(); System.detail("Offline - using local backup mode."); });

  /* ============================================================
     LANGUAGE DETECTION  (Urdu / Roman Urdu / English / Minglish)
     ============================================================ */
  const URDU_SCRIPT_RE = /[\u0600-\u06FF]/;
  const ROMAN_URDU_WORDS = new Set([
    "hai","hain","ho","hoon","hun","kya","kyun","kyu","kaisay","kaise","kaisa","kaisi","kaha","kahan",
    "acha","accha","achi","theek","thik","nahi","nahin","han","haan","mujhe","mujhy","mjhe","tum",
    "tumhara","tumhari","aap","ap","apka","aapka","aapki","mera","meri","mere","kar","karo","karna",
    "karein","kariye","raha","rahi","rahe","bhai","yaar","shukriya","mehrbani","salam","assalam",
    "walaikum","bata","batao","bataen","bolo","suno","chal","chalo","abhi","phir","wapis","wapas",
    "zindagi","dost","pyar","dil","waqt","paisay","paise","ghar","kaam","matlab","bilkul","zaroor",
    "shayad","lekin","magar","aur","ke","ki","ka","se","ko","mein","par","tha","thi","thay","gaya",
    "gayi","gaye","sikhao","sikhna","seekhna","samjhao","samjha","samajh","kuch","koi","sab","bohat",
    "bahut","zyada","kam","wala","wali","liye","liya","hoga","hogi","chahiye","chahte","chahta",
    "chahti","mujh","hum","humein","unko","usko","isko","yeh","yah","woh","wo","kaun","kab","kitna",
    "kitni","kitne","subah","raat","shaam","khana","paani","madad","dobara","ek","do","teen",
  ]);

  function detectLanguage(text) {
    if (!text) return "en";
    if (URDU_SCRIPT_RE.test(text)) return "ur";
    const words = text.toLowerCase().replace(/[^a-z\s']/g, " ").split(/\s+/).filter(Boolean);
    if (!words.length) return "en";
    let hits = 0;
    for (const w of words) if (ROMAN_URDU_WORDS.has(w)) hits++;
    return hits / words.length >= 0.25 || hits >= 3 ? "ur" : "en";
  }

  /* ============================================================
     WAKE WORD / SALAM / INTENTS
     ============================================================ */
  // Recognizers often mishear "Jarvis"; accept the usual variants.
  const WAKE_RE = /\b(jarvis|jarvish|jervis|javis|jarwis|jarves|garvis|jarvice|jarvi)\b/i;
  const WAKE_STRIP_RE = /\b(hello|hey|hi|ok|okay)?[\s,]*(jarvis|jarvish|jervis|javis|jarwis|jarves|garvis|jarvice|jarvi)\b[\s,.!?]*/ig;

  function hasWake(text) { return WAKE_RE.test(text) || /\b(hello|hey|hi)\s+service\b/i.test(text); }
  function stripWake(text) { return text.replace(WAKE_STRIP_RE, " ").replace(/\s+/g, " ").trim(); }
  function isSalamOnly(text) {
    const t = text.trim().toLowerCase();
    return t.split(/\s+/).length <= 5 && /^(assalam|assalamu|salam|walaikum|wa\s?alaikum|walekum|valaikum|w\.?\s?salam)/.test(t);
  }

  function openSite(url) {
    try {
      const w = window.open(url, "_blank");
      if (!w) window.location.href = url;
    } catch (e) { window.location.href = url; }
  }

  const INTENTS = [
    { re: /\bopen\s+(you\s?tube|youtube)\b|\byoutube\s+(kholo|khol\s?do|open)\b/i, url: "https://www.youtube.com", en: "Opening YouTube.", ur: "YouTube khol raha hoon." },
    { re: /\bopen\s+google\b|\bgoogle\s+(kholo|khol\s?do|open)\b/i, url: "https://www.google.com", en: "Opening Google.", ur: "Google khol raha hoon." },
    { re: /\bopen\s+gmail\b|\bgmail\s+(kholo|khol\s?do)\b/i, url: "https://mail.google.com", en: "Opening Gmail.", ur: "Gmail khol raha hoon." },
    { re: /\bopen\s+maps?\b|\bmaps?\s+(kholo|khol\s?do)\b/i, url: "https://maps.google.com", en: "Opening Google Maps.", ur: "Maps khol raha hoon." },
    { re: /\bopen\s+whats\s?app\b|\bwhats\s?app\s+(kholo|khol\s?do)\b/i, url: "https://web.whatsapp.com", en: "Opening WhatsApp.", ur: "WhatsApp khol raha hoon." },
    { re: /\bopen\s+facebook\b|\bfacebook\s+(kholo|khol\s?do)\b/i, url: "https://www.facebook.com", en: "Opening Facebook.", ur: "Facebook khol raha hoon." },
    { re: /\bwhat(?:'s| is)?\s+the\s+time\b|\bcurrent\s+time\b|\bwaqt\s+kya\b|\btime\s+kya\b/i, dynamic: "time" },
    { re: /\bwhat(?:'s| is)?\s+(the\s+|today'?s\s+)?date\b|\btareekh\b|\baaj\s+(ki\s+)?date\b/i, dynamic: "date" },
  ];
  function matchIntent(text) { return INTENTS.find((i) => i.re.test(text)) || null; }

  /* ============================================================
     SPEECH SYNTHESIS  (mobile-hardened; onEnd fires at most once)
     ============================================================ */
  const TTS = {
    voices: [],
    supported: "speechSynthesis" in window && "SpeechSynthesisUtterance" in window,
    token: 0,
    sess: null,

    loadVoices() {
      if (!this.supported) return;
      const v = window.speechSynthesis.getVoices();
      if (v && v.length) this.voices = v;
    },

    /* Prefers on-device (offline) voices so the greeting never waits on the network. */
    pickVoice(lang) {
      if (!this.voices.length) this.loadVoices();
      const V = this.voices;
      if (!V.length) return null;
      const order = lang === "ur"
        ? [/^ur/i, /^hi/i, /^en-IN/i, /^en-GB/i, /^en/i]
        : [/^en-GB/i, /^en-US/i, /^en-IN/i, /^en/i];
      for (const localOnly of [true, false]) {
        for (const re of order) {
          const v = V.find((x) => re.test((x.lang || "").replace("_", "-")) && (!localOnly || x.localService === true));
          if (v) return v;
        }
      }
      return V[0];
    },

    chunk(text) {
      const clean = String(text).replace(/[*_#`>~|]/g, " ").replace(/\s+/g, " ").trim();
      if (!clean) return [];
      const parts = clean.match(/[^.!?۔؟\n]+[.!?۔؟]*/g) || [clean];
      const out = [];
      let buf = "";
      for (const p of parts) {
        if ((buf + p).length > 160 && buf) { out.push(buf.trim()); buf = p; }
        else buf += p;
      }
      if (buf.trim()) out.push(buf.trim());
      const final = [];
      for (const c of out) {
        if (c.length <= 200) final.push(c);
        else for (let i = 0; i < c.length; i += 180) final.push(c.slice(i, i + 180));
      }
      return final;
    },

    /* Must run synchronously inside the orb tap (a user gesture). */
    unlock() {
      if (!this.supported) return false;
      try {
        window.speechSynthesis.cancel();
        this.loadVoices();
        const u = new SpeechSynthesisUtterance(".");
        u.volume = 0.01;
        u.rate = 2;
        const v = this.pickVoice("en");
        if (v) u.voice = v;
        window.speechSynthesis.speak(u);
        if (window.speechSynthesis.paused) window.speechSynthesis.resume();
        return true;
      } catch (e) {
        console.warn("TTS unlock failed", e);
        return false;
      }
    },

    stop() {
      this.token++;
      if (this.sess) { this.sess.clear(); this.sess = null; }
      try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    },

    /*
     * speak(text, lang, onStart, onEnd)
     * onEnd(ok) fires exactly once unless speech was superseded / stopped by a newer call.
     */
    speak(text, lang, onStart, onEnd) {
      // Supersede whatever is running. cancel() is only called when something is actually queued:
      // cancel()+speak() in the same tick can silently drop the new utterance on Chrome for Android.
      this.token++;
      if (this.sess) { this.sess.clear(); this.sess = null; }
      const token = this.token;
      const synth = window.speechSynthesis;

      const chunks = this.supported && App.audioUnlocked ? this.chunk(text) : [];
      if (!chunks.length) { setTimeout(() => { if (token === this.token && onEnd) onEnd(false); }, 0); return; }

      try { if (synth.speaking || synth.pending) synth.cancel(); } catch (e) { /* ignore */ }
      this.loadVoices();
      const voice = this.pickVoice(lang);

      let finished = false;
      let idx = 0;
      let started = false;
      const timers = new Set();
      let keepAlive = null;

      const later = (fn, ms) => {
        const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
        timers.add(t);
        return t;
      };
      const drop = (t) => { if (t) { clearTimeout(t); timers.delete(t); } };
      const clearAll = () => { timers.forEach(clearTimeout); timers.clear(); if (keepAlive) { clearInterval(keepAlive); keepAlive = null; } };
      const alive = () => token === this.token && !finished;
      const sess = { clear() { finished = true; clearAll(); } };
      this.sess = sess;

      const finish = (ok) => {
        if (finished) return;
        finished = true;
        clearAll();
        if (this.sess === sess) this.sess = null;
        if (token === this.token && onEnd) onEnd(ok);
      };

      // Chrome for Android sometimes leaves long speech paused
      keepAlive = setInterval(() => { if (alive() && synth.speaking && synth.paused) synth.resume(); }, 4000);
      later(() => { if (alive()) { try { synth.cancel(); } catch (e) { /* ignore */ } finish(started); } }, CFG.SPEAK_MAX_MS);

      const playNext = (retried) => {
        if (!alive()) return;
        if (idx >= chunks.length) { finish(true); return; }

        const u = new SpeechSynthesisUtterance(chunks[idx]);
        if (voice) u.voice = voice;
        u.lang = voice && voice.lang ? voice.lang : (lang === "ur" ? "ur-PK" : "en-US");
        u.rate = App.rate;
        u.pitch = App.pitch;
        u.volume = 1;

        let settled = false;
        let wd = null;
        const advance = () => { if (settled || !alive()) return; settled = true; drop(wd); idx++; playNext(false); };
        const markStarted = () => { if (!started) { started = true; if (alive() && onStart) onStart(); } };

        u.onstart = () => { drop(wd); markStarted(); };
        u.onend = advance;
        u.onerror = (ev) => {
          if (settled || !alive()) return;
          const err = ev && ev.error;
          if (err === "interrupted" || err === "canceled") return; // caused by our own cancel()
          if (!retried) {
            settled = true; drop(wd);
            try { synth.cancel(); } catch (e) { /* ignore */ }
            // one retry with the engine's default voice (some Android voices fail to load)
            const u2 = new SpeechSynthesisUtterance(chunks[idx]);
            u2.rate = App.rate; u2.pitch = App.pitch; u2.volume = 1;
            u2.onstart = markStarted;
            u2.onend = () => { if (alive()) { idx++; playNext(false); } };
            u2.onerror = () => { if (alive()) { idx++; playNext(false); } };
            try { synth.speak(u2); } catch (e) { idx++; playNext(false); }
          } else advance();
        };

        // The engine accepted the utterance but never started it -> retry once, then skip
        wd = later(() => {
          if (started || settled || !alive()) return;
          try { synth.cancel(); } catch (e) { /* ignore */ }
          if (!retried) { settled = true; playNext(true); } else advance();
        }, CFG.CHUNK_WATCHDOG_MS);

        try {
          if (synth.paused) synth.resume();
          synth.speak(u);
        } catch (e) { advance(); }
      };

      playNext(false);
    },
  };

  if (TTS.supported) {
    TTS.loadVoices();
    window.speechSynthesis.onvoiceschanged = () => TTS.loadVoices();
    let tries = 0;
    const poll = setInterval(() => {
      TTS.loadVoices();
      if (TTS.voices.length || ++tries > 20) clearInterval(poll);
    }, 400);
  }

  /* ============================================================
     MIC PERMISSION PRE-FLIGHT
     Asks Android for the mic through getUserMedia and RELEASES it at once.
     Holding the stream open would lock the mic against SpeechRecognition,
     which is exactly the freeze we are fixing, so every track is stopped.
     A failure here is reported but never blocks the recognizer.
     ============================================================ */
  const Mic = {
    preflight() {
      return new Promise((resolve) => {
        if (!CFG.PREFLIGHT_MIC_PERMISSION || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          resolve({ ok: true, skipped: true });
          return;
        }
        let settled = false;
        let timer = null;
        const done = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
        timer = setTimeout(() => done({ ok: false, name: "Timeout" }), CFG.MIC_PREFLIGHT_MS);
        let p;
        try { p = navigator.mediaDevices.getUserMedia({ audio: true }); }
        catch (e) { done({ ok: false, name: (e && e.name) || "Error" }); return; }
        p.then(
          (stream) => {
            // release even if the timeout already fired (late permission grant)
            try { stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
            done({ ok: true });
          },
          (e) => done({ ok: false, name: (e && e.name) || "Error" })
        );
      });
    },
  };

  /* ============================================================
     SPEECH RECOGNITION  -  pulse listener
     ------------------------------------------------------------
        beginTurn()
          ├─ arms the 8 s silence deadline (absolute, survives restarts)
          └─ startSession()  ──►  one recognition pulse
                                   ├─ result           → capture text, release mic, hand to Conversation
                                   ├─ end/error/nomatch → wait 300 ms → next pulse (deadline still ticking)
                                   └─ speech started   → deadline cancelled, hang guard armed
          deadline fires → stop() flushes any pending result, else IDLE + timeout message
     ============================================================ */
  const Listener = {
    supported: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
    rec: null,
    gen: 0,                 // generation id: events from a destroyed session are ignored
    running: false,
    sessionOver: false,     // 'error' and 'end' both fire for one failure; handle only the first
    turnActive: false,
    standby: false,
    fatal: false,
    langIdx: 0,             // 0 = en-US, 1 = ur-PK
    emptyCount: 0,
    speechDetected: false,
    gotResult: false,
    deadlineFired: false,
    restartPending: false,
    deadlineTimer: null,
    hangTimer: null,
    graceTimer: null,
    restartTimer: null,

    lang() { return this.langIdx === 0 ? CFG.LANG_PRIMARY : CFG.LANG_FALLBACK; },

    clearTimers() {
      clearTimeout(this.deadlineTimer);
      clearTimeout(this.hangTimer);
      clearTimeout(this.graceTimer);
      clearTimeout(this.restartTimer);
      this.restartPending = false;
    },

    /* Kill the live instance so none of its late events can reach us. */
    destroySession() {
      this.gen++;
      const r = this.rec;
      this.rec = null;
      this.running = false;
      if (r) {
        r.onstart = r.onresult = r.onerror = r.onend = r.onnomatch = r.onspeechstart = r.onaudiostart = null;
        try { r.abort(); } catch (e) { /* ignore */ }
      }
    },

    stopAll() {
      this.clearTimers();
      this.destroySession();
      this.turnActive = false;
      this.standby = false;
    },

    beginTurn() {
      if (!App.active || this.fatal) return;
      this.stopAll();
      this.turnActive = true;
      this.langIdx = 0;
      this.emptyCount = 0;
      this.speechDetected = false;
      this.gotResult = false;
      this.deadlineFired = false;
      View.orb(State.LISTENING);
      System.set(MSG.MIC_ACTIVE);
      this.armDeadline();
      this.startSession();
    },

    startStandby() {
      this.stopAll();
      this.standby = true;
      this.langIdx = 0;
      this.emptyCount = 0;
      this.gotResult = false;
      this.startSession();
    },

    armDeadline() {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = setTimeout(() => this.onDeadline(), CFG.LISTEN_TIMEOUT_MS);
    },

    startSession() {
      if (!this.turnActive && !this.standby) return;
      if (this.running) return;                  // one pulse at a time
      this.destroySession();                     // always start from a fresh instance
      this.restartPending = false;
      try {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        const rec = new SR();
        const myGen = ++this.gen;
        const stale = () => myGen !== this.gen;

        rec.continuous = false;        // REQUIRED: continuous mode locks the mic in Android WebView
        rec.interimResults = false;    // REQUIRED: only final results are delivered
        rec.maxAlternatives = 1;
        rec.lang = this.lang();

        rec.onstart = () => { if (stale()) return; this.running = true; };
        rec.onspeechstart = () => {
          if (stale()) return;
          this.speechDetected = true;
          clearTimeout(this.deadlineTimer);           // the user is talking: silence deadline no longer applies
          clearTimeout(this.hangTimer);
          this.hangTimer = setTimeout(() => this.onHang(myGen), CFG.SPEECH_HANG_MS);
        };
        rec.onresult = (ev) => { if (stale()) return; this.onResult(ev); };
        rec.onnomatch = () => { if (stale()) return; this.endSession("nomatch"); };
        rec.onerror = (ev) => { if (stale()) return; this.onError(ev); };
        rec.onend = () => { if (stale()) return; this.endSession("end"); };

        this.rec = rec;
        this.sessionOver = false;
        rec.start();
      } catch (e) {
        console.warn("[JARVIS] recognition start failed:", e);
        this.destroySession();
        this.scheduleRestart(CFG.RESTART_DELAY_MS * 3);
      }
    },

    onResult(ev) {
      let text = "";
      for (let i = ev.resultIndex || 0; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r && r.isFinal !== false) text += " " + ((r[0] && r[0].transcript) || "");
      }
      text = text.replace(/\s+/g, " ").trim();
      if (!text) return;

      if (this.standby) {
        if (!hasWake(text)) return;                   // session end restarts the standby pulse
        this.stopAll();
        App.active = true;
        App.starting = false;
        refreshKeyState();
        onCaptured(text);
        return;
      }

      if (!this.turnActive || this.gotResult) return;
      this.gotResult = true;
      this.clearTimers();
      this.destroySession();                          // release the mic BEFORE anything else happens
      this.turnActive = false;
      onCaptured(text);
    },

    onError(ev) {
      const err = (ev && ev.error) || "unknown";
      console.warn("[JARVIS] recognition error:", err);

      if (err === "not-allowed" || err === "service-not-allowed") {
        this.fatal = true;
        goIdle(err === "not-allowed" ? MSG.MIC_DENIED : MSG.SVC_DENIED, "error");
        return;
      }
      if (err === "language-not-supported") {
        this.langIdx = this.langIdx === 0 ? 1 : 0;     // instant en-US <-> ur-PK fallback
        this.emptyCount = -1;                          // endSession() counts this pulse as empty; net effect 0
        this.endSession("error:" + err, 50);
        return;
      }
      if (err === "network") System.detail(MSG.NET_ERR);
      else if (err === "audio-capture") System.detail(MSG.AUDIO_CAPTURE);
      this.endSession("error:" + err);
    },

    /* A pulse finished for any reason without a usable result. */
    endSession(reason, delay) {
      if (this.sessionOver) return;
      this.sessionOver = true;
      this.running = false;
      clearTimeout(this.hangTimer);
      if (this.gotResult) return;                      // the result flow owns what happens next
      if (!this.turnActive && !this.standby) return;

      if (this.deadlineFired) { timeoutToIdle(); return; }   // stop() at the deadline flushed nothing

      if (!this.speechDetected) {
        this.emptyCount++;
        if (this.emptyCount >= 2) {                    // two silent pulses on one language -> try the other
          this.langIdx = this.langIdx === 0 ? 1 : 0;
          this.emptyCount = 0;
        }
      } else {
        this.speechDetected = false;                   // sound but no words: give a fresh silence window
        if (this.turnActive) this.armDeadline();
      }
      this.scheduleRestart(delay == null ? CFG.RESTART_DELAY_MS : delay);
    },

    scheduleRestart(delay) {
      clearTimeout(this.restartTimer);
      if (!this.turnActive && !this.standby) return;
      this.restartPending = true;
      this.restartTimer = setTimeout(() => { this.restartPending = false; this.startSession(); }, delay);
    },

    /* 8 s without any speech. stop() (not abort) lets a late, in-flight result still arrive. */
    onDeadline() {
      if (!this.turnActive || this.gotResult || this.speechDetected) return;
      this.deadlineFired = true;
      if (this.rec && this.running) {
        try { this.rec.stop(); } catch (e) { /* ignore */ }
        this.graceTimer = setTimeout(() => {
          if (!this.gotResult && this.turnActive) timeoutToIdle();
        }, CFG.STOP_GRACE_MS);
      } else {
        timeoutToIdle();
      }
    },

    /* Speech began but the engine never produced a result. */
    onHang(g) {
      if (g !== this.gen || !this.turnActive || this.gotResult) return;
      console.warn("[JARVIS] recognition hung after speech start - flushing");
      try { if (this.rec) this.rec.stop(); } catch (e) { /* ignore */ }
      this.graceTimer = setTimeout(() => {
        if (g !== this.gen || this.gotResult || !this.turnActive) return;
        this.destroySession();
        this.speechDetected = false;
        this.armDeadline();
        this.scheduleRestart(CFG.RESTART_DELAY_MS);
      }, CFG.STOP_GRACE_MS);
    },
  };

  /* ============================================================
     IDLE / SESSION END
     ============================================================ */
  function goIdle(message, kind) {
    Listener.stopAll();
    TTS.stop();
    App.active = false;
    App.starting = false;
    App.flow++;
    View.orb(State.DORMANT);
    System.set(message || MSG.IDLE_HINT, kind || "info");
  }

  function timeoutToIdle() {
    goIdle(MSG.TIMEOUT, "warn");
    if (CFG.IDLE_WAKE_STANDBY && Listener.supported && !Listener.fatal) Listener.startStandby();
  }

  /* ============================================================
     OFFLINE BACKUP BANK
     ============================================================ */
  const Offline = {
    debate: [
      "Should social media be banned for children under sixteen?",
      "Is artificial intelligence a threat to human jobs?",
      "Should university education be free for everyone?",
      "Is nuclear energy the best answer to climate change?",
      "Should exams be replaced by continuous assessment?",
      "Is a four-day work week better for productivity?",
    ],
    grammar: {
      tense: "Present simple: I work. Present continuous: I am working. Present perfect: I have worked. Past simple: I worked. Past continuous: I was working. Past perfect: I had worked. Future simple: I will work.",
      modal: "Modal verbs are can, could, may, might, must, shall, should, will and would. They show ability, permission, possibility or obligation. For example: You must submit the form by Friday.",
      passive: "Passive voice uses object plus be plus past participle. Active: The chef cooked the meal. Passive: The meal was cooked by the chef.",
      conditional: "Zero conditional: If you heat water, it boils. First: If it rains, I will stay home. Second: If I had money, I would travel. Third: If I had studied, I would have passed.",
    },
    practice: [
      "Describe your morning routine using at least three different tenses.",
      "Give a one minute talk on why reading matters, using two modal verbs.",
      "Rewrite in passive voice: The manager approved the project.",
      "Make a second conditional sentence about your dream job.",
    ],
    roleplay: {
      interview: "Let's practise a job interview. First question: Tell me about yourself.",
      doctor: "Let's practise a doctor visit. I am the doctor. Good morning, what seems to be the problem today?",
      shop: "Let's practise shopping. I am the shopkeeper. Welcome! What are you looking for today?",
    },
    pick(a) { return a[Math.floor(Math.random() * a.length)]; },

    respond(text, lang) {
      const t = text.toLowerCase();
      const ur = lang === "ur";
      if (/debate/.test(t)) {
        const topic = this.pick(this.debate);
        return ur ? `Offline mode mein debate topic yeh hai: ${topic} Aap for ya against side chunein.`
                  : `Here is a debate topic: ${topic} Choose for or against, and I will help you build your points.`;
      }
      if (/tense/.test(t)) return this.grammar.tense;
      if (/modal/.test(t)) return this.grammar.modal;
      if (/passive/.test(t)) return this.grammar.passive;
      if (/conditional/.test(t)) return this.grammar.conditional;
      if (/interview/.test(t)) return this.roleplay.interview;
      if (/doctor/.test(t)) return this.roleplay.doctor;
      if (/shop/.test(t)) return this.roleplay.shop;
      if (/practice|practise|exercise|prompt/.test(t)) {
        const p = this.pick(this.practice);
        return ur ? `Practice ke liye yeh try karein: ${p}` : `Try this practice task: ${p}`;
      }
      return ur
        ? "Abhi internet ya AI service available nahi, is liye main offline mode mein hoon. Mujh se debate topic, grammar rules jaise tenses, modals, passive voice, conditionals, ya role play practice maang sakte hain."
        : "I am in offline backup mode right now. Ask me for a debate topic, a grammar rule like tenses, modals, passive voice or conditionals, or a role play practice.";
    },
  };

  const GRAMMAR_PATTERNS = [
    { re: /\bi is\b/i, fix: "I am", rule: "Use 'am' with the subject 'I'." },
    { re: /\b(he|she|it) are\b/i, fix: "$1 is", rule: "Use 'is' with he, she and it." },
    { re: /\b(he|she|it) (don't|dont)\b/i, fix: "$1 doesn't", rule: "Use 'doesn't' with he, she and it." },
    { re: /\bi has\b/i, fix: "I have", rule: "Use 'have' with 'I'." },
    { re: /\bmore better\b/i, fix: "better", rule: "'Better' is already comparative." },
    { re: /\bcan able to\b/i, fix: "can", rule: "'Can' already means able to." },
    { re: /\bi am agree\b/i, fix: "I agree", rule: "'Agree' is a verb, so no 'am'." },
    { re: /\bdiscuss about\b/i, fix: "discuss", rule: "'Discuss' takes a direct object, so drop 'about'." },
  ];
  function grammarHint(text) {
    for (const g of GRAMMAR_PATTERNS) {
      if (g.re.test(text)) {
        const fixed = g.fix ? text.replace(g.re, g.fix) : null;
        return `Possible grammar slip detected. Rule: ${g.rule}${fixed ? ` Suggested: "${fixed}"` : ""}`;
      }
    }
    return null;
  }

  /* ============================================================
     SYSTEM PROMPT + HISTORY
     ============================================================ */
  function buildSystemPrompt() {
    return (
      "You are JARVIS, a voice-first AI assistant created by IZHAR AFRIDI. Everything you write is read aloud by text-to-speech, " +
      "so keep replies natural and conversational, usually 2 to 4 short sentences, with no markdown, no asterisks, no bullet symbols, no emojis, and no long lists. " +
      "Be warm, respectful and confident. Do NOT ask for the user's name unless they explicitly ask you to. " +
      "LANGUAGE RULE: if the user speaks Urdu or Roman Urdu, reply naturally in Roman Urdu (Urdu written in English letters). " +
      "If the user mixes Urdu and English (Minglish), mirror that mix. If the user speaks English, reply in fluent, clear English. " +
      "You fully understand Pakistani English accents and phrasing. " +
      "ENGLISH COACH MODE: you are a complete English learning teacher from beginner to advanced. " +
      "When the user makes a grammar mistake, correct it politely, explain the rule in one short sentence, then give the improved sentence. " +
      "You can teach tenses, modal verbs, passive voice and conditionals step by step, giving one small exercise at a time and waiting for the answer. " +
      "You can run interactive role plays such as a job interview, a doctor visit, a shopkeeper conversation, or a classroom debate: play your part, stay in character, ask one question at a time, and give brief feedback. " +
      "You can generate structured debate arguments (opening, two or three points, rebuttal, conclusion), public speaking tips, vocabulary lists spoken as short phrases, and presentation outlines. " +
      "If a hidden system note about a grammar slip is included, use it to coach the user gently. " +
      "If asked about yourself, say you were created by IZHAR AFRIDI."
    );
  }

  function remember(role, content, lang) {
    App.conversation.push({ role: role, content: content, lang: lang });
    if (App.conversation.length > 40) App.conversation = App.conversation.slice(-40);
  }

  /* Last 12 turns, starting with a user turn, roles alternating (some APIs reject anything else). */
  function historyForLLM() {
    const out = [];
    for (const m of App.conversation.slice(-12)) {
      const role = m.role === "user" ? "user" : "assistant";
      if (!out.length && role !== "user") continue;
      if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += "\n" + m.content;
      else out.push({ role: role, content: m.content });
    }
    return out;
  }

  /* ============================================================
     PROVIDERS  (5 engines, sequential auto-failover)
     ============================================================ */
  function fail(provider, res) {
    const e = new Error(`${provider} ${res ? res.status : "network"}`);
    e.provider = provider;
    e.status = res ? res.status : 0;
    return e;
  }

  /* fetch + timeout + status check + JSON parse, in one place. */
  async function fetchJSON(provider, url, options) {
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (ctl) { try { ctl.abort(); } catch (e) { /* ignore */ } }
        reject(fail(provider, null));
      }, CFG.API_TIMEOUT_MS);
    });
    try {
      const opts = ctl ? Object.assign({}, options, { signal: ctl.signal }) : options;
      const res = await Promise.race([fetch(url, opts), timeout]);
      if (!res.ok) throw fail(provider, res);
      return await Promise.race([res.json(), timeout]);
    } catch (e) {
      if (e && e.provider) throw e;
      throw fail(provider, null);            // network error, CORS, abort
    } finally {
      clearTimeout(timer);
    }
  }

  /* Try the provider's model list in order; only "model gone / bad model" errors move to the next ID. */
  const modelIdx = {};
  async function withModels(provider, run) {
    const list = MODELS[provider];
    const first = modelIdx[provider] || 0;
    let lastErr = null;
    for (let n = 0; n < list.length; n++) {
      const idx = (first + n) % list.length;
      try {
        const out = await run(list[idx]);
        modelIdx[provider] = idx;
        return out;
      } catch (e) {
        lastErr = e;
        if (!(e && (e.status === 400 || e.status === 404))) throw e;
      }
    }
    throw lastErr;
  }

  function cleanReply(t) {
    return String(t || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  }

  async function openaiChat(provider, url, headers, model, sys, history, userText, extra) {
    const body = Object.assign({
      model: model,
      messages: [{ role: "system", content: sys }].concat(history, [{ role: "user", content: userText }]),
      temperature: 0.8,
      max_tokens: CFG.MAX_TOKENS,
    }, extra || {});
    const data = await fetchJSON(provider, url, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, headers),
      body: JSON.stringify(body),
    });
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    const text = cleanReply(msg && msg.content);
    if (!text) throw fail(provider, { status: 204 });
    return text;
  }

  const Providers = {
    gemini(key, sys, history, userText) {
      return withModels("gemini", async (model) => {
        const contents = history.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
        contents.push({ role: "user", parts: [{ text: userText }] });
        const data = await fetchJSON("gemini", `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: sys }] },
            contents: contents,
            generationConfig: { temperature: 0.8, maxOutputTokens: CFG.MAX_TOKENS + 300 },
          }),
        });
        const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
        const text = cleanReply(parts ? parts.map((p) => p.text || "").join(" ") : "");
        if (!text) throw fail("gemini", { status: 204 });
        return text;
      });
    },

    groq(key, sys, history, userText) {
      return withModels("groq", (model) =>
        openaiChat("groq", "https://api.groq.com/openai/v1/chat/completions", { Authorization: `Bearer ${key}` },
          model, sys, history, userText, /gpt-oss/i.test(model) ? { reasoning_effort: "low" } : {}));
    },

    openrouter(key, sys, history, userText) {
      return withModels("openrouter", (model) =>
        openaiChat("openrouter", "https://openrouter.ai/api/v1/chat/completions", {
          Authorization: `Bearer ${key}`,
          "HTTP-Referer": location.origin && location.origin !== "null" ? location.origin : "https://jarvis.local",
          "X-Title": "JARVIS by IZHAR AFRIDI",
        }, model, sys, history, userText));
    },

    together(key, sys, history, userText) {
      return withModels("together", (model) =>
        openaiChat("together", "https://api.together.xyz/v1/chat/completions", { Authorization: `Bearer ${key}` },
          model, sys, history, userText));
    },

    cohere(key, sys, history, userText) {
      return withModels("cohere", async (model) => {
        const data = await fetchJSON("cohere", "https://api.cohere.com/v2/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: model,
            messages: [{ role: "system", content: sys }].concat(history, [{ role: "user", content: userText }]),
            temperature: 0.8,
            max_tokens: CFG.MAX_TOKENS,
          }),
        });
        const c = data && data.message && data.message.content;
        const text = cleanReply(Array.isArray(c) ? c.map((p) => p.text || "").join(" ") : (typeof c === "string" ? c : ""));
        if (!text) throw fail("cohere", { status: 204 });
        return text;
      });
    },
  };

  let providerCursor = 0;

  /* Returns { text, provider }, or null if the user interrupted while it was running. */
  async function askAI(userText, lang, history, flow) {
    const configured = App.providerOrder.filter((p) => App.apiKeys[p] && String(App.apiKeys[p]).trim());
    const hist = history.slice();
    while (hist.length && hist[hist.length - 1].role === "user") hist.pop(); // drop an unanswered dangling turn
    const sys = buildSystemPrompt();
    const n = configured.length;
    const start = providerCursor % n;
    const t0 = Date.now();

    for (let k = 0; k < n; k++) {
      if (flow !== App.flow) return null;
      if (Date.now() - t0 > CFG.API_TOTAL_MS) break;
      const provider = configured[(start + k) % n];
      try {
        const text = await Providers[provider](String(App.apiKeys[provider]).trim(), sys, hist, userText);
        providerCursor = (start + k) % n;
        return { text: text, provider: provider };
      } catch (err) {
        const code = err && err.status;
        console.warn(`[JARVIS] ${provider} failed`, code, err);
        providerCursor = (start + k + 1) % n;
        if (flow === App.flow) System.detail(`${provider.toUpperCase()} ${code === 429 ? "quota reached" : "unavailable (" + (code || "network") + ")"} - switching engine...`);
      }
    }

    return {
      text: (lang === "ur"
        ? "Tamam AI engines abhi jawab nahi de rahe. Offline mode se madad kar raha hoon. "
        : "All AI engines are unavailable right now, so I am switching to offline mode. ") + Offline.respond(userText, lang),
      provider: "offline",
    };
  }

  /* ============================================================
     CONVERSATION FLOW
     ============================================================ */

  /* Speak a reply, show its text, then (by default) go back to listening. */
  function speakReply(text, lang, opts) {
    opts = opts || {};
    const flow = opts.flow != null ? opts.flow : App.flow;
    if (flow !== App.flow) return;
    const speakLang = App.voicePref === "auto" ? lang : App.voicePref;
    Glass.setJarvis(text);
    if (opts.remember !== false) remember("assistant", text, lang);

    let started = false;
    TTS.speak(
      text,
      speakLang,
      () => {
        started = true;
        if (flow !== App.flow) return;
        View.orb(State.SPEAKING);
        System.set(MSG.SPEAKING);
      },
      (ok) => {
        if (flow !== App.flow) return;
        if (!ok && !started) System.detail(MSG.NO_VOICE);
        if (!App.active) return;
        if (opts.next) opts.next(); else resumeListening(flow);
      }
    );
  }

  function resumeListening(flow) {
    setTimeout(() => { if (flow === App.flow && App.active) Listener.beginTurn(); }, CFG.RESUME_SETTLE_MS);
  }

  /* A final transcript arrived. The mic is already released at this point. */
  function onCaptured(text) {
    const flow = ++App.flow;
    const lang = detectLanguage(text);
    App.lastLang = lang;
    try {
      System.detail("");
      Glass.setYou(text);
      Glass.setJarvis("");
      System.set(MSG.CAPTURED(text));
      View.orb(State.THINKING);

      if (hasWake(text)) { wakeFlow(text, flow); return; }
      if (isSalamOnly(text)) {
        speakReply(lang === "ur" ? "Walaikum Assalam! Bataiye, main aap ki kya madad kar sakta hoon?" : "Walaikum Assalam! How can I help you?", lang, { flow: flow, remember: false });
        return;
      }
      routeFlow(text, lang, flow).catch((err) => flowFailed(err, text, lang, flow));
    } catch (err) {
      flowFailed(err, text, lang, flow);
    }
  }

  function flowFailed(err, text, lang, flow) {
    console.error("[JARVIS] flow error", err);
    if (flow !== App.flow) return;
    speakReply(Offline.respond(text, lang), lang, { flow: flow });
  }

  /* "Hello Jarvis" / "Hey Jarvis" / "Jarvis": INSTANT local greeting, no API involved. */
  function wakeFlow(text, flow) {
    const rest = stripWake(text);
    const greetingOnly = rest.length < 3 || /^(hello|hey|hi|ok|okay|assalam\w*|salam|walaikum\s*assalam)$/i.test(rest);
    speakReply(WAKE_GREETING, "en", {
      flow: flow,
      next: greetingOnly ? null : () => {
        routeFlow(rest, detectLanguage(rest), flow).catch((err) => flowFailed(err, rest, detectLanguage(rest), flow));
      },
    });
  }

  async function routeFlow(text, lang, flow) {
    const history = historyForLLM();          // taken BEFORE this turn is remembered
    remember("user", text, lang);

    const intent = matchIntent(text);
    if (intent) {
      if (intent.dynamic === "time") {
        const t = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        speakReply(lang === "ur" ? `Abhi waqt hai ${t}.` : `The time is ${t}.`, lang, { flow: flow });
        return;
      }
      if (intent.dynamic === "date") {
        const d = new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
        speakReply(lang === "ur" ? `Aaj ki tareekh hai ${d}.` : `Today is ${d}.`, lang, { flow: flow });
        return;
      }
      speakReply(lang === "ur" ? intent.ur : intent.en, lang, {
        flow: flow,
        next: () => { openSite(intent.url); resumeListening(flow); },
      });
      return;
    }

    if (!navigator.onLine) {
      speakReply(Offline.respond(text, lang), lang, { flow: flow });
      return;
    }

    // API failsafe: check localStorage BEFORE any request is fired
    if (!Store.hasAnyKey()) {
      App.keyMissing = true;
      System.set(MSG.NO_KEY, "warn");
      speakReply(lang === "ur" ? MSG.NO_KEY_SPOKEN_UR : MSG.NO_KEY_SPOKEN, lang, {
        flow: flow,
        remember: false,
        next: () => goIdle(MSG.NO_KEY, "warn"),
      });
      return;
    }
    App.keyMissing = false;

    const hint = grammarHint(text);
    const prompt = hint ? `${text}\n\n[Hidden coaching note, do not read aloud verbatim: ${hint}]` : text;

    const pending = askAI(prompt, lang, history, flow);   // starts now, in parallel with the capture hold
    await sleep(CFG.CAPTURE_HOLD_MS);                     // keep "Captured: ..." readable
    if (flow !== App.flow) return;
    View.orb(State.THINKING);
    System.set(MSG.THINKING);

    const result = await pending;
    if (flow !== App.flow || !result) return;
    speakReply(result.text, lang, { flow: flow });
  }

  /* ============================================================
     ORB TAP  ->  unlock audio + start / interrupt / stop
     ============================================================ */
  function activate() {
    if (App.active || App.starting) return;

    // 1) unlock speech synthesis synchronously, inside the tap gesture
    TTS.unlock();
    App.audioUnlocked = true;

    Listener.fatal = false;
    App.active = true;
    App.starting = true;
    const flow = ++App.flow;
    refreshKeyState();
    Glass.clearTurn();
    System.detail("");

    if (!Listener.supported) { goIdle(MSG.NO_SR, "error"); return; }

    View.orb(State.LISTENING);
    System.set(MSG.STARTING);

    // 2) ask for the mic permission and release it immediately, then start the first pulse
    Mic.preflight().then((res) => {
      if (flow !== App.flow || !App.active) return;
      App.starting = false;
      if (!res.ok) System.detail(`Mic permission check failed (${res.name}). Trying the recognizer anyway...`);
      setTimeout(() => { if (flow === App.flow && App.active) Listener.beginTurn(); }, 300);
    });
  }

  function interrupt() {
    App.flow++;
    TTS.stop();
    Listener.stopAll();
    Listener.beginTurn();
  }

  el.orbWrap.addEventListener("click", () => {
    if (App.starting) return;
    if (!App.active) { activate(); return; }
    if (App.state === State.LISTENING) { goIdle(MSG.IDLE_HINT); return; }   // tap while listening = stop
    interrupt();                                                            // tap while thinking/speaking = interrupt
  });

  /* Release the mic whenever the app leaves the foreground. */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      Listener.stopAll();
      TTS.stop();
      if (App.active) goIdle(MSG.IDLE_HINT);
    }
  });

  /* Watchdog: the UI can never sit on THINKING / SPEAKING forever. */
  setInterval(() => {
    if (App.active && (App.state === State.THINKING || App.state === State.SPEAKING) &&
        Date.now() - App.stateSince > CFG.STUCK_MS) {
      console.warn("[JARVIS] stuck state detected - recovering");
      App.flow++;
      TTS.stop();
      Listener.beginTurn();
      System.detail("Recovered from a stalled reply.");
    }
  }, 5000);

  /* ============================================================
     SETTINGS MODAL
     ============================================================ */
  el.settingsBtn.addEventListener("click", () => {
    if (App.active) goIdle(MSG.IDLE_HINT);      // release the mic while the keyboard is up
    Listener.stopAll();
    Store.hasAnyKey();
    el.key_gemini.value = App.apiKeys.gemini || "";
    el.key_groq.value = App.apiKeys.groq || "";
    el.key_openrouter.value = App.apiKeys.openrouter || "";
    el.key_together.value = App.apiKeys.together || "";
    el.key_cohere.value = App.apiKeys.cohere || "";
    el.voicePref.value = App.voicePref;
    el.rateRange.value = App.rate;
    el.pitchRange.value = App.pitch;
    el.rateBadge.textContent = Number(App.rate).toFixed(2);
    el.pitchBadge.textContent = Number(App.pitch).toFixed(2);
    el.settingsModal.classList.add("show");
  });
  el.rateRange.addEventListener("input", () => { el.rateBadge.textContent = Number(el.rateRange.value).toFixed(2); });
  el.pitchRange.addEventListener("input", () => { el.pitchBadge.textContent = Number(el.pitchRange.value).toFixed(2); });
  el.settingsModal.addEventListener("click", (e) => { if (e.target === el.settingsModal) el.settingsModal.classList.remove("show"); });

  el.saveKeysBtn.addEventListener("click", () => {
    App.apiKeys.gemini = el.key_gemini.value.trim();
    App.apiKeys.groq = el.key_groq.value.trim();
    App.apiKeys.openrouter = el.key_openrouter.value.trim();
    App.apiKeys.together = el.key_together.value.trim();
    App.apiKeys.cohere = el.key_cohere.value.trim();
    App.voicePref = el.voicePref.value;
    App.rate = parseFloat(el.rateRange.value) || 1.0;
    App.pitch = parseFloat(el.pitchRange.value) || 1.0;
    providerCursor = 0;
    Store.save();
    el.settingsModal.classList.remove("show");
    refreshKeyState();
    System.set(App.keyMissing ? MSG.NO_KEY : MSG.IDLE_HINT, App.keyMissing ? "warn" : "info");
  });

  el.clearKeysBtn.addEventListener("click", () => {
    Store.clearKeys();
    ["gemini", "groq", "openrouter", "together", "cohere"].forEach((k) => { el["key_" + k].value = ""; });
    refreshKeyState();
    System.set(MSG.NO_KEY, "warn");
  });

  /* ============================================================
     BOOT
     ============================================================ */
  function init() {
    Store.load();
    setNetStatus();
    View.orb(State.DORMANT);
    refreshKeyState();
    System.set(MSG.IDLE_HINT);
    if (!TTS.supported) System.detail(MSG.NO_TTS);
    if (!Listener.supported) System.detail(MSG.NO_SR);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
