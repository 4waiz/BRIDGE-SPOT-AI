/*
 * BRIDGE SPOT — shared application shell.
 *
 * Every page in the demo platform renders the same chrome: the dark
 * sidebar (brand, navigation, Spot status) and the top bar (menu button,
 * notifications, theme switch, user menu). Instead of copy-pasting that
 * markup into six HTML files, each page ships:
 *
 *   <div class="bs-app" data-shell data-nav="dashboard">
 *     <main class="bs-main"><div class="bs-content"> … page … </div></main>
 *   </div>
 *
 * and this script injects the rest.
 *
 * It also exposes the small UI kit the pages share:
 *   BridgeUI.icon(name)            -> inline SVG string
 *   BridgeUI.el(tag, class, text)  -> element helper
 *   BridgeUI.openModal({...})      -> shared dialog
 *   BridgeUI.toast(msg, tone)      -> transient confirmation
 *   BridgeUI.store                 -> namespaced localStorage wrapper
 *
 * DEMO NOTE: the Spot status, notifications and telemetry values below are
 * illustrative. Wire them to the Spot SDK (robot.get_robot_state) and the
 * BRIDGE backend when moving off the demo data — see FUTURE markers.
 */
(function (window, document) {
    "use strict";

    /* ------------------------------------------------------------------
       Icon set — stroked 24x24 glyphs, inherit currentColor.
       ------------------------------------------------------------------ */
    var PATHS = {
        home: '<path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>',
        grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
        mission: '<rect x="4.5" y="3.5" width="15" height="17" rx="2.5"/><path d="M9 3.5h6v3H9zM8.5 11h7M8.5 15h4.5"/>',
        report: '<path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><path d="M13.5 3.7V8h4.3M8.5 12.5h7M8.5 16h4.5"/>',
        assets: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/><circle cx="17.5" cy="9.5" r="2.2"/><path d="M16 14.6c2.4-.4 4.5 1.3 4.5 3.9"/>',
        settings: '<circle cx="12" cy="12" r="3.1"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l1.7-1.3-1.8-3.1-2 .8a7.6 7.6 0 0 0-2.6-1.5L14.4 3H9.6l-.3 2.4a7.6 7.6 0 0 0-2.6 1.5l-2-.8-1.8 3.1 1.7 1.3a7.6 7.6 0 0 0 0 3L2.9 14.8l1.8 3.1 2-.8a7.6 7.6 0 0 0 2.6 1.5l.3 2.4h4.8l.3-2.4a7.6 7.6 0 0 0 2.6-1.5l2 .8 1.8-3.1z"/>',
        menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
        bell: '<path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 4 1.5 5.5 1.5 5.5H5S6.5 14 6.5 10z"/><path d="M10 19a2.2 2.2 0 0 0 4 0"/>',
        chevronDown: '<path d="m6 9.5 6 5.5 6-5.5"/>',
        chevronRight: '<path d="m9.5 6 5.5 6-5.5 6"/>',
        arrowRight: '<path d="M4.5 12h14M13 6.5l5.5 5.5L13 17.5"/>',
        battery: '<rect x="3.5" y="7" width="15" height="10" rx="2.5"/><path d="M20.5 10.5v3"/><rect x="5.8" y="9.3" width="9" height="5.4" rx="1.2" fill="currentColor" stroke="none"/>',
        wifi: '<path d="M2.8 9.2a14 14 0 0 1 18.4 0M6 12.4a9.4 9.4 0 0 1 12 0M9.3 15.6a4.7 4.7 0 0 1 5.4 0"/><circle cx="12" cy="18.6" r="1" fill="currentColor" stroke="none"/>',
        sparkle: '<path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18.5 16.5 19.3 18.7 21.5 19.5 19.3 20.3 18.5 22.5 17.7 20.3 15.5 19.5 17.7 18.7z"/>',
        send: '<path d="M20.5 3.5 10.8 13.2M20.5 3.5l-6.4 17-3.3-7.3-7.3-3.3z"/>',
        scan: '<path d="M4 8.5V6a2 2 0 0 1 2-2h2.5M15.5 4H18a2 2 0 0 1 2 2v2.5M20 15.5V18a2 2 0 0 1-2 2h-2.5M8.5 20H6a2 2 0 0 1-2-2v-2.5"/><circle cx="12" cy="12" r="3.2"/>',
        map: '<path d="m9 4.5-5 2v13l5-2 6 2 5-2v-13l-5 2z"/><path d="M9 4.5v13M15 6.5v13"/>',
        doc: '<path d="M6.5 3.5h7l4.5 4.5V20a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><path d="M13 3.7V8.2h4.6M9 12.5h6M9 16h3.5"/>',
        clipboard: '<rect x="5" y="4.5" width="14" height="16" rx="2.2"/><path d="M9.5 4.5V3.4h5v1.1"/><path d="M9 11h6M9 14.5h6M9 18h3"/>',
        userGear: '<circle cx="10" cy="8" r="3.2"/><path d="M4 19.5c0-3.1 2.7-5.2 6-5.2 1 0 1.9.2 2.7.5"/><circle cx="17.6" cy="17.6" r="2.1"/><path d="M17.6 14v1.1M17.6 20.1v1.1M21.2 17.6h-1.1M15.1 17.6H14M20.1 15.1l-.8.8M15.9 19.3l-.8.8M20.1 20.1l-.8-.8M15.9 15.9l-.8-.8"/>',
        shield: '<path d="M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z"/><path d="M12 8.5v4.8M9.8 11.3 12 13.5l2.2-2.2"/>',
        chartUp: '<path d="M4 19.5V4.5"/><path d="M4 17l5-5 4 3 7-8"/><path d="M16 7.5h4.5V12"/><path d="M4 19.5h16"/>',
        target: '<circle cx="12" cy="12" r="8.3"/><circle cx="12" cy="12" r="4.4"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
        cube: '<path d="M12 3.2 4.5 7v10l7.5 3.8L19.5 17V7z"/><path d="m4.5 7 7.5 3.8L19.5 7M12 20.8V10.8"/>',
        robot: '<rect x="4" y="7.5" width="16" height="11" rx="3"/><circle cx="9" cy="13" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="13" r="1.4" fill="currentColor" stroke="none"/><path d="M12 7.5V4.2M9.5 21v-2.5M14.5 21v-2.5"/>',
        sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5m15.6-6.1-1.6 1.6M7.5 16.5l-1.6 1.6m0-12.2 1.6 1.6m9 9 1.6 1.6"/>',
        moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 1 0 9.8 9.8z"/>',
        check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
        alert: '<path d="M12 4.5 21 20H3z"/><path d="M12 10v4M12 16.8v.4"/>',
        info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.4"/>',
        close: '<path d="m6 6 12 12M18 6 6 18"/>',
        download: '<path d="M12 3.5v11M7.5 10.5 12 15l4.5-4.5"/><path d="M4.5 17v2.5a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1V17"/>',
        refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20.2 3.8v4.4h-4.4"/>',
        play: '<path d="M8 5.5 18.5 12 8 18.5z"/>',
        stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
        external: '<path d="M14 4.5h5.5V10"/><path d="M19.5 4.5 11 13"/><path d="M18 14.5v4a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6h4"/>',
        search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
        plus: '<path d="M12 5v14M5 12h14"/>',
        logout: '<path d="M15 8.5V6a1.5 1.5 0 0 0-1.5-1.5h-7A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 15 18v-2.5"/><path d="M10 12h10.5M17 8.5 20.5 12 17 15.5"/>',
        user: '<circle cx="12" cy="8.2" r="3.5"/><path d="M4.8 20c0-3.6 3.2-6 7.2-6s7.2 2.4 7.2 6"/>',
        gauge: '<path d="M4 17.5a8.5 8.5 0 1 1 16 0"/><path d="M12 17.5 15.8 10"/><circle cx="12" cy="17.5" r="1.2" fill="currentColor" stroke="none"/>',
        camera: '<path d="M3.5 8.5h3.2l1.6-2.4h7.4l1.6 2.4h3.2v10a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z"/><circle cx="12" cy="13.5" r="3.4"/>',
        thermometer: '<path d="M14 13.7V5.5a2 2 0 1 0-4 0v8.2a4.2 4.2 0 1 0 4 0z"/><path d="M12 9.5v5.2"/>',
        clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.2V12l3.2 2"/>',
        pin: '<path d="M12 21s6.5-5.6 6.5-10.2A6.5 6.5 0 0 0 5.5 10.8C5.5 15.4 12 21 12 21z"/><circle cx="12" cy="10.6" r="2.4"/>'
    };

    function icon(name, cls) {
        var body = PATHS[name] || PATHS.info;
        return (
            '<svg class="' + (cls || "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            body +
            "</svg>"
        );
    }

    /* ------------------------------------------------------------------
       Tiny helpers
       ------------------------------------------------------------------ */
    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function html(tag, className, markup) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (markup != null) node.innerHTML = markup;
        return node;
    }

    /**
     * Replace every <span data-icon="name"> placeholder with its inline SVG so
     * page markup stays readable instead of carrying raw path data.
     */
    function hydrateIcons(root) {
        var scope = root || document;
        Array.prototype.forEach.call(scope.querySelectorAll("[data-icon]"), function (node) {
            if (node.getAttribute("data-icon-done") === "1") return;
            node.innerHTML = icon(node.getAttribute("data-icon"));
            node.setAttribute("data-icon-done", "1");
        });
    }

    var store = {
        get: function (key, fallback) {
            try {
                var raw = window.localStorage.getItem("bridge-spot:" + key);
                return raw == null ? fallback : JSON.parse(raw);
            } catch (err) {
                return fallback;
            }
        },
        set: function (key, value) {
            try {
                window.localStorage.setItem("bridge-spot:" + key, JSON.stringify(value));
            } catch (err) {
                /* storage unavailable — demo still works, just not persisted */
            }
        },
        remove: function (key) {
            try {
                window.localStorage.removeItem("bridge-spot:" + key);
            } catch (err) {
                /* ignore */
            }
        }
    };

    /**
     * Client-side file download — used by the report/export buttons so the
     * demo produces a real file without needing a backend.
     */
    function download(filename, content, mime) {
        var blob = new Blob([content], { type: (mime || "text/plain") + ";charset=utf-8" });
        var url = URL.createObjectURL(blob);
        var link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.setTimeout(function () {
            URL.revokeObjectURL(url);
        }, 1000);
    }

    function formatTime(date) {
        return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    function formatDateTime(date) {
        return (
            date.toLocaleDateString([], { day: "2-digit", month: "short" }) + ", " + formatTime(date)
        );
    }

    /* ------------------------------------------------------------------
       Navigation model
       ------------------------------------------------------------------ */
    var NAV = [
        { key: "home", label: "Home", href: "index.html", icon: "home" },
        { key: "dashboard", label: "Dashboard", href: "dashboard.html", icon: "grid" },
        { key: "missions", label: "Missions", href: "missions.html", icon: "mission" },
        { key: "reports", label: "Reports", href: "reports.html", icon: "report" },
        { key: "assets", label: "Assets", href: "assets.html", icon: "assets" },
        { key: "settings", label: "Settings", href: "settings.html", icon: "settings" }
    ];

    /*
     * Demo robot state.
     * FUTURE: replace with a poll of the Spot SDK robot state endpoint, e.g.
     *   fetch('/api/robot/state').then(r => r.json())
     */
    var SPOT_STATUS = {
        connection: "Online",
        battery: 87,
        signal: "Strong",
        estop: "Released",
        temperature: "34 °C",
        firmware: "4.1.1",
        payloads: "Spot CAM+IR, Core I/O",
        uptime: "3h 12m",
        location: "Bay 4 — Digital Factory"
    };

    var NOTIFICATIONS = [
        {
            title: "Thermal anomaly on Pump P-102",
            meta: "Predictive Maintenance · 12 min ago",
            tone: "warn"
        },
        {
            title: "Inspection route “Factory AM” completed",
            meta: "Autonomous Inspection · 42 min ago",
            tone: "ok"
        },
        {
            title: "Blocked walkway detected in Bay 3",
            meta: "HSSE · 1 h ago",
            tone: "bad"
        },
        {
            title: "Weekly readiness report is ready",
            meta: "Reports · Today, 08:05",
            tone: "info"
        }
    ];

    /* ------------------------------------------------------------------
       Theme
       ------------------------------------------------------------------ */
    var theme = {
        preference: function () {
            // "theme" (light|dark) is the key the original launcher used, so an
            // existing preference carries over. "system" is new.
            var stored = store.get("theme", null);
            if (stored === "light" || stored === "dark" || stored === "system") return stored;
            try {
                var legacy = window.localStorage.getItem("theme");
                if (legacy === "light" || legacy === "dark") return legacy;
            } catch (err) {
                /* ignore */
            }
            // Light is the platform's designed default; dark is opt-in.
            return "light";
        },
        resolve: function (pref) {
            if (pref === "light" || pref === "dark") return pref;
            return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
                ? "dark"
                : "light";
        },
        apply: function (pref, persist) {
            var resolved = theme.resolve(pref);
            document.documentElement.setAttribute("data-theme", resolved);
            if (persist) {
                store.set("theme", pref);
                try {
                    window.localStorage.setItem("theme", resolved);
                } catch (err) {
                    /* ignore */
                }
            }
            document.dispatchEvent(
                new CustomEvent("bridge:themechange", { detail: { preference: pref, resolved: resolved } })
            );
            syncThemeButton(resolved);
            return resolved;
        },
        toggle: function () {
            var next = theme.resolve(theme.preference()) === "dark" ? "light" : "dark";
            theme.apply(next, true);
            return next;
        }
    };

    // Keeps the user-menu theme entry in step with the active theme.
    function syncThemeButton(resolved) {
        var btn = document.getElementById("theme-toggle");
        if (!btn) return;
        var isDark = resolved === "dark";
        var label = isDark ? "Switch to light mode" : "Switch to dark mode";
        btn.innerHTML = icon(isDark ? "sun" : "moon") + "<span>" + label + "</span>";
        btn.setAttribute("title", label);
        btn.setAttribute("aria-label", label);
        btn.setAttribute("aria-pressed", String(isDark));
    }

    // Apply as early as possible so the page never flashes the wrong theme.
    theme.apply(theme.preference(), false);
    if (window.matchMedia) {
        var mq = window.matchMedia("(prefers-color-scheme: dark)");
        var onSchemeChange = function () {
            if (theme.preference() === "system") theme.apply("system", false);
        };
        if (mq.addEventListener) mq.addEventListener("change", onSchemeChange);
        else if (mq.addListener) mq.addListener(onSchemeChange);
    }

    /* ------------------------------------------------------------------
       Shared modal
       ------------------------------------------------------------------ */
    var modalRoot = null;
    var modalBody = null;
    var modalFooter = null;
    var lastFocused = null;

    function ensureModal() {
        if (modalRoot) return modalRoot;
        modalRoot = html(
            "div",
            "bs-modal",
            '<div class="bs-modal__dialog" role="document">' +
                '<button type="button" class="bs-modal__close" data-role="modal-close" aria-label="Close">&times;</button>' +
                '<div class="bs-modal__body" data-role="modal-body"></div>' +
                '<div class="bs-modal__footer" data-role="modal-footer"></div>' +
                "</div>"
        );
        modalRoot.id = "bs-modal";
        modalRoot.setAttribute("role", "dialog");
        modalRoot.setAttribute("aria-modal", "true");
        modalRoot.setAttribute("aria-hidden", "true");
        document.body.appendChild(modalRoot);

        modalBody = modalRoot.querySelector("[data-role='modal-body']");
        modalFooter = modalRoot.querySelector("[data-role='modal-footer']");

        modalRoot.querySelector("[data-role='modal-close']").addEventListener("click", closeModal);
        modalRoot.addEventListener("click", function (event) {
            if (event.target === modalRoot) closeModal();
        });
        document.addEventListener("keydown", function (event) {
            if (event.key === "Escape" && modalRoot.classList.contains("is-open")) closeModal();
        });
        return modalRoot;
    }

    /**
     * openModal({ title, tagline, icon, badge, body, footer, wide })
     * `body` may be a Node, a DocumentFragment or an HTML string.
     */
    function openModal(options) {
        var opts = options || {};
        ensureModal();
        lastFocused = document.activeElement;
        modalBody.innerHTML = "";
        modalFooter.innerHTML = "";
        modalRoot.classList.toggle("bs-modal--wide", !!opts.wide);

        if (opts.title) {
            var header = el("div", "uc-modal__header");
            if (opts.icon) header.appendChild(html("span", "uc-modal__icon", icon(opts.icon)));
            var titles = el("div", "uc-modal__titles");
            var row = el("div", "uc-modal__title-row");
            row.appendChild(el("h2", "uc-modal__title", opts.title));
            if (opts.badge) row.appendChild(el("span", "badge badge--lg", opts.badge));
            titles.appendChild(row);
            if (opts.tagline) titles.appendChild(el("p", "uc-modal__tagline", opts.tagline));
            header.appendChild(titles);
            modalBody.appendChild(header);
        }

        if (typeof opts.body === "string") {
            modalBody.appendChild(html("div", null, opts.body));
        } else if (opts.body) {
            modalBody.appendChild(opts.body);
        }

        var footerButtons = opts.footer || [{ label: "← Back", dismiss: true }];
        footerButtons.forEach(function (item) {
            var node;
            if (item.href) {
                node = el("a", "btn" + (item.variant ? " btn--" + item.variant : ""), item.label);
                node.href = item.href;
                if (item.external) {
                    node.target = "_blank";
                    node.rel = "noopener";
                }
            } else {
                node = el("button", "btn" + (item.variant ? " btn--" + item.variant : ""), item.label);
                node.type = "button";
                node.addEventListener("click", function () {
                    if (item.onClick) item.onClick(node);
                    // Buttons close the dialog unless they opt out with dismiss:false.
                    if (item.dismiss !== false) closeModal();
                });
            }
            modalFooter.appendChild(node);
        });

        modalRoot.classList.add("is-open");
        modalRoot.setAttribute("aria-hidden", "false");
        document.body.classList.add("modal-open");
        var focusTarget = modalRoot.querySelector("[data-role='modal-close']");
        if (focusTarget) focusTarget.focus();
        return modalBody;
    }

    function closeModal() {
        if (!modalRoot) return;
        modalRoot.classList.remove("is-open");
        modalRoot.setAttribute("aria-hidden", "true");
        document.body.classList.remove("modal-open");
        modalBody.innerHTML = "";
        modalFooter.innerHTML = "";
        if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
    }

    /* ------------------------------------------------------------------
       Toasts
       ------------------------------------------------------------------ */
    var toastHost = null;

    function toast(message, tone) {
        if (!toastHost) {
            toastHost = el("div", "bs-toasts");
            toastHost.setAttribute("aria-live", "polite");
            document.body.appendChild(toastHost);
        }
        var glyph = tone === "bad" ? "alert" : tone === "warn" ? "alert" : tone === "ok" ? "check" : "info";
        var node = html("div", "bs-toast" + (tone ? " is-" + tone : ""), icon(glyph));
        node.appendChild(el("span", null, message));
        toastHost.appendChild(node);
        window.requestAnimationFrame(function () {
            node.classList.add("is-in");
        });
        window.setTimeout(function () {
            node.classList.remove("is-in");
            window.setTimeout(function () {
                if (node.parentNode) node.parentNode.removeChild(node);
            }, 250);
        }, 3600);
        return node;
    }

    /* ------------------------------------------------------------------
       Dropdown menus (notifications + user)
       ------------------------------------------------------------------ */
    function closeAllMenus(except) {
        Array.prototype.forEach.call(document.querySelectorAll(".bs-menu-host.is-open"), function (host) {
            if (host !== except) {
                host.classList.remove("is-open");
                var trigger = host.querySelector("[aria-expanded]");
                if (trigger) trigger.setAttribute("aria-expanded", "false");
            }
        });
    }

    function bindMenu(host) {
        var trigger = host.querySelector("[data-role='menu-trigger']");
        if (!trigger) return;
        trigger.addEventListener("click", function (event) {
            event.stopPropagation();
            var willOpen = !host.classList.contains("is-open");
            closeAllMenus(host);
            host.classList.toggle("is-open", willOpen);
            trigger.setAttribute("aria-expanded", String(willOpen));
        });
        host.addEventListener("click", function (event) {
            event.stopPropagation();
        });
    }

    document.addEventListener("click", function () {
        closeAllMenus(null);
    });
    document.addEventListener("keydown", function (event) {
        if (event.key === "Escape") closeAllMenus(null);
    });

    /* ------------------------------------------------------------------
       Telemetry (Spot status → "View Telemetry")
       ------------------------------------------------------------------ */
    function telemetryRows() {
        return [
            { label: "Connection", value: SPOT_STATUS.connection, tone: "ok" },
            { label: "Battery", value: SPOT_STATUS.battery + "%", tone: SPOT_STATUS.battery > 40 ? "ok" : "warn" },
            { label: "Signal", value: SPOT_STATUS.signal, tone: "ok" },
            { label: "E-Stop", value: SPOT_STATUS.estop, tone: "ok" },
            { label: "Core temperature", value: SPOT_STATUS.temperature, tone: "info" },
            { label: "Uptime", value: SPOT_STATUS.uptime, tone: "info" },
            { label: "Firmware", value: SPOT_STATUS.firmware, tone: "info" },
            { label: "Payloads", value: SPOT_STATUS.payloads, tone: "info" },
            { label: "Last known position", value: SPOT_STATUS.location, tone: "info" }
        ];
    }

    function statusGrid(items) {
        var wrap = el("div", "uc-status-grid");
        items.forEach(function (item) {
            var card = el("div", "uc-status-card tone-" + (item.tone || "info"));
            card.appendChild(el("span", "uc-status-card__label", item.label));
            card.appendChild(el("span", "uc-status-card__value", item.value));
            wrap.appendChild(card);
        });
        return wrap;
    }

    function openTelemetry() {
        var frag = document.createDocumentFragment();
        var section = el("section", "uc-section");
        section.appendChild(el("h4", "uc-section__title", "Live telemetry (demo data)"));
        var grid = statusGrid(telemetryRows());
        section.appendChild(grid);
        frag.appendChild(section);

        var note = el(
            "p",
            "uc-text",
            "Values refresh from the mock telemetry feed. Connect a robot in Settings to stream real state from the Spot SDK."
        );
        frag.appendChild(note);

        openModal({
            title: "Spot Telemetry",
            tagline: "Robot state, power and connectivity at a glance.",
            icon: "gauge",
            badge: "Demo",
            body: frag,
            footer: [
                {
                    label: "Refresh",
                    variant: "accent",
                    dismiss: false,
                    onClick: function () {
                        // FUTURE: fetch('/api/robot/state') and re-render.
                        SPOT_STATUS.battery = Math.max(12, SPOT_STATUS.battery - 1);
                        SPOT_STATUS.temperature = 32 + Math.round(Math.random() * 6) + " °C";
                        var fresh = statusGrid(telemetryRows());
                        grid.replaceWith(fresh);
                        grid = fresh;
                        renderSpotStatus();
                        toast("Telemetry refreshed (demo feed).", "ok");
                    }
                },
                { label: "Open Settings", href: "settings.html" },
                { label: "Close", dismiss: true }
            ]
        });
    }

    /* ------------------------------------------------------------------
       Shell rendering
       ------------------------------------------------------------------ */
    var app = null;

    function renderSidebar(activeKey) {
        var aside = el("aside", "bs-sidebar");
        aside.setAttribute("aria-label", "Primary");

        var brand = html(
            "a",
            "bs-brand",
            '<img class="bs-brand__img" src="brand-sidebar.png" alt="Bridge Spot">' +
                '<span class="bs-brand__mark">BS</span>'
        );
        brand.href = "index.html";
        brand.setAttribute("aria-label", "Bridge Spot — home");
        aside.appendChild(brand);

        var nav = el("nav", "bs-nav");
        NAV.forEach(function (item) {
            var link = html("a", "bs-nav__item", icon(item.icon) + "<span>" + item.label + "</span>");
            link.href = item.href;
            if (item.key === activeKey) {
                link.classList.add("is-active");
                link.setAttribute("aria-current", "page");
            }
            nav.appendChild(link);
        });
        aside.appendChild(nav);

        var status = el("div", "bs-status");
        status.setAttribute("data-role", "spot-status");
        aside.appendChild(status);

        return aside;
    }

    function renderSpotStatus() {
        var host = document.querySelector("[data-role='spot-status']");
        if (!host) return;
        var batteryTone = SPOT_STATUS.battery > 40 ? "" : SPOT_STATUS.battery > 20 ? "is-warn" : "is-bad";
        host.innerHTML =
            '<h2 class="bs-status__title">Spot Status</h2>' +
            '<div class="bs-status__row"><span class="bs-status__dot ' +
            (SPOT_STATUS.connection === "Online" ? "" : "is-bad") +
            '"></span><span class="bs-status__text">' +
            SPOT_STATUS.connection +
            "</span></div>" +
            '<div class="bs-status__row"><span class="bs-status__battery ' +
            batteryTone +
            '">' +
            icon("battery") +
            '</span><span class="bs-status__text"><strong>' +
            SPOT_STATUS.battery +
            "%</strong>Battery</span></div>" +
            '<div class="bs-status__row"><span class="bs-status__wifi">' +
            icon("wifi") +
            '</span><span class="bs-status__text"><strong>' +
            SPOT_STATUS.signal +
            "</strong>Connection</span></div>" +
            '<button type="button" class="bs-status__cta" data-role="telemetry"><span>View Telemetry</span>' +
            icon("arrowRight") +
            "</button>";
        host.querySelector("[data-role='telemetry']").addEventListener("click", openTelemetry);
    }

    function renderTopbar() {
        var bar = el("header", "bs-topbar");

        var left = el("div", "bs-topbar__left");
        var menuBtn = html("button", "bs-iconbtn", icon("menu"));
        menuBtn.type = "button";
        menuBtn.setAttribute("aria-label", "Toggle navigation");
        menuBtn.addEventListener("click", toggleSidebar);
        left.appendChild(menuBtn);
        bar.appendChild(left);

        var right = el("div", "bs-topbar__right");

        // Notifications
        var bellHost = el("div", "bs-menu-host");
        var bellBtn = html("button", "bs-iconbtn bs-iconbtn--framed bs-bell", icon("bell") + '<span class="bs-bell__dot"></span>');
        bellBtn.type = "button";
        bellBtn.setAttribute("data-role", "menu-trigger");
        bellBtn.setAttribute("aria-label", "Notifications");
        bellBtn.setAttribute("aria-expanded", "false");
        if (!store.get("notify-dot", true)) {
            bellBtn.querySelector(".bs-bell__dot").style.display = "none";
        }
        bellHost.appendChild(bellBtn);

        var bellPop = el("div", "bs-pop bs-pop--wide");
        var bellHead = el("div", "bs-pop__head");
        bellHead.appendChild(el("h3", "bs-pop__title", "Notifications"));
        bellHead.appendChild(el("span", "badge", "Demo"));
        bellPop.appendChild(bellHead);
        NOTIFICATIONS.forEach(function (note) {
            var row = el("div", "bs-note");
            row.appendChild(el("span", "bs-note__dot is-" + note.tone));
            var body = el("div");
            body.appendChild(el("p", "bs-note__title", note.title));
            body.appendChild(el("p", "bs-note__meta", note.meta));
            row.appendChild(body);
            bellPop.appendChild(row);
        });
        bellPop.appendChild(el("div", "bs-pop__sep"));
        var allNotes = html("a", "bs-pop__item", icon("report") + "<span>Open reports</span>");
        allNotes.href = "reports.html";
        bellPop.appendChild(allNotes);
        bellHost.appendChild(bellPop);
        bindMenu(bellHost);
        right.appendChild(bellHost);

        // User menu
        var userHost = el("div", "bs-menu-host");
        var userBtn = html(
            "button",
            "bs-user",
            '<span class="bs-avatar">SA</span>' +
                '<span><span class="bs-user__name">Spot Admin</span><span class="bs-user__role">Administrator</span></span>' +
                icon("chevronDown", "bs-user__caret")
        );
        userBtn.type = "button";
        userBtn.setAttribute("data-role", "menu-trigger");
        userBtn.setAttribute("aria-haspopup", "true");
        userBtn.setAttribute("aria-expanded", "false");
        userHost.appendChild(userBtn);

        var userPop = el("div", "bs-pop");
        var items = [
            { label: "Profile", icon: "user", action: function () {
                openModal({
                    title: "Spot Admin",
                    tagline: "Demo operator account for the Bridge Spot platform.",
                    icon: "user",
                    badge: "Demo",
                    body: statusGrid([
                        { label: "Role", value: "Administrator", tone: "info" },
                        { label: "Team", value: "BRIDGE Robotics", tone: "info" },
                        { label: "Access", value: "Missions, Reports, Settings", tone: "ok" },
                        { label: "Signed in", value: formatDateTime(new Date()), tone: "info" }
                    ])
                });
            } },
            { label: "Settings", icon: "settings", href: "settings.html" },
            {
                // Theme switch lives here so the top bar stays as designed.
                id: "theme-toggle",
                label: theme.resolve(theme.preference()) === "dark" ? "Switch to light mode" : "Switch to dark mode",
                icon: theme.resolve(theme.preference()) === "dark" ? "sun" : "moon",
                action: function () {
                    var next = theme.toggle();
                    toast(next === "dark" ? "Dark mode on." : "Light mode on.");
                }
            },
            { label: "Spot admin console", icon: "external", href: "https://192.168.208.117", external: true },
            { sep: true },
            { label: "Sign out", icon: "logout", action: function () {
                toast("Sign-out is disabled in the demo build.", "warn");
            } }
        ];
        items.forEach(function (item) {
            if (item.sep) {
                userPop.appendChild(el("div", "bs-pop__sep"));
                return;
            }
            var node;
            if (item.href) {
                node = html("a", "bs-pop__item", icon(item.icon) + "<span>" + item.label + "</span>");
                node.href = item.href;
                if (item.external) {
                    node.target = "_blank";
                    node.rel = "noopener";
                }
            } else {
                node = html("button", "bs-pop__item", icon(item.icon) + "<span>" + item.label + "</span>");
                node.type = "button";
                if (item.id) node.id = item.id;
                node.addEventListener("click", function () {
                    closeAllMenus(null);
                    item.action();
                });
            }
            userPop.appendChild(node);
        });
        userHost.appendChild(userPop);
        bindMenu(userHost);
        right.appendChild(userHost);

        bar.appendChild(right);
        return bar;
    }

    // Matches the drawer breakpoint in styles.css (rem in a media query is
    // always 16px, so this is the 60rem layout scaled by the 125% root size).
    function isNarrow() {
        if (window.matchMedia) return window.matchMedia("(max-width: 75rem)").matches;
        return window.innerWidth <= 1200;
    }

    function toggleSidebar() {
        if (!app) return;
        if (isNarrow()) {
            app.classList.toggle("is-drawer-open");
            return;
        }
        var collapsed = app.classList.toggle("is-collapsed");
        store.set("sidebar-collapsed", collapsed);
    }

    function mount() {
        app = document.querySelector("[data-shell]");
        if (!app) return;

        var activeKey = app.getAttribute("data-nav") || "";
        var main = app.querySelector(".bs-main");
        if (!main) return;

        app.insertBefore(renderSidebar(activeKey), main);

        var scrim = el("div", "bs-scrim");
        scrim.addEventListener("click", function () {
            app.classList.remove("is-drawer-open");
        });
        app.appendChild(scrim);

        main.insertBefore(renderTopbar(), main.firstChild);

        if (store.get("sidebar-collapsed", false) && !isNarrow()) {
            app.classList.add("is-collapsed");
        }

        renderSpotStatus();
        syncThemeButton(theme.resolve(theme.preference()));
        hydrateIcons(document);

        document.dispatchEvent(new CustomEvent("bridge:shellready"));
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", mount);
    } else {
        mount();
    }

    /* ------------------------------------------------------------------
       Public API
       ------------------------------------------------------------------ */
    window.BridgeUI = {
        icon: icon,
        hydrateIcons: hydrateIcons,
        el: el,
        html: html,
        store: store,
        theme: theme,
        nav: NAV,
        spot: SPOT_STATUS,
        notifications: NOTIFICATIONS,
        statusGrid: statusGrid,
        openModal: openModal,
        closeModal: closeModal,
        openTelemetry: openTelemetry,
        toast: toast,
        download: download,
        bindMenu: bindMenu,
        closeAllMenus: closeAllMenus,
        renderSpotStatus: renderSpotStatus,
        formatTime: formatTime,
        formatDateTime: formatDateTime
    };
})(window, document);
