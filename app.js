/**
 * JARVIS Engine — Built by IZHAR AFRIDI
 * Multi-API Provider Auto-Fallback + Hands-Free Voice + English Learning Suite
 */

const SYSTEM_INSTRUCTION = `
You are JARVIS, an advanced voice-first AI assistant and complete English Language Coach built by IZHAR AFRIDI.

KEY BEHAVIORS & RULES:
1. WAKE-WORD RESPONSE:
   - When the user greets with "Hello Jarvis", "Jarvis", or "Hey Jarvis", reply with "Assalamualaikum".
   - When the user responds to your Salam, check their well-being in clear English (e.g., "How are you doing today?").
   - Do NOT ask for the user's name unless explicitly requested.

2. DYNAMIC LANGUAGE ADAPTATION:
   - If the user speaks in Urdu, respond naturally in Urdu / Roman Urdu.
   - If the user speaks in English, respond in English.
   - Support Pakistani English and mixed Urdu-English naturally.

3. ENGLISH LEARNING & CLASSROOM COACHING SUITE (Beginner to Advance):
   - Listen to group discussions or user statements. Correct grammar politely, explain the rule briefly, and offer a better sentence structure.
   - Provide debate arguments, public speaking points, presentation outlines, and vocabulary/idioms.
   - Handle interactive role-plays (Shopkeeper, Doctor, Job Interview, Classroom) and step-by-step practice sessions for Tenses, Modals, Passive Voice, and Conditionals.

4. RESPONSE STYLE:
   - Keep answers short, smart, conversational, and direct for smooth voice delivery.
`;

class JarvisEngine {
    constructor() {
        this.apiKeys = JSON.parse(localStorage.getItem('JARVIS_MULTI_KEYS')) || {
            gemini: '', groq: '', openrouter: '', together: '', cohere: ''
        };
        
        this.providers = ['gemini', 'groq', 'openrouter', 'together', 'cohere'];
        this.currentProviderIndex = 0;
        
        this.synthesis = window.speechSynthesis;
        this.recognition = null;
        this.isGreetingPhase = true;

        this.orb = document.getElementById('jarvisOrb');
        this.stateLabel = document.getElementById('stateLabel');
        this.modeBadge = document.getElementById('modeBadge');

        this.initSpeech();
        this.bindEvents();
        this.loadKeysToModal();
        this.updateModeUI();

        if (!this.hasActiveKey() && navigator.onLine) {
            document.getElementById('keyModal').classList.remove('hidden');
        }
    }

    hasActiveKey() {
        return Object.values(this.apiKeys).some(k => k && k.trim() !== '');
    }

    setOrbState(state) {
        if (this.orb) this.orb.className = 'orb ' + state;
        if (this.stateLabel) this.stateLabel.innerText = state.toUpperCase();
    }

    updateModeUI() {
        if (!this.modeBadge) return;
        if (navigator.onLine && this.hasActiveKey()) {
            const activeName = this.providers[this.currentProviderIndex].toUpperCase();
            this.modeBadge.innerText = `ONLINE (${activeName})`;
            this.modeBadge.style.borderColor = "#00f3ff";
            this.modeBadge.style.color = "#00f3ff";
        } else {
            this.modeBadge.innerText = "OFFLINE MODE";
            this.modeBadge.style.borderColor = "#f59e0b";
            this.modeBadge.style.color = "#f59e0b";
        }
    }

    loadKeysToModal() {
        if (document.getElementById('geminiKey')) document.getElementById('geminiKey').value = this.apiKeys.gemini || '';
        if (document.getElementById('groqKey')) document.getElementById('groqKey').value = this.apiKeys.groq || '';
        if (document.getElementById('openrouterKey')) document.getElementById('openrouterKey').value = this.apiKeys.openrouter || '';
        if (document.getElementById('togetherKey')) document.getElementById('togetherKey').value = this.apiKeys.together || '';
        if (document.getElementById('cohereKey')) document.getElementById('cohereKey').value = this.apiKeys.cohere || '';
    }

