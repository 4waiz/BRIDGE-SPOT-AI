// Simple Spot Voice Assistant - Just Speech Bubble
// Clean UI showing only Spot's responses

class SimpleSpotAssistant {
    constructor() {
        this.isListening = false;
        this.isProcessing = false;
        this.wakeWordDetected = false;
        this.isSpeaking = false; // Track if Spot is currently speaking
        this.recognition = null;
        this.synthesis = window.speechSynthesis;
        this.wakeWords = ['hey spot', 'hi spot']; // Support both "Hey Spot" and "Hi Spot"
        this.activeTimeout = null;
        this.lastSpeechTime = null;
        this.backendUrl = 'http://localhost:5000';
        this.useBryceVoice = false;  // Backend TTS availability
        this.useBackendStt = false;  // Backend STT availability
        this.audioContext = null;
        this.micStream = null;
        this.micSource = null;
        this.micAnalyser = null;
        this.mediaRecorder = null;
        this.isRecording = false;
        this.silenceThreshold = 0.02;
        this.silenceDurationMs = 900;
        this.maxRecordMs = 8000;

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

    async captureQueryAudio() {
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
        }, this.maxRecordMs);
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

    async listenForQuery() {
        if (this.isProcessing || this.isSpeaking || this.isRecording) {
            return;
        }
        if (!this.useBackendStt) {
            return;
        }
        try {
            if (this.recognition && this.isListening) {
                try {
                    this.recognition.stop();
                } catch (e) {
                    console.log('Recognition stop error:', e);
                }
            }
            const audioBlob = await this.captureQueryAudio();
            if (!audioBlob) {
                this.resumeWakeWordListening();
                return;
            }
            const transcript = await this.transcribeWithBackend(audioBlob);
            if (!transcript) {
                this.resumeWakeWordListening();
                return;
            }
            this.lastSpeechTime = Date.now();
            this.resetActiveTimeout();
            this.handleQuery(transcript);
        } catch (error) {
            console.error('Backend STT failed:', error);
            this.useBackendStt = false;
            this.resumeWakeWordListening();
        }
    }

