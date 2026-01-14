// Spot Voice Assistant with Wake Word Detection
// Continuously listens for "Hey Spot" and responds with predefined answers

class SpotVoiceAssistant {
    constructor() {
        this.isListening = false;
        this.isProcessing = false;
        this.wakeWordDetected = false;
        this.recognition = null;
        this.synthesis = window.speechSynthesis;
        this.wakeWords = ['hey spot', 'hi spot'];
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
            console.error('Speech Recognition not supported in this browser');
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
        if (this.isProcessing || this.isRecording) {
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
            this.handleQuery(transcript);
        } catch (error) {
            console.error('Backend STT failed:', error);
            this.useBackendStt = false;
            this.resumeWakeWordListening();
        }
    }

    resumeWakeWordListening() {
        this.wakeWordDetected = false;
        if (this.isListening && this.recognition) {
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
                this.updateStatus('Using OpenAI voice', 'success');
                setTimeout(() => {
                    if (!this.isListening) {
                        this.updateStatus('Click "Start Assistant" to begin', 'idle');
                    }
                }, 3000);
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
            console.log('Voice recognition started. Say "Hey Spot" or "Hi Spot" to activate.');
            this.updateStatus('Listening for "Hey Spot" or "Hi Spot"...', 'listening');
        };

        this.recognition.onresult = (event) => {
            const lastResult = event.results[event.results.length - 1];
            const transcript = lastResult[0].transcript.trim().toLowerCase();
            console.log('Heard:', transcript);

            if (!this.wakeWordDetected) {
                // Check for wake word
                const wakeWordFound = this.wakeWords.some(wakeWord => transcript.includes(wakeWord));
                if (wakeWordFound) {
                    this.handleWakeWord();
                }
            } else if (!this.useBackendStt) {
                // Process user query after wake word
                if (!this.isProcessing) {
                    this.handleQuery(transcript);
                }
            }
        };

        this.recognition.onerror = (event) => {
            console.error('Speech recognition error:', event.error);
            if (event.error === 'no-speech') {
                // Continue listening
                console.log('No speech detected, continuing to listen...');
            } else if (event.error === 'not-allowed') {
                this.updateStatus('Microphone access denied. Please allow microphone access.', 'error');
            } else {
                this.updateStatus(`Error: ${event.error}`, 'error');
            }
        };

        this.recognition.onend = () => {
            console.log('Recognition ended.');
            // Automatically restart if still supposed to be listening
            if (this.isListening) {
                console.log('Restarting recognition...');
                setTimeout(() => {
                    try {
                        this.recognition.start();
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
            this.showAssistant();
        } catch (e) {
            console.log('Recognition already started or error:', e);
        }
    }

    stop() {
        this.isListening = false;
        this.wakeWordDetected = false;
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
        this.hideAssistant();
    }

    handleWakeWord() {
        this.wakeWordDetected = true;
        console.log('Wake word detected!');

        // Add Spot's greeting to chat
        const greeting = "Hey there! How may I help you?";
        this.addMessage(greeting, 'spot');
        this.speak(greeting);

        this.updateStatus('Listening to your question...', 'active');
        if (this.useBackendStt) {
            this.listenForQuery();
        }

        // Reset wake word after 15 seconds if no query
        setTimeout(() => {
            if (this.wakeWordDetected && !this.isProcessing) {
                this.updateStatus('Listening for "Hey Spot" or "Hi Spot"...', 'listening');
                this.resumeWakeWordListening();
            }
        }, 15000);
    }

    async handleQuery(query) {
        if (query.length < 2) return;

        this.isProcessing = true;
        console.log('Processing query:', query);

        // Add user message to chat
        this.addMessage(query, 'user');
        this.updateStatus('Thinking...', 'processing');

        // Find matching answer
        const answer = await this.getAnswer(query);

        // Add Spot's response to chat
        setTimeout(() => {
            this.addMessage(answer, 'spot');
            this.speak(answer);

            // Reset for next wake word
            this.isProcessing = false;
            this.updateStatus('Listening for "Hey Spot" or "Hi Spot"...', 'listening');
            this.resumeWakeWordListening();
        }, 500);
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

    async speak(text) {
        // Use backend voice if available, otherwise fall back to browser voices
        if (this.useBryceVoice) {
            await this.speakWithBryce(text);
        } else {
            this.speakWithBrowser(text);
        }
    }

    async speakWithBryce(text) {
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
            };

            source.start(0);

        } catch (error) {
            console.error('Error with backend voice, falling back to browser:', error);
            this.useBryceVoice = false;  // Disable for this session
            this.speakWithBrowser(text);
        }
    }

    speakWithBrowser(text) {
        // Cancel any ongoing speech
        this.synthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.95;  // Slightly slower for clarity
        utterance.pitch = 0.85; // Lower pitch for a deeper, more professional voice
        utterance.volume = 1.0;
        utterance.lang = 'en-US';

        // Try to find the best professional male voice
        const voices = this.synthesis.getVoices();

        // Priority order for voice selection (most preferred first)
        const voicePreferences = [
            'Microsoft David',           // Windows - deep male voice
            'Microsoft Mark',            // Windows - professional male
            'Google US English Male',    // Chrome - clear male voice
            'Microsoft Guy',             // Windows - natural male
            'Alex',                      // macOS - high quality male
            'Daniel',                    // macOS - British male
            'Microsoft Zira',            // Fallback - clear female
            'Google US English'          // Fallback - neutral
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

        // Apply the selected voice
        if (selectedVoice) {
            utterance.voice = selectedVoice;
            console.log('Using voice:', selectedVoice.name);
        } else {
            console.log('Using default voice');
        }

        utterance.onend = () => {
            console.log('Finished speaking (Browser)');
        };

        utterance.onerror = (event) => {
            console.error('Speech synthesis error:', event);
        };

        this.synthesis.speak(utterance);
    }

    showAssistant() {
        const overlay = document.getElementById('assistant-overlay');
        if (overlay) {
            overlay.classList.add('active');
        }
    }

    hideAssistant() {
        const overlay = document.getElementById('assistant-overlay');
        if (overlay) {
            overlay.classList.remove('active');
        }
    }

    addMessage(text, sender) {
        const chatContainer = document.getElementById('chat-messages');
        if (!chatContainer) return;

        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${sender}-message`;

        const bubble = document.createElement('div');
        bubble.className = 'message-bubble';
        bubble.textContent = text;

        messageDiv.appendChild(bubble);
        chatContainer.appendChild(messageDiv);

        // Auto-scroll to bottom
        chatContainer.scrollTop = chatContainer.scrollHeight;

        // Limit message history to last 20 messages
        const messages = chatContainer.querySelectorAll('.message');
        if (messages.length > 20) {
            messages[0].remove();
        }
    }

    updateStatus(text, state) {
        const statusElement = document.getElementById('assistant-status');
        if (statusElement) {
            statusElement.textContent = text;
            statusElement.className = `status ${state}`;
        }
    }

    clearChat() {
        const chatContainer = document.getElementById('chat-messages');
        if (chatContainer) {
            chatContainer.innerHTML = '';
        }
        this.updateStatus('Chat cleared', 'listening');
        setTimeout(() => {
            this.updateStatus('Listening for "Hey Spot"...', 'listening');
        }, 2000);
    }
}

// Global instance
let spotAssistant = null;

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    spotAssistant = new SpotVoiceAssistant();

    // Load voices for speech synthesis
    if ('speechSynthesis' in window) {
        speechSynthesis.addEventListener('voiceschanged', () => {
            const voices = speechSynthesis.getVoices();
            console.log('Voices loaded:', voices.length);
            console.log('Available voices:');
            voices.forEach((voice, index) => {
                console.log(`${index + 1}. ${voice.name} (${voice.lang}) - ${voice.localService ? 'Local' : 'Remote'}`);
            });
        });
    }
});

// Functions accessible from HTML
function startAssistant() {
    if (spotAssistant) {
        spotAssistant.start();
    }
}

function stopAssistant() {
    if (spotAssistant) {
        spotAssistant.stop();
    }
}

function clearChat() {
    if (spotAssistant) {
        spotAssistant.clearChat();
    }
}
