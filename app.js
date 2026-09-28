/* =========================================================================
   JARVIS — Created by IZHAR AFRIDI
   Voice-only assistant engine.
   - Reliable mobile SpeechSynthesis unlock (sync inside the tap gesture)
   - Chunked TTS (Chrome kills long utterances) + keep-alive + retry
   - Echo-safe continuous recognition (paused while JARVIS speaks)
   - Auto-restart with backoff on end/error
   - 5-provider API rotation with 429 / network failover
   - Urdu / Roman Urdu / English / Minglish detection
   - English coaching system prompt + offline rule-based backup
   ========================================================================= */

(function () {
  "use strict";

  /* ----------------------------- STATE ------------------------------- */
  const State = { DORMANT: "dormant", LISTENING: "listening", THINKING: "thinking", SPEAKING: "speaking" };

  const App = {
    audioUnlocked: false,
    voiceMode: false,          // user has activated voice mode (mic should stay on)
    awake: false,              // wake word heard at least once this session
    state: State.DORMANT,
    recognition: null,
    recognitionRunning: false,
    recognitionBlocked: false, // true while JARVIS speaks or thinks (prevents echo)
    restartTimer: null,
    restartDelay: 300,
    conversation: [],
    lastLang: "en",
    awaitingSalamReply: false,
    awaitingWellbeingReply: false,
    processing: false,
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
  };

  /* ============================================================
     UI HELPERS
     ============================================================ */
  let statusLockUntil = 0; // while now < this, passive state changes don't overwrite the status text

  function setStatus(text) {
    el.statusLine.textContent = text;
    el.statusLine.classList.remove("flash");
    void el.statusLine.offsetWidth; // restart animation
    el.statusLine.classList.add("flash");
  }

  /* lockMs > 0 pins the message so quick state changes (e.g. recognition onstart) can't clobber it */
  function setOrb(state, statusOverride, lockMs) {
    App.state = state;
    el.orb.className = "orb " + state;
    el.orbWrap.classList.toggle("active", state !== State.DORMANT);
    const defaults = {
      [State.DORMANT]: "Tap orb to start voice mode",
      [State.LISTENING]: "Listening...",
      [State.THINKING]: "Processing...",
      [State.SPEAKING]: "JARVIS Speaking...",
    };
    const now = Date.now();
    if (statusOverride) {
      statusLockUntil = lockMs ? now + lockMs : 0;
      setStatus(statusOverride);
    } else if (now >= statusLockUntil || state === State.SPEAKING || state === State.THINKING) {
      // speaking/thinking are important enough to always break through a lock
      statusLockUntil = 0;
      setStatus(defaults[state]);
    }
    // else: a lock is active -> keep the pinned message, only the orb animation changes
  }

  /* Glass overlay: one "you" row (live/interim) + one "jarvis" row + optional sys row */
  const Glass = {
    youRow: null, jarvisRow: null, sysRow: null,
    _ensureNotEmpty() { if (el.gEmpty && el.gEmpty.parentNode) el.gEmpty.remove(); },
    _row(cls, tag) {
      this._ensureNotEmpty();
      const row = document.createElement("div");
      row.className = "g-row " + cls;
      const t = document.createElement("span"); t.className = "g-tag"; t.textContent = tag;
      const x = document.createElement("div"); x.className = "g-text";
      row.appendChild(t); row.appendChild(x);
      el.glass.appendChild(row);
      return row;
    },
    showYou(text, interim) {
      if (!this.youRow) this.youRow = this._row("you", "You");
      this.youRow.classList.toggle("interim", !!interim);
      this.youRow.querySelector(".g-text").textContent = text;
      el.glass.scrollTop = el.glass.scrollHeight;
    },
    showJarvis(text) {
      if (!this.jarvisRow) this.jarvisRow = this._row("jarvis", "JARVIS");
      this.jarvisRow.querySelector(".g-text").textContent = text;
      el.glass.scrollTop = el.glass.scrollHeight;
    },
    showSys(text) {
      if (!this.sysRow) this.sysRow = this._row("sys", "System");
      this.sysRow.querySelector(".g-text").textContent = text;
      el.glass.scrollTop = el.glass.scrollHeight;
    },
    newTurn() {
      // clear the previous exchange so the overlay stays clean and minimal
      el.glass.innerHTML = "";
      this.youRow = null; this.jarvisRow = null; this.sysRow = null;
    },
  };

  function setNetStatus() {
    App.isOnline = navigator.onLine;
    el.netStatus.classList.toggle("online", App.isOnline);
    el.netStatusText.textContent = App.isOnline ? "ONLINE" : "OFFLINE";
  }
  window.addEventListener("online", () => { setNetStatus(); Glass.showSys("Connection restored — AI engines available."); });
  window.addEventListener("offline", () => { setNetStatus(); Glass.showSys("Offline — using local backup mode."); });

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
    // Minglish (mixed) counts as Urdu-leaning when a meaningful share of tokens are Roman-Urdu
    return hits / words.length >= 0.25 || hits >= 3 ? "ur" : "en";
  }

  /* ============================================================
     WAKE WORD / SALAM / INTENTS
     ============================================================ */
  // Recognition often mishears "Jarvis" — accept common variants
  const WAKE_RE = /\b(hello|hey|hi|ok|okay)?\s*(jarvis|jarvish|jervis|service|javis|jarwis|jarves|jarvi)\b/i;
  const WAKE_STRICT_RE = /\b(jarvis|jarvish|jervis|javis|jarwis|jarves)\b/i;

  function hasWake(text) { return WAKE_STRICT_RE.test(text) || /\b(hello|hey|hi)\s+service\b/i.test(text); }
  function stripWake(text) {
    return text.replace(/\b(hello|hey|hi|ok|okay)?\s*(jarvis|jarvish|jervis|javis|jarwis|jarves)\b[,.!?]*/ig, "").trim();
  }
  function isSalamReply(text) {
    return /(walaikum|wa\s?alaikum|walekum|valaikum|alaikum|w\.?\s?salam|salam|assalam|assalamu)/i.test(text);
  }

  function openSite(url) {
    try { window.open(url, "_blank"); } catch (e) { window.location.href = url; }
  }

  const INTENTS = [
    { re: /\bopen\s+(you\s?tube|youtube)\b|\byoutube (kholo|khol do|open)\b/i, url: "https://www.youtube.com", en: "Opening YouTube.", ur: "YouTube khol raha hoon." },
    { re: /\bopen\s+google\b|\bgoogle (kholo|khol do|open)\b/i, url: "https://www.google.com", en: "Opening Google.", ur: "Google khol raha hoon." },
    { re: /\bopen\s+gmail\b|\bgmail (kholo|khol do)\b/i, url: "https://mail.google.com", en: "Opening Gmail.", ur: "Gmail khol raha hoon." },
    { re: /\bopen\s+maps?\b|\bmaps? (kholo|khol do)\b/i, url: "https://maps.google.com", en: "Opening Google Maps.", ur: "Maps khol raha hoon." },
    { re: /\bopen\s+whats\s?app\b|\bwhats\s?app (kholo|khol do)\b/i, url: "https://web.whatsapp.com", en: "Opening WhatsApp.", ur: "WhatsApp khol raha hoon." },
    { re: /\bopen\s+facebook\b|\bfacebook (kholo|khol do)\b/i, url: "https://www.facebook.com", en: "Opening Facebook.", ur: "Facebook khol raha hoon." },
    { re: /\bwhat(?:'s| is)? the time\b|\bcurrent time\b|\bwaqt kya\b|\btime kya\b/i, dynamic: "time" },
    { re: /\bwhat(?:'s| is)? (the |today'?s )?date\b|\btareekh\b|\baaj (ki )?date\b/i, dynamic: "date" },
  ];
  function matchIntent(text) { return INTENTS.find((i) => i.re.test(text)) || null; }

  /* ============================================================
     SPEECH SYNTHESIS  (mobile-hardened)
     ------------------------------------------------------------
     Problems solved:
      1. Mobile Chrome/WebView requires speak() to be called
         synchronously inside a user gesture -> unlock() does this.
      2. getVoices() is async -> we poll + listen to onvoiceschanged.
      3. Chrome cuts utterances > ~15s -> text is split in sentences.
      4. Android sometimes silently drops speak() -> watchdog + retry.
      5. Recognition hears JARVIS -> mic is blocked while speaking.
     ============================================================ */
  const TTS = {
    voices: [],
    supported: "speechSynthesis" in window && "SpeechSynthesisUtterance" in window,
    queueToken: 0,

    loadVoices() {
      if (!this.supported) return;
      const v = window.speechSynthesis.getVoices();
      if (v && v.length) this.voices = v;
    },

    pickVoice(lang) {
      if (!this.voices.length) this.loadVoices();
      const V = this.voices;
      if (!V.length) return null;
      const byLang = (re) => V.find((v) => re.test((v.lang || "").replace("_", "-")));
      if (lang === "ur") {
        // Urdu voice -> Hindi voice (understands Roman Urdu phonetics best) -> en-IN -> en-GB
        return byLang(/^ur/i) || byLang(/^hi/i) || byLang(/^en-IN/i) || byLang(/^en-GB/i) || byLang(/^en/i) || V[0];
      }
      return byLang(/^en-GB/i) || byLang(/^en-US/i) || byLang(/^en-IN/i) || byLang(/^en/i) || V[0];
    },

    /* Sentence chunking keeps every utterance short & reliable */
    chunk(text) {
      const clean = text.replace(/[*_#`>~|]/g, " ").replace(/\s+/g, " ").trim();
      if (!clean) return [];
      const parts = clean.match(/[^.!?۔؟\n]+[.!?۔؟]*/g) || [clean];
      const out = [];
      let buf = "";
      for (const p of parts) {
        if ((buf + p).length > 160 && buf) { out.push(buf.trim()); buf = p; }
        else buf += p;
      }
      if (buf.trim()) out.push(buf.trim());
      // hard-split any monster chunk
      const final = [];
      for (const c of out) {
        if (c.length <= 200) final.push(c);
        else for (let i = 0; i < c.length; i += 180) final.push(c.slice(i, i + 180));
      }
      return final;
    },

    /* MUST be invoked synchronously from the tap handler */
    unlock() {
      if (!this.supported) return false;
      try {
        window.speechSynthesis.cancel();
        this.loadVoices();
        // Audible-but-tiny utterance: silent (volume 0) ones are ignored by some WebViews
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
      this.queueToken++;
      try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    },

    speak(text, lang, onStart, onEnd) {
      if (!this.supported || !App.audioUnlocked) { if (onEnd) onEnd(false); return; }
      const chunks = this.chunk(text);
      if (!chunks.length) { if (onEnd) onEnd(true); return; }

      const token = ++this.queueToken;
      const synth = window.speechSynthesis;
      try { synth.cancel(); } catch (e) { /* ignore */ }
      this.loadVoices();
      const voice = this.pickVoice(lang);
      let idx = 0;
      let started = false;
      let keepAlive = null;

      const finish = (ok) => {
        if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
        if (token !== this.queueToken) return; // superseded by a newer speak()
        if (onEnd) onEnd(ok);
      };

      // Chrome Android bug: long speech pauses itself -> nudge it
      keepAlive = setInterval(() => {
        if (token !== this.queueToken) { clearInterval(keepAlive); return; }
        if (synth.speaking && synth.paused) synth.resume();
      }, 4000);

      const next = (retry) => {
        if (token !== this.queueToken) { if (keepAlive) clearInterval(keepAlive); return; }
        if (idx >= chunks.length) { finish(true); return; }

        const u = new SpeechSynthesisUtterance(chunks[idx]);
        if (voice) u.voice = voice;
        u.lang = voice && voice.lang ? voice.lang : (lang === "ur" ? "ur-PK" : "en-US");
        u.rate = App.rate;
        u.pitch = App.pitch;
        u.volume = 1;

        let done = false;
        let watchdog = null;

        const advance = () => {
          if (done) return;
          done = true;
          clearTimeout(watchdog);
          idx++;
          next(false);
        };

        u.onstart = () => {
          clearTimeout(watchdog);
          if (!started) { started = true; if (onStart) onStart(); }
        };
        u.onend = advance;
        u.onerror = (ev) => {
          if (done) return;
          const err = ev && ev.error;
          if (err === "interrupted" || err === "canceled") { done = true; clearTimeout(watchdog); return; }
          if (!retry) {
            // one retry with default voice (some Android voices fail to load)
            done = true; clearTimeout(watchdog);
            try { synth.cancel(); } catch (e) { /* ignore */ }
            const u2 = new SpeechSynthesisUtterance(chunks[idx]);
            u2.rate = App.rate; u2.pitch = App.pitch; u2.volume = 1;
            u2.onstart = () => { if (!started) { started = true; if (onStart) onStart(); } };
            u2.onend = () => { idx++; next(false); };
            u2.onerror = () => { idx++; next(false); };
            synth.speak(u2);
          } else advance();
        };

        // Watchdog: if engine never fires onstart (silent drop), skip the chunk
        watchdog = setTimeout(() => {
          if (!started && !done) {
            try { synth.cancel(); } catch (e) { /* ignore */ }
            if (!retry) { done = true; next(true); } else advance();
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
    // Some Android builds populate voices late without firing the event
    let tries = 0;
    const poll = setInterval(() => {
      TTS.loadVoices();
      if (TTS.voices.length || ++tries > 20) clearInterval(poll);
    }, 400);
  }

  /* Speak a reply: blocks the mic, drives the orb, then resumes listening */
  function speakReply(text, lang, tag) {
    const speakLang = App.voicePref === "auto" ? lang : App.voicePref;
    Glass.showJarvis(text);
    App.conversation.push({ role: "assistant", content: text, lang });
    if (App.conversation.length > 40) App.conversation = App.conversation.slice(-40);

    Recognition.block();
    setOrb(State.THINKING, "Processing...");

    let spokeStarted = false;
    TTS.speak(
      text,
      speakLang,
      () => { spokeStarted = true; setOrb(State.SPEAKING); },
      (ok) => {
        App.processing = false;
        // Small settle delay so the mic doesn't catch the audio tail
        setTimeout(() => {
          Recognition.unblock();
          if (App.voiceMode) setOrb(State.LISTENING);
          else setOrb(State.DORMANT);
        }, 450);
        if (!ok && !spokeStarted) Glass.showSys("Voice output unavailable on this device — showing text only.");
      }
    );
  }

  /* ============================================================
     SPEECH RECOGNITION  (continuous, echo-safe, self-healing)
     ============================================================ */
  const Recognition = {
    supported: !!(window.SpeechRecognition || window.webkitSpeechRecognition),

    create() {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      const rec = new SR();
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.lang = "en-US"; // recognises Pakistani English + Roman Urdu phonetics reasonably well

      rec.onstart = () => {
        App.recognitionRunning = true;
        App.restartDelay = 300;
        if (App.voiceMode && !App.recognitionBlocked && App.state !== State.SPEAKING && App.state !== State.THINKING) {
          setOrb(State.LISTENING);
        }
      };

      rec.onresult = (event) => {
        if (App.recognitionBlocked || App.processing) return;
        let interim = "";
        let finalText = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const r = event.results[i];
          if (r.isFinal) finalText += r[0].transcript;
          else interim += r[0].transcript;
        }
        if (interim && !finalText) Glass.showYou(interim.trim(), true);
        if (finalText.trim()) handleUtterance(finalText.trim());
      };

      rec.onerror = (ev) => {
        const err = ev && ev.error;
        if (err === "not-allowed" || err === "service-not-allowed") {
          App.voiceMode = false;
          setOrb(State.DORMANT, "Microphone blocked — allow mic access");
          Glass.showSys("Microphone permission denied. Enable it in app settings, then tap the orb again.");
          return;
        }
        if (err === "network") App.restartDelay = Math.min(App.restartDelay * 2, 4000);
        // "no-speech" / "aborted" / "audio-capture": handled by onend auto-restart
      };

      rec.onend = () => {
        App.recognitionRunning = false;
        Recognition.scheduleRestart();
      };

      return rec;
    },

    start() {
      if (!this.supported || !App.voiceMode || App.recognitionBlocked) return;
      if (App.recognitionRunning) return;
      if (!App.recognition) App.recognition = this.create();
      try {
        App.recognition.start();
      } catch (e) {
        // InvalidStateError -> already started; anything else -> rebuild
        if (!/already/i.test(String(e && e.message))) {
          App.recognition = null;
          this.scheduleRestart();
        }
      }
    },

    scheduleRestart() {
      clearTimeout(App.restartTimer);
      if (!App.voiceMode) return;
      App.restartTimer = setTimeout(() => this.start(), App.restartDelay);
    },

    stop() {
      clearTimeout(App.restartTimer);
      if (App.recognition) { try { App.recognition.stop(); } catch (e) { /* ignore */ } }
    },

    /* Pause the mic while JARVIS is talking so it can't hear itself */
    block() {
      App.recognitionBlocked = true;
      if (App.recognition && App.recognitionRunning) {
        try { App.recognition.abort(); } catch (e) { /* ignore */ }
      }
    },
    unblock() {
      App.recognitionBlocked = false;
      if (App.voiceMode) this.scheduleRestart();
    },
  };

  /* Watchdog: if the browser silently kills recognition, revive it */
  setInterval(() => {
    if (App.voiceMode && !App.recognitionBlocked && !App.recognitionRunning && !App.processing) {
      Recognition.start();
    }
  }, 3000);

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

  /* Lightweight local grammar detector: enriches the LLM prompt */
  const GRAMMAR_PATTERNS = [
    { re: /\bi is\b/i, fix: "I am", rule: "Use 'am' with the subject 'I'." },
    { re: /\b(he|she|it) are\b/i, fix: "$1 is", rule: "Use 'is' with he, she and it." },
    { re: /\b(he|she|it) (don't|dont)\b/i, fix: "$1 doesn't", rule: "Use 'doesn't' with he, she and it." },
    { re: /\bi has\b/i, fix: "I have", rule: "Use 'have' with 'I'." },
    { re: /\bmore better\b/i, fix: "better", rule: "'Better' is already comparative." },
    { re: /\bcan able to\b/i, fix: "can", rule: "'Can' already means able to." },
    { re: /\bi am agree\b/i, fix: "I agree", rule: "'Agree' is a verb, so no 'am'." },
    { re: /\bdiscuss about\b/i, fix: "discuss", rule: "'Discuss' takes a direct object, so drop 'about'." },
    { re: /\bi am having (a )?(car|house|phone|laptop)\b/i, fix: "I have $1$2", rule: "'Have' for possession is a stative verb and is not used in the continuous form." },
    { re: /\bmy name is (.*) and i am (\d+) years\b/i, fix: null, rule: "Say 'I am X years old'." },
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
  function fail(provider, res, extra) {
    const e = new Error(`${provider} ${res ? res.status : "network"}`);
    e.provider = provider;
    e.status = res ? res.status : 0;
    e.extra = extra;
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
      const text = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
        data.candidates[0].content.parts ? data.candidates[0].content.parts.map((p) => p.text || "").join(" ").trim() : "";
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

  /* Round-robin start index so a working key is reused, and a failing one is skipped first */
  let providerCursor = 0;

  async function askAI(userText, lang) {
    if (!App.isOnline) return { text: Offline.respond(userText, lang), provider: "offline" };

    const configured = App.providerOrder.filter((p) => App.apiKeys[p]);
    if (!configured.length) {
      const msg = lang === "ur"
        ? "Abhi koi API key set nahi hai. Settings mein gear icon dabaa kar apni key add karein. Tab tak main offline mode mein hoon. "
        : "No API key is set yet. Tap the gear icon and add at least one key. Until then I am in offline mode. ";
      return { text: msg + Offline.respond(userText, lang), provider: "offline" };
    }

    const sys = buildSystemPrompt();
    const history = historyForLLM();
    const n = configured.length;
    const start = providerCursor % n;

    for (let k = 0; k < n; k++) {
      const provider = configured[(start + k) % n];
      try {
        const text = await Providers[provider](App.apiKeys[provider], sys, history, userText);
        providerCursor = (start + k) % n; // stick with the engine that worked
        return { text, provider };
      } catch (err) {
        const code = err && err.status;
        console.warn(`[JARVIS] ${provider} failed`, code, err);
        // 429 = quota; 0 = network/CORS; 401/403 = bad key; 5xx = server -> all rotate to next engine
        providerCursor = (start + k + 1) % n;
        Glass.showSys(`${provider.toUpperCase()} ${code === 429 ? "quota reached" : "unavailable"} — switching engine...`);
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
  async function handleUtterance(raw) {
    const text = raw.trim();
    if (!text || App.processing) return;

    // Before the first wake word, JARVIS stays passive in the background.
    // After it has been woken once, it converses freely (no need to repeat the wake word).
    const woke = hasWake(text);
    if (!App.awake && !woke) {
      Glass.showYou(text, true);
      return;
    }

    App.processing = true;
    Glass.newTurn();
    Glass.showYou(text, false);

    const lang = detectLanguage(text);
    App.lastLang = lang;

    /* ---------- Wake-word greeting ---------- */
    if (woke && !App.awaitingSalamReply && !App.awaitingWellbeingReply) {
      const rest = stripWake(text);
      App.awake = true;
      // Just the wake word (or a greeting) -> Salam, then wait for the reply
      if (rest.length < 3 || /^(hello|hey|hi|ok|okay|assalam.*|salam.*)$/i.test(rest)) {
        App.awaitingSalamReply = true;
        App.conversation.push({ role: "user", content: text, lang });
        speakReply("Assalamualaikum", "ur");
        return;
      }
      // "Hey Jarvis, open YouTube" -> greet is skipped, run the command directly
      return routeCommand(rest, detectLanguage(rest), text);
    }

    /* ---------- Reply to Salam ---------- */
    if (App.awaitingSalamReply) {
      App.awaitingSalamReply = false;
      App.conversation.push({ role: "user", content: text, lang });
      if (isSalamReply(text)) {
        App.awaitingWellbeingReply = true;
        speakReply(lang === "ur" ? "Walaikum Assalam! Aap kaisay hain aaj?" : "Walaikum Assalam! How are you doing today?", lang);
        return;
      }
      // User skipped the salam and asked something else -> treat as a normal message
    }

    /* ---------- Reply to well-being question ---------- */
    if (App.awaitingWellbeingReply) {
      App.awaitingWellbeingReply = false;
      // If the user ignored the question and made a real request, answer it instead of swallowing it
      if (looksLikeRequest(text)) return routeCommand(text, lang, text);

      App.conversation.push({ role: "user", content: text, lang });
      const negative = /\b(not (good|well|great|fine)|bad|sad|tired|sick|unwell|terrible|stressed|upset|worried)\b|\b(theek nahi|thik nahi|bura|udaas|pareshan|bimar|thaka|thak)\b/i.test(text);
      let reply;
      if (negative) {
        reply = lang === "ur"
          ? "Yeh sun kar afsos hua. Umeed hai jald behtar mehsoos karenge. Main aap ki kya madad kar sakta hoon?"
          : "I'm sorry to hear that. I hope things get better soon. How can I help you today?";
      } else {
        reply = lang === "ur"
          ? "Sun kar acha laga! Bataiye, main aaj aap ki kya madad karoon? English practice, debate, ya kuch aur?"
          : "Glad to hear that! How can I help you today? English practice, a debate, or something else?";
      }
      speakReply(reply, lang);
      return;
    }

    return routeCommand(text, lang, text);
  }

  /* Does this utterance look like a real request/question rather than a "how are you" answer? */
  function looksLikeRequest(text) {
    const t = text.trim().toLowerCase();
    if (/\b(explain|teach|tell|give|show|open|start|help|correct|practice|practise|debate|interview|write|what|why|how|when|where|who|can you|could you|please|sikhao|batao|samjhao|kholo|kya|kaise|kyun)\b/.test(t)) {
      // "how are you" style pleasantries are NOT requests
      if (/^(how are you|and you|aap kaisay|aap kaise|tum kaise)/.test(t)) return false;
      return true;
    }
    return t.split(/\s+/).length > 9;
  }

  /* Intent check -> AI */
  async function routeCommand(cmdText, lang, originalText) {
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
      speakReply(lang === "ur" ? intent.ur : intent.en, lang);
      // Give the spoken confirmation a moment before navigating away
      setTimeout(() => openSite(intent.url), 1200);
      return;
    }

    setOrb(State.THINKING, "Processing...");
    Recognition.block();

    const hint = grammarHint(originalText);
    const prompt = hint ? `${cmdText}\n\n[Hidden coaching note, do not read aloud verbatim: ${hint}]` : cmdText;

    try {
      const { text } = await askAI(prompt, lang);
      speakReply(text, lang);
    } catch (e) {
      console.error("askAI crashed", e);
      speakReply(Offline.respond(cmdText, lang), lang);
    }
  }

  /* ============================================================
     ORB TAP  -> unlock audio + start / stop voice mode
     ============================================================ */
  function activateVoiceMode() {
    // 1) UNLOCK AUDIO synchronously inside the user gesture
    const unlocked = TTS.unlock();
    App.audioUnlocked = unlocked || !TTS.supported ? true : false;
    if (TTS.supported) App.audioUnlocked = true;

    App.voiceMode = true;
    Glass.newTurn();

    if (!Recognition.supported) {
      setOrb(State.DORMANT, "Voice recognition not supported here");
      Glass.showSys("This browser has no speech recognition. Open JARVIS in Chrome or an Android WebView with microphone access.");
      return;
    }

    // 2) Visual confirmation, then start listening
    setOrb(State.LISTENING, "AUDIO UNLOCKED & LISTENING", 2200);
    Glass.showSys('Audio unlocked. Say "Hello Jarvis" to begin.');
    Recognition.start();

    // After the pinned message expires, settle on the plain status line
    setTimeout(() => {
      if (App.voiceMode && App.state === State.LISTENING && Date.now() >= statusLockUntil) setStatus("Listening...");
    }, 2300);
  }

  function deactivateVoiceMode() {
    App.voiceMode = false;
    App.awake = false;
    App.awaitingSalamReply = false;
    App.awaitingWellbeingReply = false;
    App.processing = false;
    TTS.stop();
    Recognition.stop();
    setOrb(State.DORMANT);
  }

  el.orbWrap.addEventListener("click", () => {
    if (!App.voiceMode) {
      activateVoiceMode();
    } else if (App.state === State.SPEAKING) {
      // Tap while speaking = interrupt JARVIS and listen again
      TTS.stop();
      App.processing = false;
      Recognition.unblock();
      setOrb(State.LISTENING);
    } else {
      deactivateVoiceMode();
    }
  });

  /* Resume audio + mic when the app returns to the foreground */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && App.voiceMode) {
      if (TTS.supported && window.speechSynthesis.paused) window.speechSynthesis.resume();
      Recognition.scheduleRestart();
    }
  });

  /* ============================================================
     SETTINGS MODAL
     ============================================================ */
  el.settingsBtn.addEventListener("click", () => {
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
    Glass.showSys("Settings saved.");
  });

  el.clearKeysBtn.addEventListener("click", () => {
    Store.clearKeys();
    ["gemini", "groq", "openrouter", "together", "cohere"].forEach((k) => { el["key_" + k].value = ""; });
    Glass.showSys("All API keys cleared.");
  });

  /* ============================================================
     BOOT
     ============================================================ */
  function init() {
    Store.load();
    setNetStatus();
    setOrb(State.DORMANT);
    if (!TTS.supported) Glass.showSys("Speech synthesis is not supported on this device.");
  }
  document.addEventListener("DOMContentLoaded", init);
})();
