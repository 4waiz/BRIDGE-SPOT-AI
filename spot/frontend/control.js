/*
 * BRIDGE SPOT — live robot control.
 *
 * Talks to the /api/robot/* endpoints served by spot/app/control_api.py. Unlike
 * the rest of the platform pages, nothing here is demo data: every button moves
 * real hardware.
 *
 * Drive model
 * -----------
 * The sticks only ever update a local {v_x, v_y, v_rot} vector. A timer posts
 * that vector to /move at DRIVE_HZ while it is non-zero, and posts a single
 * /stop on the transition back to zero. The robot expires each velocity command
 * on its own (see SPOT_CMD_DURATION), so if this page freezes or the network
 * drops, the robot coasts to a halt instead of continuing on the last command.
 *
 * Axis conventions are Boston Dynamics body frame:
 *   v_x   forward positive
 *   v_y   left positive
 *   v_rot counter-clockwise positive
 * Screen coordinates are y-down, so both are inverted when read off a stick.
 */
(function () {
    "use strict";

    var API = "/api/robot";
    var POLL_MS = 1000;     // telemetry refresh
    var DRIVE_MS = 100;     // 10 Hz, comfortably inside the 0.6s command expiry
    var CAMERA_MS = 250;    // ~4 fps; enough to drive by without saturating wifi

    var limits = { max_linear: 0.6, max_angular: 0.8 };
    var robot = { connected: false, ready: false };

    var drive = { v_x: 0, v_y: 0, v_rot: 0 };
    var wasDriving = false;
    var inFlight = false;

    var cameraUrl = null;
    var cameraBusy = false;

    var $ = function (sel, root) { return (root || document).querySelector(sel); };
    var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

    function toast(msg, tone) {
        if (window.BridgeUI && window.BridgeUI.toast) window.BridgeUI.toast(msg, tone);
        else if (tone === "bad") console.error(msg);
    }

    /* ------------------------------------------------------------------
       API helper
       ------------------------------------------------------------------ */

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
                    // The service layer puts the human-readable reason in `detail`.
                    var reason = data && data.detail ? data.detail : res.statusText;
                    var err = new Error(reason);
                    err.status = res.status;
                    throw err;
                }
                return data;
            });
        });
    }

    /* ------------------------------------------------------------------
       Confirmation dialog for the commands that make the robot move a lot
       ------------------------------------------------------------------ */

    function confirmAction(title, message, confirmLabel, onConfirm) {
        if (!window.BridgeUI || !window.BridgeUI.openModal) { onConfirm(); return; }
        window.BridgeUI.openModal({
            title: title,
            icon: "alert",
            body: "<p class='ctl-confirm'>" + message + "</p>",
            footer: [
                { label: "Cancel" },
                { label: confirmLabel, variant: "accent", onClick: onConfirm }
            ]
        });
    }

    /* ------------------------------------------------------------------
       Telemetry
       ------------------------------------------------------------------ */

    function refreshState() {
        return api("/state", { method: "GET" })
            .then(render)
            .catch(function (err) {
                robot.connected = false;
                robot.ready = false;
                setChip("conn-chip", "Unreachable", "bad");
                console.error("state poll failed", err);
            });
    }

    function setChip(role, text, tone) {
        var node = $("[data-role='" + role + "']");
        if (!node) return;
        node.textContent = text;
        node.className = "chip " + (tone ? "chip--" + tone : "chip--plain");
    }

    function setStat(field, text, tone) {
        var node = $("[data-field='" + field + "']");
        if (!node) return;
        node.textContent = text;
        var tile = node.closest(".ctl-stat");
        if (tile) tile.className = "ctl-stat" + (tone ? " is-" + tone : "");
    }

    function markStep(step, done) {
        var node = $(".ctl-step[data-step='" + step + "']");
        if (node) node.classList.toggle("is-done", !!done);
    }

    function render(state) {
        if (state.limits) limits = state.limits;

        robot.connected = !!state.connected;

        if (!state.connected) {
            setChip("conn-chip", "Disconnected", null);
            setStat("connection", state.ip || "—", null);
            ["estop", "lease", "power", "battery", "dock"].forEach(function (f) { setStat(f, "—", null); });
            ["connect", "estop", "lease", "power", "stand"].forEach(function (s) { markStep(s, false); });
            robot.ready = false;
            updateLocks();
            return;
        }

        setChip("conn-chip", "Connected", "ok");
        setStat("connection", (state.comms && state.comms[0] && state.comms[0].essid) || "Online", "ok");

        var estop = state.estop || {};
        var estopClear = !!estop.clear;
        setStat("estop", !estop.registered ? "Not registered" : (estopClear ? "Clear" : "ENGAGED"),
                !estop.registered ? null : (estopClear ? "ok" : "bad"));

        setStat("lease", state.lease_held ? "Held" : "Not held", state.lease_held ? "ok" : null);

        var poweredOn = !!state.powered_on;
        setStat("power", poweredOn ? "On" : "Off", poweredOn ? "ok" : null);

        var bat = state.battery || {};
        if (bat.percentage !== null && bat.percentage !== undefined) {
            var tone = bat.percentage > 40 ? "ok" : (bat.percentage > 15 ? "warn" : "bad");
            setStat("battery", bat.percentage + "%", tone);
        } else {
            setStat("battery", "—", null);
        }

        var dock = state.docking || {};
        var dockLabel = (dock.status || "").replace("DOCK_STATUS_", "").toLowerCase() || "unknown";
        setStat("dock", dockLabel + (dock.dock_id ? " (" + dock.dock_id + ")" : ""),
                dock.status === "DOCK_STATUS_DOCKED" ? "ok" : null);

        markStep("connect", true);
        markStep("estop", !!estop.registered);
        markStep("lease", !!state.lease_held);
        markStep("power", poweredOn);
        markStep("stand", poweredOn);

        // Driving requires the full chain: E-stop live, lease held, motors on.
        robot.ready = !!estop.registered && estopClear && !!state.lease_held && poweredOn;
        updateLocks();

        if (state.faults && state.faults.length) {
            setStat("connection", state.faults.length + " fault(s)", "warn");
        }
    }

    function updateLocks() {
        var panel = $("[data-role='drive']");
        if (panel) panel.classList.toggle("is-locked", !robot.ready);

        var hint = $("[data-role='drive-lock']");
        if (hint) hint.style.display = robot.ready ? "none" : "";

        $$("[data-needs='control']").forEach(function (btn) {
            btn.disabled = !robot.connected;
        });

        var step = !robot.connected ? 1 : (!$(".ctl-step[data-step='estop']").classList.contains("is-done") ? 2
                 : (!$(".ctl-step[data-step='lease']").classList.contains("is-done") ? 3
                 : (!$(".ctl-step[data-step='power']").classList.contains("is-done") ? 4 : 5)));
        var hintChip = $("[data-role='step-hint']");
        if (hintChip) hintChip.textContent = robot.ready ? "Ready to drive" : "Step " + step + " of 5";
    }

    /* ------------------------------------------------------------------
       Bring-up and posture actions
       ------------------------------------------------------------------ */

    var ACTIONS = {
        "connect":        { path: "/connect",        label: "Connected to robot." },
        "estop-register": { path: "/estop/register", label: "E-stop registered." },
        "power-on":       { path: "/power/on",       label: "Motors on." },
        "stand":          { path: "/stand",          label: "Standing." },
        "sit":            { path: "/sit",            label: "Sitting." },
        "selfright":      { path: "/selfright",      label: "Self-righting." }
    };

    // These make the robot travel or drop, so they get a confirmation first.
    var CONFIRMED = {
        "undock":    ["Undock robot", "Spot will power on, stand and walk off the dock. Make sure the area in front of the dock is clear.", "Undock"],
        "dock":      ["Dock robot", "Spot will walk to dock " + "and seat itself on the charger. Make sure the path to the dock is clear.", "Dock"],
        "power-off": ["Power off motors", "Spot will sit down and cut motor power.", "Power off"]
    };

    var CONFIRMED_PATHS = { "undock": "/undock", "dock": "/dock", "power-off": "/power/off" };

    function runAction(name, button) {
        var spec = ACTIONS[name];
        var path = spec ? spec.path : CONFIRMED_PATHS[name];
        if (!path) return;

        if (button) button.disabled = true;
        api(path)
            .then(function () {
                toast(spec ? spec.label : name + " done.", "ok");
                // Connecting is what makes the Spot CAM sources resolvable.
                if (name === "connect") syncCameras();
                return refreshState();
            })
            .catch(function (err) { toast(err.message, "bad"); })
            .then(function () { if (button) button.disabled = false; });
    }

    /*
     * Lease acquisition is a two-stage affair. The polite Acquire fails with
     * 423 when someone else holds the lease -- nearly always the tablet, since
     * it grabs the lease as soon as it connects. Rather than dead-ending there,
     * offer the forced Take behind a dialog that spells out the consequence,
     * because the tablet operator loses control the instant it goes through.
     */
    function acquireLease(button) {
        if (button) button.disabled = true;
        api("/lease/acquire")
            .then(function () { toast("Lease acquired.", "ok"); return refreshState(); })
            .catch(function (err) {
                if (err.status !== 423) { toast(err.message, "bad"); return; }
                confirmAction(
                    "Lease held by another operator",
                    err.message +
                    "<br><br><strong>Taking it drops the tablet's control immediately.</strong> " +
                    "Only do this if you can see the robot and nobody else is driving it.",
                    "Take lease anyway",
                    function () { takeLease(button); }
                );
            })
            .then(function () { if (button) button.disabled = false; });
    }

    function takeLease(button) {
        if (button) button.disabled = true;
        api("/lease/take")
            .then(function () {
                toast("Lease taken — the tablet no longer has control.", "warn");
                return refreshState();
            })
            .catch(function (err) { toast(err.message, "bad"); })
            .then(function () { if (button) button.disabled = false; });
    }

    function bindActions() {
        $$("[data-action]").forEach(function (btn) {
            var name = btn.getAttribute("data-action");
            btn.addEventListener("click", function () {
                if (name === "lease-acquire") { acquireLease(btn); return; }
                if (CONFIRMED[name]) {
                    var c = CONFIRMED[name];
                    confirmAction(c[0], c[1], c[2], function () { runAction(name, btn); });
                    return;
                }
                if (name === "release") {
                    confirmAction("Release control",
                        "Returns the lease and tears down the E-stop endpoint. The robot keeps its current pose.",
                        "Release", function () {
                            api("/lease/return")
                                .then(function () { return api("/estop/release"); })
                                .then(function () { toast("Control released.", "ok"); return refreshState(); })
                                .catch(function (err) { toast(err.message, "bad"); });
                        });
                    return;
                }
                runAction(name, btn);
            });
        });

        // Emergency stop: no confirmation, by design.
        var estopBtn = $("[data-role='estop']");
        if (estopBtn) {
            estopBtn.addEventListener("click", function () {
                zeroDrive();
                api("/estop/engage")
                    .then(function () { toast("EMERGENCY STOP engaged — motor power cut.", "bad"); return refreshState(); })
                    .catch(function (err) { toast(err.message, "bad"); });
            });
        }
    }

    /* ------------------------------------------------------------------
       Joysticks
       ------------------------------------------------------------------ */

    function makeStick(node, onMove) {
        var knob = $(".ctl-stick__knob", node);
        var active = null;      // pointerId currently driving this stick
        var radius = 1;

        function measure() { radius = node.clientWidth / 2 - knob.clientWidth / 2; }

        function place(dx, dy) {
            knob.style.transform = "translate(" + dx + "px," + dy + "px)";
        }

        function update(ev) {
            var rect = node.getBoundingClientRect();
            var dx = ev.clientX - (rect.left + rect.width / 2);
            var dy = ev.clientY - (rect.top + rect.height / 2);
            var dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > radius && dist > 0) {
                dx = dx / dist * radius;
                dy = dy / dist * radius;
            }
            place(dx, dy);
            // Normalised to -1..1; screen y is inverted so up reads positive.
            onMove(radius ? dx / radius : 0, radius ? -dy / radius : 0);
        }

        function release() {
            active = null;
            place(0, 0);
            node.classList.remove("is-active");
            onMove(0, 0);
        }

        node.addEventListener("pointerdown", function (ev) {
            if (!robot.ready) return;
            measure();
            active = ev.pointerId;
            node.setPointerCapture(ev.pointerId);
            node.classList.add("is-active");
            update(ev);
            ev.preventDefault();
        });

        node.addEventListener("pointermove", function (ev) {
            if (active !== ev.pointerId) return;
            update(ev);
            ev.preventDefault();
        });

        ["pointerup", "pointercancel", "lostpointercapture"].forEach(function (type) {
            node.addEventListener(type, function (ev) {
                if (active !== ev.pointerId) return;
                release();
            });
        });

        // Losing the tab mid-drive must not leave a stick held down.
        window.addEventListener("blur", function () { if (active !== null) release(); });

        measure();
        window.addEventListener("resize", measure);
    }

    function setupSticks() {
        var translate = $(".ctl-stick[data-stick='translate']");
        var turn = $(".ctl-stick[data-stick='turn']");

        if (translate) {
            makeStick(translate, function (nx, ny) {
                drive.v_x = ny * limits.max_linear;   // up  -> forward
                drive.v_y = -nx * limits.max_linear;  // right -> strafe right (v_y negative)
                showSpeed();
            });
        }
        if (turn) {
            makeStick(turn, function (nx) {
                drive.v_rot = -nx * limits.max_angular; // right -> clockwise (negative)
                showSpeed();
            });
        }
    }

    function showSpeed() {
        var node = $("[data-role='speed']");
        if (!node) return;
        var linear = Math.sqrt(drive.v_x * drive.v_x + drive.v_y * drive.v_y);
        node.textContent = "v " + linear.toFixed(2) + " m/s · ω " + Math.abs(drive.v_rot).toFixed(2) + " rad/s";
    }

    function zeroDrive() {
        drive.v_x = drive.v_y = drive.v_rot = 0;
        showSpeed();
    }

    /* ------------------------------------------------------------------
       Keyboard drive
       ------------------------------------------------------------------ */

    var keys = {};
    var KEY_AXES = {
        w: ["v_x", 1], s: ["v_x", -1],
        a: ["v_y", 1], d: ["v_y", -1],
        q: ["v_rot", 1], e: ["v_rot", -1]
    };

    function applyKeys() {
        if (!robot.ready) return;
        var next = { v_x: 0, v_y: 0, v_rot: 0 };
        Object.keys(keys).forEach(function (k) {
            if (!keys[k] || !KEY_AXES[k]) return;
            var axis = KEY_AXES[k][0];
            var sign = KEY_AXES[k][1];
            next[axis] += sign * (axis === "v_rot" ? limits.max_angular : limits.max_linear);
        });
        drive.v_x = next.v_x;
        drive.v_y = next.v_y;
        drive.v_rot = next.v_rot;
        showSpeed();
    }

    function bindKeyboard() {
        window.addEventListener("keydown", function (ev) {
            var tag = (ev.target.tagName || "").toLowerCase();
            if (tag === "input" || tag === "select" || tag === "textarea") return;
            var k = ev.key.toLowerCase();
            if (k === " ") { zeroDrive(); keys = {}; ev.preventDefault(); return; }
            if (!KEY_AXES[k]) return;
            keys[k] = true;
            applyKeys();
            ev.preventDefault();
        });
        window.addEventListener("keyup", function (ev) {
            var k = ev.key.toLowerCase();
            if (!KEY_AXES[k]) return;
            keys[k] = false;
            applyKeys();
        });
        // Any focus loss releases every held key, so the robot cannot run on.
        window.addEventListener("blur", function () { keys = {}; zeroDrive(); });
    }

    /* ------------------------------------------------------------------
       Drive loop
       ------------------------------------------------------------------ */

    function driveTick() {
        if (!robot.ready) {
            if (wasDriving) wasDriving = false;
            return;
        }
        var moving = drive.v_x !== 0 || drive.v_y !== 0 || drive.v_rot !== 0;

        if (!moving && !wasDriving) return;
        if (inFlight) return;   // never queue commands behind a slow round trip

        inFlight = true;
        if (moving) {
            wasDriving = true;
            api("/move", { body: { v_x: drive.v_x, v_y: drive.v_y, v_rot: drive.v_rot } })
                .catch(function (err) { toast(err.message, "bad"); zeroDrive(); })
                .then(function () { inFlight = false; });
        } else {
            wasDriving = false;
            api("/stop")
                .catch(function () { /* the command expiry stops it regardless */ })
                .then(function () { inFlight = false; });
        }
    }

    /* ------------------------------------------------------------------
       Camera
       ------------------------------------------------------------------ */

    /*
     * Hide the Spot CAM options when the payload is not fitted, so the operator
     * is not offered cameras that will only ever return an error.
     */
    function syncCameras() {
        return api("/cameras", { method: "GET" })
            .then(function (data) {
                var list = (data && data.cameras) || [];
                if (!list.length) return;
                var hasPayload = list.some(function (c) { return c.payload; });
                var group = $("optgroup[data-group='spotcam']");
                if (!group) return;
                group.disabled = !hasPayload;
                group.label = hasPayload ? "Spot CAM" : "Spot CAM (not fitted)";
                if (!hasPayload) {
                    var select = $("[data-role='camera-view']");
                    if (select && select.value.indexOf("cam-") === 0) select.value = "frontleft";
                }
            })
            .catch(function () { /* leave the static list in place */ });
    }

    // The panoramic source is 9600x1080 and roughly a megabyte a frame, so it
    // gets a slower beat than the 1080p PTZ feed.
    var VIEW_INTERVAL = { "cam-pano": 1500, "cam-ptz": 400 };
    var lastFrameAt = 0;

    function cameraTick() {
        if (!robot.connected || cameraBusy) return;
        var select = $("[data-role='camera-view']");
        var img = $("[data-role='camera-img']");
        var empty = $("[data-role='camera-empty']");
        if (!select || !img) return;

        var minGap = VIEW_INTERVAL[select.value] || 0;
        var now = Date.now();
        if (minGap && now - lastFrameAt < minGap) return;
        lastFrameAt = now;

        cameraBusy = true;
        fetch(API + "/camera/" + select.value)
            .then(function (res) {
                if (!res.ok) throw new Error("no frame");
                var rotation = parseInt(res.headers.get("X-Image-Rotation") || "0", 10);
                return res.blob().then(function (blob) {
                    var url = URL.createObjectURL(blob);
                    img.src = url;
                    img.style.transform = rotation ? "rotate(" + rotation + "deg)" : "";
                    // Must be an explicit value: the stylesheet hides this img by
                    // default as the empty state, so "" would re-hide it.
                    img.style.display = "block";
                    if (empty) empty.style.display = "none";
                    // Release the previous frame or the tab leaks a blob per frame.
                    if (cameraUrl) URL.revokeObjectURL(cameraUrl);
                    cameraUrl = url;
                });
            })
            .catch(function () {
                if (empty) empty.style.display = "";
            })
            .then(function () { cameraBusy = false; });
    }

    /* ------------------------------------------------------------------
       Boot
       ------------------------------------------------------------------ */

    function init() {
        bindActions();
        setupSticks();
        bindKeyboard();

        refreshState().then(syncCameras);
        setInterval(refreshState, POLL_MS);
        setInterval(driveTick, DRIVE_MS);
        setInterval(cameraTick, CAMERA_MS);

        // Leaving the page must not leave the robot under a stale command.
        window.addEventListener("beforeunload", function () {
            if (wasDriving) navigator.sendBeacon(API + "/stop");
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
