/*
 * BRIDGE SPOT — Autowalk mission playback.
 *
 * Drives the real Autowalk section at the top of the Missions page. Everything
 * else on that page is the demo mission builder; nothing here touches it.
 *
 * Playback is the highest-risk action in the dashboard: Spot walks a recorded
 * route on its own, with nobody steering. So the three steps are shown as an
 * explicit sequence rather than one button, Play asks for confirmation naming
 * the actual route length, and Pause/Stop stay reachable throughout.
 */
(function (window, document) {
    "use strict";

    var POLL_MS = 2000;

    var $ = function (s, r) { return (r || document).querySelector(s); };
    var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

    var Svc = window.RobotService;
    var selected = null;
    var library = [];
    var state = {};
    var poll = null;

    function toast(msg, tone) {
        if (window.BridgeUI && window.BridgeUI.toast) window.BridgeUI.toast(msg, tone);
    }

    function confirmAction(title, message, label, onConfirm) {
        if (!window.BridgeUI || !window.BridgeUI.openModal) { onConfirm(); return; }
        window.BridgeUI.openModal({
            title: title, icon: "alert",
            body: "<p class='ctl-confirm'>" + message + "</p>",
            footer: [{ label: "Cancel" }, { label: label, variant: "accent", onClick: onConfirm }]
        });
    }

    /* ------------------------------------------------------------------
       Library
       ------------------------------------------------------------------ */

    function renderLibrary() {
        var host = $("[data-role='aw-list']");
        if (!host) return;
        host.innerHTML = "";

        if (!library.length) {
            host.innerHTML = '<p class="ctl-note">No Autowalk exports found in ' +
                "<code>spot/data/missions/</code>. Export a walk from the tablet and unzip it there.</p>";
            return;
        }

        library.forEach(function (mission) {
            var card = document.createElement("button");
            card.type = "button";
            card.className = "aw-card" + (selected === mission.id ? " is-selected" : "");
            card.disabled = !mission.playable;

            var warn = "";
            if (!mission.playable) {
                warn = '<p class="aw-card__warn">' +
                    (mission.missing_snapshots
                        ? mission.missing_snapshots + " waypoint snapshots missing"
                        : "No autowalk file in this export") + "</p>";
            } else if (mission.actions === 0) {
                // Worth saying plainly: this route walks and docks but captures
                // nothing, so no inspection images will appear afterwards.
                warn = '<p class="aw-card__warn aw-card__warn--info">Navigation only — no capture actions</p>';
            }

            card.innerHTML =
                '<h3 class="aw-card__name">' + mission.name + "</h3>" +
                '<dl class="aw-card__facts">' +
                "<div><dt>Waypoints</dt><dd>" + mission.waypoints + "</dd></div>" +
                "<div><dt>Distance</dt><dd>" + mission.route_ft + " ft</dd></div>" +
                "<div><dt>Actions</dt><dd>" + mission.actions + "</dd></div>" +
                "<div><dt>Dock</dt><dd>" + (mission.dock_ids.length ? mission.dock_ids.join(", ") : "none") + "</dd></div>" +
                "</dl>" + warn;

            card.addEventListener("click", function () {
                selected = mission.id;
                renderLibrary();
                $("[data-role='aw-run']").hidden = false;
                render();
            });
            host.appendChild(card);
        });
    }

    /* ------------------------------------------------------------------
       State
       ------------------------------------------------------------------ */

    function render() {
        var chip = $("[data-role='aw-state']");
        if (chip) {
            var label = state.running ? "Running" : (state.status || "idle");
            chip.textContent = label.charAt(0).toUpperCase() + label.slice(1);
            chip.className = "chip " + (state.running ? "chip--warn"
                : state.status === "failed" ? "chip--bad"
                : state.status === "finished" ? "chip--ok" : "chip--plain");
        }

        var message = $("[data-role='aw-message']");
        if (message) message.textContent = state.message || "";

        mark("upload", state.uploaded === selected);
        mark("localize", !!state.localized);
        mark("play", !!state.running || state.status === "finished");

        // Play is only meaningful once uploaded and localised.
        var playBtn = $("[data-action='aw-play']");
        if (playBtn) playBtn.disabled = !(state.uploaded === selected && state.localized) || !!state.running;
        var pauseBtn = $("[data-action='aw-pause']");
        if (pauseBtn) pauseBtn.disabled = !state.running;
    }

    function mark(step, done) {
        var node = $(".aw-steps .ctl-step[data-step='" + step + "']");
        if (node) node.classList.toggle("is-done", !!done);
    }

    function refresh() {
        return Svc.call("missions", "/missions", { method: "GET" }).then(function (result) {
            if (!result.ok) return;
            library = result.data.library || [];
            state = result.data;
            if (!selected && library.length && library[0].playable) selected = library[0].id;
            renderLibrary();
            if (selected) $("[data-role='aw-run']").hidden = false;
            render();
        });
    }

    /* ------------------------------------------------------------------
       Actions
       ------------------------------------------------------------------ */

    function run(action, path, body, label) {
        var btn = $("[data-action='" + action + "']");
        if (btn) btn.disabled = true;
        return Svc.call(action, path, { body: body })
            .then(function (result) {
                if (result.ok) toast(label + " complete.", "ok");
                else toast(result.error, "bad");
                return refresh();
            })
            .then(function () { if (btn) btn.disabled = false; });
    }

    function bind() {
        var upload = $("[data-action='aw-upload']");
        if (upload) upload.addEventListener("click", function () {
            toast("Uploading map — this can take a minute.", "info");
            run("aw-upload", "/missions/upload", { mission: selected }, "Upload");
        });

        var localize = $("[data-action='aw-localize']");
        if (localize) localize.addEventListener("click", function () {
            run("aw-localize", "/missions/localize", undefined, "Localise");
        });

        var play = $("[data-action='aw-play']");
        if (play) play.addEventListener("click", function () {
            var mission = library.find(function (m) { return m.id === selected; }) || {};
            confirmAction(
                "Play " + (mission.name || "mission"),
                "Spot will walk the recorded route <strong>autonomously</strong> — about " +
                (mission.route_ft || "?") + " ft across " + (mission.waypoints || "?") +
                " waypoints, with nobody steering.<br><br>" +
                "Clear the route, keep the tablet controller in reach, and stay with the robot.",
                "Play route",
                function () { run("aw-play", "/missions/play", { mission: selected }, "Playback start"); }
            );
        });

        var pause = $("[data-action='aw-pause']");
        if (pause) pause.addEventListener("click", function () {
            run("aw-pause", "/missions/pause", undefined, "Pause");
        });

        var stop = $("[data-action='aw-stop']");
        if (stop) stop.addEventListener("click", function () {
            run("aw-stop", "/missions/stop", undefined, "Stop");
        });
    }

    function init() {
        if (!$("[data-role='aw-panel']") || !Svc) return;
        bind();
        refresh();
        poll = setInterval(refresh, POLL_MS);
        window.addEventListener("pagehide", function () { if (poll) clearInterval(poll); });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})(window, document);
