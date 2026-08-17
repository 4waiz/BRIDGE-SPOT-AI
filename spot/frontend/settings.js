/*
 * BRIDGE SPOT - settings page.
 *
 * Every control writes straight to localStorage through BridgeUI.store, so
 * the rest of the platform picks the value up on the next render:
 *   robot-host / api-mode     , used by the connection test and shown in dialogs
 *   default-route             , orders the "Start Inspection" menu on home
 *   assistant-mode/-autostart , applied by home.js to the voice assistant
 *   assistant-collapsed       , assistant panel default state
 *   sidebar-collapsed         , shared app shell
 *   notify-dot                , unread indicator in the top bar
 */
(function initSettings() {
    var ui = window.BridgeUI;
    if (!ui) return;

    var DEFAULTS = {
        "robot-host": "192.168.33.137",
        "api-mode": "mock",
        "default-route": "digital_factory.html",
        "assistant-mode": "online",
        "assistant-autostart": false,
        "assistant-collapsed": false,
        "sidebar-collapsed": false,
        "notify-dot": true
    };

    function value(key) {
        return ui.store.get(key, DEFAULTS[key]);
    }

    /* ---------------- Bind the form ---------------- */
    function bindInputs() {
        Array.prototype.forEach.call(document.querySelectorAll("[data-setting]"), function (input) {
            var key = input.getAttribute("data-setting");
            var current = value(key);

            if (input.type === "checkbox") {
                input.checked = !!current;
                input.addEventListener("change", function () {
                    ui.store.set(key, input.checked);
                    applySideEffects(key, input.checked);
                    ui.toast("Setting saved.", "ok");
                });
            } else {
                input.value = current;
                input.addEventListener("change", function () {
                    ui.store.set(key, input.value);
                    applySideEffects(key, input.value);
                    ui.toast("Setting saved.", "ok");
                });
            }
        });
    }

    // A couple of settings change the current page straight away.
    function applySideEffects(key, val) {
        var app = document.querySelector("[data-shell]");
        if (key === "sidebar-collapsed" && app) app.classList.toggle("is-collapsed", !!val);
        if (key === "notify-dot") {
            var dot = document.querySelector(".bs-bell__dot");
            if (dot) dot.style.display = val ? "" : "none";
        }
    }

    function bindTheme() {
        var seg = document.querySelector("[data-role='theme']");
        if (!seg) return;

        var sync = function () {
            var pref = ui.theme.preference();
            Array.prototype.forEach.call(seg.querySelectorAll("button"), function (btn) {
                btn.classList.toggle("is-active", btn.getAttribute("data-theme-pref") === pref);
            });
        };

        seg.addEventListener("click", function (event) {
            var btn = event.target.closest("[data-theme-pref]");
            if (!btn) return;
            ui.theme.apply(btn.getAttribute("data-theme-pref"), true);
            sync();
            ui.toast("Theme updated.", "ok");
        });
        sync();
    }

    /* ---------------- Connection test ---------------- */
    function testConnection() {
        var button = document.querySelector("[data-role='test-connection']");
        var result = document.querySelector("[data-role='connection-result']");
        if (!result) return;

        if (button) {
            button.classList.add("is-busy");
            button.disabled = true;
        }
        result.className = "chip chip--plain";
        result.textContent = "Testing…";

        var finish = function (tone, text) {
            result.className = "chip chip--" + tone;
            result.textContent = text;
            if (button) {
                button.classList.remove("is-busy");
                button.disabled = false;
            }
        };

        // Ping a static asset served by the FastAPI app, this proves the
        // platform backend is reachable without waking the robot.
        // FUTURE (live mode): call GET /api/robot/ping instead.
        var url = "favicon/favicon-32x32.png?ping=" + new Date().getTime();
        var timeout = window.setTimeout(function () {
            finish("bad", "Timed out");
            ui.toast("No response from the Bridge Spot service.", "bad");
        }, 5000);

        fetch(url, { cache: "no-store" })
            .then(function (response) {
                window.clearTimeout(timeout);
                if (!response.ok) throw new Error("HTTP " + response.status);
                if (value("api-mode") === "live") {
                    finish("warn", "Service online · robot not verified");
                    ui.toast("Platform reachable. Live robot checks need Spot on the network.", "warn");
                } else {
                    finish("ok", "Service online · mock mode");
                    ui.toast("Bridge Spot service is reachable.", "ok");
                }
            })
            .catch(function (error) {
                window.clearTimeout(timeout);
                console.error(error);
                finish("bad", "Unreachable");
                ui.toast("Could not reach the Bridge Spot service.", "bad");
            });
    }

    /* ---------------- Local data ---------------- */
    function storageStats() {
        var host = document.querySelector("[data-role='storage-stats']");
        if (!host) return;
        var reports = ui.store.get("reports", []);
        var keys = 0;
        try {
            for (var i = 0; i < window.localStorage.length; i += 1) {
                if (window.localStorage.key(i).indexOf("bridge-spot:") === 0) keys += 1;
            }
        } catch (err) {
            keys = 0;
        }

        host.innerHTML = "";
        [
            { label: "Generated reports", value: String(reports.length), tone: "info" },
            { label: "Stored preferences", value: String(keys), tone: "info" },
            { label: "API mode", value: value("api-mode") === "live" ? "Live" : "Mock", tone: value("api-mode") === "live" ? "warn" : "ok" },
            { label: "Robot host", value: value("robot-host"), tone: "info" }
        ].forEach(function (item) {
            var card = ui.el("div", "uc-status-card tone-" + item.tone);
            card.appendChild(ui.el("span", "uc-status-card__label", item.label));
            card.appendChild(ui.el("span", "uc-status-card__value", item.value));
            host.appendChild(card);
        });
    }

    function clearLocalData() {
        ui.openModal({
            title: "Clear local demo data?",
            tagline: "Removes generated reports and every stored preference in this browser.",
            icon: "alert",
            badge: "Careful",
            body: ui.statusGrid([
                { label: "Generated reports", value: String(ui.store.get("reports", []).length), tone: "warn" },
                { label: "Preferences", value: "All settings on this page", tone: "warn" },
                { label: "Robot data", value: "Not affected", tone: "ok" }
            ]),
            footer: [
                {
                    label: "Clear data",
                    variant: "accent",
                    onClick: function () {
                        try {
                            var doomed = [];
                            for (var i = 0; i < window.localStorage.length; i += 1) {
                                var key = window.localStorage.key(i);
                                if (key.indexOf("bridge-spot:") === 0) doomed.push(key);
                            }
                            doomed.forEach(function (key) {
                                window.localStorage.removeItem(key);
                            });
                        } catch (err) {
                            /* ignore */
                        }
                        ui.toast("Local demo data cleared.", "ok");
                        window.setTimeout(function () {
                            window.location.reload();
                        }, 700);
                    }
                },
                { label: "Cancel", dismiss: true }
            ]
        });
    }

    function bindActions() {
        var test = document.querySelector("[data-role='test-connection']");
        if (test) test.addEventListener("click", testConnection);

        var clear = document.querySelector("[data-role='clear-data']");
        if (clear) clear.addEventListener("click", clearLocalData);

        var exportBtn = document.querySelector("[data-role='export-settings']");
        if (exportBtn) {
            exportBtn.addEventListener("click", function () {
                var payload = {};
                Object.keys(DEFAULTS).forEach(function (key) {
                    payload[key] = value(key);
                });
                payload.theme = ui.theme.preference();
                ui.download("bridge-spot-settings.json", JSON.stringify(payload, null, 2), "application/json");
                ui.toast("Settings exported.", "ok");
            });
        }

        var reset = document.querySelector("[data-role='reset']");
        if (reset) {
            reset.addEventListener("click", function () {
                Object.keys(DEFAULTS).forEach(function (key) {
                    ui.store.set(key, DEFAULTS[key]);
                });
                ui.theme.apply("system", true);
                ui.toast("Settings restored to defaults.", "ok");
                window.setTimeout(function () {
                    window.location.reload();
                }, 600);
            });
        }
    }

    function start() {
        bindInputs();
        bindTheme();
        bindActions();
        storageStats();
        ui.hydrateIcons(document);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
    } else {
        start();
    }
})();
