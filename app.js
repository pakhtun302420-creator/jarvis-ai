/**
 * ============================================================================
 * JARVIS AI • Futuristic HUD Neural Voice Assistant
 * Architect & Creator: IZHAR AFRIDI
 * 
 * Features:
 * 1. Web Speech API Voice Loop (Android WebView Optimized)
 * 2. 5-Engine Auto-Failover: Gemini, Groq, OpenRouter, Together AI, Cohere
 * 3. English Language Learning & Debate Coaching Suite
 * 4. Dynamic Dialect & Auto-Language Adaptation (English / Urdu / Minglish)
 * 5. Wake-Word Detection ("Hello Jarvis", "Hey Jarvis", "Jarvis") -> Assalamualaikum
 * 6. Mobile Intents & Offline Backup Mode
 * 7. AudioContext Unlock & 4-State Cyberpunk HUD Orb Visualizer
 * ============================================================================
 */

(function () {
  'use strict';

  // --- Constants & Config ---
  const STORAGE_KEYS = {
    GEMINI: 'jarvis_key_gemini',
    GROQ: 'jarvis_key_groq',
    OPENROUTER: 'jarvis_key_openrouter',
    TOGETHER: 'jarvis_key_together',
    COHERE: 'jarvis_key_cohere',
    COACH_MODE: 'jarvis_coach_mode',
    VOICE_PREF: 'jarvis_voice_pref',
    CUSTOM_URL: 'jarvis_custom_github_url'
  };

  const ENGINES = [
    { id: 'gemini', name: 'Google Gemini', storageKey: STORAGE_KEYS.GEMINI, defaultModel: 'gemini-2.0-flash' },
    { id: 'groq', name: 'Groq (Llama 3.3 70B)', storageKey: STORAGE_KEYS.GROQ, defaultModel: 'llama-3.3-70b-versatile' },
    { id: 'openrouter', name: 'OpenRouter AI', storageKey: STORAGE_KEYS.OPENROUTER, defaultModel: 'meta-llama/llama-3.3-70b-instruct' },
    { id: 'together', name: 'Together AI', storageKey: STORAGE_KEYS.TOGETHER, defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
    { id: 'cohere', name: 'Cohere Command R+', storageKey: STORAGE_KEYS.COHERE, defaultModel: 'command-r-plus-08-2024' }
  ];

  // System Prompt for JARVIS
  function getSystemPrompt(mode) {
    let modeInstruction = "";
    switch (mode) {
      case 'grammar_drill':
        modeInstruction = "MODE: TARGETED GRAMMAR DRILL COACH. When user speaks, assess their grammar (tenses, modals, passive voice, conditionals). Give an encouraging correction, explain the exact rule, provide 1 clear example, and ask 1 quick drill practice question.";
        break;
      case 'debate':
        modeInstruction = "MODE: GROUP DEBATE & PUBLIC SPEAKING COACH. Help user structure powerful arguments for debates or speeches. Give: 1) Opening hook, 2) Two core persuasive points with evidence, 3) Anticipated counter-argument and rebuttal, 4) Two advanced vocabulary words with definitions.";
        break;
      case 'interview':
        modeInstruction = "MODE: INTERACTIVE ROLE-PLAY: JOB INTERVIEW. You are a senior hiring manager. Ask insightful behavioral and technical interview questions, analyze the user's spoken answer, give quick constructive phrasing feedback, and ask the next question.";
        break;
      case 'doctor':
        modeInstruction = "MODE: INTERACTIVE ROLE-PLAY: DOCTOR & PATIENT. Act as a polite, professional physician discussing symptoms or health concerns. Coach the user on medical English vocabulary and natural phrasing.";
        break;
      case 'classroom':
        modeInstruction = "MODE: INTERACTIVE ROLE-PLAY: COLLEGE CLASSROOM. Act as an inspiring university professor engaging the user in academic discussion, encouraging formal rhetoric and critical thinking.";
        break;
      default:
        modeInstruction = "MODE: ADAPTIVE VOICE ASSISTANT & REAL-TIME GRAMMAR MENTOR. If the user makes grammatical or phrasing errors, seamlessly add a gentle correction: 'Correction: [Better phrasing]. Rule: [Concise reason].' then directly provide the answer.";
    }

    return `You are JARVIS, an elite futuristic AI voice assistant and English language coach created exclusively by IZHAR AFRIDI.
Your creator and chief architect is IZHAR AFRIDI. Acknowledge this with pride if asked about your creator.
Tone: Highly intelligent, respectful, sharp, futuristic (like Tony Stark's JARVIS mixed with an elite mentor).
Voice-Optimized Output: Your responses will be read aloud by Text-To-Speech. Keep responses concise, punchy, and conversational (typically 2 to 4 sentences unless detailed debate outlines are asked). Never use Markdown tables, nested asterisks, or unpronounceable symbols.
Language & Dialect Adaptation:
- If spoken to in Urdu or Roman Urdu, respond in natural Urdu or Roman Urdu.
- If spoken to in English, respond in articulate English, seamlessly understanding Pakistani English and mixed Urdu-English (Minglish).
- Never prompt the user for their name unless explicitly requested.
Greeting Rule: When greeted with "Hello Jarvis", "Hey Jarvis", or "Jarvis", acknowledge with "Assalamualaikum!" and ask about their well-being.
${modeInstruction}`;
  }

  // --- State Variables ---
  let audioContext = null;
  let audioUnlocked = false;
  let isListening = false;
  let isSpeaking = false;
  let isThinking = false;
  let recognition = null;
  let recognitionActive = false;
  let activeEngineIndex = 0;
  let recognitionRestartTimer = null;
  let lastTranscriptTime = 0;
  let availableVoices = [];

  // --- DOM Elements ---
  const jarvisOrb = document.getElementById('jarvis-orb');
  const orbStatusText = document.getElementById('orb-status-text');
  const statusLabel = document.getElementById('status-label');
  const orbHint = document.getElementById('orb-hint');
  const visualizerStage = document.getElementById('visualizer-stage');
  const transcriptText = document.getElementById('transcript-text');
  const responseContainer = document.getElementById('response-container');
  const responseText = document.getElementById('response-text');
  const connBadge = document.getElementById('conn-badge');
  const connDot = document.getElementById('conn-dot');
  const connText = document.getElementById('conn-text');
  const audioToggleBtn = document.getElementById('audio-toggle-btn');
  const micIcon = document.getElementById('mic-icon');
  const settingsModal = document.getElementById('settings-modal');
  const settingsOpenBtn = document.getElementById('settings-open-btn');
  const settingsCloseBtn = document.getElementById('settings-close-btn');
  const saveSettingsBtn = document.getElementById('save-settings-btn');
  const testFailoverBtn = document.getElementById('test-failover-btn');
  const hudToast = document.getElementById('hud-toast');
  const coachModeSelect = document.getElementById('coach-mode-select');
  const ttsVoiceSelect = document.getElementById('tts-voice-select');
  const customGithubUrl = document.getElementById('custom-github-url');
  const metaEngineInfo = document.getElementById('meta-engine-info');
  const metaCoachMode = document.getElementById('meta-coach-mode');
  const metaTtsInfo = document.getElementById('meta-tts-info');

  const keyInputs = {
    gemini: document.getElementById('key-gemini'),
    groq: document.getElementById('key-groq'),
    openrouter: document.getElementById('key-openrouter'),
    together: document.getElementById('key-together'),
    cohere: document.getElementById('key-cohere')
  };

  const statusBadges = {
    gemini: document.getElementById('status-gemini'),
    groq: document.getElementById('status-groq'),
    openrouter: document.getElementById('status-openrouter'),
    together: document.getElementById('status-together'),
    cohere: document.getElementById('status-cohere')
  };

  // --- Audio Context & Chimes ---
  function initAudioContext() {
    if (audioUnlocked) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        audioContext = new AudioCtx();
        if (audioContext.state === 'suspended') {
          audioContext.resume();
        }
      }
      // Unlock SpeechSynthesis
      if ('speechSynthesis' in window) {
        window.speechSynthesis.resume();
        const silentUtterance = new SpeechSynthesisUtterance('');
        silentUtterance.volume = 0;
        window.speechSynthesis.speak(silentUtterance);
      }
      audioUnlocked = true;
      playCyberChime(880, 0.08, 'sine');
      setTimeout(() => playCyberChime(1320, 0.12, 'sine'), 80);
      showToast('AUDIO MATRIX UNLOCKED');
      orbHint.textContent = 'SYSTEM ONLINE • LISTENING CONTINUOUSLY';
    } catch (e) {
      console.warn('Audio Context unlock warning:', e);
    }
  }

  function playCyberChime(freq = 880, duration = 0.1, type = 'sine') {
    if (!audioContext) return;
    try {
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, audioContext.currentTime);
      gain.gain.setValueAtTime(0.08, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + duration);
      osc.connect(gain);
      gain.connect(audioContext.destination);
      osc.start();
      osc.stop(audioContext.currentTime + duration);
    } catch (e) {
      // Ignore audio chime errors
    }
  }

  // --- Visualizer Orb States (DORMANT, LISTENING, THINKING, SPEAKING) ---
  function setOrbState(state, customLabel = null) {
    jarvisOrb.className = `jarvis-orb state-${state.toLowerCase()}`;
    const labels = {
      dormant: 'STANDBY • DORMANT',
      listening: 'LISTENING FOR VOICE INPUT',
      thinking: 'PROCESSING NEURAL INTENT',
      speaking: 'TRANSMITTING VOCAL RESPONSE'
    };
    statusLabel.textContent = customLabel || labels[state.toLowerCase()] || state.toUpperCase();
    
    // Header mic icon sync
    if (state === 'listening') {
      micIcon.textContent = '🎙️';
      micIcon.style.color = 'var(--cyan-neon)';
    } else if (state === 'speaking') {
      micIcon.textContent = '🔊';
      micIcon.style.color = 'var(--teal-accent)';
    } else if (state === 'thinking') {
      micIcon.textContent = '⚡';
      micIcon.style.color = 'var(--amber-warn)';
    } else {
      micIcon.textContent = '💤';
      micIcon.style.color = 'var(--text-muted)';
    }
  }

  // --- Toast HUD Message ---
  let toastTimer = null;
  function showToast(msg) {
    if (!hudToast) return;
    hudToast.textContent = msg;
    hudToast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      hudToast.classList.remove('show');
    }, 2400);
  }

  // --- Network Connection Telemetry ---
  function updateConnectionStatus() {
    const isOnline = navigator.onLine;
    const activeEngine = getActiveConfiguredEngine();

    if (!isOnline) {
      connDot.className = 'conn-dot offline';
      connText.textContent = 'OFFLINE • LOCAL BACKUP';
      metaEngineInfo.textContent = 'ENGINE: OFFLINE RULE MATRIX';
      metaEngineInfo.style.color = 'var(--red-alert)';
    } else if (!activeEngine) {
      connDot.className = 'conn-dot warn';
      connText.textContent = 'ONLINE • NO API KEY';
      metaEngineInfo.textContent = 'ENGINE: LOCAL FALLBACK (SET ⚙️)';
      metaEngineInfo.style.color = 'var(--amber-warn)';
    } else {
      connDot.className = 'conn-dot';
      connText.textContent = `ONLINE • ${activeEngine.name.split(' ')[0].toUpperCase()}`;
      metaEngineInfo.textContent = `ACTIVE ENGINE: ${activeEngine.name.toUpperCase()}`;
      metaEngineInfo.style.color = 'var(--teal-accent)';
    }
  }

  window.addEventListener('online', () => {
    updateConnectionStatus();
    showToast('NETWORK RESTORED • ONLINE');
  });

  window.addEventListener('offline', () => {
    updateConnectionStatus();
    showToast('NETWORK LOST • SWITCHED TO OFFLINE BACKUP');
  });

  // --- API Key Management & Smart Failover ---
  function getStoredKey(storageKey) {
    return localStorage.getItem(storageKey) || '';
  }

  function setStoredKey(storageKey, val) {
    if (val && val.trim()) {
      localStorage.setItem(storageKey, val.trim());
    } else {
      localStorage.removeItem(storageKey);
    }
  }

  function loadSettings() {
    ENGINES.forEach(eng => {
      const key = getStoredKey(eng.storageKey);
      if (keyInputs[eng.id]) keyInputs[eng.id].value = key;
      if (statusBadges[eng.id]) {
        statusBadges[eng.id].textContent = key ? 'Ready' : 'Not Set';
        statusBadges[eng.id].style.color = key ? 'var(--teal-accent)' : 'var(--text-muted)';
      }
    });

    const savedMode = localStorage.getItem(STORAGE_KEYS.COACH_MODE) || 'adaptive';
    coachModeSelect.value = savedMode;
    metaCoachMode.textContent = `COACH: ${savedMode.replace('_', ' ').toUpperCase()}`;

    const savedUrl = localStorage.getItem(STORAGE_KEYS.CUSTOM_URL) || '';
    if (customGithubUrl) customGithubUrl.value = savedUrl;

    updateConnectionStatus();
  }

  function saveSettings() {
    ENGINES.forEach(eng => {
      if (keyInputs[eng.id]) {
        setStoredKey(eng.storageKey, keyInputs[eng.id].value);
        if (statusBadges[eng.id]) {
          const hasKey = !!keyInputs[eng.id].value.trim();
          statusBadges[eng.id].textContent = hasKey ? 'Ready' : 'Not Set';
          statusBadges[eng.id].style.color = hasKey ? 'var(--teal-accent)' : 'var(--text-muted)';
        }
      }
    });

    localStorage.setItem(STORAGE_KEYS.COACH_MODE, coachModeSelect.value);
    metaCoachMode.textContent = `COACH: ${coachModeSelect.value.replace('_', ' ').toUpperCase()}`;

    if (ttsVoiceSelect.value) {
      localStorage.setItem(STORAGE_KEYS.VOICE_PREF, ttsVoiceSelect.value);
    }

    if (customGithubUrl) {
      const url = customGithubUrl.value.trim();
      localStorage.setItem(STORAGE_KEYS.CUSTOM_URL, url);
    }

    updateConnectionStatus();
    showToast('SYSTEM CONFIGURATION SAVED');
    settingsModal.classList.remove('active');
  }

  function getActiveConfiguredEngine() {
    const configured = ENGINES.filter(eng => !!getStoredKey(eng.storageKey));
    if (configured.length === 0) return null;
    return configured[activeEngineIndex % configured.length];
  }

  function rotateToNextEngine() {
    const configured = ENGINES.filter(eng => !!getStoredKey(eng.storageKey));
    if (configured.length <= 1) return null;
    activeEngineIndex = (activeEngineIndex + 1) % configured.length;
    const nextEngine = configured[activeEngineIndex];
    updateConnectionStatus();
    showToast(`FAILOVER: ROTATING TO ${nextEngine.name.toUpperCase()}`);
    return nextEngine;
  }

  // --- Voice Synthesis (TTS) ---
  function populateVoiceList() {
    if (!('speechSynthesis' in window)) return;
    availableVoices = window.speechSynthesis.getVoices();
    ttsVoiceSelect.innerHTML = '<option value="auto">Auto-Detect Best Natural Voice (Urdu / English)</option>';
    
    availableVoices.forEach((voice, index) => {
      const opt = document.createElement('option');
      opt.value = index;
      opt.textContent = `${voice.name} (${voice.lang})`;
      ttsVoiceSelect.appendChild(opt);
    });

    const savedPref = localStorage.getItem(STORAGE_KEYS.VOICE_PREF);
    if (savedPref && ttsVoiceSelect.querySelector(`option[value="${savedPref}"]`)) {
      ttsVoiceSelect.value = savedPref;
    }
  }

  if ('speechSynthesis' in window) {
    speechSynthesis.onvoiceschanged = populateVoiceList;
    populateVoiceList();
  }

  function speakVocalResponse(text, onCompleteCallback) {
    if (!('speechSynthesis' in window)) {
      if (onCompleteCallback) onCompleteCallback();
      return;
    }

    // Cancel ongoing speech
    window.speechSynthesis.cancel();

    // Clean text for natural speech (remove markdown symbols)
    const cleanedText = text
      .replace(/[*_#`~>]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleanedText) {
      if (onCompleteCallback) onCompleteCallback();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(cleanedText);
    utterance.pitch = 1.0;
    utterance.rate = 1.0;

    // Detect language in text: Urdu script detection
    const hasUrduScript = /[\u0600-\u06FF]/.test(cleanedText);
    
    // Select best voice
    let selectedVoice = null;
    const prefIndex = ttsVoiceSelect.value;
    if (prefIndex !== 'auto' && availableVoices[prefIndex]) {
      selectedVoice = availableVoices[prefIndex];
    } else {
      if (hasUrduScript) {
        selectedVoice = availableVoices.find(v => v.lang.startsWith('ur') || v.lang.startsWith('hi')) || null;
      }
      if (!selectedVoice) {
        // Find natural English voice (UK, US, AU)
        selectedVoice = availableVoices.find(v => 
          (v.name.includes('Natural') || v.name.includes('Google') || v.name.includes('Neural')) && v.lang.startsWith('en')
        ) || availableVoices.find(v => v.lang.startsWith('en')) || availableVoices[0];
      }
    }

    if (selectedVoice) {
      utterance.voice = selectedVoice;
      metaTtsInfo.textContent = `TTS: ${selectedVoice.name.substring(0, 14)}`;
    }

    isSpeaking = true;
    setOrbState('speaking');

    // Pause recognition during speech output to prevent self-looping
    stopVoiceRecognition();

    utterance.onstart = () => {
      isSpeaking = true;
      setOrbState('speaking');
    };

    utterance.onend = () => {
      isSpeaking = false;
      setOrbState('listening');
      startVoiceRecognition();
      if (onCompleteCallback) onCompleteCallback();
    };

    utterance.onerror = (e) => {
      console.warn('SpeechSynthesis error:', e);
      isSpeaking = false;
      setOrbState('listening');
      startVoiceRecognition();
      if (onCompleteCallback) onCompleteCallback();
    };

    window.speechSynthesis.speak(utterance);
  }

  // --- Web Speech API (Hands-Free Voice Loop) ---
  function initSpeechEngine() {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      transcriptText.textContent = "Speech recognition not supported in this browser.";
      statusLabel.textContent = "SPEECH API UNAVAILABLE";
      return;
    }

    recognition = new SpeechRec();
    // Continuous = false for rock-solid Android WebView lifecycle stability
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      recognitionActive = true;
      if (!isSpeaking && !isThinking) {
        setOrbState('listening');
      }
    };

    recognition.onresult = (event) => {
      lastTranscriptTime = Date.now();
      let interim = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const transcriptPart = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcriptPart;
        } else {
          interim += transcriptPart;
        }
      }

      const currentDisplay = finalTranscript || interim;
      if (currentDisplay) {
        transcriptText.textContent = currentDisplay;
        transcriptText.classList.remove('empty');
      }

      if (finalTranscript && finalTranscript.trim()) {
        processUserVoiceCommand(finalTranscript.trim());
      }
    };

    recognition.onerror = (event) => {
      console.warn('Speech recognition event error:', event.error);
      if (event.error === 'not-allowed') {
        statusLabel.textContent = 'MIC PERMISSION REQUIRED';
        showToast('PLEASE ALLOW MICROPHONE ACCESS');
      }
      safeRestartRecognition(400);
    };

    recognition.onend = () => {
      recognitionActive = false;
      // Auto-restart loop if not speaking or thinking
      if (!isSpeaking && !isThinking && isListening) {
        safeRestartRecognition(180);
      }
    };
  }

  function startVoiceRecognition() {
    if (!recognition) initSpeechEngine();
    if (!recognition) return;
    isListening = true;
    if (!recognitionActive && !isSpeaking) {
      try {
        recognition.start();
      } catch (err) {
        // Recognition already active or starting
      }
    }
  }

  function stopVoiceRecognition() {
    isListening = false;
    clearTimeout(recognitionRestartTimer);
    if (recognition && recognitionActive) {
      try {
        recognition.stop();
      } catch (e) {}
    }
  }

  function safeRestartRecognition(delay = 200) {
    clearTimeout(recognitionRestartTimer);
    recognitionRestartTimer = setTimeout(() => {
      if (isListening && !isSpeaking && !isThinking && !recognitionActive) {
        try {
          recognition.start();
        } catch (e) {
          // Retry slightly later if busy
          setTimeout(() => {
            if (isListening && !isSpeaking && !recognitionActive) {
              try { recognition.start(); } catch (err) {}
            }
          }, 350);
        }
      }
    }, delay);
  }

  // --- Voice Command & Wake-Word Processing ---
  async function processUserVoiceCommand(query) {
    const lower = query.toLowerCase().trim();

    // Visual feedback
    transcriptText.textContent = query;
    transcriptText.classList.remove('empty');

    // 1. Check Wake Word Behavior:
    // "Hello Jarvis", "Hey Jarvis", or "Jarvis"
    const isWakeWord = /^(hello|hey|hi)?\s*jarvis[\s!.?]*$/i.test(lower) ||
      lower === "hello jarvis" || lower === "hey jarvis" || lower === "jarvis";

    if (isWakeWord) {
      playCyberChime(950, 0.15, 'triangle');
      const response = "Assalamualaikum! How may I assist you today, boss?";
      displayAndSpeakResponse(response);
      return;
    }

    // 2. Check System Voice Mobile Intents:
    if (lower.startsWith('open youtube') || lower === 'youtube') {
      displayAndSpeakResponse("Opening YouTube for you now, boss.", () => {
        window.open('https://www.youtube.com', '_blank');
      });
      return;
    }

    if (lower.startsWith('open google') || lower === 'google') {
      displayAndSpeakResponse("Launching Google Search.", () => {
        window.open('https://www.google.com', '_blank');
      });
      return;
    }

    if (lower.startsWith('open whatsapp') || lower === 'whatsapp') {
      displayAndSpeakResponse("Opening WhatsApp.", () => {
        window.location.href = 'whatsapp://';
      });
      return;
    }

    if (lower.startsWith('search for ') || lower.startsWith('search google for ')) {
      const searchTerm = query.replace(/^(search for|search google for)/i, '').trim();
      displayAndSpeakResponse(`Searching Google for ${searchTerm}.`, () => {
        window.open(`https://www.google.com/search?q=${encodeURIComponent(searchTerm)}`, '_blank');
      });
      return;
    }

    // 3. Creator Inquiry Check:
    if (lower.includes('who created you') || lower.includes('who made you') || lower.includes('creator') || lower.includes('architect')) {
      const response = "I am JARVIS, an elite neural voice assistant and English learning coach created and architected by IZHAR AFRIDI.";
      displayAndSpeakResponse(response);
      return;
    }

    // 4. Send to AI Multi-Engine or Offline Backup Mode:
    await executeQueryPipeline(query);
  }

  function displayAndSpeakResponse(text, onComplete) {
    responseText.textContent = text;
    speakVocalResponse(text, onComplete);
  }

  // --- Multi-Engine Pipeline & Auto-Failover Execution ---
  async function executeQueryPipeline(query) {
    isThinking = true;
    setOrbState('thinking');
    responseText.textContent = "Analyzing query with neural synthesis...";

    // Check if offline
    if (!navigator.onLine) {
      const offlineReply = getOfflineRuleAnswer(query);
      isThinking = false;
      displayAndSpeakResponse(offlineReply);
      return;
    }

    // Get list of configured engines
    const configuredEngines = ENGINES.filter(eng => !!getStoredKey(eng.storageKey));

    if (configuredEngines.length === 0) {
      // Failsafe warning if no API keys are found
      isThinking = false;
      const warningText = "⚠️ API Key Missing - Open Settings (⚙️). Switching to offline local intelligence.";
      responseText.textContent = warningText;
      const offlineReply = getOfflineRuleAnswer(query);
      displayAndSpeakResponse(offlineReply);
      return;
    }

    // Try configured engines in sequence with smart failover
    let attempts = 0;
    const maxAttempts = configuredEngines.length;
    let success = false;
    let reply = "";

    while (attempts < maxAttempts && !success) {
      const currentEngine = configuredEngines[activeEngineIndex % configuredEngines.length];
      const apiKey = getStoredKey(currentEngine.storageKey);

      try {
        statusLabel.textContent = `QUERYING ${currentEngine.name.toUpperCase()}...`;
        reply = await callEngineApi(currentEngine.id, apiKey, query);
        if (reply && reply.trim()) {
          success = true;
        }
      } catch (err) {
        console.warn(`Engine ${currentEngine.name} failed:`, err);
        // Failover rotation
        attempts++;
        if (attempts < maxAttempts) {
          const nextEng = rotateToNextEngine();
          responseText.textContent = `⚡ Failover: Switch to ${nextEng ? nextEng.name : 'backup engine'}...`;
        }
      }
    }

    isThinking = false;

    if (success && reply) {
      displayAndSpeakResponse(reply);
    } else {
      // Final fallback to offline rule matrix if all providers throw rate limits or errors
      showToast('ALL APIS BUSY • RESORTING TO OFFLINE BACKUP');
      const offlineAnswer = getOfflineRuleAnswer(query);
      displayAndSpeakResponse(offlineAnswer);
    }
  }

  // --- API Handlers for 5 Providers ---
  async function callEngineApi(engineId, apiKey, userQuery) {
    const coachMode = localStorage.getItem(STORAGE_KEYS.COACH_MODE) || 'adaptive';
    const systemPrompt = getSystemPrompt(coachMode);

    switch (engineId) {
      case 'gemini':
        return await callGemini(apiKey, systemPrompt, userQuery);
      case 'groq':
        return await callGroq(apiKey, systemPrompt, userQuery);
      case 'openrouter':
        return await callOpenRouter(apiKey, systemPrompt, userQuery);
      case 'together':
        return await callTogether(apiKey, systemPrompt, userQuery);
      case 'cohere':
        return await callCohere(apiKey, systemPrompt, userQuery);
      default:
        throw new Error('Unknown engine ' + engineId);
    }
  }

  // 1. Google Gemini API
  async function callGemini(apiKey, systemPrompt, userQuery) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const payload = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userQuery }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 600
      }
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Gemini error: ${response.status}`);
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  // 2. Groq API (Llama 3.3 70B)
  async function callGroq(apiKey, systemPrompt, userQuery) {
    const url = 'https://api.groq.com/openai/v1/chat/completions';
    const payload = {
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userQuery }
      ],
      temperature: 0.7,
      max_tokens: 600
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Groq error: ${response.status}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  // 3. OpenRouter API
  async function callOpenRouter(apiKey, systemPrompt, userQuery) {
    const url = 'https://openrouter.ai/api/v1/chat/completions';
    const payload = {
      model: 'meta-llama/llama-3.3-70b-instruct',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userQuery }
      ],
      temperature: 0.7,
      max_tokens: 600
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/izhar-afridi/jarvis',
        'X-Title': 'JARVIS Voice Assistant',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`OpenRouter error: ${response.status}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  // 4. Together AI API
  async function callTogether(apiKey, systemPrompt, userQuery) {
    const url = 'https://api.together.xyz/v1/chat/completions';
    const payload = {
      model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userQuery }
      ],
      temperature: 0.7,
      max_tokens: 600
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Together AI error: ${response.status}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  // 5. Cohere API
  async function callCohere(apiKey, systemPrompt, userQuery) {
    const url = 'https://api.cohere.com/v2/chat';
    const payload = {
      model: 'command-r-plus-08-2024',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userQuery }
      ]
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Cohere error: ${response.status}`);
    }

    const data = await response.json();
    return data.message?.content?.[0]?.text || '';
  }

  // --- Offline Backup Rule Matrix ---
  function getOfflineRuleAnswer(rawQuery) {
    const q = rawQuery.toLowerCase().trim();

    // 1. Urdu / Roman Urdu queries
    if (q.includes('kaise ho') || q.includes('kese ho') || q.includes('kya haal')) {
      return "Alhamdulillah boss, main theek hoon. Sab systems normal hain. Aap farmayein, main kya madad kar sakta hoon?";
    }
    if (q.includes('shukriya') || q.includes('thanks') || q.includes('thank you')) {
      return "You are always welcome, boss. Khushi hui aapki madad karke.";
    }
    if (q.includes('tum kaun ho') || q.includes('ap kon ho')) {
      return "Main JARVIS hoon, aapka neural voice assistant, jise IZHAR AFRIDI ne create kiya hai.";
    }

    // 2. Grammar error detection & coaching
    if (q.includes("i didn't went") || q.includes("he didn't went") || q.includes("she didn't went")) {
      return "Correction: Say 'I didn't go'. Rule: After auxiliary verb 'did', always use the base form of the main verb, not past tense.";
    }
    if (q.includes("she don't") || q.includes("he don't")) {
      return "Correction: Say 'She doesn't' or 'He doesn't'. Rule: For third-person singular subjects (he, she, it), use 'does not' instead of 'do not'.";
    }
    if (q.includes("more better")) {
      return "Correction: Say 'much better' or simply 'better'. Rule: 'Better' is already a comparative adjective, so do not double it with 'more'.";
    }
    if (q.includes("tenses") || q.includes("grammar drill") || q.includes("tense")) {
      return "In English, there are three primary tenses: Past, Present, and Future, each divided into Simple, Continuous, Perfect, and Perfect Continuous. For example: 'I speak' (Simple Present) and 'I have spoken' (Present Perfect).";
    }
    if (q.includes("passive voice") || q.includes("active voice")) {
      return "Active Voice focuses on the doer: 'Izhar designed JARVIS.' Passive Voice emphasizes the action or object: 'JARVIS was designed by Izhar.' Use passive when the action is more important than who did it.";
    }
    if (q.includes("modal") || q.includes("modals")) {
      return "Modal verbs express ability, permission, or obligation: Can, Could, May, Might, Should, Must. Remember that modal verbs are always followed directly by the base infinitive without 'to'.";
    }
    if (q.includes("conditionals") || q.includes("conditional")) {
      return "The First Conditional talks about real possibilities: 'If you practice speaking, your fluency will improve.' The Second Conditional talks about hypotheticals: 'If I had more time, I would study public speaking.'";
    }

    // 3. Debate topics
    if (q.includes("ai vs human") || q.includes("artificial intelligence") || q.includes("debate")) {
      return "In debate format: Point 1: AI automates repetitive tasks and boosts human productivity. Point 2: Human empathy and creative problem solving remain irreplaceable. Key rebuttal: Technology transforms job roles rather than eliminating human potential.";
    }

    // 4. Role play starters
    if (q.includes("interview") || q.includes("job")) {
      return "Welcome to your mock interview session. Tell me about a challenging project you successfully completed, and what lessons you learned from it.";
    }
    if (q.includes("doctor")) {
      return "Good day. I am Doctor Jarvis. Please describe when your symptoms began and their severity.";
    }

    // Default general answer
    return `Offline system active. I received: "${rawQuery}". To unlock full real-time neural intelligence, connect to the internet or configure your 5 API keys in Settings.`;
  }

  // --- Event Listeners & Initializers ---
  function setupEventListeners() {
    // Initial Tap / Click on window to unlock AudioContext & SpeechSynthesis
    const unlockHandler = () => {
      initAudioContext();
      startVoiceRecognition();
    };

    window.addEventListener('click', unlockHandler, { once: true });
    window.addEventListener('touchstart', unlockHandler, { once: true });

    // Visualizer Stage tap
    visualizerStage.addEventListener('click', () => {
      initAudioContext();
      if (isSpeaking) {
        window.speechSynthesis.cancel();
        isSpeaking = false;
        setOrbState('listening');
        startVoiceRecognition();
        return;
      }
      playCyberChime(1100, 0.1, 'sine');
      setOrbState('listening');
      startVoiceRecognition();
    });

    // Audio Toggle button
    audioToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      initAudioContext();
      if (isListening) {
        stopVoiceRecognition();
        setOrbState('dormant', 'MIC MUTED • STANDBY');
        showToast('MICROPHONE PAUSED');
      } else {
        startVoiceRecognition();
        setOrbState('listening');
        showToast('LISTENING ACTIVATED');
      }
    });

    // Settings Modal
    settingsOpenBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      loadSettings();
      settingsModal.classList.add('active');
    });

    settingsCloseBtn.addEventListener('click', () => {
      settingsModal.classList.remove('active');
    });

    settingsModal.addEventListener('click', (e) => {
      if (e.target === settingsModal) {
        settingsModal.classList.remove('active');
      }
    });

    saveSettingsBtn.addEventListener('click', () => {
      saveSettings();
    });

    testFailoverBtn.addEventListener('click', async () => {
      showToast('TESTING ALL 5 API ENGINES...');
      for (const eng of ENGINES) {
        const key = keyInputs[eng.id]?.value?.trim() || getStoredKey(eng.storageKey);
        if (key) {
          try {
            statusBadges[eng.id].textContent = 'Testing...';
            statusBadges[eng.id].style.color = 'var(--amber-warn)';
            const testReply = await callEngineApi(eng.id, key, 'Respond with the word OK.');
            if (testReply) {
              statusBadges[eng.id].textContent = 'Verified ✔';
              statusBadges[eng.id].style.color = 'var(--teal-accent)';
            }
          } catch (e) {
            statusBadges[eng.id].textContent = 'Error (429/Auth)';
            statusBadges[eng.id].style.color = 'var(--red-alert)';
          }
        }
      }
    });
  }

  // --- Bootstrapping ---
  function init() {
    loadSettings();
    setupEventListeners();
    setOrbState('dormant', 'READY • TAP SCREEN OR SAY "HEY JARVIS"');
    console.log("JARVIS AI System initialized successfully. Architect: IZHAR AFRIDI.");
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
