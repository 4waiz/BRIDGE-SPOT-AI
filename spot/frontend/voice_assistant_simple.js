// Simple Spot Voice Assistant - Just Speech Bubble
// Clean UI showing only Spot's responses

// Explicit assistant states for wake-query-response lifecycle.
const ASSISTANT_STATES = Object.freeze({
    IDLE: 'IDLE',
    GREET: 'GREET',
    LISTEN_QUERY: 'LISTEN_QUERY',
    FOLLOWUP_PROMPT: 'FOLLOWUP_PROMPT',
    LISTEN_FOLLOWUP: 'LISTEN_FOLLOWUP',
    PROCESS: 'PROCESS',
    SPEAK: 'SPEAK',
    COOLDOWN: 'COOLDOWN'
});

const QUERY_TIMEOUT_MS = 20000;
const FOLLOWUP_TIMEOUT_MS = 10000;
const COOLDOWN_MS = 1500;
const TTS_RESUME_DELAY_MS = 400;
const TOAST_DISMISS_MIN_MS = 4000;
const TOAST_DISMISS_MAX_MS = 6000;
const GREETING_TEXT = 'Hi, I am the Spot dog. How may I help you?';
const FOLLOWUP_PROMPT_TEXT = 'Do you have any other question?';
const OFFLINE_MAX_WORDS = 28;
const OFFLINE_MAX_CHARS = 180;
const OFFLINE_UNKNOWN_MESSAGE = 'Offline mode: I can answer BRIDGE overview, programs, schedules, fees, policies, certifications.';

// Small deterministic wake phrase variant lists.
const HEY_VARIANTS = ['hey', 'hi', 'hay', 'hei', 'hello', 'high', 'hig', 'hai', 'heyy', 'hiya'];
const SPOT_VARIANTS = ['spot', 'sport', 'spat', 'spotty', 'spotify', 'esport', 'spott', 'spod'];
const MERGED_WAKE_VARIANTS = ['highspot', 'hayesport', 'heyspot', 'hispot', 'hisport', 'heysport', 'hayespot'];

const OFFLINE_TEMPLATES = Object.freeze({
    overview: 'BRIDGE is EDGE\'s training hub for Industry 4.0, operational excellence, and practical digital transformation skills.',
    programs: 'BRIDGE offers practical programs in Industry 4.0, Lean, analytics, agile methods, and leadership development.',
    schedule: 'I can share BRIDGE course schedules and dates, including the next available training window.',
    fees: 'BRIDGE booking is AED 500 per trainee per day, and no-show fees may also apply.',
    policies: 'BRIDGE requires strong attendance and early cancellation through the official training registration platform.',
    certifications: 'BRIDGE training is included in EDGE\'s ISO 9001:2015 quality management certification scope.',
    unknown: OFFLINE_UNKNOWN_MESSAGE
});

class SimpleSpotAssistant {
    constructor() {
        this.isListening = false;
        this.isProcessing = false;
        this.isSpeaking = false;
        this.audioGate = false;
        this.state = ASSISTANT_STATES.IDLE;
        this.recognition = null;
        this.synthesis = window.speechSynthesis;
        this.recognitionActive = false;
        this.recognitionBlocks = new Set();
        this.queryTimeoutHandle = null;
        this.cooldownTimeoutHandle = null;
        this.resumeRecognitionTimeout = null;
        this.toastDismissHandle = null;
        this.querySessionId = 0;
        this.queryDeadlineAt = 0;
        this.backendUrl = 'http://localhost:5000';
        this.useBryceVoice = false;  // Backend TTS availability
        this.useBackendStt = false;  // Backend STT availability
        this.offlineBriefMode = true;
        this.audioContext = null;
        this.micStream = null;
        this.micSource = null;
        this.micAnalyser = null;
        this.mediaRecorder = null;
        this.isRecording = false;
        this.silenceThreshold = 0.02;
        this.silenceDurationMs = 900;
        this.maxRecordMs = 8000;
        this.mode = 'online';
        this.modeDropdown = null;
        this.modeTrigger = null;
        this.modeLabel = null;
        this.modeIndicator = null;
        this.modeOptions = [];
        this.offlineData = null;
        this.offlineEntries = [];
        this.offlineDataPromise = this.loadOfflineData();

        // Initialize Speech Recognition
        if ('webkitSpeechRecognition' in window) {
            this.recognition = new webkitSpeechRecognition();
        } else if ('SpeechRecognition' in window) {
            this.recognition = new SpeechRecognition();
        } else {
            console.error('Speech Recognition not supported');
            alert('Speech Recognition is not supported in your browser. Please use Chrome or Edge.');
            return;
        }

        this.setupRecognition();
        this.checkBackendAvailability();
        this.initAudioContext();
    }

