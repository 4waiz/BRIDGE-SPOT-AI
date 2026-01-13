// Spot Voice Assistant with Chat Bubble Over Robot
// Displays conversation as a speech bubble positioned over Spot

class SpotBubbleAssistant {
    constructor() {
        this.qaDatabase = null;
        this.isListening = false;
        this.isProcessing = false;
        this.wakeWordDetected = false;
        this.recognition = null;
        this.synthesis = window.speechSynthesis;
        this.wakeWord = 'hey spot';
        this.conversationHistory = [];
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
            console.error('Speech Recognition not supported in this browser');
            this.showError('Speech Recognition is not supported in your browser. Please use Chrome or Edge.');
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
            console.log('Voice recognition started. Say "Hey Spot" to activate.');
            this.updateBubbleStatus('listening', '🎤 Say "Hey Spot" to start');
        };

        this.recognition.onresult = (event) => {
            const lastResult = event.results[event.results.length - 1];
            const transcript = lastResult[0].transcript.trim().toLowerCase();
            console.log('Heard:', transcript);

            if (!this.wakeWordDetected) {
                // Check for wake word
                if (transcript.includes(this.wakeWord)) {
                    this.handleWakeWord();
                }
            } else {
                // Process user query after wake word
                if (!this.isProcessing) {
                    this.handleQuery(transcript);
                }
            }
        };

        this.recognition.onerror = (event) => {
            console.error('Speech recognition error:', event.error);
            if (event.error === 'no-speech') {
                console.log('No speech detected, continuing to listen...');
            } else if (event.error === 'not-allowed') {
                this.updateBubbleStatus('error', '❌ Microphone access denied');
            } else {
                this.updateBubbleStatus('error', `❌ Error: ${event.error}`);
            }
        };

        this.recognition.onend = () => {
            console.log('Recognition ended.');
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

    async loadQADatabase() {
        try {
            const response = await fetch('spot_qa_database.json');
            const data = await response.json();
            this.qaDatabase = data.conversations;
            console.log(`Loaded ${this.qaDatabase.length} Q&A pairs`);
        } catch (error) {
            console.error('Error loading Q&A database:', error);
            this.showError('Failed to load knowledge base');
        }
    }

    start() {
        if (!this.recognition) {
            this.showError('Speech recognition not available');
            return;
        }

        this.isListening = true;
        try {
            this.recognition.start();
            this.showBubble();
            this.updateBubbleStatus('listening', '🎤 Listening for "Hey Spot"...');
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
        this.synthesis.cancel();
        this.hideBubble();
        this.conversationHistory = [];
    }

    handleWakeWord() {
        this.wakeWordDetected = true;
        console.log('Wake word detected!');

        const greeting = "Hey there! How may I help you?";

        // Show typing animation
        this.showTypingIndicator();

        // After short delay, show greeting
        setTimeout(() => {
            this.displayMessage(greeting, 'spot');
            this.speak(greeting);
            this.updateBubbleStatus('active', '🎧 Listening to your question...');
        }, 800);

        // Reset wake word after 15 seconds if no query
        setTimeout(() => {
            if (this.wakeWordDetected && !this.isProcessing) {
                this.wakeWordDetected = false;
                this.updateBubbleStatus('listening', '🎤 Say "Hey Spot" to start');
            }
        }, 15000);
    }

    async handleQuery(query) {
        if (query.length < 2) return;

        this.isProcessing = true;
        console.log('Processing query:', query);

        // Display user's question
        this.displayUserInput(query);
        this.updateBubbleStatus('processing', '💭 Thinking...');

        // Show typing animation
        this.showTypingIndicator();

        // Find matching answer
        const answer = await this.getAnswer(query);

        // Display Spot's response after a short delay
        setTimeout(() => {
            this.displayMessage(answer, 'spot');
            this.speak(answer);

            // Reset for next wake word
            setTimeout(() => {
                this.wakeWordDetected = false;
                this.isProcessing = false;
                this.updateBubbleStatus('listening', '🎤 Say "Hey Spot" for another question');
            }, 1000);
        }, 1000);
    }

    async getAnswer(query) {
        const localAnswer = this.findAnswer(query);
        if (!localAnswer) {
            return "I'm sorry, my knowledge base is not loaded yet.";
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
            return "I'm sorry, my knowledge base is not loaded yet.";
        }

        const cleanQuery = query.toLowerCase().trim();

        // Try exact match first
        let match = this.qaDatabase.find(qa =>
            qa.question.toLowerCase() === cleanQuery
        );

        // If no exact match, try partial match
        if (!match) {
            match = this.qaDatabase.find(qa =>
                cleanQuery.includes(qa.question.toLowerCase()) ||
                qa.question.toLowerCase().includes(cleanQuery)
            );
        }

        // If still no match, try word-by-word similarity
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

        return match ? match.answer : "I'm not sure how to answer that. Try asking about Spot robots, inspections, or basic questions!";
    }

    async speak(text) {
        // Use Bryce voice if backend is available, otherwise fall back to browser voices
        if (this.useBryceVoice) {
            await this.speakWithBryce(text);
        } else {
            this.speakWithBrowser(text);
        }
    }

    async speakWithBryce(text) {
        try {
            console.log('Speaking with Bryce voice:', text);
            this.updateBubbleStatus('speaking', '🔊 Speaking with Bryce voice...');
            this.addSoundWaveAnimation();

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
                this.removeSoundWaveAnimation();
            };

            source.start(0);

        } catch (error) {
            console.error('Error with Bryce voice, falling back to browser:', error);
            this.useBryceVoice = false;  // Disable for this session
            this.speakWithBrowser(text);
        }
    }

    speakWithBrowser(text) {
        this.synthesis.cancel();

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
            this.updateBubbleStatus('speaking', '🔊 Speaking...');
            this.addSoundWaveAnimation();
        };

        utterance.onend = () => {
            console.log('Finished speaking');
            this.removeSoundWaveAnimation();
        };

        utterance.onerror = (event) => {
            console.error('Speech synthesis error:', event);
            this.removeSoundWaveAnimation();
        };

        this.synthesis.speak(utterance);
    }

