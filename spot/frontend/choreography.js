/*
 * BRIDGE SPOT — Choreography page.
 *
 * A browsable view of Spot's dance repertoire that can also drive it. Shares
 * the /api/robot/choreography endpoints and the .dance-tile styling with the
 * Dance panel on the Control page, so the two never drift apart.
 *
 * Playing a move needs the same chain as manual driving: E-stop registered,
 * lease held, motors on. Rather than duplicate the bring-up sequence here, the
 * page reports what is missing and links back to the Control page.
 */
(function () {
    "use strict";

    var API = "/api/robot";
    var STATE_MS = 2000;
    var RING_CIRCUMFERENCE = 2 * Math.PI * 20;

    var ready = false;          // full control chain satisfied
    var engineReady = false;    // catalogue loaded and robot connected
    var catalogueLoaded = false;
    var playing = null;
    var endsAt = 0;
    var duration = 0;
    var frame = null;

    var $ = function (s, r) { return (r || document).querySelector(s); };
    var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

    function toast(msg, tone) {
        if (window.BridgeUI && window.BridgeUI.toast) window.BridgeUI.toast(msg, tone);
    }

    function api(path, options) {
        var opts = options || {};
        var init = { method: opts.method || "POST", headers: {} };
        if (opts.body !== undefined) {
            init.headers["Content-Type"] = "application/json";
            init.body = JSON.stringify(opts.body);
        }
        return fetch(API + path, init).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (data) {
                if (!res.ok) {
                    var err = new Error(data && data.detail ? data.detail : res.statusText);
                    err.status = res.status;
                    throw err;
                }
                return data;
            });
        });
    }

    /* ------------------------------------------------------------------
       Tiles
       ------------------------------------------------------------------ */

    function tile(item) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "dance-tile";
        btn.setAttribute("data-move", item.id);
        if (!item.available) {
            btn.classList.add("is-unavailable");
            btn.disabled = true;
            btn.title = item.reason || "Unavailable on this robot";
        }

        btn.innerHTML =
            '<span class="dance-tile__medal">' +
            '  <svg class="dance-tile__ring" viewBox="0 0 44 44" aria-hidden="true">' +
            '    <circle class="dance-tile__ring-bg" cx="22" cy="22" r="20"></circle>' +
            '    <circle class="dance-tile__ring-fg" cx="22" cy="22" r="20"></circle>' +
            "  </svg>" +
            '  <span class="dance-tile__emoji">' + item.emoji + "</span>" +
            "</span>" +
            '<span class="dance-tile__label">' + item.label + "</span>" +
            '<span class="dance-tile__blurb">' + item.blurb + "</span>" +
            '<span class="dance-tile__energy is-' + item.energy + '">' + item.energy + "</span>" +
            // Travel moves drive the legs and need clear space; pose moves keep
            // the feet planted. Worth knowing before pressing play.
            '<span class="choreo-move-id">' +
            (item.travels ? "moves around" : "stays in place") + "</span>";

        var ring = btn.querySelector(".dance-tile__ring-fg");
        ring.style.strokeDasharray = RING_CIRCUMFERENCE;
        ring.style.strokeDashoffset = RING_CIRCUMFERENCE;

        btn.addEventListener("click", function () { play(item.id, item.label); });
        return btn;
    }

    function render(data) {
        engineReady = !!data.ready;
        catalogueLoaded = !!data.connected;
        var grid = $("[data-role='choreo-grid']");
        var basics = $("[data-role='choreo-basics']");
        if (grid) { grid.innerHTML = ""; (data.dances || []).forEach(function (d) { grid.appendChild(tile(d)); }); }
        if (basics) { basics.innerHTML = ""; (data.basics || []).forEach(function (b) { basics.appendChild(tile(b)); }); }
        applyGate();
    }

    /* ------------------------------------------------------------------
       Gating — say plainly why the tiles are inert
       ------------------------------------------------------------------ */

    function setBanner(message, tone) {
        var el = $("[data-role='choreo-banner']");
        if (!el) return;
        if (!message) { el.hidden = true; return; }
        el.hidden = false;
        el.className = "choreo-banner is-" + (tone || "info");
        el.innerHTML = message;
    }

    function applyGate() {
        var usable = ready && engineReady;
        $$(".dance-tile").forEach(function (t) {
            if (t.classList.contains("is-unavailable")) return;
            t.disabled = !usable;
        });
        if (!usable && playing) clearActive();
    }

    function refreshState() {
        return fetch(API + "/state")
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (s) {
                var chip = $("[data-role='choreo-state']");
                if (!s || !s.connected) {
                    ready = false;
                    if (chip) { chip.textContent = "Robot not connected"; chip.className = "chip chip--plain"; }
                    setBanner(
                        'Spot is not connected. Open the <a href="control.html">Control page</a> ' +
                        "and run through bring-up to enable these moves.", "info");
                    applyGate();
                    return;
                }

                var estop = s.estop || {};
                ready = !!estop.registered && !!estop.clear && !!s.lease_held && !!s.powered_on;

                if (chip) {
                    chip.textContent = ready ? "Ready to dance" : "Connected — bring-up incomplete";
                    chip.className = "chip " + (ready ? "chip--ok" : "chip--warn");
                }

                // Re-read the catalogue on first connect: per-move availability
                // is only knowable once the robot is reachable.
                if (!catalogueLoaded) {
                    api("/choreography", { method: "GET" }).then(render).catch(function () {});
                    return;
                }

                if (!ready) {
                    // Name the exact missing step rather than a vague "not ready".
                    var missing = [];
                    if (!estop.registered) missing.push("register the E-stop");
                    else if (!estop.clear) missing.push("clear the E-stop");
                    if (!s.lease_held) missing.push("acquire the lease");
                    if (!s.powered_on) missing.push("power on the motors");
                    setBanner(
                        "Almost there — still need to " + missing.join(", ") + ". " +
                        'Do it on the <a href="control.html">Control page</a>.', "info");
                } else {
                    setBanner(null);
                }
                applyGate();
            })
            .catch(function () {
                ready = false;
                applyGate();
            });
    }

    /* ------------------------------------------------------------------
       Playback
       ------------------------------------------------------------------ */

    function play(moveId) {
        if (!ready || !engineReady) return;
        setActive(moveId);
        api("/choreography/play", { body: { move: moveId } })
            .then(function (res) {
                playing = res.playing;
                duration = res.duration;
                endsAt = Date.now() + (res.started_in * 1000) + (res.duration * 1000);
                startClock();
            })
            .catch(function (err) { toast(err.message, "bad"); clearActive(); });
    }

    function stop() {
        api("/choreography/stop")
            .then(function () { toast("Routine stopped.", "ok"); })
            .catch(function (err) { toast(err.message, "bad"); })
            .then(clearActive);
    }

    function setActive(moveId) {
        $$(".dance-tile").forEach(function (t) {
            t.classList.toggle("is-playing", t.getAttribute("data-move") === moveId);
        });
        var btn = $("[data-role='choreo-stop']");
        if (btn) btn.disabled = false;
    }

    function clearActive() {
        playing = null;
        endsAt = 0;
        if (frame) { cancelAnimationFrame(frame); frame = null; }
        $$(".dance-tile").forEach(function (t) {
            t.classList.remove("is-playing");
            var ring = t.querySelector(".dance-tile__ring-fg");
            if (ring) ring.style.strokeDashoffset = RING_CIRCUMFERENCE;
        });
        var now = $("[data-role='choreo-now']");
        if (now) { now.textContent = "Idle"; now.classList.remove("is-live"); }
        var btn = $("[data-role='choreo-stop']");
        if (btn) btn.disabled = true;
    }

    function startClock() {
        if (frame) cancelAnimationFrame(frame);
        function tick() {
            var left = endsAt - Date.now();
            if (!playing || left <= 0) { clearActive(); return; }
            var progress = Math.max(0, Math.min(1, 1 - left / (duration * 1000)));
            var ring = $(".dance-tile.is-playing .dance-tile__ring-fg");
            if (ring) ring.style.strokeDashoffset = RING_CIRCUMFERENCE * progress;
            var now = $("[data-role='choreo-now']");
            if (now) {
                var label = $(".dance-tile.is-playing .dance-tile__label");
                now.textContent = (label ? label.textContent : "Dancing") + " · " + (left / 1000).toFixed(1) + "s";
                now.classList.add("is-live");
            }
            frame = requestAnimationFrame(tick);
        }
        frame = requestAnimationFrame(tick);
    }

    /* ------------------------------------------------------------------
       Boot
       ------------------------------------------------------------------ */

    function init() {
        api("/choreography", { method: "GET" })
            .then(render)
            .catch(function () {
                setBanner("Could not reach the Spot service on port 4000.", "warn");
            });

        var stopBtn = $("[data-role='choreo-stop']");
        if (stopBtn) stopBtn.addEventListener("click", stop);

        refreshState();
        setInterval(refreshState, STATE_MS);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
