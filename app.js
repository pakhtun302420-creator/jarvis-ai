/* =========================================================================
   JARVIS — Created by IZHAR AFRIDI
   Android WebView-hardened voice engine.

   RECOGNITION DESIGN (why it no longer freezes)
   - continuous = false, interimResults = true: each recognition session is a
     short, self-terminating "one utterance" session. Android WebView delivers
     these reliably, whereas continuous mode often hangs silently.
   - A supervisor loop restarts the session 300ms after 'end' / 'error' /
     'nomatch'. Only ONE session may exist at a time (start guard + generation
     counter), which removes the abort()->start() InvalidStateError race.
   - Language falls back en-US -> ur-PK instantly when a session yields nothing
     or the engine rejects the language.
   - Every session has a hard timeout so a hung engine can never leave the UI
     stuck on "LISTENING".
   - The mic is stopped while JARVIS speaks (no echo) and a TTS watchdog
     guarantees the mic always comes back.
   ========================================================================= */

(function () {
  "use strict";

  /* ----------------------------- CONSTANTS --------------------------- */
  const RESTART_DELAY_MS = 300;       // requested graceful restart delay
  const SESSION_TIMEOUT_MS = 12000;   // hard cap: a hung recognition session is force-restarted
  const SPEAK_MAX_MS = 45000;         // TTS watchdog: never stay in "speaking" forever
  const LANG_PRIMARY = "en-US";
  const LANG_FALLBACK = "ur-PK";
  const OWNER_NAME = "Izhar";

  const State = { DORMANT: "dormant", LISTENING: "listening", THINKING: "thinking", SPEAKING: "speaking" };

  const STATUS = {
    IDLE: "Tap orb to start voice mode",
    MIC: "Mic Active - Speak Now",
    PROCESSING: "Processing Voice...",
    SPEAKING: "JARVIS Speaking...",
    NO_KEY: "API Key Missing - Click Settings (⚙️)",
    MIC_BLOCKED: "Microphone blocked - allow mic access",
    UNLOCKED: "AUDIO UNLOCKED & LISTENING",
  };

  /* ----------------------------- STATE ------------------------------- */
  const App = {
    audioUnlocked: false,
    voiceMode: false,       // user turned voice mode on (mic supervisor should keep running)
    state: State.DORMANT,
    awake: false,
    awaitingSalamReply: false,
    awaitingWellbeingReply: false,
    busy: false,            // true from "final transcript accepted" until JARVIS finished replying
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

  /* ============================================================
     PERSISTENCE
     ============================================================ */
  const Store = {
    load() {
      try {
        const raw = localStorage.getItem("jarvis_api_keys");
        if (raw) App.apiKeys = Object.assign(App.apiKeys, JSON.parse(raw));
        App.voicePref = localStorage.getItem("jarvis_voice_pref") || "auto";
        App.rate = parseFloat(localStorage.getItem("jarvis_rate")) || 1.0;
        App.pitch = parseFloat(localStorage.getItem("jarvis_pitch")) || 1.0;
      } catch (e) { console.warn("Store.load failed", e); }
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
      App.apiKeys = { gemini: "", groq: "", openrouter: "", together: "", cohere: "" };
    },
    /* Re-read straight from localStorage so a key saved in another moment is never missed */
    hasAnyKey() {
      try {
        const raw = localStorage.getItem("jarvis_api_keys");
        if (raw) {
          const parsed = JSON.parse(raw);
          App.apiKeys = Object.assign(App.apiKeys, parsed);
        }
      } catch (e) { /* ignore */ }
      return App.providerOrder.some((p) => !!(App.apiKeys[p] && String(App.apiKeys[p]).trim()));
    },
  };

  /* ============================================================
     UI HELPERS  (status line + glass "system" box)
     ============================================================ */
  let statusLockUntil = 0; // while now < this, passive listening updates don't overwrite the status text

  function setStatus(text) {
    if (el.statusLine.textContent === text) return;
    el.statusLine.textContent = text;
    el.statusLine.classList.remove("flash");
    void el.statusLine.offsetWidth; // restart CSS animation
    el.statusLine.classList.add("flash");
  }

  /* lockMs > 0 pins a message so quick passive updates (recognition onstart) can't clobber it */
  function setOrb(state, statusText, lockMs) {
    App.state = state;
    el.orb.className = "orb " + state;
    el.orbWrap.classList.toggle("active", state !== State.DORMANT);
    const defaults = {
      [State.DORMANT]: STATUS.IDLE,
      [State.LISTENING]: STATUS.MIC,
      [State.THINKING]: STATUS.PROCESSING,
      [State.SPEAKING]: STATUS.SPEAKING,
    };
    const now = Date.now();
    if (statusText) {
      statusLockUntil = lockMs ? now + lockMs : 0;
      setStatus(statusText);
    } else if (now >= statusLockUntil || state === State.SPEAKING || state === State.THINKING) {
      statusLockUntil = 0;
      setStatus(defaults[state]);
    }
    // else: a lock is active -> keep the pinned message, only the orb animation changes
    updateKeyBanner();
  }

  /*
   * Persistent warning: when no API key exists, keep it visible in the SYSTEM row of the glass box
   * for as long as we are idle/listening, so it can't be missed. Never interrupts speaking/thinking.
   */
  function updateKeyBanner() {
    if (App.state === State.LISTENING || App.state === State.DORMANT) {
      if (!Store.hasAnyKey()) Glass.sys(STATUS.NO_KEY);
    }
  }

  /*
   * Glass box rows:
   *   LIVE   - real-time recognised speech (proves the mic is hearing you)
   *   YOU    - the accepted final transcript
   *   JARVIS - the reply text
   *   SYSTEM - notices / errors
   */
  const Glass = {
    rows: {},
    _clearEmpty() { if (el.gEmpty && el.gEmpty.parentNode) el.gEmpty.remove(); },
    _row(key, cls, tag) {
      if (this.rows[key]) return this.rows[key];
      this._clearEmpty();
      const row = document.createElement("div");
      row.className = "g-row " + cls;
      const t = document.createElement("span"); t.className = "g-tag"; t.textContent = tag;
      const x = document.createElement("div"); x.className = "g-text";
      row.appendChild(t); row.appendChild(x);
      el.glass.appendChild(row);
      this.rows[key] = row;
      return row;
    },
    _set(key, cls, tag, text, interim) {
      const row = this._row(key, cls, tag);
      row.classList.toggle("interim", !!interim);
      row.querySelector(".g-text").textContent = text;
      el.glass.scrollTop = el.glass.scrollHeight;
    },
    live(text) { this._set("live", "you interim", "Live Transcript", text, true); },
    you(text) { this.drop("live"); this._set("you", "you", "You", text, false); },
    jarvis(text) { this._set("jarvis", "jarvis", "JARVIS", text, false); },
    sys(text) { this._set("sys", "sys", "System", text, false); },
    drop(key) {
      const r = this.rows[key];
      if (r) { r.remove(); delete this.rows[key]; }
    },
    newTurn() {
      el.glass.innerHTML = "";
      this.rows = {};
    },
  };

  function setNetStatus() {
    App.isOnline = navigator.onLine;
    el.netStatus.classList.toggle("online", App.isOnline);
    el.netStatusText.textContent = App.isOnline ? "ONLINE" : "OFFLINE";
  }
  window.addEventListener("online", () => { setNetStatus(); Glass.sys("Connection restored - AI engines available."); });
  window.addEventListener("offline", () => { setNetStatus(); Glass.sys("Offline - using local backup mode."); });

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
  // Recogniser frequently mishears "Jarvis"; accept the common variants.
  const WAKE_RE = /\b(jarvis|jarvish|jervis|javis|jarwis|jarves|garvis|jarvice|service\s+jarvis)\b/i;
  const WAKE_STRIP_RE = /\b(hello|hey|hi|ok|okay)?[\s,]*(jarvis|jarvish|jervis|javis|jarwis|jarves|garvis|jarvice)\b[\s,.!?]*/ig;

  function hasWake(text) {
    return WAKE_RE.test(text) || /\b(hello|hey|hi)\s+(service|jar\s?vis|jar\s?wiss)\b/i.test(text);
  }
  function stripWake(text) { return text.replace(WAKE_STRIP_RE, " ").replace(/\s+/g, " ").trim(); }
  function isSalamReply(text) {
    return /(walaikum|wa\s?alaikum|walekum|valaikum|alaikum|w\.?\s?salam|salam|assalam|assalamu)/i.test(text);
  }

  function openSite(url) {
    try { window.open(url, "_blank"); } catch (e) { window.location.href = url; }
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
     SPEECH SYNTHESIS  (mobile-hardened, with watchdog)
     ============================================================ */
  const TTS = {
    voices: [],
    supported: "speechSynthesis" in window && "SpeechSynthesisUtterance" in window,
    token: 0,

    loadVoices() {
      if (!this.supported) return;
      const v = window.speechSynthesis.getVoices();
      if (v && v.length) this.voices = v;
    },

    pickVoice(lang) {
      if (!this.voices.length) this.loadVoices();
      const V = this.voices;
      if (!V.length) return null;
      const by = (re) => V.find((v) => re.test((v.lang || "").replace("_", "-")));
      if (lang === "ur") return by(/^ur/i) || by(/^hi/i) || by(/^en-IN/i) || by(/^en-GB/i) || by(/^en/i) || V[0];
      return by(/^en-GB/i) || by(/^en-US/i) || by(/^en-IN/i) || by(/^en/i) || V[0];
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

    /* MUST run synchronously inside the orb tap (user gesture) */
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
      try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    },

    /*
     * speak(text, lang, onStart, onEnd)
     * onEnd(ok) is GUARANTEED to fire exactly once (watchdog), so the mic can never stay dead.
     */
    speak(text, lang, onStart, onEnd) {
      let ended = false;
      const done = (ok) => { if (ended) return; ended = true; if (onEnd) onEnd(ok); };

      if (!this.supported || !App.audioUnlocked) { done(false); return; }
      const chunks = this.chunk(text);
      if (!chunks.length) { done(true); return; }

      const token = ++this.token;
      const synth = window.speechSynthesis;
      try { synth.cancel(); } catch (e) { /* ignore */ }
      this.loadVoices();
      const voice = this.pickVoice(lang);
      let idx = 0;
      let started = false;

      const overall = setTimeout(() => {
        try { synth.cancel(); } catch (e) { /* ignore */ }
        clearInterval(keepAlive);
        done(started);
      }, SPEAK_MAX_MS);

      const keepAlive = setInterval(() => {
        if (token !== this.token) { clearInterval(keepAlive); return; }
        if (synth.speaking && synth.paused) synth.resume();
      }, 4000);

      const finish = (ok) => {
        clearTimeout(overall);
        clearInterval(keepAlive);
        if (token !== this.token) return; // superseded/stopped -> caller handles state
        done(ok);
      };

      const next = (retried) => {
        if (token !== this.token) { clearTimeout(overall); clearInterval(keepAlive); return; }
        if (idx >= chunks.length) { finish(true); return; }

        const u = new SpeechSynthesisUtterance(chunks[idx]);
        if (voice) u.voice = voice;
        u.lang = voice && voice.lang ? voice.lang : (lang === "ur" ? "ur-PK" : "en-US");
        u.rate = App.rate;
        u.pitch = App.pitch;
        u.volume = 1;

        let settled = false;
        let watchdog = null;
        const advance = () => { if (settled) return; settled = true; clearTimeout(watchdog); idx++; next(false); };

        u.onstart = () => {
          clearTimeout(watchdog);
          if (!started) { started = true; if (onStart) onStart(); }
        };
        u.onend = advance;
        u.onerror = (ev) => {
          if (settled) return;
          const err = ev && ev.error;
          if (err === "interrupted" || err === "canceled") { settled = true; clearTimeout(watchdog); return; }
          if (!retried) {
            settled = true; clearTimeout(watchdog);
            try { synth.cancel(); } catch (e) { /* ignore */ }
            const u2 = new SpeechSynthesisUtterance(chunks[idx]);
            u2.rate = App.rate; u2.pitch = App.pitch; u2.volume = 1;
            u2.onstart = () => { if (!started) { started = true; if (onStart) onStart(); } };
            u2.onend = () => { idx++; next(false); };
            u2.onerror = () => { idx++; next(false); };
            try { synth.speak(u2); } catch (e) { idx++; next(false); }
          } else advance();
        };

        // Engine silently dropped it -> retry once, then skip the chunk
        watchdog = setTimeout(() => {
          if (!started && !settled) {
            try { synth.cancel(); } catch (e) { /* ignore */ }
            if (!retried) { settled = true; next(true); } else advance();
          }
        }, 4500);

        try {
          if (synth.paused) synth.resume();
          synth.speak(u);
        } catch (e) { advance(); }
      };

      next(false);
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

  /*
   * Speak a reply. Stops the mic first (no echo), shows text, then hands control
   * back to the listener. `after` runs once speech is finished (or failed).
   */
  function speakReply(text, lang, after) {
    const speakLang = App.voicePref === "auto" ? lang : App.voicePref;
    Glass.jarvis(text);
    App.conversation.push({ role: "assistant", content: text, lang });
    if (App.conversation.length > 40) App.conversation = App.conversation.slice(-40);

    Listener.pause();
    setOrb(State.THINKING, STATUS.PROCESSING);

    let started = false;
    TTS.speak(
      text,
      speakLang,
      () => { started = true; setOrb(State.SPEAKING, STATUS.SPEAKING); },
      (ok) => {
        App.busy = false;
        if (!ok && !started) Glass.sys("Voice output unavailable on this device - showing text only.");
        if (after) { try { after(); } catch (e) { console.warn(e); } }
        // settle delay so the mic does not catch the audio tail
        setTimeout(() => Listener.resume(), 450);
      }
    );
  }

  /* ============================================================
     SPEECH RECOGNITION  -  one-shot sessions + supervisor loop
     ============================================================
     State machine:
        idle ──start()──► starting ──onstart──► running ──onend/onerror/nomatch/timeout──► idle
                                                                        │
                                                    Listener schedules restart (300ms)
     Invariants:
        * at most ONE SpeechRecognition instance alive (Listener.rec)
        * every session is tagged with a generation id; events from old sessions are ignored
        * a hard timeout kills sessions that hang without firing any event
  */
  const Listener = {
    supported: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
    rec: null,
    gen: 0,                 // generation counter for stale-event protection
    running: false,
    paused: false,          // true while JARVIS is speaking/thinking
    langIndex: 0,           // 0 = en-US, 1 = ur-PK
    emptySessions: 0,       // consecutive sessions with no speech at all
    heardThisSession: false,
    sessionTimer: null,
    restartTimer: null,
    restartPending: false,  // true only while a restart timeout is genuinely queued
    permissionDenied: false,

    currentLang() { return this.langIndex === 0 ? LANG_PRIMARY : LANG_FALLBACK; },

    /* Kill any live instance without letting its late events affect us */
    _destroy() {
      this.gen++; // invalidate old handlers
      clearTimeout(this.sessionTimer);
      const r = this.rec;
      this.rec = null;
      this.running = false;
      if (r) {
        r.onstart = r.onresult = r.onerror = r.onend = r.onnomatch = r.onspeechstart = r.onaudiostart = null;
        try { r.abort(); } catch (e) { /* ignore */ }
      }
    },

    _create() {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      const rec = new SR();
      const myGen = ++this.gen;

      rec.continuous = false;      // REQUIRED for Android WebView stability
      rec.interimResults = true;   // live transcript
      rec.maxAlternatives = 1;
      rec.lang = this.currentLang();

      const stale = () => myGen !== this.gen;

      rec.onaudiostart = () => { if (stale()) return; /* mic hardware opened */ };

      rec.onstart = () => {
        if (stale()) return;
        this.running = true;
        this.heardThisSession = false;
        if (App.voiceMode && !this.paused && !App.busy) setOrb(State.LISTENING);
      };

      rec.onspeechstart = () => { if (stale()) return; this.heardThisSession = true; };

      rec.onresult = (event) => {
        if (stale() || this.paused || App.busy) return;
        this.heardThisSession = true;
        this.emptySessions = 0;

        let interim = "";
        let finalText = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const r = event.results[i];
          const t = (r[0] && r[0].transcript) || "";
          if (r.isFinal) finalText += t; else interim += t;
        }

        const live = (finalText || interim).trim();
        if (live) {
          Glass.live(live);                       // real-time proof the mic hears you
          // instant wake word: react on the FIRST interim that contains it
          if (!App.awake && !App.busy && hasWake(live)) {
            triggerWake(live, /*fromInterim*/ !finalText.trim());
            return;
          }
        }
        if (finalText.trim()) handleFinal(finalText.trim());
      };

      rec.onnomatch = () => {
        if (stale()) return;
        this.onSessionOver("nomatch");
      };

      rec.onerror = (ev) => {
        if (stale()) return;
        const err = ev && ev.error ? ev.error : "unknown";
        console.warn("[JARVIS] recognition error:", err);

        if (err === "not-allowed" || err === "service-not-allowed") {
          this.permissionDenied = true;
          App.voiceMode = false;
          this._destroy();
          setOrb(State.DORMANT, STATUS.MIC_BLOCKED);
          Glass.sys("Microphone permission denied. Grant microphone access to this app, then tap the orb again.");
          return;
        }
        if (err === "language-not-supported") {
          // instant fallback en-US <-> ur-PK
          this.langIndex = this.langIndex === 0 ? 1 : 0;
        }
        if (err === "network") {
          Glass.sys("Speech service unreachable - retrying...");
        }
        // 'no-speech', 'aborted', 'audio-capture', 'network': onend follows; also handled here for safety
        this.onSessionOver(err);
      };

      rec.onend = () => {
        if (stale()) return;
        this.onSessionOver("end");
      };

      return rec;
    },

    /* A session ended for any reason -> decide language + schedule restart in 300ms */
    onSessionOver(reason) {
      // Both 'error' and 'end' fire for one failed session; only handle the first one.
      if (this.restartPending) return;
      clearTimeout(this.sessionTimer);
      this.running = false;

      if (!this.heardThisSession && (reason === "end" || reason === "no-speech" || reason === "nomatch")) {
        this.emptySessions++;
        // en-US heard nothing twice in a row -> try ur-PK, then flip back if that is empty too
        if (this.emptySessions >= 2) {
          this.langIndex = this.langIndex === 0 ? 1 : 0;
          this.emptySessions = 0;
        }
      }
      this.scheduleRestart(RESTART_DELAY_MS);
    },

    scheduleRestart(delay) {
      clearTimeout(this.restartTimer);
      this.restartPending = false;
      if (!App.voiceMode || this.paused || this.permissionDenied) return;
      this.restartPending = true;
      this.restartTimer = setTimeout(() => {
        this.restartPending = false;
        this.start();
      }, delay);
    },

    start() {
      if (!this.supported || !App.voiceMode || this.paused || this.permissionDenied) return;
      if (App.busy) return;
      if (this.running && this.rec) return;      // one session at a time

      // Always build a fresh instance: reusing one across sessions is a classic WebView freeze
      this._destroy();
      try {
        this.rec = this._create();
        this.rec.start();
      } catch (e) {
        console.warn("[JARVIS] recognition start failed:", e);
        this._destroy();
        this.scheduleRestart(RESTART_DELAY_MS * 2);
        return;
      }

      // Hard timeout: if the engine never fires end/error, kill and restart
      clearTimeout(this.sessionTimer);
      const g = this.gen;
      this.sessionTimer = setTimeout(() => {
        if (g !== this.gen) return;
        console.warn("[JARVIS] recognition session timed out - restarting");
        this._destroy();
        this.scheduleRestart(RESTART_DELAY_MS);
      }, SESSION_TIMEOUT_MS);
    },

    stop() {
      clearTimeout(this.restartTimer);
      this.restartPending = false;
      this._destroy();
    },

    /* JARVIS is about to talk / think: silence the mic completely */
    pause() {
      this.paused = true;
      clearTimeout(this.restartTimer);
      this.restartPending = false;
      this._destroy();
    },

    /* JARVIS finished: bring the mic back */
    resume() {
      this.paused = false;
      this.emptySessions = 0;
      this.langIndex = 0; // always start the next turn on en-US
      if (App.voiceMode) {
        setOrb(State.LISTENING);
        this.start();
      } else {
        setOrb(State.DORMANT);
      }
    },
  };

  /* Supervisor: if anything stalls (e.g. WebView swallowed every event), revive the mic */
  setInterval(() => {
    if (App.voiceMode && !Listener.paused && !App.busy && !Listener.running && !Listener.restartPending) {
      Listener.start();
    }
  }, 2500);

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
     SYSTEM PROMPT  (English coach + language adaptation)
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

  function historyForLLM() {
    return App.conversation.slice(-12).map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content }));
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

  const Providers = {
    async gemini(key, sys, history, userText) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(key)}`;
      const contents = history.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
      contents.push({ role: "user", parts: [{ text: userText }] });
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: sys }] },
          contents,
          generationConfig: { temperature: 0.8, maxOutputTokens: 500 },
        }),
      });
      if (!res.ok) throw fail("gemini", res);
      const data = await res.json();
      const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
      const text = parts ? parts.map((p) => p.text || "").join(" ").trim() : "";
      if (!text) throw fail("gemini", { status: 204 });
      return text;
    },

    async groq(key, sys, history, userText) {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "system", content: sys }, ...history, { role: "user", content: userText }],
          temperature: 0.8, max_tokens: 500,
        }),
      });
      if (!res.ok) throw fail("groq", res);
      const data = await res.json();
      const text = data && data.choices && data.choices[0] && data.choices[0].message ? (data.choices[0].message.content || "").trim() : "";
      if (!text) throw fail("groq", { status: 204 });
      return text;
    },

    async openrouter(key, sys, history, userText) {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          "HTTP-Referer": location.origin && location.origin !== "null" ? location.origin : "https://jarvis.local",
          "X-Title": "JARVIS by IZHAR AFRIDI",
        },
        body: JSON.stringify({
          model: "meta-llama/llama-3.3-70b-instruct:free",
          messages: [{ role: "system", content: sys }, ...history, { role: "user", content: userText }],
          temperature: 0.8, max_tokens: 500,
        }),
      });
      if (!res.ok) throw fail("openrouter", res);
      const data = await res.json();
      const text = data && data.choices && data.choices[0] && data.choices[0].message ? (data.choices[0].message.content || "").trim() : "";
      if (!text) throw fail("openrouter", { status: 204 });
      return text;
    },

    async together(key, sys, history, userText) {
      const res = await fetch("https://api.together.xyz/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
          messages: [{ role: "system", content: sys }, ...history, { role: "user", content: userText }],
          temperature: 0.8, max_tokens: 500,
        }),
      });
      if (!res.ok) throw fail("together", res);
      const data = await res.json();
      const text = data && data.choices && data.choices[0] && data.choices[0].message ? (data.choices[0].message.content || "").trim() : "";
      if (!text) throw fail("together", { status: 204 });
      return text;
    },

    async cohere(key, sys, history, userText) {
      const res = await fetch("https://api.cohere.com/v1/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: "command-r-plus",
          preamble: sys,
          chat_history: history.map((m) => ({ role: m.role === "assistant" ? "CHATBOT" : "USER", message: m.content })),
          message: userText,
          temperature: 0.8, max_tokens: 500,
        }),
      });
      if (!res.ok) throw fail("cohere", res);
      const data = await res.json();
      const text = data && data.text ? data.text.trim() : "";
      if (!text) throw fail("cohere", { status: 204 });
      return text;
    },
  };

  let providerCursor = 0;

  /* Returns { text, provider } or { missingKey:true } */
  async function askAI(userText, lang) {
    if (!App.isOnline) return { text: Offline.respond(userText, lang), provider: "offline" };

    if (!Store.hasAnyKey()) return { missingKey: true };

    const configured = App.providerOrder.filter((p) => App.apiKeys[p] && String(App.apiKeys[p]).trim());
    const sys = buildSystemPrompt();
    const history = historyForLLM();
    const n = configured.length;
    const start = providerCursor % n;

    for (let k = 0; k < n; k++) {
      const provider = configured[(start + k) % n];
      try {
        const text = await Providers[provider](String(App.apiKeys[provider]).trim(), sys, history, userText);
        providerCursor = (start + k) % n;
        return { text, provider };
      } catch (err) {
        const code = err && err.status;
        console.warn(`[JARVIS] ${provider} failed`, code, err);
        providerCursor = (start + k + 1) % n;
        Glass.sys(`${provider.toUpperCase()} ${code === 429 ? "quota reached" : "unavailable"} - switching engine...`);
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
     WAKE WORD  -  INSTANT hardcoded local response
     ============================================================ */
  const WAKE_REPLY = `Assalamualaikum! How can I help you today ${OWNER_NAME}?`;

  /*
   * Called the moment "jarvis" appears in the transcript (even in an interim result).
   * Speaks immediately with speechSynthesis, before any API work.
   */
  function triggerWake(transcript, fromInterim) {
    if (App.busy) return;
    App.busy = true;
    App.awake = true;

    const rest = stripWake(transcript);
    const onlyGreeting = rest.length < 3 || /^(hello|hey|hi|ok|okay|assalam.*|salam.*)$/i.test(rest);

    Glass.newTurn();
    Glass.you(transcript);

    App.conversation.push({ role: "user", content: transcript, lang: "en" });

    if (onlyGreeting) {
      App.awaitingSalamReply = false;      // the reply itself already asks how it can help
      App.awaitingWellbeingReply = false;
      speakReply(WAKE_REPLY, "en");
      return;
    }

    // "Hey Jarvis, open YouTube": greet first (instant, local), then run the command.
    // Do it in one sentence chain so the mic stays closed once.
    speakReply(WAKE_REPLY, "en", () => {
      // after greeting, run the command that came with the wake word
      setTimeout(() => {
        if (!App.voiceMode) return;
        App.busy = true;
        routeCommand(rest, detectLanguage(rest), rest);
      }, 200);
    });
  }

  /* ============================================================
     CONVERSATION FLOW
     ============================================================ */
  function handleFinal(raw) {
    const text = raw.trim();
    if (!text || App.busy) return;

    // Wake word in a final result
    if (hasWake(text) && !App.awake) { triggerWake(text, false); return; }
    // Repeating the wake word later re-greets instantly too
    if (hasWake(text) && App.awake && stripWake(text).length < 3) { triggerWake(text, false); return; }

    // Before the first wake word JARVIS stays passive (but the live transcript still shows what it heard)
    if (!App.awake) {
      Glass.live(text);
      Listener.scheduleRestart(RESTART_DELAY_MS);
      return;
    }

    App.busy = true;
    Glass.newTurn();
    Glass.you(text);
    setOrb(State.THINKING, STATUS.PROCESSING);

    const lang = detectLanguage(text);
    App.lastLang = lang;

    if (App.awaitingSalamReply) {
      App.awaitingSalamReply = false;
      App.conversation.push({ role: "user", content: text, lang });
      if (isSalamReply(text)) {
        App.awaitingWellbeingReply = true;
        return speakReply(lang === "ur" ? "Walaikum Assalam! Aap kaisay hain aaj?" : "Walaikum Assalam! How are you doing today?", lang);
      }
    }

    if (App.awaitingWellbeingReply) {
      App.awaitingWellbeingReply = false;
      if (looksLikeRequest(text)) return routeCommand(text, lang, text);

      App.conversation.push({ role: "user", content: text, lang });
      const negative = /\b(not (good|well|great|fine)|bad|sad|tired|sick|unwell|terrible|stressed|upset|worried)\b|\b(theek nahi|thik nahi|bura|udaas|pareshan|bimar|thaka|thak)\b/i.test(text);
      const reply = negative
        ? (lang === "ur"
            ? "Yeh sun kar afsos hua. Umeed hai jald behtar mehsoos karenge. Main aap ki kya madad kar sakta hoon?"
            : "I'm sorry to hear that. I hope things get better soon. How can I help you today?")
        : (lang === "ur"
            ? "Sun kar acha laga! Bataiye, main aaj aap ki kya madad karoon? English practice, debate, ya kuch aur?"
            : "Glad to hear that! How can I help you today? English practice, a debate, or something else?");
      return speakReply(reply, lang);
    }

    return routeCommand(text, lang, text);
  }

  function looksLikeRequest(text) {
    const t = text.trim().toLowerCase();
    if (/^(how are you|and you|aap kaisay|aap kaise|tum kaise)/.test(t)) return false;
    if (/\b(explain|teach|tell|give|show|open|start|help|correct|practice|practise|debate|interview|write|what|why|how|when|where|who|can you|could you|please|sikhao|batao|samjhao|kholo|kya|kaise|kyun)\b/.test(t)) return true;
    return t.split(/\s+/).length > 9;
  }

  /* Intent check -> API-key check -> AI */
  async function routeCommand(cmdText, lang, originalText) {
    App.busy = true;
    App.conversation.push({ role: "user", content: cmdText, lang });

    const intent = matchIntent(cmdText);
    if (intent) {
      if (intent.dynamic === "time") {
        const t = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        return speakReply(lang === "ur" ? `Abhi waqt hai ${t}.` : `The time is ${t}.`, lang);
      }
      if (intent.dynamic === "date") {
        const d = new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
        return speakReply(lang === "ur" ? `Aaj ki tareekh hai ${d}.` : `Today is ${d}.`, lang);
      }
      speakReply(lang === "ur" ? intent.ur : intent.en, lang, () => setTimeout(() => openSite(intent.url), 300));
      return;
    }

    setOrb(State.THINKING, STATUS.PROCESSING);
    Listener.pause();

    const hint = grammarHint(originalText);
    const prompt = hint ? `${cmdText}\n\n[Hidden coaching note, do not read aloud verbatim: ${hint}]` : cmdText;

    try {
      const result = await askAI(prompt, lang);

      // API failsafe: no key stored anywhere
      if (result.missingKey) {
        Glass.sys(STATUS.NO_KEY);
        setOrb(State.THINKING, STATUS.NO_KEY);
        const spoken = lang === "ur"
          ? "API key nahi mili. Settings mein gear icon dabaa kar key add karein."
          : "API key missing. Please tap the settings gear and add a key.";
        speakReply(spoken, lang, () => setStatus(STATUS.NO_KEY));
        return;
      }
      speakReply(result.text, lang);
    } catch (e) {
      console.error("askAI crashed", e);
      speakReply(Offline.respond(cmdText, lang), lang);
    }
  }

  /* ============================================================
     ORB TAP  ->  unlock audio + start / interrupt / stop
     ============================================================ */
  function activateVoiceMode() {
    // 1) unlock TTS synchronously inside the gesture
    TTS.unlock();
    App.audioUnlocked = true;

    App.voiceMode = true;
    App.awake = false;
    App.busy = false;
    Listener.permissionDenied = false;
    Listener.paused = false;
    Listener.langIndex = 0;
    Listener.emptySessions = 0;
    Glass.newTurn();

    if (!Listener.supported) {
      setOrb(State.DORMANT, "Voice recognition not supported here");
      Glass.sys("This WebView has no speech recognition. Use Chrome, or an Android WebView with microphone permission granted.");
      return;
    }

    if (!Store.hasAnyKey()) Glass.sys(STATUS.NO_KEY);
    else Glass.sys('Audio unlocked. Say "Hello Jarvis" to begin.');

    setOrb(State.LISTENING, STATUS.UNLOCKED, 1800);
    Listener.start();
    setTimeout(() => {
      if (App.voiceMode && App.state === State.LISTENING && Date.now() >= statusLockUntil) setStatus(STATUS.MIC);
    }, 1900);
  }

  function deactivateVoiceMode() {
    App.voiceMode = false;
    App.awake = false;
    App.busy = false;
    App.awaitingSalamReply = false;
    App.awaitingWellbeingReply = false;
    TTS.stop();
    Listener.stop();
    Listener.paused = false;
    setOrb(State.DORMANT);
  }

  el.orbWrap.addEventListener("click", () => {
    if (!App.voiceMode) {
      activateVoiceMode();
    } else if (App.state === State.SPEAKING || App.state === State.THINKING) {
      // Tap while JARVIS talks = interrupt and listen again
      TTS.stop();
      App.busy = false;
      Listener.paused = false;
      Listener.resume();
    } else {
      deactivateVoiceMode();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && App.voiceMode) {
      if (TTS.supported && window.speechSynthesis.paused) window.speechSynthesis.resume();
      if (!Listener.paused && !App.busy) Listener.start();
    }
  });

  /* ============================================================
     SETTINGS MODAL
     ============================================================ */
  el.settingsBtn.addEventListener("click", () => {
    Store.hasAnyKey(); // refresh App.apiKeys from storage
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
    Glass.sys(Store.hasAnyKey() ? "Settings saved." : STATUS.NO_KEY);
    if (App.voiceMode && Store.hasAnyKey() && App.state === State.LISTENING) setStatus(STATUS.MIC);
  });

  el.clearKeysBtn.addEventListener("click", () => {
    Store.clearKeys();
    ["gemini", "groq", "openrouter", "together", "cohere"].forEach((k) => { el["key_" + k].value = ""; });
    Glass.sys(STATUS.NO_KEY);
  });

  /* ============================================================
     BOOT
     ============================================================ */
  function init() {
    Store.load();
    setNetStatus();
    setOrb(State.DORMANT);
    if (!TTS.supported) Glass.sys("Speech synthesis is not supported on this device.");
    if (!Store.hasAnyKey()) Glass.sys(STATUS.NO_KEY);
  }
  document.addEventListener("DOMContentLoaded", init);
})();
