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

    handleQuery(query) {
        if (query.length < 2) return;

        this.isProcessing = true;
        console.log('Processing query:', query);

        // Display user's question
        this.displayUserInput(query);
        this.updateBubbleStatus('processing', '💭 Thinking...');

        // Show typing animation
        this.showTypingIndicator();

        // Find matching answer
        const answer = this.findAnswer(query);

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

    speak(text) {
        this.synthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 1.0;
        utterance.pitch = 1.0;
        utterance.volume = 1.0;
        utterance.lang = 'en-US';

        const voices = this.synthesis.getVoices();
        const preferredVoice = voices.find(voice =>
            voice.name.includes('Google') ||
            voice.name.includes('Microsoft') ||
            voice.name.includes('Male')
        );

        if (preferredVoice) {
            utterance.voice = preferredVoice;
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
