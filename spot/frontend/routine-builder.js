/*
 * BRIDGE SPOT - routine builder.
 *
 * "5 steps forward, capture footage and take a photo, come back": typed in
 * plain words, read by the server into steps, shown back to the operator, and
 * only then run on the robot.
 *
 * This replaces a builder that simulated its runs with timers. Two rules shape
 * it, both because the output is a real robot moving:
 *
 *   The text that runs is the text that was previewed. Editing the instruction
 *   after building it disables Run until it is built again, so nobody reads one
 *   plan and sends another.
 *
 *   The server does the reading and the refusing. This page never guesses at
 *   an instruction; a clause the parser cannot follow comes back as a named
 *   error and nothing is sent.
 */
(function (window, document) {
    "use strict";

    var API = "/api/robot";
    var POLL_MS = 1000;

    var $ = function (s, r) { return (r || document).querySelector(s); };
    var ui = window.BridgeUI || {};

    var SAMPLES = [
        "5 steps forward, capture footage and take a photo, come back",
        "turn left 90, take a thermal photo, turn right 90",
        "forward 2 m, record 10 seconds of thermal footage, come back",
        "take a panoramic photo, turn around, take a photo"
    ];

    var ICONS = {
        move: "arrowRight", turn: "refresh", photo: "camera",
        video: "play", wait: "clock", return: "home"
    };

    var steps = [];
    var builtText = null;       // the exact text the preview came from
    var poll = null;
    var shownCaptures = 0;

    function api(path, options) {
        var opts = options || {};
        var init = { method: opts.method || "GET", headers: {} };
        if (opts.body !== undefined) {
            init.headers["Content-Type"] = "application/json";
            init.body = JSON.stringify(opts.body);
        }
        return fetch(API + path, init).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (data) {
                if (!res.ok) {
                    var error = new Error((data && data.detail) || res.statusText);
                    error.status = res.status;
                    throw error;
                }
                return data;
            });
        });
    }

    function toast(message, tone) {
        if (ui.toast) ui.toast(message, tone);
    }

    function escapeHtml(text) {
        return String(text).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }

    /* ------------------------------------------------------------------
       Preview
       ------------------------------------------------------------------ */

    function renderSteps(activeIndex, finished) {
        var host = $("[data-role='steps']");
        var count = $("[data-role='step-count']");
        if (!host) return;

        host.innerHTML = "";
        if (!steps.length) {
            host.innerHTML = '<li class="empty-state">No routine built yet.</li>';
            if (count) count.textContent = "0 steps";
            return;
        }

        steps.forEach(function (step, index) {
            // Reuses the page's existing step styling, including its active
            // and done states, rather than a second look for the same list.
            var li = document.createElement("li");
            li.className = "step";
            if (activeIndex === index) li.classList.add("is-active");
            if (finished || (activeIndex !== undefined && index < activeIndex)) {
                li.classList.add("is-done");
            }
            var icon = ui.icon ? ui.icon(ICONS[step.kind] || "check") : "";
            li.innerHTML =
                '<span class="step__index">' + (index + 1) + "</span>" +
                "<span>" + escapeHtml(step.text) + "</span>" +
                '<span class="step__meta">' + icon + "</span>";
            host.appendChild(li);
        });
        if (count) count.textContent = steps.length + (steps.length === 1 ? " step" : " steps");
    }

    function showParseError(message) {
        var host = $("[data-role='steps']");
        if (host) {
            host.innerHTML = '<li class="step-error">' + escapeHtml(message) + "</li>";
        }
        var count = $("[data-role='step-count']");
        if (count) count.textContent = "Not understood";
    }

    function setRunEnabled(enabled) {
        var run = $("[data-role='run']");
        if (run) run.disabled = !enabled;
    }

    function build() {
        var input = $("[data-role='mission-input']");
        var text = input ? input.value.trim() : "";
        if (!text) {
            toast("Write what the robot should do first.", "warn");
            return;
        }

        setRunEnabled(false);
        api("/routine/parse", { method: "POST", body: { text: text } })
            .then(function (data) {
                steps = data.steps || [];
                builtText = text;
                renderSteps();
                setRunEnabled(steps.length > 0);
                log("Built " + steps.length + " steps. Check them, then Run.");
            })
            .catch(function (err) {
                steps = [];
                builtText = null;
                showParseError(err.message);
                log("Not run: " + err.message);
            });
    }

    // Anything typed after a build invalidates it. Run must send what was shown.
    function onInputChanged() {
        var input = $("[data-role='mission-input']");
        if (builtText !== null && input && input.value.trim() !== builtText) {
            setRunEnabled(false);
            var count = $("[data-role='step-count']");
            if (count) count.textContent = "Changed, build again";
        }
    }

    /* ------------------------------------------------------------------
       Running
       ------------------------------------------------------------------ */

    function confirmRun() {
        if (!builtText || !steps.length) return;

        var list = steps.map(function (s, i) {
            return "<li>" + (i + 1) + ". " + escapeHtml(s.text) + "</li>";
        }).join("");

        var body =
            "<p>The robot will carry these out on its own:</p>" +
            '<ol class="routine-confirm">' + list + "</ol>" +
            "<p><strong>Stand clear of its path</strong> and keep the hardware " +
            "E-stop in reach. Stop on this page halts it between steps.</p>";

        if (!ui.openModal) {
            if (window.confirm("Run this routine on the robot?")) start();
            return;
        }
        ui.openModal({
            title: "Run on the robot?",
            icon: "alert",
            body: body,
            footer: [
                { label: "Cancel", dismiss: true },
                { label: "Run routine", variant: "accent", onClick: start }
            ]
        });
    }

    function start() {
        setRunEnabled(false);
        setStopEnabled(true);
        shownCaptures = 0;
        clearCaptures();

        api("/routine/run", { method: "POST", body: { text: builtText } })
            .then(function () {
                log("Started. The robot is moving.");
                setRunState("Running", "info");
                beginPolling();
            })
            .catch(function (err) {
                setStopEnabled(false);
                setRunEnabled(true);
                setRunState("Not started", "bad");
                log("Could not start: " + err.message);
                toast(err.message, "warn");
            });
    }

    function stop() {
        api("/routine/stop", { method: "POST" })
            .then(function () { log("Stop requested. It will halt before the next step."); })
            .catch(function (err) { toast(err.message, "warn"); });
    }

    function beginPolling() {
        if (poll) window.clearInterval(poll);
        poll = window.setInterval(refresh, POLL_MS);
        refresh();
    }

    var lastMessage = null;

    function refresh() {
        api("/routine")
            .then(function (state) {
                var total = (state.steps || []).length || steps.length;
                var index = state.step_index;
                var finished = state.status === "finished";

                if (state.steps && state.steps.length) steps = state.steps;
                renderSteps(state.running ? index : undefined, finished);

                var done = finished ? total : Math.max(0, index);
                setProgress(total ? Math.round((done / total) * 100) : 0);

                if (state.message && state.message !== lastMessage) {
                    log(state.message);
                    lastMessage = state.message;
                }
                renderCaptures(state.captures || []);

                if (!state.running) {
                    window.clearInterval(poll);
                    poll = null;
                    setStopEnabled(false);
                    setRunEnabled(!!builtText);
                    var tone = { finished: "ok", stopped: "warn", failed: "bad" }[state.status] || "info";
                    setRunState(labelFor(state.status), tone);
                } else {
                    setRunState("Running step " + (index + 1) + " of " + total, "info");
                }
            })
            .catch(function () { /* keep polling through a blip */ });
    }

    function labelFor(status) {
        return { finished: "Finished", stopped: "Stopped", failed: "Failed", idle: "Idle" }[status] || status;
    }

    /* ------------------------------------------------------------------
       Captures
       ------------------------------------------------------------------ */

    function captureUrl(file) {
        // data/routines/<stamp>/<name>
        var parts = String(file).split("/");
        if (parts.length < 2) return null;
        return API + "/routine/capture/" + encodeURIComponent(parts[parts.length - 2]) +
            "/" + encodeURIComponent(parts[parts.length - 1]);
    }

    function clearCaptures() {
        var host = $("[data-role='captures']");
        if (host) {
            host.innerHTML = "";
            host.hidden = true;
        }
    }

    function renderCaptures(captures) {
        var host = $("[data-role='captures']");
        if (!host || captures.length === shownCaptures) return;

        captures.slice(shownCaptures).forEach(function (capture) {
            var url = captureUrl(capture.file);
            if (!url) return;
            var figure = document.createElement("figure");
            figure.className = "routine-capture";
            var media = capture.kind === "video"
                ? '<video src="' + url + '" controls muted playsinline preload="metadata"></video>'
                : '<a href="' + url + '" target="_blank" rel="noopener"><img src="' + url + '" alt="Routine capture" loading="lazy"></a>';
            figure.innerHTML = media +
                "<figcaption>" + (capture.kind === "video" ? "Footage" : "Photo") +
                " &middot; " + escapeHtml(capture.view || "") + "</figcaption>";
            host.appendChild(figure);
        });
        shownCaptures = captures.length;
        host.hidden = captures.length === 0;
    }

    /* ------------------------------------------------------------------
       Small UI helpers
       ------------------------------------------------------------------ */

    function log(message) {
        var box = $("[data-role='log']");
        if (!box) return;
        var line = document.createElement("p");
        var time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        line.textContent = time + "  " + message;
        if (box.children.length === 1 && /Waiting for/.test(box.textContent)) box.innerHTML = "";
        box.appendChild(line);
        box.scrollTop = box.scrollHeight;
    }

    function setProgress(percent) {
        var fill = $("[data-role='progress']");
        if (fill) fill.style.width = percent + "%";
    }

    function setRunState(text, tone) {
        var chip = $("[data-role='run-state']");
        if (!chip) return;
        chip.textContent = text;
        chip.className = "chip chip--" + (tone === "ok" ? "ok" : tone === "bad" ? "bad" : tone === "warn" ? "warn" : "plain");
    }

    function setStopEnabled(enabled) {
        var stopBtn = $("[data-role='stop']");
        if (stopBtn) stopBtn.disabled = !enabled;
    }

    function clearAll() {
        var input = $("[data-role='mission-input']");
        if (input) input.value = "";
        steps = [];
        builtText = null;
        renderSteps();
        setRunEnabled(false);
        setProgress(0);
        setRunState("Idle", "plain");
        clearCaptures();
        var box = $("[data-role='log']");
        if (box) box.innerHTML = "<p>Waiting for a routine…</p>";
    }

    function renderSamples() {
        var host = $("[data-role='samples']");
        if (!host) return;
        host.innerHTML = "";
        SAMPLES.forEach(function (sample) {
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "chip chip--plain chip--clickable";
            btn.textContent = sample;
            btn.addEventListener("click", function () {
                var input = $("[data-role='mission-input']");
                if (input) {
                    input.value = sample;
                    onInputChanged();
                    input.focus();
                }
            });
            host.appendChild(btn);
        });
    }

    function bind() {
        var buildBtn = $("[data-role='build']");
        if (buildBtn) buildBtn.addEventListener("click", build);
        var runBtn = $("[data-role='run']");
        if (runBtn) runBtn.addEventListener("click", confirmRun);
        var stopBtn = $("[data-role='stop']");
        if (stopBtn) stopBtn.addEventListener("click", stop);
        var clearBtn = $("[data-role='clear']");
        if (clearBtn) clearBtn.addEventListener("click", clearAll);

        var input = $("[data-role='mission-input']");
        if (input) {
            input.addEventListener("input", onInputChanged);
            input.addEventListener("keydown", function (event) {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") build();
            });
        }
    }

    function boot() {
        if (!$("[data-role='mission-input']")) return;
        renderSamples();
        renderSteps();
        bind();
        setStopEnabled(false);

        // Picking up a routine that is already running, e.g. after a reload.
        api("/routine").then(function (state) {
            if (state.running) {
                steps = state.steps || [];
                log("A routine is already running.");
                setStopEnabled(true);
                beginPolling();
            }
        }).catch(function () { /* server may be starting */ });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})(window, document);
