// Simple Spot Voice Assistant - Just Speech Bubble
// Clean UI showing only Spot's responses

class SimpleSpotAssistant {
    constructor() {
        this.qaDatabase = null;
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
        this.openAiRetryAt = 0;
        this.useBryceVoice = false;  // Will be set to true if backend is available
        this.audioContext = null;

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
        this.loadQADatabase();
        this.checkBackendAvailability();
        this.initAudioContext();
    }

    initAudioContext() {
        // Initialize Web Audio API context for playing backend audio
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
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
                console.log('✓ Bryce voice backend is available');
            }
        } catch (error) {
            console.log('✗ Bryce voice backend not available, using browser voices');
            this.useBryceVoice = false;
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
            const confidence = lastResult[0].confidence;

            console.log('Heard:', transcript, 'Confidence:', confidence);

            // Ignore very short transcripts to avoid false triggers
            if (transcript.length < 8) {
                console.log('Ignoring too short transcript:', transcript);
                return;
            }

            // Higher confidence threshold to reduce false positives
            if (confidence && confidence < 0.8) {
                console.log('Ignoring low confidence transcript:', transcript, 'Confidence:', confidence);
                return;
            }

            if (!this.wakeWordDetected) {
                // Check if transcript contains any of the wake words
                const wakeWordFound = this.wakeWords.some(wakeWord => transcript.includes(wakeWord));
                if (wakeWordFound) {
                    this.handleWakeWord();
                }
            } else {
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

                    // Require at least 3 words AND 10 characters for a valid question
                    const wordCount = transcript.split(/\s+/).filter(w => w.length > 0).length;

                    if (wordCount >= 3 && transcript.length >= 10) {
                        // Reset the timeout since we heard something meaningful
                        this.lastSpeechTime = Date.now();
                        this.resetActiveTimeout();
                        this.handleQuery(transcript);
                    } else {
                        console.log('Ignoring too short query:', transcript, '(needs 3+ words AND 10+ chars)');
                    }
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

    async loadQADatabase() {
        try {
            const response = await fetch('spot_qa_database.json');
            const data = await response.json();
            this.qaDatabase = data.conversations;
            console.log(`Loaded ${this.qaDatabase.length} Q&A pairs`);
        } catch (error) {
            console.error('Error loading Q&A database:', error);
        }
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
                this.wakeWordDetected = false;
                this.showMessage('Say "Hey Spot" or "Hi Spot" to start...');
            }
        }, 20000);
    }

    handleWakeWord() {
        this.wakeWordDetected = true;
        this.lastSpeechTime = Date.now();
        console.log('Wake word detected!');

        this.showTyping();

        const greeting = "Hey there! How may I help you?";

        // Respond faster - reduced delay
        setTimeout(() => {
            this.showMessage(greeting);
            this.speak(greeting, () => {
                // Callback when speaking finishes
                console.log('Greeting finished, ready for questions');
                this.resetActiveTimeout();
            });
        }, 300); // Reduced from 800ms to 300ms
    }

    async handleQuery(query) {
        if (query.length < 10) {
            console.log('Query too short, ignoring:', query);
            return;
        }

        // Count words - must have at least 3 real words
        const words = query.split(/\s+/).filter(w => w.length > 0);
        if (words.length < 3) {
            console.log('Not enough words, ignoring:', query);
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
            this.showMessage(answer);
            this.speak(answer, () => {
                // Callback when speaking finishes
                console.log('Answer finished speaking, waiting for next question...');
                this.isProcessing = false;
                // Stay in active mode, ready for next question
                // Don't reset wakeWordDetected - keep listening for more questions
                this.resetActiveTimeout();
            });
        }, 400);
    }

    async getAnswer(query) {
        const localAnswer = this.findAnswer(query);
        if (!localAnswer) {
            return null;
        }

        if (!navigator.onLine || Date.now() < this.openAiRetryAt) {
            return localAnswer;
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

            return answer;
        } catch (error) {
            console.log('OpenAI unavailable, using local knowledge base:', error);
            this.openAiRetryAt = Date.now() + 30000;
            return localAnswer;
        }
    }

    findAnswer(query) {
        if (!this.qaDatabase) {
            return "My knowledge base is loading...";
        }

        const cleanQuery = query.toLowerCase().trim();

        // Filter out short queries that are likely noise
        const wordCount = cleanQuery.split(/\s+/).filter(w => w.length > 0).length;
        if (wordCount < 3) {
            console.log('Too few words in query, likely noise:', cleanQuery);
            return null; // Return null to prevent speaking
        }

        if (cleanQuery.length < 10) {
            console.log('Query too short, likely noise:', cleanQuery);
            return null; // Return null to prevent speaking
        }

        // Exact match
        let match = this.qaDatabase.find(qa =>
            qa.question.toLowerCase() === cleanQuery
        );

        // Partial match
        if (!match) {
            match = this.qaDatabase.find(qa =>
                cleanQuery.includes(qa.question.toLowerCase()) ||
                qa.question.toLowerCase().includes(cleanQuery)
            );
        }

        // Word similarity
        if (!match) {
            const queryWords = cleanQuery.split(' ').filter(w => w.length > 2);
            let bestMatch = null;
            let bestScore = 0;

            this.qaDatabase.forEach(qa => {
                const questionWords = qa.question.toLowerCase().split(' ');
                let score = 0;

                queryWords.forEach(qWord => {
                    if (questionWords.some(word => word.includes(qWord) || qWord.includes(word))) {
                        score++;
                    }
                });

                if (score > bestScore && score >= Math.min(2, queryWords.length * 0.5)) {
                    bestScore = score;
                    bestMatch = qa;
                }
            });

            match = bestMatch;
        }

        return match ? match.answer : "I'm not sure about that. Try asking about Spot, inspections, or basic questions!";
    }

    async speak(text, onComplete) {
        // Use Bryce voice if backend is available, otherwise fall back to browser voices
        if (this.useBryceVoice) {
            await this.speakWithBryce(text, onComplete);
        } else {
            this.speakWithBrowser(text, onComplete);
        }
    }

    async speakWithBryce(text, onComplete) {
        try {
            console.log('Speaking with Bryce voice:', text);
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
                console.log('Finished speaking (Bryce)');
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

            source.start(0);

        } catch (error) {
            console.error('Error with Bryce voice, falling back to browser:', error);
            this.useBryceVoice = false;  // Disable for this session
            this.speakWithBrowser(text, onComplete);
        }
    }

    speakWithBrowser(text, onComplete) {
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
