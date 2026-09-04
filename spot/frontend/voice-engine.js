/*
 * BRIDGE SPOT - voice engine.
 *
 * Speech in, speech out, and a microphone level meter for the waveform. All
 * browser-native: Web Speech API for both directions, Web Audio for metering.
 * No API keys, no network round trip, no paid provider.
 *
 * Adapted from the voice layer in the bridge-jarvis project, which uses the
 * same vanilla-JS stack. Reused from there:
 *   - the neural/US-English voice picker (browsers expose wildly varying
 *     voice lists, and the default is usually the worst one available)
 *   - cancel-before-speak, which is what actually prevents overlapping replies
 *   - treating "no-speech" and "aborted" as normal rather than as faults
 *   - the restart guard so a recogniser that ends on its own does not
 *     silently stay dead
 *
 * Deliberately NOT reused: bridge-jarvis restarts recognition continuously to
 * listen for a wake word. This page is push-to-talk, so recognition only runs
 * while the operator has asked for it. That avoids holding the microphone open
 * across a robotics dashboard indefinitely.
 *
 * Exposed as window.VoiceEngine.
 */
(function (window) {
    "use strict";

    var SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;

    /* ==================================================================
       Speaker, text to speech with a strict one-at-a-time contract
       ================================================================== */

    var preferredVoice = null;

    function pickVoice() {
        if (!("speechSynthesis" in window)) return null;
        var voices = window.speechSynthesis.getVoices() || [];
        if (!voices.length) return null;

        function isUS(v) { return (v.lang || "").toLowerCase() === "en-us"; }

        // Best first. Neural/"Natural" voices are dramatically clearer than the
        // legacy SAPI ones Windows ships as default.
        preferredVoice =
            voices.find(function (v) { return isUS(v) && /natural|neural|online/i.test(v.name); }) ||
            voices.find(function (v) { return v.name.indexOf("Google US English") !== -1; }) ||
            voices.find(function (v) { return isUS(v) && /aria|guy|jenny|andrew|christopher/i.test(v.name); }) ||
            voices.find(isUS) ||
            voices.find(function (v) { return (v.lang || "").toLowerCase().indexOf("en") === 0; }) ||
            voices[0] ||
            null;
        return preferredVoice;
    }

    if ("speechSynthesis" in window) {
        pickVoice();
        // The list populates asynchronously, and on some browsers only after
        // this event fires.
        window.speechSynthesis.onvoiceschanged = pickVoice;
    }

    var speaking = false;
    var activeUtterance = null;

    var Speaker = {
        supported: function () { return "speechSynthesis" in window; },
        isSpeaking: function () { return speaking; },
        voiceName: function () { return preferredVoice ? preferredVoice.name : null; },

        /**
         * Say something. Cancels anything already speaking, so two responses
         * can never overlap, the operator always hears the most recent thing.
         * Resolves when finished (or immediately if unsupported).
         */
        speak: function (text, handlers) {
            var hooks = handlers || {};
            if (!Speaker.supported() || !text) {
                if (hooks.onEnd) hooks.onEnd();
                return Promise.resolve(false);
            }

            Speaker.cancel();

            return new Promise(function (resolve) {
                var utter = new SpeechSynthesisUtterance(text);
                // Slightly quick and level: an operator assistant, not a reader.
                utter.rate = 1.06;
                utter.pitch = 0.95;
                utter.volume = 1.0;
                utter.lang = "en-US";
                if (!preferredVoice) pickVoice();
                if (preferredVoice) utter.voice = preferredVoice;

                var done = false;
                function finish(ok) {
                    if (done) return;
                    done = true;
                    speaking = false;
                    activeUtterance = null;
                    if (hooks.onEnd) hooks.onEnd();
                    resolve(ok);
                }

                utter.onstart = function () {
                    speaking = true;
                    if (hooks.onStart) hooks.onStart();
                };
                utter.onend = function () { finish(true); };
                utter.onerror = function () { finish(false); };

                activeUtterance = utter;
                speaking = true;
                if (hooks.onStart) hooks.onStart();

                try {
                    window.speechSynthesis.speak(utter);
                } catch (err) {
                    finish(false);
                }

                // Chrome drops long utterances silently when the tab is
                // backgrounded; this stops the UI hanging in "speaking".
                var guardMs = Math.max(4000, text.length * 120);
                setTimeout(function () { if (!done) finish(false); }, guardMs);
            });
        },

        cancel: function () {
            if (!Speaker.supported()) return;
            try { window.speechSynthesis.cancel(); } catch (err) { /* nothing to cancel */ }
            speaking = false;
            activeUtterance = null;
        }
    };

    /* ==================================================================
       Recogniser, speech to text, push to talk
       ================================================================== */

    // Stop listening after this much continuous silence, and never hold the
    // microphone longer than the hard cap.
    var SILENCE_MS = 3500;
    var MAX_LISTEN_MS = 12000;

    function createRecognizer(handlers, options) {
        var hooks = handlers || {};
        var opts = options || {};
        if (!SpeechRecognitionImpl) return null;

        // Continuous mode holds the mic open across utterances and quietly
        // restarts if the browser ends the session anyway (Chromium stops
        // recognition every ~60s to save power; without a restart the tab
        // would go silent halfway through a demo).
        var continuous = !!opts.continuous;

        var recognition = new SpeechRecognitionImpl();
        recognition.lang = "en-US";
        recognition.continuous = continuous;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;

        var listening = false;
        var stoppedByUs = false;
        var gotSpeech = false;
        var silenceTimer = null;
        var hardTimer = null;
        var restartTimer = null;

        function clearTimers() {
            if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
            if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
        }

        function armSilence() {
            if (continuous) return;   // in continuous mode, silence is fine
            if (silenceTimer) clearTimeout(silenceTimer);
            silenceTimer = setTimeout(function () { api.stop(); }, SILENCE_MS);
        }

        recognition.onstart = function () {
            listening = true;
            gotSpeech = false;
            armSilence();
            if (!continuous) {
                hardTimer = setTimeout(function () { api.stop(); }, MAX_LISTEN_MS);
            }
            if (hooks.onStart) hooks.onStart();
        };

        recognition.onresult = function (event) {
            var interim = "";
            var finalText = "";
            for (var i = event.resultIndex; i < event.results.length; i++) {
                var text = event.results[i][0].transcript;
                if (event.results[i].isFinal) finalText += text;
                else interim += text;
            }

            if (interim.trim()) {
                gotSpeech = true;
                armSilence();
                if (hooks.onInterim) hooks.onInterim(interim.trim());
            }

            if (finalText.trim()) {
                gotSpeech = true;
                clearTimers();
                // Hand the final transcript up exactly once. The controller
                // deduplicates further, but not emitting twice from here keeps
                // that a backstop rather than the primary defence.
                if (hooks.onFinal) hooks.onFinal(finalText.trim(),
                    event.results[event.results.length - 1][0].confidence);
            }
        };

        recognition.onspeechstart = function () { gotSpeech = true; armSilence(); };

        recognition.onerror = function (event) {
            var code = event.error;
            // Normal outcomes, not faults: the recogniser heard nothing, or we
            // aborted it ourselves.
            if (code === "no-speech") {
                if (hooks.onNoSpeech) hooks.onNoSpeech();
                return;
            }
            if (code === "aborted" && stoppedByUs) return;

            var message;
            switch (code) {
                case "not-allowed":
                case "service-not-allowed":
                    message = "Microphone access is blocked. Allow microphone access in your " +
                              "browser settings to use Spot Voice Control.";
                    break;
                case "audio-capture":
                    message = "No microphone was found. Connect one and try again.";
                    break;
                case "network":
                    message = "Speech recognition needs a network connection and could not reach it.";
                    break;
                default:
                    message = "Speech recognition failed (" + code + ").";
            }
            if (hooks.onError) hooks.onError(message, code);
        };

        recognition.onend = function () {
            listening = false;
            clearTimers();
            // Continuous mode auto-restarts so a browser-initiated end (Chromium
            // stops recognition every ~60s) does not silently kill the mic. A
            // short delay avoids the InvalidStateError "recognition has already
            // started" you get if you call start() from inside onend.
            if (continuous && !stoppedByUs) {
                restartTimer = setTimeout(function () {
                    try { recognition.start(); } catch (err) { /* already up */ }
                }, 250);
            }
            if (hooks.onEnd) hooks.onEnd(gotSpeech);
        };

        var api = {
            start: function () {
                if (listening) return false;
                stoppedByUs = false;
                try {
                    recognition.start();
                    return true;
                } catch (err) {
                    // start() throws if it is already starting; harmless.
                    return false;
                }
            },
            stop: function () {
                if (!listening) return;
                stoppedByUs = true;
                clearTimers();
                if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
                try { recognition.stop(); } catch (err) { /* already stopping */ }
            },
            abort: function () {
                stoppedByUs = true;
                clearTimers();
                if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
                try { recognition.abort(); } catch (err) { /* already stopped */ }
                listening = false;
            },
            isListening: function () { return listening; },
            isContinuous: function () { return continuous; },
            dispose: function () {
                api.abort();
                recognition.onstart = recognition.onresult = recognition.onerror =
                    recognition.onend = recognition.onspeechstart = null;
            }
        };

        return api;
    }

    /* ==================================================================
       Audio meter, drives the waveform from real microphone input
       ================================================================== */

    function createAudioMeter() {
        var context = null;
        var analyser = null;
        var stream = null;
        var data = null;
        var running = false;

        return {
            /** Open the mic and start metering. Resolves false if unavailable. */
            start: function () {
                if (running) return Promise.resolve(true);
                if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                    return Promise.resolve(false);
                }
                var Ctx = window.AudioContext || window.webkitAudioContext;
                if (!Ctx) return Promise.resolve(false);

                return navigator.mediaDevices.getUserMedia({ audio: true })
                    .then(function (mediaStream) {
                        stream = mediaStream;
                        context = new Ctx();
                        analyser = context.createAnalyser();
                        // Small FFT: we only need a coarse level, and this keeps
                        // the per-frame cost negligible.
                        analyser.fftSize = 256;
                        analyser.smoothingTimeConstant = 0.75;
                        data = new Uint8Array(analyser.frequencyBinCount);
                        context.createMediaStreamSource(stream).connect(analyser);
                        running = true;
                        return true;
                    })
                    .catch(function () { return false; });
            },

            /** Current input level, 0..1. Returns 0 when not running. */
            level: function () {
                if (!running || !analyser) return 0;
                analyser.getByteFrequencyData(data);
                var sum = 0;
                for (var i = 0; i < data.length; i++) sum += data[i];
                var avg = sum / data.length / 255;
                // Perceptual curve: quiet speech should still move the bars.
                return Math.min(1, Math.pow(avg, 0.6) * 1.7);
            },

            /** Release the microphone. Safe to call repeatedly. */
            stop: function () {
                running = false;
                if (stream) {
                    stream.getTracks().forEach(function (t) { t.stop(); });
                    stream = null;
                }
                if (context) {
                    try { context.close(); } catch (err) { /* already closed */ }
                    context = null;
                }
                analyser = null;
                data = null;
            },
            isRunning: function () { return running; }
        };
    }

    window.VoiceEngine = {
        speaker: Speaker,
        createRecognizer: createRecognizer,
        createAudioMeter: createAudioMeter,
        recognitionSupported: function () { return !!SpeechRecognitionImpl; },
        synthesisSupported: function () { return "speechSynthesis" in window; },
        SILENCE_MS: SILENCE_MS,
        MAX_LISTEN_MS: MAX_LISTEN_MS
    };
})(window);