    initSpeech() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            alert("Speech Recognition API is not supported on this browser.");
            return;
        }

        this.recognition = new SpeechRecognition();
        this.recognition.continuous = true;
        this.recognition.interimResults = false;
        this.recognition.lang = 'en-US';

        this.recognition.onstart = () => {
            this.setOrbState('listening');
        };

        this.recognition.onresult = (event) => {
            const text = event.results[event.results.length - 1][0].transcript.trim();
            document.getElementById('userSpeech').innerText = "User: " + text;
            this.processInput(text);
        };

        this.recognition.onerror = (err) => {
            console.warn("Speech error:", err);
            this.setOrbState('dormant');
        };

        this.recognition.onend = () => {
            try { this.recognition.start(); } catch(e) {}
        };

        try { this.recognition.start(); } catch(e) {}
    }

    processInput(input) {
        const lower = input.toLowerCase();

        if (lower.includes("open youtube") || lower.includes("youtube kholo")) {
            this.speak("Opening YouTube.");
            setTimeout(() => { window.open("https://www.youtube.com", "_blank"); }, 1000);
            return;
        }
        if (lower.includes("open google") || lower.includes("google kholo")) {
            this.speak("Opening Google.");
            setTimeout(() => { window.open("https://www.google.com", "_blank"); }, 1000);
            return;
        }

        if (this.isGreetingPhase) {
            if (lower.includes("hello jarvis") || lower.includes("hey jarvis") || lower === "jarvis") {
                this.speak("Assalamualaikum");
                return;
            }
            if (lower.includes("walaikum") || lower.includes("salam") || lower.includes("kaise ho") || lower.includes("how are you")) {
                this.isGreetingPhase = false;
                this.speak("How are you doing today? How can I help with your English practice?");
                return;
            }
        }

        this.setOrbState('thinking');

        if (navigator.onLine && this.hasActiveKey()) {
            this.queryMultiApiPipeline(input);
        } else {
            this.queryOfflineEngine(input);
        }
    }

    async queryMultiApiPipeline(prompt) {
        let attempts = 0;

        while (attempts < this.providers.length) {
            const provider = this.providers[this.currentProviderIndex];
            const apiKey = this.apiKeys[provider];

            if (!apiKey || apiKey.trim() === '') {
                this.rotateProvider();
                attempts++;
                continue;
            }

            try {
                let reply = "";
                if (provider === 'gemini') {
                    reply = await this.callGemini(prompt, apiKey);
                } else if (provider === 'groq') {
                    reply = await this.callGroq(prompt, apiKey);
                } else if (provider === 'openrouter') {
                    reply = await this.callOpenRouter(prompt, apiKey);
                } else if (provider === 'together') {
                    reply = await this.callTogether(prompt, apiKey);
                } else if (provider === 'cohere') {
                    reply = await this.callCohere(prompt, apiKey);
                }

                if (reply) {
                    this.speak(reply);
                    return;
                } else {
                    throw new Error("Empty Response");
                }
            } catch (err) {
                console.warn(`Provider ${provider} failed. Rotating...`, err);
                this.rotateProvider();
                attempts++;
            }
        }

        this.queryOfflineEngine(prompt);
    }

    rotateProvider() {
        this.currentProviderIndex = (this.currentProviderIndex + 1) % this.providers.length;
        this.updateModeUI();
    }

    async callGemini(prompt, key) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] }
            })
        });
        if (!res.ok) throw new Error("Gemini API Error");
        const data = await res.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text;
    }

    async callGroq(prompt, key) {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: "llama-3.3-70b-versatile",
                messages: [{ role: "system", content: SYSTEM_INSTRUCTION }, { role: "user", content: prompt }]
            })
        });
        if (!res.ok) throw new Error("Groq API Error");
        const data = await res.json();
        return data.choices?.[0]?.message?.content;
    }

    async callOpenRouter(prompt, key) {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: "meta-llama/llama-3.1-8b-instruct:free",
                messages: [{ role: "system", content: SYSTEM_INSTRUCTION }, { role: "user", content: prompt }]
            })
        });
        if (!res.ok) throw new Error("OpenRouter API Error");
        const data = await res.json();
        return data.choices?.[0]?.message?.content;
    }

    async callTogether(prompt, key) {
        const res = await fetch('https://api.together.xyz/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
                messages: [{ role: "system", content: SYSTEM_INSTRUCTION }, { role: "user", content: prompt }]
            })
        });
        if (!res.ok) throw new Error("Together API Error");
        const data = await res.json();
        return data.choices?.[0]?.message?.content;
    }

    async callCohere(prompt, key) {
        const res = await fetch('https://api.cohere.com/v1/chat', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: prompt, preamble: SYSTEM_INSTRUCTION })
        });
        if (!res.ok) throw new Error("Cohere API Error");
        const data = await res.json();
        return data.text;
    }

    queryOfflineEngine(prompt) {
        const lower = prompt.toLowerCase();
        let reply = "";

        if (lower.includes("topic") || lower.includes("debate") || lower.includes("class")) {
            reply = "Here is an offline debate topic: Is AI a threat or an opportunity for future students?";
        } else if (lower.includes("learning") || lower.includes("aaj kya seekhna hai")) {
            reply = "Today offline activity: Let's practice Present Continuous Tenses.";
        } else {
            reply = "I am ready offline. Ask me for debate topics or English grammar practice.";
        }

        this.speak(reply);
    }

    speak(text) {
        const speechDisplay = document.getElementById('jarvisSpeech');
        if (speechDisplay) speechDisplay.innerText = "JARVIS: " + text;
        this.setOrbState('speaking');

        if (this.synthesis.speaking) this.synthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'en-US';
        utterance.rate = 1.0;
        utterance.pitch = 1.0;

        utterance.onend = () => {
            this.setOrbState('listening');
        };

        utterance.onerror = () => {
            this.setOrbState('listening');
        };

        this.synthesis.speak(utterance);
    }

    bindEvents() {
        const startTouchArea = document.getElementById('startTouchArea');
        if (startTouchArea) {
            startTouchArea.onclick = () => {
                if (this.synthesis && !this.synthesis.speaking) {
                    const unlockAudio = new SpeechSynthesisUtterance("Audio active");
                    this.synthesis.speak(unlockAudio);
                }
            };
        }

        const openBtn = document.getElementById('openKeyModalBtn');
        if (openBtn) {
            openBtn.onclick = () => {
                document.getElementById('keyModal').classList.remove('hidden');
            };
        }

        const saveBtn = document.getElementById('saveKeysBtn');
        if (saveBtn) {
            saveBtn.onclick = () => {
                this.apiKeys = {
                    gemini: document.getElementById('geminiKey').value.trim(),
                    groq: document.getElementById('groqKey').value.trim(),
                    openrouter: document.getElementById('openrouterKey').value.trim(),
                    together: document.getElementById('togetherKey').value.trim(),
                    cohere: document.getElementById('cohereKey').value.trim()
                };

                localStorage.setItem('JARVIS_MULTI_KEYS', JSON.stringify(this.apiKeys));
                document.getElementById('keyModal').classList.add('hidden');
                this.currentProviderIndex = 0;
                this.updateModeUI();
                alert("API Keys Saved Successfully!");
            };
        }

        window.addEventListener('online', () => this.updateModeUI());
        window.addEventListener('offline', () => this.updateModeUI());
    }
}

window.onload = () => { new JarvisEngine(); };
