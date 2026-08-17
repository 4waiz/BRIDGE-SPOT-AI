/*
 * BRIDGE SPOT — robot command service.
 *
 * The single place the frontend talks to the robot. Both the manual Control
 * page and the Voice Control page call these functions, so there is exactly one
 * definition of "what standing up means" no matter how the operator asked for
 * it. The real source of truth is still the backend SpotController; this is the
 * thin, shared HTTP client in front of it.
 *
 * Every call resolves to the same normalised shape:
 *
 *   { ok, action, data, error, status, durationMs }
 *
 * It never rejects. Callers get a result object either way, which is what lets
 * the voice layer say "I couldn't do that, sir" instead of dying on an
 * unhandled rejection.
 *
 * Exposed as window.RobotService.
 */
(function (window) {
    "use strict";

    var BASE = "/api/robot";

    /**
     * One HTTP call to the robot API.
     * @returns {Promise<Object>} always resolves; check `.ok`
     */
    function call(action, path, options) {
        var opts = options || {};
        var started = (window.performance && performance.now) ? performance.now() : Date.now();

        var init = { method: opts.method || "POST", headers: {} };
        if (opts.body !== undefined) {
            init.headers["Content-Type"] = "application/json";
            init.body = JSON.stringify(opts.body);
        }

        // A hung request must not leave the UI stuck "executing" forever.
        var controller = null;
        var timer = null;
        if (typeof AbortController !== "undefined" && opts.timeoutMs) {
            controller = new AbortController();
            init.signal = controller.signal;
            timer = setTimeout(function () { controller.abort(); }, opts.timeoutMs);
        }

        function elapsed() {
            var now = (window.performance && performance.now) ? performance.now() : Date.now();
            return Math.round(now - started);
        }

        return fetch(BASE + path, init)
            .then(function (res) {
                return res.json().catch(function () { return {}; }).then(function (data) {
                    if (!res.ok) {
                        return {
                            ok: false,
                            action: action,
                            // The API puts the operator-readable reason in `detail`.
                            error: (data && data.detail) || res.statusText || "Request failed",
                            status: res.status,
                            durationMs: elapsed()
                        };
                    }
                    return { ok: true, action: action, data: data, status: res.status, durationMs: elapsed() };
                });
            })
            .catch(function (err) {
                var aborted = err && err.name === "AbortError";
                return {
                    ok: false,
                    action: action,
                    error: aborted
                        ? "The robot did not respond in time."
                        : "Could not reach the Spot service.",
                    status: 0,
                    durationMs: elapsed()
                };
            })
            .then(function (result) {
                if (timer) clearTimeout(timer);
                return result;
            });
    }

    // Docking and power drive real motion and can take many seconds; the rest
    // should answer promptly or something is wrong.
    var SLOW = 90000;
    var NORMAL = 20000;

    var RobotService = {
        call: call,

        // -- connection --
        connect:        function () { return call("connect", "/connect", { timeoutMs: NORMAL }); },
        disconnect:     function () { return call("disconnect", "/disconnect", { timeoutMs: NORMAL }); },
        getState:       function () { return call("state", "/state", { method: "GET", timeoutMs: NORMAL }); },

        // -- e-stop --
        registerEstop:  function () { return call("estop_register", "/estop/register", { timeoutMs: NORMAL }); },
        engageEstop:    function () { return call("estop_engage", "/estop/engage", { timeoutMs: NORMAL }); },
        clearEstop:     function () { return call("estop_clear", "/estop/clear", { timeoutMs: NORMAL }); },
        releaseEstop:   function () { return call("estop_release", "/estop/release", { timeoutMs: NORMAL }); },

        // -- lease --
        acquireLease:   function () { return call("lease_acquire", "/lease/acquire", { timeoutMs: NORMAL }); },
        takeLease:      function () { return call("lease_take", "/lease/take", { timeoutMs: NORMAL }); },
        returnLease:    function () { return call("lease_return", "/lease/return", { timeoutMs: NORMAL }); },

        // -- power and posture --
        powerOn:        function () { return call("power_on", "/power/on", { timeoutMs: SLOW }); },
        powerOff:       function () { return call("power_off", "/power/off", { timeoutMs: SLOW }); },
        stand:          function () { return call("stand", "/stand", { timeoutMs: NORMAL }); },
        sit:            function () { return call("sit", "/sit", { timeoutMs: NORMAL }); },
        selfRight:      function () { return call("selfright", "/selfright", { timeoutMs: NORMAL }); },
        stop:           function () { return call("stop", "/stop", { timeoutMs: NORMAL }); },

        // -- docking --
        dock:           function (dockId) {
            return call("dock", "/dock", { body: { dock_id: dockId || null }, timeoutMs: SLOW });
        },
        undock:         function () { return call("undock", "/undock", { timeoutMs: SLOW }); },

        // -- drive --
        move:           function (vx, vy, vrot) {
            return call("move", "/move", { body: { v_x: vx, v_y: vy, v_rot: vrot } });
        },

        // -- choreography --
        listMoves:      function () { return call("choreography", "/choreography", { method: "GET", timeoutMs: NORMAL }); },
        dance:          function (moveId) {
            return call("dance", "/choreography/play", { body: { move: moveId }, timeoutMs: NORMAL });
        },
        stopDance:      function () { return call("dance_stop", "/choreography/stop", { timeoutMs: NORMAL }); }
    };

    /**
     * Read the robot state and reduce it to the booleans the UI actually asks
     * about. Keeps the "can I run this command yet" logic in one place instead
     * of every page re-deriving it from the raw payload.
     */
    RobotService.readiness = function (state) {
        var s = state || {};
        var estop = s.estop || {};
        var battery = s.battery || {};
        var docking = s.docking || {};
        return {
            connected: !!s.connected,
            estopRegistered: !!estop.registered,
            estopClear: !!estop.clear,
            leaseHeld: !!s.lease_held,
            poweredOn: !!s.powered_on,
            // Everything needed before the robot will accept a motion command.
            canMove: !!s.connected && !!estop.registered && !!estop.clear &&
                     !!s.lease_held && !!s.powered_on,
            batteryPercent: (typeof battery.percentage === "number") ? battery.percentage : null,
            dockStatus: docking.status || null,
            docked: docking.status === "DOCK_STATUS_DOCKED"
        };
    };

    window.RobotService = RobotService;
})(window);
