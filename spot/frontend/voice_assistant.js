// Spot Voice Assistant with Wake Word Detection
// Continuously listens for "Hey Spot" and responds with predefined answers

class SpotVoiceAssistant {
    constructor() {
        this.qaDatabase = null;
        this.isListening = false;
        this.isProcessing = false;
        this.wakeWordDetected = false;
        this.recognition = null;
        this.synthesis = window.speechSynthesis;
        this.wakeWord = 'hey spot';

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
        this.loadQADatabase();
    }

    setupRecognition() {
        this.recognition.continuous = true;
        this.recognition.interimResults = false;
        this.recognition.lang = 'en-US';
        this.recognition.maxAlternatives = 1;

        this.recognition.onstart = () => {
            console.log('Voice recognition started. Say "Hey Spot" to activate.');
            this.updateStatus('Listening for "Hey Spot"...', 'listening');
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

    async loadQADatabase() {
        try {
            const response = await fetch('spot_qa_database.json');
            const data = await response.json();
            this.qaDatabase = data.conversations;
            console.log(`Loaded ${this.qaDatabase.length} Q&A pairs`);
        } catch (error) {
            console.error('Error loading Q&A database:', error);
            this.updateStatus('Failed to load Q&A database', 'error');
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

        // Reset wake word after 15 seconds if no query
        setTimeout(() => {
            if (this.wakeWordDetected && !this.isProcessing) {
                this.wakeWordDetected = false;
                this.updateStatus('Listening for "Hey Spot"...', 'listening');
            }
        }, 15000);
    }

    handleQuery(query) {
        if (query.length < 2) return;

        this.isProcessing = true;
        console.log('Processing query:', query);

        // Add user message to chat
        this.addMessage(query, 'user');
        this.updateStatus('Thinking...', 'processing');

        // Find matching answer
        const answer = this.findAnswer(query);

        // Add Spot's response to chat
        setTimeout(() => {
            this.addMessage(answer, 'spot');
            this.speak(answer);

            // Reset for next wake word
            this.wakeWordDetected = false;
            this.isProcessing = false;
            this.updateStatus('Listening for "Hey Spot"...', 'listening');
        }, 500);
    }

    findAnswer(query) {
        if (!this.qaDatabase) {
            return "I'm sorry, my knowledge base is not loaded yet.";
        }

        // Clean the query
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
        // Cancel any ongoing speech
        this.synthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 1.0;
        utterance.pitch = 1.0;
        utterance.volume = 1.0;
        utterance.lang = 'en-US';

        // Try to use a more robotic/professional voice if available
        const voices = this.synthesis.getVoices();
        const preferredVoice = voices.find(voice =>
            voice.name.includes('Google') ||
            voice.name.includes('Microsoft') ||
            voice.name.includes('Male')
        );

        if (preferredVoice) {
            utterance.voice = preferredVoice;
        }

        utterance.onend = () => {
            console.log('Finished speaking');
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
            console.log('Voices loaded:', speechSynthesis.getVoices().length);
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