    initAudioContext() {
        // Initialize Web Audio API context for playing backend audio
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    setState(nextState, reason = '') {
        const prevState = this.state;
        if (prevState === nextState) {
            if (reason) {
                console.log(`[State] ${nextState} (no change) | ${reason}`);
            }
            return;
        }
        this.state = nextState;
        if (reason) {
            console.log(`[State] ${prevState} -> ${nextState} | ${reason}`);
        } else {
            console.log(`[State] ${prevState} -> ${nextState}`);
        }
    }

    blockRecognition(reason) {
        if (!this.recognitionBlocks.has(reason)) {
            this.recognitionBlocks.add(reason);
            console.log(`[Recognition] blocked: ${reason}`);
        }
        this.stopRecognition(`block:${reason}`);
    }

    unblockRecognition(reason) {
        if (this.recognitionBlocks.delete(reason)) {
            console.log(`[Recognition] unblocked: ${reason}`);
        }
        this.ensureRecognitionRunning(`unblock:${reason}`);
    }

    shouldRecognitionRun() {
        if (!this.isListening || !this.recognition || this.audioGate || this.recognitionBlocks.size > 0) {
            return false;
        }
        if (this.state === ASSISTANT_STATES.IDLE) {
            return true;
        }
        return (
            (this.state === ASSISTANT_STATES.LISTEN_QUERY || this.state === ASSISTANT_STATES.LISTEN_FOLLOWUP) &&
            !this.useBackendStt
        );
    }

    ensureRecognitionRunning(reason = '') {
        if (!this.shouldRecognitionRun()) {
            return;
        }
        if (this.recognitionActive) {
            return;
        }
        try {
            this.recognitionActive = true;
            this.recognition.start();
            if (reason) {
                console.log(`[Recognition] start requested (${reason})`);
            }
        } catch (e) {
            this.recognitionActive = false;
            const message = e && e.message ? e.message.toLowerCase() : '';
            if (!message.includes('already started')) {
                console.log('[Recognition] start error:', e);
            }
        }
    }

    stopRecognition(reason = '') {
        if (!this.recognition) {
            return;
        }
        if (!this.recognitionActive) {
            return;
        }
        try {
            this.recognition.stop();
            if (reason) {
                console.log(`[Recognition] stop requested (${reason})`);
            }
        } catch (e) {
            this.recognitionActive = false;
            const message = e && e.message ? e.message.toLowerCase() : '';
            if (!message.includes('already') && !message.includes('abort')) {
                console.log('[Recognition] stop error:', e);
            }
        }
    }

    clearQueryTimeout() {
        if (!this.queryTimeoutHandle) {
            return;
        }
        clearTimeout(this.queryTimeoutHandle);
        this.queryTimeoutHandle = null;
    }

    clearCooldownTimeout() {
        if (!this.cooldownTimeoutHandle) {
            return;
        }
        clearTimeout(this.cooldownTimeoutHandle);
        this.cooldownTimeoutHandle = null;
    }

    clearResumeRecognitionTimeout() {
        if (!this.resumeRecognitionTimeout) {
            return;
        }
        clearTimeout(this.resumeRecognitionTimeout);
        this.resumeRecognitionTimeout = null;
    }

    clearToastDismissTimer() {
        if (!this.toastDismissHandle) {
            return;
        }
        clearTimeout(this.toastDismissHandle);
        this.toastDismissHandle = null;
    }

    cancelActiveRecording() {
        if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
            try {
                this.mediaRecorder.stop();
            } catch (e) {
                console.log('Recorder stop error:', e);
            }
        }
    }

    nextQuerySessionId() {
        this.querySessionId += 1;
        return this.querySessionId;
    }

    beginQueryWindow(
        reason = '',
        targetState = ASSISTANT_STATES.LISTEN_QUERY,
        timeoutMs = QUERY_TIMEOUT_MS
    ) {
        if (!this.isListening) {
            return;
        }

        // Every query window gets a session id so stale async callbacks are ignored.
        this.clearQueryTimeout();
        this.cancelActiveRecording();
        const sessionId = this.nextQuerySessionId();

        this.queryDeadlineAt = Date.now() + timeoutMs;
        const isFollowup = targetState === ASSISTANT_STATES.LISTEN_FOLLOWUP;
        const stateReason = reason || (isFollowup ? 'Ready for follow-up query' : 'Ready for user query');
        this.setState(targetState, stateReason);
        console.log(
            `[Query] Listening for ${isFollowup ? 'follow-up' : 'user'} query for ${timeoutMs}ms (session ${sessionId})`
        );

        this.queryTimeoutHandle = setTimeout(() => {
            if (!this.isListening || this.state !== targetState || this.querySessionId !== sessionId) {
                return;
            }
            console.log(`[Query] No ${isFollowup ? 'follow-up' : 'query'} received within timeout; returning to IDLE`);
            this.enterIdle('Query timeout');
        }, timeoutMs);

        if (this.useBackendStt) {
            this.blockRecognition('backend-stt');
            this.listenForQuery(sessionId, targetState);
        } else {
            this.unblockRecognition('backend-stt');
            this.ensureRecognitionRunning('listen-query-browser-stt');
        }
    }

    beginFollowupWindow(reason = '') {
        this.beginQueryWindow(reason, ASSISTANT_STATES.LISTEN_FOLLOWUP, FOLLOWUP_TIMEOUT_MS);
    }

    closeQueryWindow(reason = '') {
        this.clearQueryTimeout();
        this.queryDeadlineAt = 0;
        this.nextQuerySessionId();
        this.cancelActiveRecording();
        this.unblockRecognition('backend-stt');
        if (reason) {
            console.log(`[Query] Closed query window | ${reason}`);
        }
    }

    enterIdle(reason = '') {
        this.clearCooldownTimeout();
        this.clearQueryTimeout();
        this.cancelActiveRecording();
        this.queryDeadlineAt = 0;
        this.unblockRecognition('backend-stt');
        this.unblockRecognition('cooldown');
        this.setState(ASSISTANT_STATES.IDLE, reason || 'Wake listening');
        this.ensureRecognitionRunning('enter-idle');
    }