    resumeWakeWordListening() {
        this.wakeWordDetected = false;
        if (this.isListening && this.recognition && !this.isSpeaking) {
            try {
                this.recognition.start();
            } catch (e) {
                if (!e.message || !e.message.includes('already started')) {
                    console.log('Recognition start error:', e);
                }
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

    setupRecognition() {
        this.recognition.continuous = true;
        this.recognition.interimResults = false;
        this.recognition.lang = 'en-US';
        this.recognition.maxAlternatives = 1;

        this.recognition.onstart = () => {
            console.log('Listening for "Hey Spot" or "Hi Spot"...');
        };

        this.recognition.onresult = (event) => {
            const lastResult = event.results[event.results.length - 1];
            const transcript = lastResult[0].transcript.trim().toLowerCase();

            if (!this.wakeWordDetected) {
                console.log('Heard:', transcript);
                // Check if transcript contains any of the wake words
                const wakeWordFound = this.wakeWords.some(wakeWord => transcript.includes(wakeWord));
                if (wakeWordFound) {
                    this.handleWakeWord();
                }
            } else if (!this.useBackendStt) {
                console.log('Heard:', transcript);
                // After wake word, accept any question (not just after processing)
                // BUT only if Spot is not currently speaking
                // CRITICAL: Never process speech while Spot is talking to avoid feedback loop
                if (!this.isProcessing && !this.isSpeaking) {
                    // Ignore if it contains the wake word again (don't process wake words as questions)
                    const containsWakeWord = this.wakeWords.some(wakeWord => transcript.includes(wakeWord));
                    if (containsWakeWord) {
                        console.log('Wake word detected again, ignoring as question:', transcript);
                        return;
                    }

                    if (!transcript) {
                        return;
                    }
                    // Reset the timeout since we heard something meaningful
                    this.lastSpeechTime = Date.now();
                    this.resetActiveTimeout();
                    this.handleQuery(transcript);
                } else if (this.isSpeaking) {
                    console.log('Spot is speaking, ignoring input:', transcript);
                }
            }
        };

        this.recognition.onerror = (event) => {
            console.error('Speech recognition error:', event.error);
            if (event.error === 'not-allowed') {
                this.showMessage('Microphone access denied');
            }
        };

        this.recognition.onend = () => {
            // Only auto-restart if we're listening AND not in the middle of speaking
            // This prevents conflicts with the speak() method's restart logic
            if (this.isListening && !this.isSpeaking) {
                setTimeout(() => {
                    try {
                        this.recognition.start();
                        console.log('Auto-restarted recognition');
                    } catch (e) {
                        console.log('Recognition already started or error:', e);
                    }
                }, 100);
            }
        };
    }

    start() {
        if (!this.recognition) {
            alert('Speech recognition not available');
            return;
        }

        this.isListening = true;
        try {
            this.recognition.start();
            this.showBubble();
            this.showMessage('Say "Hey Spot" or "Hi Spot" to start...');
        } catch (e) {
            console.log('Recognition error:', e);
        }
    }

    stop() {
        this.isListening = false;
        this.wakeWordDetected = false;
        this.isSpeaking = false;
        if (this.activeTimeout) {
            clearTimeout(this.activeTimeout);
            this.activeTimeout = null;
        }
        if (this.recognition) {
            this.recognition.stop();
        }
        if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
            try {
                this.mediaRecorder.stop();
            } catch (e) {
                console.log('Recorder stop error:', e);
            }
        }
        this.synthesis.cancel();
        this.hideBubble();
    }

    resetActiveTimeout() {
        // Clear existing timeout
        if (this.activeTimeout) {
            clearTimeout(this.activeTimeout);
        }

        // Set new 20-second timeout
        this.activeTimeout = setTimeout(() => {
            if (this.wakeWordDetected && !this.isProcessing) {
                console.log('20 seconds passed with no speech, going back to wake word mode');
                this.showMessage('Say "Hey Spot" or "Hi Spot" to start...');
                this.resumeWakeWordListening();
            }
        }, 20000);
    }

    handleWakeWord() {
        this.wakeWordDetected = true;
        this.lastSpeechTime = Date.now();
        console.log('Wake word detected!');

        this.showTyping();

        const greeting = "Hey there! How may I help you?";
        if (this.useBackendStt && this.recognition && this.isListening) {
            try {
                this.recognition.stop();
            } catch (e) {
                console.log('Recognition stop error:', e);
            }
        }

        // Respond faster - reduced delay
        setTimeout(() => {
            this.speak(
                greeting,
                () => {
                // Callback when speaking finishes
                    console.log('Greeting finished, ready for questions');
                    this.resetActiveTimeout();
                    if (this.useBackendStt) {
                        this.listenForQuery();
                    }
                },
                () => {
                    this.showMessage(greeting);
                }
            );
        }, 150); // Faster response after wake word
    }

    async handleQuery(query) {
        if (!query || !query.trim()) {
            return;
        }

        this.isProcessing = true;
        console.log('Processing valid query:', query);

        this.showTyping();

        const answer = await this.getAnswer(query);

        // Don't respond if no valid answer (likely noise)
        if (!answer) {
            console.log('No answer found, ignoring as noise');
            this.isProcessing = false;
            this.resetActiveTimeout();
            return;
        }

        // Respond much faster
        setTimeout(() => {
            this.speak(
                answer,
                () => {
                // Callback when speaking finishes
                    console.log('Answer finished speaking, waiting for next question...');
                    this.isProcessing = false;
                    // Stay in active mode, ready for next question
                    // Don't reset wakeWordDetected - keep listening for more questions
                    this.resetActiveTimeout();
                    if (this.useBackendStt) {
                        this.listenForQuery();
                    }
                },
                () => {
                    this.showMessage(answer);
                }
            );
        }, 400);
    }

    async getAnswer(query) {
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

            return answer;
        } catch (error) {
            console.log('OpenAI unavailable:', error);
            return "I'm having trouble reaching OpenAI right now. Please try again.";
        }
    }

    async speak(text, onComplete, onStart) {
        // Use backend voice if available, otherwise fall back to browser voices
        if (this.useBryceVoice) {
            await this.speakWithBryce(text, onComplete, onStart);
        } else {
            this.speakWithBrowser(text, onComplete, onStart);
        }
    }

    async speakWithBryce(text, onComplete, onStart) {
        try {
            console.log('Speaking with backend voice:', text);
            this.isSpeaking = true;

            // CRITICAL: Stop recognition while speaking to prevent feedback loop
            const wasListening = this.isListening;
            let recognitionWasStopped = false;

            if (this.recognition && wasListening) {
                try {
                    this.recognition.stop();
                    recognitionWasStopped = true;
                    console.log('Paused recognition to prevent feedback');
                } catch (e) {
                    console.log('Error stopping recognition (may already be stopped):', e);
                }
            }

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
                this.isSpeaking = false;

                // Restart recognition after speaking
                if (recognitionWasStopped && wasListening && this.isListening) {
                    setTimeout(() => {
                        try {
                            this.recognition.start();
                            console.log('Resumed recognition after speaking');
                        } catch (e) {
                            if (!e.message || !e.message.includes('already started')) {
                                console.log('Error restarting recognition:', e);
                            }
                        }
                    }, 500);
                }

                if (onComplete) {
                    onComplete();
                }
            };

            if (onStart) {
                onStart();
            }
            source.start(0);

        } catch (error) {
            console.error('Error with backend voice, falling back to browser:', error);
            this.useBryceVoice = false;  // Disable for this session
            this.speakWithBrowser(text, onComplete, onStart);
        }
    }

