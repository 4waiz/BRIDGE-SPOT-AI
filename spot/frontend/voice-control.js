/*
 * BRIDGE SPOT — Voice Control page controller.
 *
 * Pipeline:
 *   listen -> transcript -> intent -> validate robot state -> acknowledge
 *          -> execute via RobotService -> real result -> spoken outcome
 *
 * Two rules shape most of the code here:
 *
 *  1. Nothing is announced as done until the backend says it is. The success
 *     line is spoken from the resolved result, never from a timer.
 *  2. One command at a time. A physical robot must not receive "stand" and
 *     "sit" because speech recognition emitted two finals, or because the
 *     operator pressed a quick command twice.
 *
 * State is a single tagged object rather than a spread of booleans, so
 * "listening while speaking" is not representable.
 */
(function (window, document) {
    "use strict";

    var Svc = window.RobotService;
    var Engine = window.VoiceEngine;
    var Commands = window.VoiceCommands;

    var STATE_POLL_MS = 2000;
    // Two finals for the same intent inside this window are treated as one
    // utterance rather than two commands.
    var DEDUPE_MS = 2000;

    var $ = function (s, r) { return (r || document).querySelector(s); };
    var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

    /* ==================================================================
       State
       ================================================================== */

    // { type: 'idle' | 'listening' | 'processing' | 'executing' | 'speaking'
    //          | 'success' | 'error', ... }
    var state = { type: "idle" };

    var recognizer = null;
    var meter = null;
    var waveFrame = null;
    var statePoll = null;
    var resetTimer = null;

    var telemetry = { connected: false, canMove: false };
    var lastCommand = { intent: null, at: 0 };
    var executing = false;          // hard lock: one robot command at a time
    var commandSeq = 0;
    var disposed = false;

    function log() {
        if (window.console && console.debug) {
            console.debug.apply(console, ["[voice]"].concat(Array.prototype.slice.call(arguments)));
        }
    }

    /* ==================================================================
       State machine
       ================================================================== */

    var STATE_TEXT = {
        idle: "Ready for command",
        listening: "Listening…",
        processing: "Understanding command…",
        executing: "Executing",
        speaking: "Spot is responding…",
        success: "Completed",
        error: "Error"
    };

    function setState(next) {
        state = next;
        var stage = $(".vc-stage");
        var label = $("[data-role='vc-state']");
        var hint = $("[data-role='vc-hint']");
        var mic = $("[data-role='vc-mic']");
        if (!stage || !label || !mic) return;

        stage.setAttribute("data-state", next.type);

        var text = STATE_TEXT[next.type] || "";
        if (next.type === "executing" && next.label) text = "Executing: " + next.label;
        if (next.type === "success" && next.label) text = next.label + " — completed";
        if (next.type === "error") text = next.message || "Error";
        label.textContent = text;

        if (hint) {
            if (next.type === "listening") hint.textContent = "Speak now — tap again to cancel";
            else if (next.type === "idle") hint.textContent = "Tap the microphone, or press Space";
            else hint.textContent = "";
        }

        var listening = next.type === "listening";
        mic.classList.toggle("is-listening", listening);
        mic.setAttribute("aria-label", listening
            ? "Stop listening"
            : "Start listening for a Spot command");
        // Busy states must not accept another press.
        mic.disabled = (next.type === "processing" || next.type === "executing");

        if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
        if (next.type === "success" || next.type === "error") {
            resetTimer = setTimeout(function () {
                if (state.type === "success" || state.type === "error") setState({ type: "idle" });
            }, next.type === "error" ? 6000 : 2600);
        }
    }

    /* ==================================================================
       Banner
       ================================================================== */

    function setBanner(message, tone) {
        var el = $("[data-role='vc-banner']");
        if (!el) return;
        if (!message) { el.hidden = true; return; }
        el.hidden = false;
        el.className = "vc-banner is-" + (tone || "info");
        el.textContent = message;
    }

    /* ==================================================================
       Transcript log
       ================================================================== */

    function logEntry(entry) {
        var host = $("[data-role='vc-log']");
        if (!host) return;
        var empty = host.querySelector(".vc-log__empty");
        if (empty) empty.remove();

        var time = new Date().toLocaleTimeString();
        var row = document.createElement("article");
        row.className = "vc-entry is-" + (entry.status || "info");

        var parts = [
            '<header class="vc-entry__head">' +
                '<time>' + time + "</time>" +
                (entry.intent ? '<code class="vc-entry__intent">' + entry.intent + "</code>" : "") +
                '<span class="vc-entry__status">' + (entry.statusLabel || "") + "</span>" +
                (entry.durationMs ? '<span class="vc-entry__dur">' + (entry.durationMs / 1000).toFixed(1) + "s</span>" : "") +
            "</header>",
            '<p class="vc-entry__line"><span class="vc-entry__who">You</span>' + escapeHtml(entry.said || "") + "</p>"
        ];
        if (entry.reply) {
            parts.push('<p class="vc-entry__line"><span class="vc-entry__who vc-entry__who--spot">Spot</span>' +
                escapeHtml(entry.reply) + "</p>");
        }
        row.innerHTML = parts.join("");
        host.insertBefore(row, host.firstChild);

        // Keep the panel readable rather than unbounded.
        var rows = host.querySelectorAll(".vc-entry");
        for (var i = 12; i < rows.length; i++) rows[i].remove();
        return row;
    }

    function escapeHtml(text) {
        var div = document.createElement("div");
        div.textContent = String(text == null ? "" : text);
        return div.innerHTML;
    }

    /* ==================================================================
       Speaking
       ================================================================== */

    function say(text) {
        if (!text) return Promise.resolve();
        return Engine.speaker.speak(text);
    }

    /* ==================================================================
       Command execution
       ================================================================== */

    /**
     * Explain, in the operator's terms, why a command cannot run yet.
     * @returns {string|null} null when the command may proceed
     */
    function blockedReason(command) {
        if (command.requiresConnection && !telemetry.connected) {
            return "I can't do that yet, sir. Spot isn't connected.";
        }
        if (command.requiresControl && !telemetry.canMove) {
            var missing = [];
            if (!telemetry.estopRegistered) missing.push("the E-stop isn't registered");
            else if (!telemetry.estopClear) missing.push("the E-stop is engaged");
            if (!telemetry.leaseHeld) missing.push("I don't hold the lease");
            if (!telemetry.poweredOn) missing.push("the motors are off");
            if (!missing.length) missing.push("the robot isn't ready");
            return "I can't do that yet, sir — " + missing.join(", ") + ".";
        }
        return null;
    }

    /**
     * Run one resolved command end to end. The single entry point for both
     * speech and quick-command clicks, so they behave identically.
     */
    function execute(command, saidText) {
        var now = Date.now();

        // Duplicate protection: same intent again almost immediately is one
        // utterance heard twice, not two commands.
        if (lastCommand.intent === command.intent && (now - lastCommand.at) < DEDUPE_MS) {
            log("deduped", command.intent);
            return Promise.resolve();
        }

        // Safety commands preempt; everything else queues behind the lock.
        var isSafety = command.risk === "critical";
        if (executing && !isSafety) {
            var busy = "One moment, sir — I'm still working on the last command.";
            logEntry({ said: saidText, intent: command.intent, reply: busy,
                       status: "warn", statusLabel: "Rejected — busy" });
            setState({ type: "error", message: "Busy with the previous command" });
            return say(busy);
        }

        var blocked = blockedReason(command);
        if (blocked) {
            logEntry({ said: saidText, intent: command.intent, reply: blocked,
                       status: "warn", statusLabel: "Blocked" });
            setState({ type: "error", message: "Command not available in this state" });
            return say(blocked);
        }

        lastCommand = { intent: command.intent, at: now };
        var id = ++commandSeq;
        executing = true;
        log("dispatch", id, command.intent);

        var ack = Commands.pick(command.responses.acknowledgement);
        setState({ type: "executing", intent: command.intent, label: command.label });
        setFact("command", command.label + "…");

        // Acknowledge and start the robot work together, so the operator hears
        // something immediately instead of waiting on the robot. The outcome is
        // spoken only once BOTH have finished, which is what stops the reply
        // talking over the acknowledgement.
        var ackDone = isSafety ? Promise.resolve() : say(ack);
        if (isSafety) say(ack);   // fire and forget: never delay a stop

        var started = Date.now();
        var work = Promise.resolve().then(function () { return command.run(Svc); });

        return Promise.all([ackDone, work])
            .then(function (results) {
                var result = results[1] || { ok: false, error: "No result" };
                var durationMs = Date.now() - started;
                log("result", id, command.intent, result.ok ? "ok" : result.error);

                if (result.ok) {
                    var reply = command.intent === "ROBOT_STATUS"
                        ? describeStatus(result.data)
                        : Commands.pick(command.responses.success);
                    logEntry({ said: saidText, intent: command.intent, reply: reply,
                               status: "ok", statusLabel: "Completed", durationMs: durationMs });
                    setState({ type: "success", intent: command.intent, label: command.label });
                    return say(reply);
                }

                // Speak the natural line, but keep the backend's own words in
                // the log and the status strip. "UnableToConnectToRobotError"
                // is what an engineer needs; it is not what Spot should say.
                var spoken = Commands.pick(command.responses.failure);
                var detail = result.error || "";
                logEntry({
                    said: saidText,
                    intent: command.intent,
                    reply: detail ? spoken + "  (" + detail + ")" : spoken,
                    status: "bad", statusLabel: "Failed", durationMs: durationMs
                });
                setState({ type: "error", message: detail || spoken });
                return say(spoken);
            })
            .catch(function (err) {
                // Should not happen: RobotService resolves rather than rejects.
                log("unexpected", err);
                var msg = "Something went wrong running that command, sir.";
                logEntry({ said: saidText, intent: command.intent, reply: msg,
                           status: "bad", statusLabel: "Failed" });
                setState({ type: "error", message: msg });
                return say(msg);
            })
            .then(function () {
                executing = false;
                setFact("command", "Ready");
                refreshState();
            });
    }

    /** Spoken status built only from values the backend actually reported. */
    function describeStatus(data) {
        if (!data || !data.connected) return "Spot is not connected, sir.";
        var r = Svc.readiness(data);
        var bits = ["Spot is connected"];
        bits.push(r.poweredOn ? "motors on" : "motors off");
        if (r.leaseHeld) bits.push("lease held");
        if (r.batteryPercent !== null) bits.push("battery " + Math.round(r.batteryPercent) + " percent");
        if (r.docked) bits.push("on the dock");
        return bits.join(", ") + ", sir.";
    }

    /* ==================================================================
       Handling a transcript
       ================================================================== */

    function handleTranscript(text) {
        if (!text) return;
        setState({ type: "processing", transcript: text });

        var match = Commands.resolve(text);
        if (!match) {
            var reply = "I don't have that command available, sir.";
            logEntry({ said: text, reply: reply, status: "warn", statusLabel: "Not recognised" });
            setState({ type: "error", message: "Command not recognized" });
            say(reply);
            return;
        }
        log("resolved", text, "->", match.command.intent, "via", match.matched);
        execute(match.command, text);
    }

    /* ==================================================================
       Listening
       ================================================================== */

    function startListening() {
        if (!recognizer) return;
        if (state.type === "processing" || state.type === "executing") return;

        // Taking the microphone always wins over Spot talking, so the operator
        // can cut in mid-sentence.
        Engine.speaker.cancel();

        var liveText = $("[data-role='vc-live-text']");
        if (liveText) liveText.textContent = "";
        var live = $("[data-role='vc-live']");
        if (live) live.hidden = true;

        if (meter) meter.start().then(function (ok) { setVoiceFact("mic", ok ? "Live" : "Unavailable", ok); });
        recognizer.start();
    }

    function stopListening() {
        if (recognizer) recognizer.stop();
    }

    function toggleListening() {
        if (state.type === "listening") stopListening();
        else startListening();
    }

    /* ==================================================================
       Waveform
       ================================================================== */

    function drawWave() {
        var canvas = $("[data-role='vc-wave']");
        if (!canvas) return;
        var ctx = canvas.getContext("2d");
        if (!ctx) return;

        var dpr = window.devicePixelRatio || 1;
        var cssWidth = canvas.clientWidth || 600;
        var cssHeight = 64;
        if (canvas.width !== Math.round(cssWidth * dpr)) {
            canvas.width = Math.round(cssWidth * dpr);
            canvas.height = Math.round(cssHeight * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssWidth, cssHeight);

        var listening = state.type === "listening";
        var speaking = state.type === "speaking" || Engine.speaker.isSpeaking();
        if (!listening && !speaking) return;

        // Real microphone level while listening. While Spot speaks the browser
        // gives no access to the synthesis output, so that bar motion is a
        // state indicator, not measured audio.
        var level = listening && meter ? meter.level() : 0.42;
        var accent = getComputedStyle(document.documentElement)
            .getPropertyValue("--accent").trim() || "#ff5622";

        var bars = 48;
        var gap = 3;
        var barWidth = Math.max(2, (cssWidth - gap * (bars - 1)) / bars);
        var t = Date.now() / 1000;

        for (var i = 0; i < bars; i++) {
            var phase = (i / bars) * Math.PI * 2;
            var wobble = Math.sin(t * (listening ? 7 : 4) + phase * 3) * 0.5 + 0.5;
            // Centre bars taller than the edges: reads as a voice, not a bar chart.
            var envelope = Math.sin((i / (bars - 1)) * Math.PI);
            var amp = (listening ? level : 0.35) * wobble * envelope;
            var h = Math.max(2, amp * cssHeight * 0.92);
            var x = i * (barWidth + gap);
            var y = (cssHeight - h) / 2;
            ctx.fillStyle = accent;
            ctx.globalAlpha = 0.35 + envelope * 0.55;
            if (ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(x, y, barWidth, h, barWidth / 2);
                ctx.fill();
            } else {
                ctx.fillRect(x, y, barWidth, h);
            }
        }
        ctx.globalAlpha = 1;
    }

    function waveLoop() {
        if (disposed) return;
        drawWave();
        waveFrame = requestAnimationFrame(waveLoop);
    }

    /* ==================================================================
       Telemetry panel
       ================================================================== */

    function setFact(key, value, tone) {
        var el = $("[data-fact='" + key + "']");
        if (!el) return;
        el.textContent = value;
        el.className = tone ? "is-" + tone : "";
    }

    function setVoiceFact(key, value, ok) {
        var el = $("[data-vfact='" + key + "']");
        if (!el) return;
        el.textContent = value;
        el.className = ok === undefined ? "" : (ok ? "is-ok" : "is-bad");
    }

    function refreshState() {
        return Svc.getState().then(function (res) {
            var chip = $("[data-role='vc-conn']");
            if (!res.ok) {
                telemetry = { connected: false, canMove: false };
                if (chip) { chip.textContent = "Service unreachable"; chip.className = "chip chip--bad"; }
                setFact("connection", "Unreachable", "bad");
                return;
            }

            var data = res.data || {};
            var r = Svc.readiness(data);
            telemetry = r;

            if (chip) {
                chip.textContent = r.connected ? (r.canMove ? "Connected • Ready" : "Connected") : "Disconnected";
                chip.className = "chip " + (r.connected ? (r.canMove ? "chip--ok" : "chip--warn") : "chip--plain");
            }

            setFact("connection", r.connected ? "Connected" : "Disconnected", r.connected ? "ok" : null);
            setFact("power", !r.connected ? "Unavailable" : (r.poweredOn ? "On" : "Off"), r.poweredOn ? "ok" : null);
            // The API reports power and lease but not a posture; saying
            // "standing" here would be inventing telemetry.
            setFact("mobility", !r.connected ? "Unavailable" : (r.poweredOn ? "Powered" : "Idle"));
            setFact("lease", !r.connected ? "Unavailable" : (r.leaseHeld ? "Active" : "Not held"), r.leaseHeld ? "ok" : null);
            setFact("estop", !r.connected ? "Unavailable"
                : (!r.estopRegistered ? "Not registered" : (r.estopClear ? "Clear" : "ENGAGED")),
                r.estopRegistered && r.estopClear ? "ok" : (r.estopRegistered ? "bad" : null));
            setFact("battery", r.batteryPercent === null ? "Unavailable" : Math.round(r.batteryPercent) + "%",
                r.batteryPercent === null ? null : (r.batteryPercent > 30 ? "ok" : "warn"));
            setFact("dock", !r.connected ? "Unavailable"
                : (r.dockStatus ? r.dockStatus.replace("DOCK_STATUS_", "").toLowerCase() : "Unknown"));
        });
    }

    /* ==================================================================
       Quick commands
       ================================================================== */

    function renderQuick() {
        var host = $("[data-role='vc-quick']");
        if (!host) return;
        // Same registry the speech path uses, so the two can never diverge.
        Commands.all.forEach(function (command) {
            if (command.intent === "EMERGENCY_STOP") return;   // has its own button
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "vc-chip is-" + command.risk;
            btn.textContent = command.label;
            btn.setAttribute("data-intent", command.intent);
            btn.title = "Say: \"" + command.aliases[0] + "\"";
            btn.addEventListener("click", function () {
                Engine.speaker.cancel();
                execute(command, command.aliases[0]);
            });
            host.appendChild(btn);
        });
    }

    /* ==================================================================
       Cleanup
       ================================================================== */

    function dispose() {
        disposed = true;
        if (waveFrame) cancelAnimationFrame(waveFrame);
        if (statePoll) clearInterval(statePoll);
        if (resetTimer) clearTimeout(resetTimer);
        if (recognizer) recognizer.dispose();
        if (meter) meter.stop();
        Engine.speaker.cancel();
        log("disposed");
    }

    /* ==================================================================
       Boot
       ================================================================== */

    function init() {
        if (!Svc || !Engine || !Commands) {
            setBanner("Voice control failed to load its dependencies.", "warn");
            return;
        }

        renderQuick();
        setState({ type: "idle" });

        // -- voice system panel --
        var sttOk = Engine.recognitionSupported();
        var ttsOk = Engine.synthesisSupported();
        setVoiceFact("stt", sttOk ? "Ready" : "Unsupported", sttOk);
        setVoiceFact("tts", ttsOk ? (Engine.speaker.voiceName() || "Ready") : "Unsupported", ttsOk);
        setVoiceFact("engine", "Online", true);
        setVoiceFact("mic", "Idle");

        if (!sttOk) {
            setBanner("This browser has no speech recognition. Use Chrome or Edge for voice, " +
                      "or use the quick commands below — they run the same pipeline.", "warn");
            var mic = $("[data-role='vc-mic']");
            if (mic) mic.disabled = true;
        } else {
            meter = Engine.createAudioMeter();
            recognizer = Engine.createRecognizer({
                onStart: function () { setState({ type: "listening" }); },
                onInterim: function (text) {
                    var live = $("[data-role='vc-live']");
                    var el = $("[data-role='vc-live-text']");
                    if (live) live.hidden = false;
                    if (el) el.textContent = text;
                },
                onFinal: function (text) {
                    var el = $("[data-role='vc-live-text']");
                    if (el) el.textContent = text;
                    handleTranscript(text);
                },
                onNoSpeech: function () {
                    setState({ type: "error", message: "I didn't catch that, sir." });
                    say("I didn't catch that, sir.");
                },
                onError: function (message) {
                    setBanner(message, "warn");
                    setState({ type: "error", message: "Microphone error" });
                },
                onEnd: function () {
                    if (meter) meter.stop();
                    setVoiceFact("mic", "Idle");
                    // Only fall back to idle if nothing downstream took over.
                    if (state.type === "listening") setState({ type: "idle" });
                }
            });
        }

        // -- microphone button --
        var micBtn = $("[data-role='vc-mic']");
        if (micBtn) micBtn.addEventListener("click", toggleListening);

        // -- emergency stop --
        var estop = $("[data-role='vc-estop']");
        if (estop) {
            estop.addEventListener("click", function () {
                var command = Commands.byIntent("EMERGENCY_STOP");
                Engine.speaker.cancel();
                execute(command, "emergency stop");
            });
        }

        // -- clear history --
        var clear = $("[data-role='vc-clear']");
        if (clear) {
            clear.addEventListener("click", function () {
                var host = $("[data-role='vc-log']");
                if (host) host.innerHTML = '<p class="vc-log__empty">No commands yet. ' +
                    "Speak to Spot, or use a quick command.</p>";
            });
        }

        // -- Space toggles, but never while typing --
        document.addEventListener("keydown", function (ev) {
            if (ev.code !== "Space" && ev.key !== " ") return;
            var tag = (ev.target.tagName || "").toLowerCase();
            if (tag === "input" || tag === "textarea" || tag === "select" || ev.target.isContentEditable) return;
            // Space on a focused button should press it, not toggle the mic.
            if (tag === "button") return;
            ev.preventDefault();
            toggleListening();
        });

        refreshState();
        statePoll = setInterval(refreshState, STATE_POLL_MS);
        waveLoop();

        // Release the microphone and stop any speech when leaving the page.
        window.addEventListener("pagehide", dispose);
        window.addEventListener("beforeunload", dispose);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})(window, document);