    enterCooldown(reason = '') {
        this.closeQueryWindow('Entering cooldown');
        this.setState(ASSISTANT_STATES.COOLDOWN, reason || 'Post-response cooldown');
        this.blockRecognition('cooldown');
        this.clearCooldownTimeout();
        this.cooldownTimeoutHandle = setTimeout(() => {
            this.cooldownTimeoutHandle = null;
            this.unblockRecognition('cooldown');
            if (this.isListening) {
                this.enterIdle('Cooldown complete');
            }
        }, COOLDOWN_MS);
    }

    beginTtsPlayback(reason = '') {
        this.clearResumeRecognitionTimeout();
        // Audio gate blocks wake/query handling while TTS is audible.
        this.audioGate = true;
        this.isSpeaking = true;
        this.setState(ASSISTANT_STATES.SPEAK, reason || 'TTS playback');
        this.blockRecognition('tts');
    }

    endTtsPlayback(onComplete) {
        this.isSpeaking = false;
        console.log(`[AudioGate] TTS ended, resuming recognition after ${TTS_RESUME_DELAY_MS}ms`);
        this.clearResumeRecognitionTimeout();
        this.resumeRecognitionTimeout = setTimeout(() => {
            this.resumeRecognitionTimeout = null;
            this.audioGate = false;
            this.unblockRecognition('tts');
            if (onComplete) {
                onComplete();
            }
        }, TTS_RESUME_DELAY_MS);
    }

    async ensureMicStream() {
        if (this.micStream) {
            return;
        }
        this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.micSource = this.audioContext.createMediaStreamSource(this.micStream);
        this.micAnalyser = this.audioContext.createAnalyser();
        this.micAnalyser.fftSize = 2048;
        this.micSource.connect(this.micAnalyser);
    }

    startSilenceMonitor(onSilence) {
        if (!this.micAnalyser) {
            return () => {};
        }
        const data = new Uint8Array(this.micAnalyser.fftSize);
        let silenceMs = 0;
        let lastTime = performance.now();
        let active = true;
        const tick = () => {
            if (!active || !this.isRecording) {
                return;
            }
            this.micAnalyser.getByteTimeDomainData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) {
                const value = (data[i] - 128) / 128;
                sum += value * value;
            }
            const rms = Math.sqrt(sum / data.length);
            const now = performance.now();
            const delta = now - lastTime;
            lastTime = now;
            if (rms < this.silenceThreshold) {
                silenceMs += delta;
            } else {
                silenceMs = 0;
            }
            if (silenceMs >= this.silenceDurationMs) {
                onSilence();
                return;
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return () => {
            active = false;
        };
    }

    async captureQueryAudio(maxDurationMs = this.maxRecordMs) {
        await this.ensureMicStream();
        this.isRecording = true;
        const recorder = new MediaRecorder(this.micStream, { mimeType: 'audio/webm' });
        this.mediaRecorder = recorder;
        const chunks = [];
        recorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
                chunks.push(event.data);
            }
        };
        const stopPromise = new Promise((resolve) => {
            recorder.onstop = resolve;
        });

        recorder.start(250);
        const stopSilenceMonitor = this.startSilenceMonitor(() => {
            if (recorder.state === 'recording') {
                recorder.stop();
            }
        });
        const maxTimer = setTimeout(() => {
            if (recorder.state === 'recording') {
                recorder.stop();
            }
        }, maxDurationMs);

        await stopPromise;
        clearTimeout(maxTimer);
        stopSilenceMonitor();
        this.isRecording = false;
        this.mediaRecorder = null;