    speakWithBrowser(text, onComplete, onStart) {
        this.synthesis.cancel();
        this.isSpeaking = true;

        // CRITICAL: Stop recognition while speaking to prevent feedback loop
        const wasListening = this.isListening;
        let recognitionWasStopped = false;

        if (this.recognition && wasListening) {
            try {
                this.recognition.stop();
                recognitionWasStopped = true;
                console.log('Paused recognition to prevent feedback');
            } catch (e) {
                console.log('Error stopping recognition (may already be stopped):', e);
            }
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
            this.isSpeaking = false;

            // CRITICAL: Restart recognition after speaking to resume listening
            if (recognitionWasStopped && wasListening && this.isListening) {
                setTimeout(() => {
                    try {
                        this.recognition.start();
                        console.log('Resumed recognition after speaking');
                    } catch (e) {
                        if (!e.message || !e.message.includes('already started')) {
                            console.log('Error restarting recognition:', e);
                        }
                    }
                }, 500);
            }

            if (onComplete) {
                onComplete();
            }
        };

        // Handle errors
        utterance.onerror = (event) => {
            console.error('Speech error:', event);
            this.isSpeaking = false;

            // Restart recognition even on error
            if (recognitionWasStopped && wasListening && this.isListening) {
                setTimeout(() => {
                    try {
                        this.recognition.start();
                        console.log('Resumed recognition after error');
                    } catch (e) {
                        if (!e.message || !e.message.includes('already started')) {
                            console.log('Error restarting recognition:', e);
                        }
                    }
                }, 500);
            }

            if (onComplete) {
                onComplete();
            }
        };

        this.synthesis.speak(utterance);
    }

    showBubble() {
        const bubble = document.getElementById('simple-chat-bubble');
        if (bubble) {
            bubble.classList.add('active');
        }
    }

    hideBubble() {
        const bubble = document.getElementById('simple-chat-bubble');
        if (bubble) {
            bubble.classList.remove('active');
        }
    }

    showMessage(text) {
        const textEl = document.getElementById('bubble-text');
        if (textEl) {
            textEl.innerHTML = text;
            textEl.classList.add('fade-in');
            setTimeout(() => textEl.classList.remove('fade-in'), 400);
        }
    }

    showTyping() {
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
    }
}

// Global instance
let simpleAssistant = null;

document.addEventListener('DOMContentLoaded', () => {
    simpleAssistant = new SimpleSpotAssistant();

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
