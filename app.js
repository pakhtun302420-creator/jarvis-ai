/* =========================================================================
   JARVIS AI — Created by IZHAR AFRIDI
   Voice-first assistant: recognition, synthesis, multi-API fallback,
   offline mode, language auto-detection, English coaching suite.
   ========================================================================= */

(function () {
  "use strict";

  /* ----------------------------- STATE ------------------------------- */
  const State = {
    DORMANT: "dormant",
    LISTENING: "listening",
    THINKING: "thinking",
    SPEAKING: "speaking",
  };

  const App = {
    audioUnlocked: false,
    micOn: false,
    currentState: State.DORMANT,
    recognition: null,
    recognitionActive: false,
    conversation: [], // {role:'user'|'assistant', content, lang}
    lastLang: "en", // 'en' or 'ur'
    awaitingSalamReply: false,
    awaitingWellbeingReply: false,
    activeRolePlay: null, // {scenario, turn}
    activeCoaching: null, // {topic}
    apiKeys: {
      gemini: "",
      groq: "",
      openrouter: "",
      together: "",
      cohere: "",
    },
    providerOrder: ["gemini", "groq", "openrouter", "together", "cohere"],
    voicePref: "auto",
    isOnline: navigator.onLine,
  };

  /* --------------------------- DOM REFS ------------------------------ */
  const el = {
    orb: document.getElementById("orb"),
    orbWrap: document.getElementById("orbWrap"),
    orbLabel: document.getElementById("orbLabel"),
    unlockHint: document.getElementById("unlockHint"),
    transcript: document.getElementById("transcript"),
    micBtn: document.getElementById("micBtn"),
    textInput: document.getElementById("textInput"),
    sendBtn: document.getElementById("sendBtn"),
    netStatus: document.getElementById("netStatus"),
    netStatusText: document.getElementById("netStatusText"),
    settingsBtn: document.getElementById("settingsBtn"),
    settingsModal: document.getElementById("settingsModal"),
    saveKeysBtn: document.getElementById("saveKeysBtn"),
    clearKeysBtn: document.getElementById("clearKeysBtn"),
    quickRow: document.getElementById("quickRow"),
    key_gemini: document.getElementById("key_gemini"),
    key_groq: document.getElementById("key_groq"),
    key_openrouter: document.getElementById("key_openrouter"),
    key_together: document.getElementById("key_together"),
    key_cohere: document.getElementById("key_cohere"),
    voicePref: document.getElementById("voicePref"),
  };

  /* ============================================================
     PERSISTENCE (LocalStorage)
     ============================================================ */
  const Storage = {
    load() {
      try {
        const raw = localStorage.getItem("jarvis_api_keys");
        if (raw) App.apiKeys = Object.assign(App.apiKeys, JSON.parse(raw));
        const pref = localStorage.getItem("jarvis_voice_pref");
        if (pref) App.voicePref = pref;
      } catch (e) {
        console.warn("Storage load failed", e);
      }
    },
    save() {
      try {
        localStorage.setItem("jarvis_api_keys", JSON.stringify(App.apiKeys));
        localStorage.setItem("jarvis_voice_pref", App.voicePref);
      } catch (e) {
        console.warn("Storage save failed", e);
      }
    },
    clear() {
      localStorage.removeItem("jarvis_api_keys");
      App.apiKeys = { gemini: "", groq: "", openrouter: "", together: "", cohere: "" };
    },
  };

  /* ============================================================
     UI HELPERS
     ============================================================ */
  function setOrbState(state) {
    App.currentState = state;
    el.orb.className = "orb " + state;
    const labels = {
      [State.DORMANT]: "TAP TO ACTIVATE",
      [State.LISTENING]: "LISTENING...",
      [State.THINKING]: "PROCESSING...",
      [State.SPEAKING]: "SPEAKING...",
    };
    el.orbLabel.textContent = labels[state] || "";
  }

  function addMessage(role, text, meta) {
    const div = document.createElement("div");
    div.className = "msg " + (role === "user" ? "user" : role === "sys" ? "sys" : "jarvis");
    const textNode = document.createElement("span");
    textNode.textContent = text;
    div.appendChild(textNode);
    if (meta) {
      const m = document.createElement("span");
      m.className = "meta";
      m.textContent = meta;
      div.appendChild(m);
    }
    el.transcript.appendChild(div);
    el.transcript.scrollTop = el.transcript.scrollHeight + 200;
    return div;
  }

  function setNetStatus() {
    App.isOnline = navigator.onLine;
    if (App.isOnline) {
      el.netStatus.classList.add("online");
      el.netStatusText.textContent = "ONLINE";
    } else {
      el.netStatus.classList.remove("online");
      el.netStatusText.textContent = "OFFLINE";
    }
  }
  window.addEventListener("online", () => {
    setNetStatus();
    addMessage("sys", "🌐 Connection restored — full AI engines available.");
  });
  window.addEventListener("offline", () => {
    setNetStatus();
    addMessage("sys", "⚠ Connection lost — switching to Offline Backup Mode.");
  });

  /* ============================================================
     LANGUAGE DETECTION (Urdu / Roman Urdu / English / Minglish)
     ============================================================ */
  const URDU_SCRIPT_RE = /[\u0600-\u06FF]/;
  // Common Roman-Urdu tokens (kept concise but effective)
  const ROMAN_URDU_WORDS = new Set([
    "hai","hain","ho","hoon","hun","kya","kyun","kyu","kaisay","kaise","kaha","kahan",
    "acha","accha","theek","thik","nahi","nahin","han","haan","mujhe","mujhy","tum",
    "tumhara","aap","ap","apka","aapka","mera","meri","mere","kar","karo","karna",
    "raha","rahi","rahe","bhai","yaar","shukriya","mehrbani","salam","assalam",
    "walaikum","kyaa","bata","batao","bolo","suno","chal","chalo","abhi","phir",
    "wapis","wapas","zindagi","dost","pyar","dil","waqt","paisay","paise","ghar",
    "kaam","matlab","bilkul","zaroor","shayad","lekin","magar","aur","ke","ki","ka",
    "se","ko","me","mein","par","tha","thi","thay","gaya","gayi","gaye","raha hai",
  ]);

  function detectLanguage(text) {
    if (!text) return "en";
    if (URDU_SCRIPT_RE.test(text)) return "ur";
    const words = text.toLowerCase().replace(/[^\w\s']/g, " ").split(/\s+/).filter(Boolean);
    if (words.length === 0) return "en";
    let romanHits = 0;
    words.forEach((w) => {
      if (ROMAN_URDU_WORDS.has(w)) romanHits++;
    });
    const ratio = romanHits / words.length;
    // Minglish: if a meaningful chunk of words are roman-urdu tokens, treat as Urdu-leaning
    if (ratio >= 0.28) return "ur";
    return "en";
  }

  /* ============================================================
     WAKE WORD + INTENT DETECTION
     ============================================================ */
  const WAKE_WORD_RE = /\b(hello jarvis|hey jarvis|hi jarvis|jarvis)\b/i;

  function isWakeWord(text) {
    return WAKE_WORD_RE.test(text.trim());
  }

  function isSalamReply(text) {
    const t = text.toLowerCase();
    return /(walaikum|wa alaikum|valaikum|walekum)/i.test(t) ||
           /\b(salam|assalam)\b/i.test(t);
  }

  const INTENT_PATTERNS = [
    { re: /\bopen youtube\b/i, action: () => openSite("https://www.youtube.com"), en: "Opening YouTube for you, sir.", ur: "Theek hai, YouTube khol raha hoon." },
    { re: /\bopen google\b/i, action: () => openSite("https://www.google.com"), en: "Opening Google now.", ur: "Google khol raha hoon." },
    { re: /\bopen gmail\b/i, action: () => openSite("https://mail.google.com"), en: "Opening Gmail.", ur: "Gmail khol raha hoon." },
    { re: /\bopen maps\b/i, action: () => openSite("https://maps.google.com"), en: "Opening Maps.", ur: "Maps khol raha hoon." },
    { re: /\bopen whatsapp\b/i, action: () => openSite("https://web.whatsapp.com"), en: "Opening WhatsApp Web.", ur: "WhatsApp khol raha hoon." },
    { re: /\bopen facebook\b/i, action: () => openSite("https://www.facebook.com"), en: "Opening Facebook.", ur: "Facebook khol raha hoon." },
    { re: /\bwhat time is it\b|\bcurrent time\b/i, action: null, dynamic: "time" },
    { re: /\bwhat.?s the date\b|\btoday.?s date\b/i, action: null, dynamic: "date" },
  ];

  function openSite(url) {
    window.open(url, "_blank");
  }

  function matchIntent(text) {
    for (const intent of INTENT_PATTERNS) {
      if (intent.re.test(text)) return intent;
    }
    return null;
  }

  /* ============================================================
     SPEECH SYNTHESIS (TTS)
     ============================================================ */
  const TTS = {
    voices: [],
    loadVoices() {
      this.voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    },
    pickVoice(lang) {
      if (!this.voices.length) this.loadVoices();
      const wantUrdu = lang === "ur";
      let v = null;
      if (wantUrdu) {
        v = this.voices.find((x) => /ur|hi|IN/i.test(x.lang));
      }
      if (!v) {
        v = this.voices.find((x) => /en-GB|en_GB/i.test(x.lang)) ||
            this.voices.find((x) => /en-US|en_US/i.test(x.lang)) ||
            this.voices.find((x) => /^en/i.test(x.lang));
      }
      return v || null;
    },
    speak(text, lang, onDone) {
      if (!window.speechSynthesis || !App.audioUnlocked) {
        if (onDone) onDone();
        return;
      }
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      const voice = this.pickVoice(lang);
      if (voice) utter.voice = voice;
      utter.lang = lang === "ur" ? (voice ? voice.lang : "ur-PK") : "en-US";
      utter.rate = 1.0;
      utter.pitch = 1.0;
      utter.volume = 1.0;

      utter.onstart = () => setOrbState(State.SPEAKING);
      utter.onend = () => {
        setOrbState(App.micOn ? State.LISTENING : State.DORMANT);
        if (onDone) onDone();
      };
      utter.onerror = () => {
        setOrbState(App.micOn ? State.LISTENING : State.DORMANT);
        if (onDone) onDone();
      };
      window.speechSynthesis.speak(utter);
    },
  };

  if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = () => TTS.loadVoices();
  }

  function unlockAudio() {
    if (App.audioUnlocked) return;
    App.audioUnlocked = true;
    try {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      window.speechSynthesis.speak(u);
    } catch (e) { /* ignore */ }
    el.unlockHint.style.display = "none";
    addMessage("sys", "🔓 Audio unlocked. JARVIS is ready.");
  }

  /* ============================================================
     SPEECH RECOGNITION (STT)
     ============================================================ */
  function initRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      addMessage("sys", "⚠ Speech recognition is not supported in this browser. You can still type below.");
      return null;
    }
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = "en-US"; // recognition works across Urdu/English fairly well on en-US/ur-PK; we keep en-US as base and rely on text detection
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      App.recognitionActive = true;
      if (App.micOn) setOrbState(State.LISTENING);
    };

    rec.onresult = (event) => {
      const last = event.results[event.results.length - 1];
      if (!last.isFinal) return;
      const transcript = last[0].transcript.trim();
      if (!transcript) return;
      handleUserUtterance(transcript, "voice");
    };

    rec.onerror = (event) => {
      console.warn("Recognition error:", event.error);
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        addMessage("sys", "⚠ Microphone permission denied. Please allow mic access.");
        App.micOn = false;
        updateMicUI();
      }
    };

    rec.onend = () => {
      App.recognitionActive = false;
      if (App.micOn) {
        // auto-restart for continuous hands-free listening
        try { rec.start(); } catch (e) { /* already started guard */ }
      } else {
        setOrbState(State.DORMANT);
      }
    };

    return rec;
  }

  function updateMicUI() {
    el.micBtn.classList.toggle("active", App.micOn);
    if (App.micOn) {
      setOrbState(State.LISTENING);
    } else {
      setOrbState(State.DORMANT);
    }
  }

  function toggleMic() {
    if (!App.audioUnlocked) unlockAudio();
    if (!App.recognition) {
      App.recognition = initRecognition();
      if (!App.recognition) return;
    }
    App.micOn = !App.micOn;
    updateMicUI();
    if (App.micOn) {
      try { App.recognition.start(); } catch (e) { /* ignore double start */ }
    } else {
      try { App.recognition.stop(); } catch (e) { /* ignore */ }
    }
  }

  /* ============================================================
     OFFLINE BACKUP MODE — rule based content
     ============================================================ */
  const OfflineBank = {
    debateTopics: [
      "Should social media be banned for children under 16?",
      "Is artificial intelligence a threat to human jobs?",
      "Should university education be free for everyone?",
      "Is nuclear energy the best solution to climate change?",
      "Should exams be abolished in favor of continuous assessment?",
      "Is a four-day work week better for productivity?",
    ],
    grammarTips: {
      tenses: "Present Simple: I work. Present Continuous: I am working. Present Perfect: I have worked. Past Simple: I worked. Past Continuous: I was working. Past Perfect: I had worked. Future Simple: I will work.",
      modals: "Modal verbs (can, could, may, might, must, shall, should, will, would) show ability, permission, possibility, or obligation. Example: 'You must submit the form by Friday' shows obligation.",
      passive: "Passive voice: object + be + past participle + (by agent). Active: 'The chef cooked the meal.' Passive: 'The meal was cooked by the chef.'",
      conditionals: "Zero: If you heat water, it boils. First: If it rains, I will stay home. Second: If I had money, I would travel. Third: If I had studied, I would have passed.",
    },
    practicePrompts: [
      "Describe your morning routine using at least three different tenses.",
      "Give a two-minute speech on why reading books matters, using at least two modal verbs.",
      "Rewrite this sentence in passive voice: 'The manager approved the project.'",
      "Form a second conditional sentence about your dream job.",
    ],
    roleplayScenarios: {
      interview: [
        "Tell me about yourself.",
        "What are your greatest strengths and weaknesses?",
        "Why do you want to work with our company?",
        "Where do you see yourself in five years?",
      ],
      doctor: [
        "Good morning, what seems to be the problem today?",
        "How long have you had this symptom?",
        "Are you currently taking any medication?",
        "I'll write you a prescription — take this twice daily after meals.",
      ],
      shopkeeper: [
        "Welcome! What are you looking for today?",
        "This one is on sale — would you like to try it?",
        "That will be the total, will you pay by cash or card?",
        "Thank you for shopping with us, come again!",
      ],
    },
  };

  function offlineRespond(userText, lang) {
    const t = userText.toLowerCase();
    if (/debate/.test(t)) {
      const topic = OfflineBank.debateTopics[Math.floor(Math.random() * OfflineBank.debateTopics.length)];
      return lang === "ur"
        ? `Offline mode mein, yeh raha aik debate topic: "${topic}" — aap "for" ya "against" side choose kar sakte hain, main structure dene mein madad karoon ga.`
        : `Here's a debate topic for offline practice: "${topic}". Pick a side — for or against — and I'll help you structure your points.`;
    }
    if (/tense/.test(t)) return OfflineBank.grammarTips.tenses;
    if (/modal/.test(t)) return OfflineBank.grammarTips.modals;
    if (/passive/.test(t)) return OfflineBank.grammarTips.passive;
    if (/conditional/.test(t)) return OfflineBank.grammarTips.conditionals;
    if (/practice|prompt/.test(t)) {
      const p = OfflineBank.practicePrompts[Math.floor(Math.random() * OfflineBank.practicePrompts.length)];
      return lang === "ur" ? `Practice ke liye yeh try karein: ${p}` : `Try this practice prompt: ${p}`;
    }
    if (/interview/.test(t)) return "Offline Interview Practice — Question: " + OfflineBank.roleplayScenarios.interview[0];
    if (/doctor/.test(t)) return "Offline Role-Play (Doctor) — " + OfflineBank.roleplayScenarios.doctor[0];
    if (/shop/.test(t)) return "Offline Role-Play (Shopkeeper) — " + OfflineBank.roleplayScenarios.shopkeeper[0];

    return lang === "ur"
      ? "Is waqt internet available nahi hai, is liye main offline mode mein hoon. Aap mujh se debate topics, grammar rules (tenses, modals, passive, conditionals), ya role-play practice maang sakte hain."
      : "I'm currently offline, running in local backup mode. You can ask me for debate topics, grammar quick-reference (tenses, modals, passive voice, conditionals), or role-play practice.";
  }

  /* ============================================================
     GRAMMAR CORRECTION ENGINE (lightweight local pass, used to
     enrich prompts sent to the LLM, and as offline fallback)
     ============================================================ */
  const CommonErrors = [
    { re: /\bi is\b/i, fix: "I am", rule: "Use 'am' with the subject 'I', not 'is'." },
    { re: /\bhe are\b/i, fix: "he is", rule: "Use 'is' with third-person singular subjects (he/she/it)." },
    { re: /\bshe are\b/i, fix: "she is", rule: "Use 'is' with third-person singular subjects." },
    { re: /\bdont has\b/i, fix: "doesn't have", rule: "Use 'doesn't have' for third-person singular negative present." },
    { re: /\bmore better\b/i, fix: "better", rule: "'Better' is already comparative — don't add 'more'." },
    { re: /\bi has\b/i, fix: "I have", rule: "Use 'have' with the subject 'I'." },
    { re: /\bcan able to\b/i, fix: "can", rule: "'Can' already expresses ability — don't add 'able to'." },
    { re: /\bvery much good\b/i, fix: "very good", rule: "Use 'very good', not 'very much good'." },
    { re: /\bi am agree\b/i, fix: "I agree", rule: "'Agree' is a verb, not an adjective — no 'am' needed." },
    { re: /\bdiscuss about\b/i, fix: "discuss", rule: "'Discuss' is transitive — drop 'about'." },
  ];

  function quickGrammarCheck(text) {
    for (const err of CommonErrors) {
      if (err.re.test(text)) {
        return `I noticed a small grammar slip. Rule: ${err.rule} Suggested correction: "${text.replace(err.re, err.fix)}"`;
      }
    }
    return null;
  }

  /* ============================================================
     MULTI-API PROVIDER LAYER WITH AUTO-FAILOVER
     ============================================================ */

  function buildSystemPrompt(lang) {
    const base =
      "You are JARVIS, a voice-first AI assistant created by IZHAR AFRIDI. " +
      "You are warm, respectful, concise (2-4 sentences unless asked for detail), and address the user politely (like 'sir' occasionally is fine but not required). " +
      "You are also a complete English coaching system: you correct grammar mistakes politely, explain rules briefly, and give an improved sentence. " +
      "You can run role-plays (job interview, doctor visit, shopkeeper, classroom debate), generate debate arguments, vocabulary lists, and presentation outlines. " +
      "You do NOT ask the user's name unless they explicitly ask you to. " +
      "Language rule: if the user writes in Urdu or Roman Urdu or mixes Urdu-English (Minglish), reply naturally in the same style (Roman Urdu or Urdu script matching their input); if they write in English, reply in fluent English. " +
      "Keep responses natural for text-to-speech (avoid heavy markdown, asterisks, or bullet symbols).";
    return base;
  }

  function toLLMHistory() {
    // last 12 turns for context window efficiency
    return App.conversation.slice(-12).map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.content,
    }));
  }

  const Providers = {
    async gemini(key, sysPrompt, history, userText) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(key)}`;
      const contents = history.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));
      contents.push({ role: "user", parts: [{ text: userText }] });
      const body = {
        system_instruction: { parts: [{ text: sysPrompt }] },
        contents,
        generationConfig: { temperature: 0.8, maxOutputTokens: 400 },
      };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 429) throw { code: 429, provider: "gemini" };
      if (!res.ok) throw { code: res.status, provider: "gemini" };
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join(" ").trim();
      if (!text) throw { code: 500, provider: "gemini", msg: "empty response" };
      return text;
    },

    async groq(key, sysPrompt, history, userText) {
      const url = "https://api.groq.com/openai/v1/chat/completions";
      const messages = [{ role: "system", content: sysPrompt }, ...history, { role: "user", content: userText }];
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages,
          temperature: 0.8,
          max_tokens: 400,
        }),
      });
      if (res.status === 429) throw { code: 429, provider: "groq" };
      if (!res.ok) throw { code: res.status, provider: "groq" };
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (!text) throw { code: 500, provider: "groq", msg: "empty response" };
      return text;
    },

    async openrouter(key, sysPrompt, history, userText) {
      const url = "https://openrouter.ai/api/v1/chat/completions";
      const messages = [{ role: "system", content: sysPrompt }, ...history, { role: "user", content: userText }];
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          "HTTP-Referer": "https://jarvis.ai",
          "X-Title": "JARVIS AI by IZHAR AFRIDI",
        },
        body: JSON.stringify({
          model: "meta-llama/llama-3.3-70b-instruct:free",
          messages,
          temperature: 0.8,
          max_tokens: 400,
        }),
      });
      if (res.status === 429) throw { code: 429, provider: "openrouter" };
      if (!res.ok) throw { code: res.status, provider: "openrouter" };
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (!text) throw { code: 500, provider: "openrouter", msg: "empty response" };
      return text;
    },

    async together(key, sysPrompt, history, userText) {
      const url = "https://api.together.xyz/v1/chat/completions";
      const messages = [{ role: "system", content: sysPrompt }, ...history, { role: "user", content: userText }];
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
          messages,
          temperature: 0.8,
          max_tokens: 400,
        }),
      });
      if (res.status === 429) throw { code: 429, provider: "together" };
      if (!res.ok) throw { code: res.status, provider: "together" };
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (!text) throw { code: 500, provider: "together", msg: "empty response" };
      return text;
    },

    async cohere(key, sysPrompt, history, userText) {
      const url = "https://api.cohere.com/v1/chat";
      const chatHistory = history.map((m) => ({
        role: m.role === "assistant" ? "CHATBOT" : "USER",
        message: m.content,
      }));
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: "command-r-plus",
          preamble: sysPrompt,
          chat_history: chatHistory,
          message: userText,
          temperature: 0.8,
          max_tokens: 400,
        }),
      });
      if (res.status === 429) throw { code: 429, provider: "cohere" };
      if (!res.ok) throw { code: res.status, provider: "cohere" };
      const data = await res.json();
      const text = data?.text?.trim();
      if (!text) throw { code: 500, provider: "cohere", msg: "empty response" };
      return text;
    },
  };

  async function getAIResponse(userText, lang) {
    const sysPrompt = buildSystemPrompt(lang);
    const history = toLLMHistory();

    if (!App.isOnline) {
      return { text: offlineRespond(userText, lang), provider: "offline" };
    }

    const availableProviders = App.providerOrder.filter((p) => App.apiKeys[p]);
    if (availableProviders.length === 0) {
      return {
        text:
          lang === "ur"
            ? "Abhi tak koi API key configure nahi hui. Settings (⚙) mein ja kar apni Gemini, Groq, OpenRouter, Together ya Cohere key add karein — tab tak main offline mode mein madad karoon ga.\n\n" +
              offlineRespond(userText, lang)
            : "No API key is configured yet. Please add a Gemini, Groq, OpenRouter, Together AI, or Cohere key in Settings (⚙). Meanwhile, here's offline help:\n\n" +
              offlineRespond(userText, lang),
        provider: "none",
      };
    }

    let lastError = null;
    for (const provider of availableProviders) {
      try {
        const key = App.apiKeys[provider];
        const text = await Providers[provider](key, sysPrompt, history, userText);
        return { text, provider };
      } catch (err) {
        lastError = err;
        console.warn(`Provider ${provider} failed:`, err);
        addMessage("sys", `⚠ ${provider.toUpperCase()} unavailable (${err?.code || "error"}) — rotating to next engine...`);
        continue; // auto-failover to next provider
      }
    }

    // all providers failed -> graceful offline-style fallback
    return {
      text:
        (lang === "ur"
          ? "Tamam AI engines is waqt jawab nahi de rahe (quota ya connection issue). Offline mode se madad kar raha hoon:\n\n"
          : "All configured AI engines failed to respond right now (quota or connection issue). Falling back to offline assistance:\n\n") +
        offlineRespond(userText, lang),
      provider: "offline-fallback",
      error: lastError,
    };
  }

  /* ============================================================
     CORE CONVERSATION HANDLER
     ============================================================ */
  async function handleUserUtterance(rawText, source) {
    const text = rawText.trim();
    if (!text) return;

    const lang = detectLanguage(text);
    App.lastLang = lang;

    addMessage("user", text, source === "voice" ? "🎤 voice" : "⌨ typed");
    App.conversation.push({ role: "user", content: text, lang });

    // ---- Wake word handling ----
    if (isWakeWord(text) && !App.awaitingSalamReply && !App.awaitingWellbeingReply) {
      const strippedCheck = text.replace(WAKE_WORD_RE, "").trim();
      App.awaitingSalamReply = true;
      const reply = "Assalamualaikum!";
      respondAndSpeak(reply, "ur");
      // If the user said more than just the wake word, treat remainder as their message too
      if (strippedCheck.length > 2) {
        App.awaitingSalamReply = false;
        setTimeout(() => handleUserUtterance(strippedCheck, source), 900);
      }
      return;
    }

    if (App.awaitingSalamReply) {
      App.awaitingSalamReply = false;
      if (isSalamReply(text) || /^(walaikum|w\.?salam)/i.test(text)) {
        App.awaitingWellbeingReply = true;
        const reply = lang === "ur" ? "Walaikum Assalam! Aap kaisay hain aaj?" : "Walaikum Assalam! How are you doing today?";
        respondAndSpeak(reply, lang);
        return;
      }
      // fall through — treat as normal message but continue naturally
    }

    if (App.awaitingWellbeingReply) {
      App.awaitingWellbeingReply = false;
      const reply =
        lang === "ur"
          ? "Sun kar acha laga! Main hazir hoon — batayein main aapki kis tarah madad karoon: English practice, debate, ya kuch aur?"
          : "Glad to hear that! I'm all set — how can I help you today? English practice, a debate topic, or something else?";
      respondAndSpeak(reply, lang);
      return;
    }

    // ---- Intent / navigation commands ----
    const intent = matchIntent(text);
    if (intent) {
      if (intent.dynamic === "time") {
        const now = new Date();
        const timeStr = now.toLocaleTimeString();
        respondAndSpeak(lang === "ur" ? `Abhi waqt hai ${timeStr}.` : `The current time is ${timeStr}.`, lang);
        return;
      }
      if (intent.dynamic === "date") {
        const now = new Date();
        const dateStr = now.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
        respondAndSpeak(lang === "ur" ? `Aaj ki tareekh hai ${dateStr}.` : `Today's date is ${dateStr}.`, lang);
        return;
      }
      if (intent.action) intent.action();
      respondAndSpeak(lang === "ur" ? intent.ur : intent.en, lang);
      return;
    }

    // ---- Quick local grammar nudge (non-blocking enrichment) ----
    const grammarNote = quickGrammarCheck(text);

    // ---- Route to AI (with auto-failover) or offline ----
    setOrbState(State.THINKING);
    try {
      const { text: aiText, provider } = await getAIResponse(
        grammarNote ? `${text}\n\n(System note: ${grammarNote})` : text,
        lang
      );
      const finalReply = aiText;
      respondAndSpeak(finalReply, lang, provider);
    } catch (e) {
      console.error(e);
      const fallback = offlineRespond(text, lang);
      respondAndSpeak(fallback, lang, "offline-error");
    }
  }

  function respondAndSpeak(text, lang, providerTag) {
    App.conversation.push({ role: "assistant", content: text, lang });
    const meta = providerTag ? `via ${providerTag}` : undefined;
    addMessage("jarvis", text, meta);
    setOrbState(State.THINKING);
    // small delay so THINKING -> SPEAKING transition is visible
    setTimeout(() => {
      TTS.speak(text, App.voicePref === "auto" ? lang : (App.voicePref === "ur-PK" ? "ur" : "en"), () => {
        setOrbState(App.micOn ? State.LISTENING : State.DORMANT);
      });
    }, 250);
  }

  /* ============================================================
     EVENT WIRING
     ============================================================ */
  el.orbWrap.addEventListener("click", () => {
    if (!App.audioUnlocked) {
      unlockAudio();
    }
    toggleMic();
  });

  el.micBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!App.audioUnlocked) unlockAudio();
    toggleMic();
  });

  el.sendBtn.addEventListener("click", () => {
    const val = el.textInput.value;
    if (!val.trim()) return;
    el.textInput.value = "";
    handleUserUtterance(val, "text");
  });

  el.textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      el.sendBtn.click();
    }
  });

  el.quickRow.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    const cmd = chip.getAttribute("data-cmd");
    if (cmd) handleUserUtterance(cmd, "text");
  });

  el.settingsBtn.addEventListener("click", () => {
    el.key_gemini.value = App.apiKeys.gemini || "";
    el.key_groq.value = App.apiKeys.groq || "";
    el.key_openrouter.value = App.apiKeys.openrouter || "";
    el.key_together.value = App.apiKeys.together || "";
    el.key_cohere.value = App.apiKeys.cohere || "";
    el.voicePref.value = App.voicePref || "auto";
    el.settingsModal.classList.add("show");
  });

  el.settingsModal.addEventListener("click", (e) => {
    if (e.target === el.settingsModal) el.settingsModal.classList.remove("show");
  });

  el.saveKeysBtn.addEventListener("click", () => {
    App.apiKeys.gemini = el.key_gemini.value.trim();
    App.apiKeys.groq = el.key_groq.value.trim();
    App.apiKeys.openrouter = el.key_openrouter.value.trim();
    App.apiKeys.together = el.key_together.value.trim();
    App.apiKeys.cohere = el.key_cohere.value.trim();
    App.voicePref = el.voicePref.value;
    Storage.save();
    el.settingsModal.classList.remove("show");
    addMessage("sys", "✅ API configuration saved locally.");
  });

  el.clearKeysBtn.addEventListener("click", () => {
    Storage.clear();
    el.key_gemini.value = "";
    el.key_groq.value = "";
    el.key_openrouter.value = "";
    el.key_together.value = "";
    el.key_cohere.value = "";
    addMessage("sys", "🗑 All API keys cleared.");
  });

  /* ============================================================
     BOOTSTRAP
     ============================================================ */
  function init() {
    Storage.load();
    setNetStatus();
    setOrbState(State.DORMANT);
    if (window.speechSynthesis) TTS.loadVoices();

    addMessage("sys", "JARVIS AI — Created by IZHAR AFRIDI. System online.");
    addMessage(
      "jarvis",
      "I'm JARVIS, your voice assistant. Tap the orb to unlock audio and start talking, or type below. Say \"Hello Jarvis\" any time to greet me."
    );

    if (!("SpeechRecognition" in window) && !("webkitSpeechRecognition" in window)) {
      addMessage("sys", "ℹ Voice input unavailable on this browser — text mode is fully functional.");
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