        if (!chunks.length) {
            return null;
        }
        return new Blob(chunks, { type: recorder.mimeType });
    }

    async transcribeWithBackend(audioBlob) {
        const formData = new FormData();
        formData.append('audio', audioBlob, 'query.webm');
        const response = await fetch(`${this.backendUrl}/stt`, {
            method: 'POST',
            body: formData
        });
        if (!response.ok) {
            throw new Error(`Backend STT failed: ${response.status}`);
        }
        const data = await response.json();
        return data && data.text ? data.text.trim() : '';
    }

    async listenForQuery(sessionId, expectedState = ASSISTANT_STATES.LISTEN_QUERY) {
        if (!this.useBackendStt) {
            return;
        }
        console.log(`[Query] Backend STT loop started (session ${sessionId}, state=${expectedState})`);

        while (
            this.isListening &&
            this.state === expectedState &&
            this.querySessionId === sessionId
        ) {
            const remainingMs = this.queryDeadlineAt - Date.now();
            if (remainingMs <= 0) {
                return;
            }

            try {
                const captureMs = Math.max(300, Math.min(this.maxRecordMs, remainingMs));
                const audioBlob = await this.captureQueryAudio(captureMs);

                if (
                    !this.isListening ||
                    this.state !== expectedState ||
                    this.querySessionId !== sessionId
                ) {
                    return;
                }

                if (!audioBlob) {
                    continue;
                }

                const transcript = await this.transcribeWithBackend(audioBlob);
                if (
                    !this.isListening ||
                    this.state !== expectedState ||
                    this.querySessionId !== sessionId
                ) {
                    return;
                }

                if (transcript && transcript.trim()) {
                    console.log('[Query] Backend STT transcript:', transcript.trim());
                    const consumed = this.handleQueryTranscript(transcript.trim(), 'backend-stt');
                    if (consumed) {
                        return;
                    }
                    continue;
                }
            } catch (error) {
                console.error('Backend STT failed during query listen:', error);
                this.useBackendStt = false;
                this.unblockRecognition('backend-stt');
                if (
                    this.isListening &&
                    (this.state === ASSISTANT_STATES.LISTEN_QUERY || this.state === ASSISTANT_STATES.LISTEN_FOLLOWUP)
                ) {
                    this.ensureRecognitionRunning('backend-stt-fallback');
                }
                return;
            }
        }
    }

    async checkBackendAvailability() {
        try {
            const response = await fetch(`${this.backendUrl}/health`, {
                method: 'GET',
                timeout: 2000
            });
            const data = await response.json();
            if (data.status === 'healthy') {
                this.useBryceVoice = true;
                this.useBackendStt = true;
                console.log('OpenAI voice backend is available');
            }
        } catch (error) {
            console.log('OpenAI voice backend not available, using browser voices');
            this.useBryceVoice = false;
            this.useBackendStt = false;
        }
    }

    bindModeToggle() {
        const dropdown = document.getElementById('assistant-mode-dropdown');
        if (!dropdown) {
            return;
        }
        const trigger = dropdown.querySelector('[data-role="mode-trigger"]');
        const label = dropdown.querySelector('[data-role="mode-label"]');
        const indicator = dropdown.querySelector('[data-role="mode-indicator"]');
        const options = Array.from(dropdown.querySelectorAll('[data-mode]'));
        if (!trigger || !label || !indicator || !options.length) {
            return;
        }

        this.modeDropdown = dropdown;
        this.modeTrigger = trigger;
        this.modeLabel = label;
        this.modeIndicator = indicator;
        this.modeOptions = options;

        this.updateModeUI();

        trigger.addEventListener('click', (event) => {
            event.stopPropagation();
            this.toggleModeMenu();
        });

        options.forEach((option) => {
            option.addEventListener('click', (event) => {
                event.stopPropagation();
                const nextMode = option.getAttribute('data-mode');
                this.setMode(nextMode);
                this.closeModeMenu();
            });
        });

        document.addEventListener('click', (event) => {
            if (!this.modeDropdown) {
                return;
            }
            if (!this.modeDropdown.contains(event.target)) {
                this.closeModeMenu();
            }
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                this.closeModeMenu();
            }
        });
    }

    setMode(mode) {
        if (mode !== 'online' && mode !== 'offline') {
            return;
        }
        this.mode = mode;
        if (this.mode === 'offline') {
            this.offlineBriefMode = true;
        } else {
            this.clearToastDismissTimer();
        }
        this.updateModeUI();
        this.updateBubbleMode();
    }

    updateModeUI() {
        const isOnline = this.mode === 'online';
        if (this.modeLabel) {
            this.modeLabel.textContent = isOnline ? 'Online Mode' : 'Offline Mode';
        }
        if (this.modeIndicator) {
            this.modeIndicator.classList.toggle('online', isOnline);
            this.modeIndicator.classList.toggle('offline', !isOnline);
        }
        if (this.modeOptions && this.modeOptions.length) {
            this.modeOptions.forEach((option) => {
                const isActive = option.getAttribute('data-mode') === this.mode;
                option.classList.toggle('is-active', isActive);
                option.setAttribute('aria-selected', String(isActive));
            });
        }
    }

    updateBubbleMode() {
        const bubble = document.getElementById('simple-chat-bubble');
        if (!bubble) {
            return;
        }
        bubble.classList.toggle('offline-toast', this.mode === 'offline');
    }

    toggleModeMenu() {
        if (!this.modeDropdown) {
            return;
        }
        if (this.modeDropdown.classList.contains('open')) {
            this.closeModeMenu();
        } else {
            this.openModeMenu();
        }
    }

    openModeMenu() {
        if (!this.modeDropdown) {
            return;
        }
        this.modeDropdown.classList.add('open');
        if (this.modeTrigger) {
            this.modeTrigger.setAttribute('aria-expanded', 'true');
        }
    }

    closeModeMenu() {
        if (!this.modeDropdown) {
            return;
        }
        this.modeDropdown.classList.remove('open');
        if (this.modeTrigger) {
            this.modeTrigger.setAttribute('aria-expanded', 'false');
        }
    }

    async loadOfflineData() {
        try {
            const response = await fetch('bridge_offline_conversation.json', { cache: 'no-store' });
            if (!response.ok) {
                throw new Error(`Offline data fetch failed: ${response.status}`);
            }
            const data = await response.json();
            if (!data || !Array.isArray(data.entries)) {
                throw new Error('Offline data format invalid');
            }
            this.offlineData = data;
            this.offlineEntries = data.entries.map((entry) => {
                const keywords = Array.isArray(entry.keywords) ? entry.keywords : [];
                const matchText = this.normalizeText(
                    [entry.id, entry.title, entry.answer, keywords.join(' ')].filter(Boolean).join(' ')
                );
                return { ...entry, keywords, matchText };
            });
        } catch (error) {
            console.log('Offline conversation load failed:', error);
            this.offlineData = null;
            this.offlineEntries = [];
        }
    }

    normalizeText(text) {
        return (text || '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    tokenize(text) {
        const normalized = this.normalizeText(text);
        if (!normalized) {
            return [];
        }
        return normalized.split(' ').filter((token) => token.length > 2);
    }

    normalizeOfflineText(text) {
        return (text || '')
            .replace(/[\r\n]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    truncateOfflineText(text) {
        let normalized = this.normalizeOfflineText(text);
        if (!normalized) {
            return '';
        }

        let truncated = false;
        const words = normalized.split(/\s+/);
        if (words.length > OFFLINE_MAX_WORDS) {
            normalized = words.slice(0, OFFLINE_MAX_WORDS).join(' ');
            truncated = true;
        }

        if (normalized.length > OFFLINE_MAX_CHARS) {
            let cut = normalized.slice(0, OFFLINE_MAX_CHARS);
            cut = cut.replace(/\s+\S*$/, '').trim();
            if (!cut) {
                cut = normalized.slice(0, OFFLINE_MAX_CHARS).trim();
            }
            normalized = cut;
            truncated = true;
        }

        if (truncated) {
            normalized = normalized.replace(/[.]+$/, '');
            normalized += '...';
        }

        return normalized;
    }

    findStrongOfflineEntry(query) {
        if (!this.offlineEntries || !this.offlineEntries.length) {
            return null;
        }

        const normalizedQuery = this.normalizeText(query);
        const tokens = this.tokenize(query);
        let bestScore = 0;
        let bestEntry = null;

        for (const entry of this.offlineEntries) {
            let score = 0;
            if (entry.keywords && entry.keywords.length) {
                for (const keyword of entry.keywords) {
                    const normalizedKeyword = this.normalizeText(keyword);
                    if (!normalizedKeyword) {
                        continue;
                    }
                    if (normalizedQuery.includes(normalizedKeyword)) {
                        score += normalizedQuery === normalizedKeyword ? 8 : 5;
                    }
                }
            }
            for (const token of tokens) {
                if (entry.matchText.includes(token)) {
                    score += 1;
                }
            }
            if (score > bestScore) {
                bestScore = score;
                bestEntry = entry;
            }
        }

        return bestScore >= 7 ? bestEntry : null;
    }

    classifyOfflineIntent(query) {
        const normalizedQuery = this.normalizeText(query);
        if (!normalizedQuery) {
            return 'unknown';
        }

        if (
            /\bwhat is bridge\b/.test(normalizedQuery) ||
            /\bwho are you\b/.test(normalizedQuery) ||
            /\bwhat do you do\b/.test(normalizedQuery) ||
            /\babout bridge\b/.test(normalizedQuery) ||
            /\bbridge overview\b/.test(normalizedQuery)
        ) {
            return 'overview';
        }
        if (/\bprograms?\b|\bcourses?\b|\btraining\b/.test(normalizedQuery)) {
            return 'programs';
        }
        if (/\bschedules?\b|\bdates?\b|\bcalendar\b/.test(normalizedQuery)) {
            return 'schedule';
        }
        if (/\bfees?\b|\bprices?\b|\bcosts?\b|\bpricing\b/.test(normalizedQuery)) {
            return 'fees';
        }
        if (/\bpolic(?:y|ies)\b|\brefund\b|\battendance\b/.test(normalizedQuery)) {
            return 'policies';
        }
        if (/\bcertificates?\b|\bcertifications?\b/.test(normalizedQuery)) {
            return 'certifications';
        }
        return 'unknown';
    }

    getOfflineUiHint(intent) {
        if (intent === 'overview' || intent === 'unknown') {
            return 'Try: programs, schedules, or fees.';
        }
        return '';
    }

    getOfflineAnswer(query) {
        const intent = this.classifyOfflineIntent(query);
        const template = OFFLINE_TEMPLATES[intent] || OFFLINE_TEMPLATES.unknown;
        const strongEntry = this.findStrongOfflineEntry(query);
        const preferredText = strongEntry && strongEntry.answer ? strongEntry.answer : template;
        const text = this.offlineBriefMode ? this.truncateOfflineText(preferredText) : this.normalizeOfflineText(preferredText);

        return {
            text,
            uiHint: this.getOfflineUiHint(intent),
            intent
        };
    }

    isMeaningfulFollowupInput(text) {
        const normalized = this.normalizeText(text);
        if (!normalized || normalized.length < 2) {
            return false;
        }
        if (/^(uh+|um+)$/.test(normalized)) {
            return false;
        }
        return true;
    }

    normalizeWakeText(text) {
        const deAccented = (text || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '');
        return this.normalizeText(deAccented);
    }

    toWakePhonetic(token) {
        let output = this.normalizeWakeText(token).replace(/\s+/g, '');
        output = output
            .replace(/ph/g, 'f')
            .replace(/ck/g, 'k')
            .replace(/qu/g, 'kw')
            .replace(/ee|ea|ei|ey|ay/g, 'e')
            .replace(/oo|ou/g, 'u')
            .replace(/tt/g, 't')
            .replace(/([a-z])\1+/g, '$1');

        if (output.length > 3) {
            output = output[0] + output.slice(1).replace(/[aeiou]/g, '');
        }
        return output;
    }

    editDistance(left, right) {
        if (left === right) {
            return 0;
        }
        if (!left.length) {
            return right.length;
        }
        if (!right.length) {
            return left.length;
        }

        const rows = left.length + 1;
        const cols = right.length + 1;
        const dp = Array.from({ length: rows }, () => new Array(cols).fill(0));

        for (let i = 0; i < rows; i++) {
            dp[i][0] = i;
        }
        for (let j = 0; j < cols; j++) {
            dp[0][j] = j;
        }

        for (let i = 1; i < rows; i++) {
            for (let j = 1; j < cols; j++) {
                const cost = left[i - 1] === right[j - 1] ? 0 : 1;
                dp[i][j] = Math.min(
                    dp[i - 1][j] + 1,
                    dp[i][j - 1] + 1,
                    dp[i - 1][j - 1] + cost
                );
            }
        }
        return dp[left.length][right.length];
    }

    allowedWakeDistance(a, b) {
        const maxLen = Math.max(a.length, b.length);
        return maxLen <= 4 ? 1 : 2;
    }

    tokenMatchesWakeVariant(token, variants) {
        const normalizedToken = this.normalizeWakeText(token).replace(/\s+/g, '');
        if (!normalizedToken) {
            return false;
        }
        const phoneticToken = this.toWakePhonetic(normalizedToken);

        for (const variant of variants) {
            const normalizedVariant = this.normalizeWakeText(variant).replace(/\s+/g, '');
            if (!normalizedVariant) {
                continue;
            }

            if (normalizedToken === normalizedVariant) {
                return true;
            }

            const plainDistance = this.editDistance(normalizedToken, normalizedVariant);
            if (plainDistance <= this.allowedWakeDistance(normalizedToken, normalizedVariant)) {
                return true;
            }

            const phoneticVariant = this.toWakePhonetic(normalizedVariant);
            if (phoneticToken === phoneticVariant) {
                return true;
            }

            const phoneticDistance = this.editDistance(phoneticToken, phoneticVariant);
            if (phoneticDistance <= this.allowedWakeDistance(phoneticToken, phoneticVariant)) {
                return true;
            }
        }
        return false;
    }

    isWakePhrase(transcript) {
        const normalized = this.normalizeWakeText(transcript);
        if (!normalized) {
            return false;
        }
        const tokens = normalized.split(' ').filter(Boolean);
        const joined = normalized.replace(/\s+/g, '');
        if (!tokens.length) {
            return false;
        }

        // Handles merged wake transcriptions like "highspot" or "hayesport".
        if (MERGED_WAKE_VARIANTS.some((variant) => joined.includes(variant))) {
            console.log(`[Wake] Matched merged wake phrase | transcript="${normalized}"`);
            return true;
        }

        const heyIndices = [];
        const spotIndices = [];
        tokens.forEach((token, index) => {
            if (this.tokenMatchesWakeVariant(token, HEY_VARIANTS)) {
                heyIndices.push(index);
            }
            if (this.tokenMatchesWakeVariant(token, SPOT_VARIANTS)) {
                spotIndices.push(index);
            }
        });

        if (!heyIndices.length || !spotIndices.length) {
            return false;
        }

        // Wake words must be close: up to two words between "hey/hi" and "spot".
        for (const heyIndex of heyIndices) {
            for (const spotIndex of spotIndices) {
                const wordsBetween = Math.abs(heyIndex - spotIndex) - 1;
                if (wordsBetween <= 2) {
                    console.log(
                        `[Wake] Matched wake phrase | transcript="${normalized}" | hey@${heyIndex} spot@${spotIndex}`
                    );
                    return true;
                }
            }
        }

        console.log(`[Wake] Rejected wake phrase by distance | transcript="${normalized}"`);
        return false;
    }

    handleWakePhraseDetected(transcript) {
        if (!this.isListening || this.audioGate || this.state !== ASSISTANT_STATES.IDLE) {
            return;
        }
        const normalized = this.normalizeWakeText(transcript);
        this.setState(ASSISTANT_STATES.GREET, `Wake phrase detected: "${normalized}"`);
        this.showTyping();

        this.speak(
            GREETING_TEXT,
            () => {
                if (!this.isListening) {
                    return;
                }
                this.beginQueryWindow('Greeting completed');
            },
            () => {
                this.showMessage(GREETING_TEXT);
            }
        );
    }

    handleQueryTranscript(query, source = 'browser-stt') {
        const normalizedQuery = (query || '').trim();
        if (!normalizedQuery) {
            return false;
        }
        const isListeningState =
            this.state === ASSISTANT_STATES.LISTEN_QUERY || this.state === ASSISTANT_STATES.LISTEN_FOLLOWUP;
        if (!this.isListening || this.audioGate || !isListeningState) {
            return false;
        }

        if (this.state === ASSISTANT_STATES.LISTEN_FOLLOWUP && !this.isMeaningfulFollowupInput(normalizedQuery)) {
            console.log(`[Followup] Ignored non-meaningful follow-up input: "${normalizedQuery}"`);
            return false;
        }

        console.log(`[Query] Received (${source}): ${normalizedQuery}`);
        this.closeQueryWindow(`Query received from ${source}`);
        this.handleQuery(normalizedQuery, source);
        return true;
    }

    setupRecognition() {
        this.recognition.continuous = true;
        this.recognition.interimResults = false;
        this.recognition.lang = 'en-US';
        this.recognition.maxAlternatives = 1;

        this.recognition.onstart = () => {
            this.recognitionActive = true;
            console.log(`[Recognition] started | state=${this.state}`);
        };

        this.recognition.onresult = (event) => {
            const lastResult = event.results[event.results.length - 1];
            const transcript = lastResult && lastResult[0] ? lastResult[0].transcript.trim() : '';
            if (!transcript) {
                return;
            }

            const normalizedTranscript = this.normalizeWakeText(transcript);
            console.log(`[STT] Heard | state=${this.state} | text="${normalizedTranscript}"`);

            if (!this.isListening) {
                return;
            }

            if (this.audioGate) {
                console.log('[STT] Ignored because audioGate is active');
                return;
            }

            if (this.state === ASSISTANT_STATES.IDLE) {
                if (this.isWakePhrase(transcript)) {
                    this.handleWakePhraseDetected(transcript);
                }
                return;
            }

            if (
                (this.state === ASSISTANT_STATES.LISTEN_QUERY || this.state === ASSISTANT_STATES.LISTEN_FOLLOWUP) &&
                !this.useBackendStt
            ) {
                this.handleQueryTranscript(transcript, 'browser-stt');
                return;
            }

            console.log(`[STT] Ignored in state ${this.state}`);
        };

        this.recognition.onerror = (event) => {
            console.error('Speech recognition error:', event.error);
            if (event.error !== 'no-speech') {
                this.recognitionActive = false;
            }
            if (event.error === 'not-allowed') {
                this.showMessage('Microphone access denied');
            }
        };

        this.recognition.onend = () => {
            this.recognitionActive = false;
            console.log(
                `[Recognition] ended | state=${this.state} | gate=${this.audioGate} | blocks=${[...this.recognitionBlocks].join(',') || 'none'}`
            );
            if (!this.isListening) {
                return;
            }
            setTimeout(() => {
                this.ensureRecognitionRunning('recognition-onend');
            }, 100);
        };
    }

    start() {
        if (!this.recognition) {
            alert('Speech recognition not available');
            return;
        }

        this.isListening = true;
        this.isProcessing = false;
        this.isSpeaking = false;
        this.audioGate = false;
        this.recognitionActive = false;
        this.recognitionBlocks.clear();
        this.clearQueryTimeout();
        this.clearCooldownTimeout();
        this.clearResumeRecognitionTimeout();
        this.showBubble();
        this.showMessage('Say "Hey Spot" or "Hi Spot" to start...');
        this.enterIdle('Assistant started');
    }

    stop() {
        this.isListening = false;
        this.isProcessing = false;
        this.isSpeaking = false;
        this.audioGate = false;
        this.recognitionActive = false;
        this.clearQueryTimeout();
        this.clearCooldownTimeout();
        this.clearResumeRecognitionTimeout();
        this.clearToastDismissTimer();
        this.queryDeadlineAt = 0;
        this.nextQuerySessionId();
        this.cancelActiveRecording();
        this.recognitionBlocks.clear();
        this.stopRecognition('assistant-stop');
        this.synthesis.cancel();
        this.setState(ASSISTANT_STATES.IDLE, 'Assistant stopped');
        this.hideBubble();
    }

    async handleQuery(query, source = 'unknown') {
        const normalizedQuery = (query || '').trim();
        if (!normalizedQuery || !this.isListening) {
            return;
        }

        this.isProcessing = true;
        this.setState(ASSISTANT_STATES.PROCESS, `Processing query from ${source}`);
        console.log(`[Query] Processing: "${normalizedQuery}"`);
        this.showTyping();

        let answerPayload = { text: '', uiHint: '' };
        try {
            answerPayload = await this.getAnswer(normalizedQuery);
        } catch (error) {
            console.error('Query processing failed:', error);
        }

        if (!this.isListening) {
            this.isProcessing = false;
            return;
        }

        const payload = typeof answerPayload === 'string'
            ? { text: answerPayload, uiHint: '' }
            : (answerPayload || { text: '', uiHint: '' });

        const responseHint = payload.uiHint ? payload.uiHint.trim() : '';
        let responseText = payload.text ? payload.text.trim() : '';
        if (this.mode === 'offline' && this.offlineBriefMode) {
            responseText = this.truncateOfflineText(responseText);
        }

        if (!responseText) {
            console.log('[Query] Empty answer, returning to IDLE');
            this.isProcessing = false;
            this.enterIdle('No response generated');
            return;
        }

        this.speak(
            responseText,
            () => {
                this.isProcessing = false;
                if (!this.isListening) {
                    return;
                }
                this.startFollowupPrompt();
            },
            () => {
                this.showMessage(responseText, { hint: responseHint });
            }
        );
    }

    startFollowupPrompt() {
        if (!this.isListening) {
            return;
        }

        this.setState(ASSISTANT_STATES.FOLLOWUP_PROMPT, 'Prompting for follow-up question');
        this.speak(
            FOLLOWUP_PROMPT_TEXT,
            () => {
                if (!this.isListening) {
                    return;
                }
                this.beginFollowupWindow('Follow-up prompt completed');
            },
            () => {
                this.showMessage(FOLLOWUP_PROMPT_TEXT);
            }
        );
    }

    async getAnswer(query) {
        if (this.mode === 'offline') {
            return this.getOfflineAnswer(query);
        }
        try {
            const response = await fetch(`${this.backendUrl}/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ text: query })
            });

            if (!response.ok) {
                throw new Error(`OpenAI request failed: ${response.status}`);
            }

            const data = await response.json();
            const answer = data && data.answer ? data.answer.trim() : '';
            if (!answer) {
                throw new Error('OpenAI returned an empty response');
            }

            return { text: answer, uiHint: '' };
        } catch (error) {
            console.log('OpenAI unavailable:', error);
            return { text: "I'm having trouble reaching OpenAI right now. Please try again.", uiHint: '' };
        }
    }

    async speak(text, onComplete, onStart) {
        const spokenText = (text || '').trim();
        if (!spokenText) {
            if (onComplete) {
                onComplete();
            }
            return;
        }

        this.beginTtsPlayback(`Speaking text (${spokenText.slice(0, 60)})`);
        if (this.useBryceVoice) {
            const backendStarted = await this.speakWithBryce(spokenText, onComplete, onStart);
            if (backendStarted) {
                return;
            }
            this.useBryceVoice = false;
        }
        this.speakWithBrowser(spokenText, onComplete, onStart, true);
    }

    async speakWithBryce(text, onComplete, onStart) {
        try {
            console.log('Speaking with backend voice:', text);

            // Call backend TTS API
            const response = await fetch(`${this.backendUrl}/tts-base64`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ text: text })
            });

            if (!response.ok) {
                throw new Error(`Backend TTS failed: ${response.status}`);
            }

            const data = await response.json();

            // Decode base64 audio
            const audioData = atob(data.audio);
            const arrayBuffer = new ArrayBuffer(audioData.length);
            const view = new Uint8Array(arrayBuffer);
            for (let i = 0; i < audioData.length; i++) {
                view[i] = audioData.charCodeAt(i);
            }

            // Decode and play audio
            const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
            const source = this.audioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(this.audioContext.destination);

            source.onended = () => {
                console.log('Finished speaking (backend)');
                this.endTtsPlayback(onComplete);
            };

            if (onStart) {
                onStart();
            }
            source.start(0);
            return true;

        } catch (error) {
            console.error('Error with backend voice, falling back to browser:', error);
            return false;
        }
    }

    speakWithBrowser(text, onComplete, onStart, reuseActiveSession = false) {
        this.synthesis.cancel();

        if (!reuseActiveSession) {
            this.beginTtsPlayback(`Speaking text (${text.slice(0, 60)})`);
        }

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.95;  // Slightly slower for clarity
        utterance.pitch = 0.85; // Lower pitch for a deeper, more professional voice
        utterance.volume = 1.0;
        utterance.lang = 'en-US';

        const voices = this.synthesis.getVoices();

        // Priority order for voice selection - professional male voices
        const voicePreferences = [
            'Microsoft David',           // Windows - deep male voice
            'Microsoft Mark',            // Windows - professional male
            'Google US English Male',    // Chrome - clear male voice
            'Microsoft Guy',             // Windows - natural male
            'Alex',                      // macOS - high quality male
            'Daniel',                    // macOS - British male
        ];

        // Find the first available voice from preferences
        let selectedVoice = null;
        for (const prefName of voicePreferences) {
            selectedVoice = voices.find(voice =>
                voice.name.includes(prefName)
            );
            if (selectedVoice) {
                console.log('Selected voice:', selectedVoice.name);
                break;
            }
        }

        // If no preferred voice found, try any male voice
        if (!selectedVoice) {
            selectedVoice = voices.find(voice =>
                voice.name.toLowerCase().includes('male') ||
                voice.name.toLowerCase().includes('david') ||
                voice.name.toLowerCase().includes('mark')
            );
        }

        if (selectedVoice) {
            utterance.voice = selectedVoice;
            console.log('Using voice:', selectedVoice.name);
        }

        utterance.onstart = () => {
            if (onStart) {
                onStart();
            }
        };

        // When speech ends, mark as not speaking and call callback
        utterance.onend = () => {
            console.log('Speech finished');
            this.endTtsPlayback(onComplete);
        };

        // Handle errors
        utterance.onerror = (event) => {
            console.error('Speech error:', event);
            this.endTtsPlayback(onComplete);
        };

        this.synthesis.speak(utterance);
    }

    showBubble() {
        this.updateBubbleMode();
        const bubble = document.getElementById('simple-chat-bubble');
        if (bubble) {
            bubble.classList.add('active');
        }
    }

    hideBubble() {
        this.clearToastDismissTimer();
        const bubble = document.getElementById('simple-chat-bubble');
        if (bubble) {
            bubble.classList.remove('active');
        }
    }

    showMessage(text, options = {}) {
        const message = (text || '').trim();
        if (!message) {
            return;
        }

        this.clearToastDismissTimer();
        this.updateBubbleMode();
        this.showBubble();
        const isOfflineToast = this.mode === 'offline';

        const textEl = document.getElementById('bubble-text');
        if (textEl) {
            textEl.textContent = message;
            textEl.classList.add('fade-in');
            setTimeout(() => textEl.classList.remove('fade-in'), 400);
        }

        const hintEl = document.getElementById('bubble-hint');
        if (hintEl) {
            hintEl.textContent = isOfflineToast && options.hint ? options.hint.trim() : '';
        }

        if (isOfflineToast) {
            const dismissMs = TOAST_DISMISS_MIN_MS + Math.floor(Math.random() * (TOAST_DISMISS_MAX_MS - TOAST_DISMISS_MIN_MS + 1));
            this.toastDismissHandle = setTimeout(() => {
                this.toastDismissHandle = null;
                this.hideBubble();
            }, dismissMs);
        }
    }

    showTyping() {
        this.clearToastDismissTimer();
        this.updateBubbleMode();
        this.showBubble();

        const textEl = document.getElementById('bubble-text');
        if (textEl) {
            textEl.innerHTML = `
                <div class="typing-dots">
                    <div class="typing-dot"></div>
                    <div class="typing-dot"></div>
                    <div class="typing-dot"></div>
                </div>
            `;
        }

        const hintEl = document.getElementById('bubble-hint');
        if (hintEl) {
            hintEl.textContent = '';
        }
    }
}

// Global instance
let simpleAssistant = null;

document.addEventListener('DOMContentLoaded', () => {
    simpleAssistant = new SimpleSpotAssistant();
    simpleAssistant.bindModeToggle();

    if ('speechSynthesis' in window) {
        speechSynthesis.addEventListener('voiceschanged', () => {
            console.log('Voices loaded');
        });
    }
});

// Public functions
function startAssistant() {
    if (simpleAssistant) {
        simpleAssistant.start();
    }
}

function stopAssistant() {
    if (simpleAssistant) {
        simpleAssistant.stop();
    }
}