    showBubble() {
        const container = document.getElementById('chat-bubble-container');
        if (container) {
            container.classList.add('active');
        }
    }

    hideBubble() {
        const container = document.getElementById('chat-bubble-container');
        if (container) {
            container.classList.remove('active');
        }
    }

    displayMessage(text, sender) {
        const messageDiv = document.getElementById('bubble-message');
        const historyDiv = document.getElementById('conversation-mini');

        if (messageDiv) {
            messageDiv.textContent = text;
            messageDiv.parentElement.classList.add('bubble-speaking-animation');
            setTimeout(() => {
                messageDiv.parentElement.classList.remove('bubble-speaking-animation');
            }, 600);
        }

        // Add to conversation history
        if (historyDiv && sender !== 'user') {
            this.conversationHistory.push({ text, sender });
            this.updateConversationHistory();
        }
    }

    displayUserInput(text) {
        const userInputDiv = document.getElementById('bubble-user-input');
        const historyDiv = document.getElementById('conversation-mini');

        if (userInputDiv) {
            userInputDiv.textContent = `You: "${text}"`;
        }

        // Add to history
        if (historyDiv) {
            this.conversationHistory.push({ text, sender: 'user' });
            this.updateConversationHistory();
        }
    }

    updateConversationHistory() {
        const historyDiv = document.getElementById('conversation-mini');
        if (!historyDiv) return;

        // Keep only last 4 exchanges
        const recentHistory = this.conversationHistory.slice(-8);

        historyDiv.innerHTML = recentHistory.map(msg =>
            `<div class="mini-message ${msg.sender}">${msg.text}</div>`
        ).join('');

        // Auto-scroll
        historyDiv.scrollTop = historyDiv.scrollHeight;
    }

    showTypingIndicator() {
        const messageDiv = document.getElementById('bubble-message');
        if (messageDiv) {
            messageDiv.innerHTML = `
                <div class="typing-indicator">
                    <div class="typing-dot"></div>
                    <div class="typing-dot"></div>
                    <div class="typing-dot"></div>
                </div>
            `;
        }
    }

    updateBubbleStatus(state, text) {
        const statusDiv = document.getElementById('bubble-status');
        if (statusDiv) {
            statusDiv.textContent = text;
            statusDiv.className = `bubble-status ${state}`;
        }
    }

    addSoundWaveAnimation() {
        const messageDiv = document.getElementById('bubble-message');
        if (messageDiv && !messageDiv.querySelector('.sound-wave')) {
            const soundWave = document.createElement('div');
            soundWave.className = 'sound-wave';
            soundWave.innerHTML = `
                <div class="sound-bar"></div>
                <div class="sound-bar"></div>
                <div class="sound-bar"></div>
                <div class="sound-bar"></div>
                <div class="sound-bar"></div>
            `;
            messageDiv.appendChild(soundWave);
        }
    }

    removeSoundWaveAnimation() {
        const soundWave = document.querySelector('.sound-wave');
        if (soundWave) {
            soundWave.remove();
        }
    }

    showError(message) {
        const messageDiv = document.getElementById('bubble-message');
        if (messageDiv) {
            messageDiv.textContent = message;
        }
        this.updateBubbleStatus('error', '❌ Error');
    }

    clearConversation() {
        this.conversationHistory = [];
        const historyDiv = document.getElementById('conversation-mini');
        const userInputDiv = document.getElementById('bubble-user-input');
        const messageDiv = document.getElementById('bubble-message');

        if (historyDiv) historyDiv.innerHTML = '';
        if (userInputDiv) userInputDiv.textContent = 'Your question will appear here';
        if (messageDiv) messageDiv.textContent = 'Say "Hey Spot" to start a conversation!';

        this.updateBubbleStatus('listening', '🎤 Listening for "Hey Spot"...');
    }
}

// Global instance
let spotBubbleAssistant = null;

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    spotBubbleAssistant = new SpotBubbleAssistant();

    // Load voices for speech synthesis
    if ('speechSynthesis' in window) {
        speechSynthesis.addEventListener('voiceschanged', () => {
            console.log('Voices loaded:', speechSynthesis.getVoices().length);
        });
    }
});

// Functions accessible from HTML
function startAssistant() {
    if (spotBubbleAssistant) {
        spotBubbleAssistant.start();
    }
}

function stopAssistant() {
    if (spotBubbleAssistant) {
        spotBubbleAssistant.stop();
    }
}

function clearChat() {
    if (spotBubbleAssistant) {
        spotBubbleAssistant.clearConversation();
    }
}
