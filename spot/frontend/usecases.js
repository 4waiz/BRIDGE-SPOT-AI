/*
 * BRIDGE SPOT - mission modules (Industry 5.0 use cases) + detail dialog.
 *
 * DEMO ONLY. Renders the cards defined in usecases.data.js and opens a
 * client-side detail dialog through the shared BridgeUI modal. No backend
 * calls are made, every action button is mocked (see handleMockAction).
 *
 * How pages use it:
 *   <div class="module-list" data-role="module-list"
 *        data-modules="safety-response,predictive-maintenance"></div>
 *        ... renders those modules, in that order (omit the attribute for all)
 *   <button data-open-demo="digital-twin-mission">…</button>
 *        ... opens that module's dialog from anywhere
 *   index.html#demo=<id>
 *        ... deep link straight into a module
 *
 * FUTURE REAL API INTEGRATION: see handleMockAction() at the bottom, each
 * action id is where a real Spot SDK / BRIDGE backend call should be wired.
 */
(function initUseCases() {
    var data = window.BRIDGE_SPOT_DEMO;
    var ui = window.BridgeUI;
    if (!data || !ui) {
        console.warn("[bridge-spot] use-case demo data or UI kit not found");
        return;
    }

    var USE_CASES = data.USE_CASES;
    var ADMIN_INFO = data.ADMIN_INFO;
    var el = ui.el;
    var html = ui.html;

    function findById(id) {
        if (id === ADMIN_INFO.id) return ADMIN_INFO;
        for (var i = 0; i < USE_CASES.length; i += 1) {
            if (USE_CASES[i].id === id) return USE_CASES[i];
        }
        return null;
    }

    /* ---------------- Module cards ---------------- */
    function buildCard(uc) {
        var card = el("button", "module-card");
        card.type = "button";
        card.setAttribute("data-id", uc.id);
        card.setAttribute("aria-haspopup", "dialog");

        card.appendChild(html("span", "icon-tile", ui.icon(uc.icon)));

        var body = el("div", "module-card__body");
        body.appendChild(el("span", "badge", "Demo"));
        body.appendChild(el("h3", "module-card__title", uc.title));
        body.appendChild(el("p", "module-card__text", uc.short || uc.tagline));
        card.appendChild(body);

        card.appendChild(html("span", "module-card__chevron", ui.icon("chevronRight")));

        card.addEventListener("click", function () {
            openModal(uc);
        });
        return card;
    }

    function renderLists() {
        var hosts = document.querySelectorAll("[data-role='module-list']");
        Array.prototype.forEach.call(hosts, function (host) {
            var filter = host.getAttribute("data-modules");
            var items;
            if (filter) {
                items = filter
                    .split(",")
                    .map(function (id) {
                        return findById(id.trim());
                    })
                    .filter(Boolean);
            } else {
                items = USE_CASES.slice();
            }
            host.innerHTML = "";
            items.forEach(function (uc) {
                host.appendChild(buildCard(uc));
            });
        });
    }

    /* ---------------- Detail dialog ---------------- */
    function list(items) {
        var ul = el("ul", "uc-list");
        items.forEach(function (item) {
            ul.appendChild(el("li", null, item));
        });
        return ul;
    }

    function section(title, node) {
        var sec = el("section", "uc-section");
        sec.appendChild(el("h4", "uc-section__title", title));
        sec.appendChild(node);
        return sec;
    }

    function actionBar(actions, context) {
        var bar = el("div", "uc-actions");
        actions.forEach(function (action) {
            var btn;
            if (action.external && context.externalUrl) {
                // Spot Admin keeps a real link to the existing admin console.
                btn = el("a", "btn", action.label);
                btn.href = context.externalUrl;
                btn.target = "_blank";
                btn.rel = "noopener";
            } else {
                btn = el("button", "btn", action.label);
                btn.type = "button";
                btn.addEventListener("click", function () {
                    handleMockAction(action, context, btn);
                });
            }
            if (action.primary) btn.classList.add("btn--accent");
            bar.appendChild(btn);
        });
        return bar;
    }

    function buildUseCaseBody(uc) {
        var frag = document.createDocumentFragment();

        frag.appendChild(section("Overview", el("p", "uc-text", uc.overview)));
        frag.appendChild(section("Live status (demo data)", ui.statusGrid(uc.mockStatus)));

        if (uc.samplePrompt) {
            var promptBox = el("div", "uc-prompt");
            promptBox.appendChild(el("span", "uc-prompt__label", "Example instruction"));
            promptBox.appendChild(el("p", "uc-prompt__text", "“" + uc.samplePrompt + "”"));
            frag.appendChild(section("Natural-language mission", promptBox));
        }

        var cols = el("div", "uc-cols");
        cols.appendChild(section("What Spot does", list(uc.spotDoes)));
        cols.appendChild(section("What the external app does", list(uc.appDoes)));
        frag.appendChild(cols);

        frag.appendChild(section("Key benefits", list(uc.benefits)));
        frag.appendChild(actionBar(uc.actions, uc));

        var log = el("div", "uc-log");
        log.setAttribute("data-role", "uc-log");
        log.setAttribute("aria-live", "polite");
        log.hidden = true;
        frag.appendChild(log);

        return frag;
    }

    function buildAdminBody(admin) {
        var frag = document.createDocumentFragment();
        frag.appendChild(section("System status (demo)", ui.statusGrid(admin.status)));
        frag.appendChild(actionBar(admin.actions, admin));

        var log = el("div", "uc-log");
        log.setAttribute("data-role", "uc-log");
        log.setAttribute("aria-live", "polite");
        log.hidden = true;
        frag.appendChild(log);
        return frag;
    }

    // Each module gets a sensible "go deeper" link into a real platform page.
    var DEEP_LINKS = {
        "inspection-copilot": { label: "Open inspection route", href: "digital_factory.html" },
        "predictive-maintenance": { label: "Open asset health", href: "assets.html" },
        "safety-response": { label: "Open HSSE route", href: "hsse.html" },
        "readiness-evaluator": { label: "Open reports", href: "reports.html" },
        "digital-twin-mission": { label: "Open mission builder", href: "missions.html" },
        "spot-admin": { label: "Open settings", href: "settings.html" }
    };

    function openModal(context) {
        var isAdmin = context.id === ADMIN_INFO.id;
        var footer = [];
        var deep = DEEP_LINKS[context.id];
        if (deep) footer.push({ label: deep.label, href: deep.href, variant: "dark" });
        footer.push({ label: "← Back to Home", dismiss: true });

        ui.openModal({
            title: context.title,
            tagline: context.tagline,
            icon: context.icon,
            badge: "Demo Mode",
            body: isAdmin ? buildAdminBody(context) : buildUseCaseBody(context),
            footer: footer
        });
    }

    /* ---------------- Wiring ---------------- */
    renderLists();

    // Any element on any page can open a module dialog.
    document.addEventListener("click", function (event) {
        var trigger = event.target.closest ? event.target.closest("[data-open-demo]") : null;
        if (!trigger) return;
        var target = findById(trigger.getAttribute("data-open-demo"));
        if (!target) return;
        if (event.metaKey || event.ctrlKey || event.button === 1) return;
        event.preventDefault();
        openModal(target);
    });

    // Deep link: <page>#demo=<id>
    function openFromHash() {
        var match = /(?:^|#|&)demo=([\w-]+)/.exec(window.location.hash);
        if (!match) return;
        var target = findById(match[1]);
        if (target) openModal(target);
    }
    openFromHash();
    window.addEventListener("hashchange", openFromHash);

    /* ---------------- Mock actions ---------------- */
    function logLine(btn, message) {
        var root = btn.closest(".bs-modal__body") || document;
        var log = root.querySelector("[data-role='uc-log']");
        if (!log) return;
        log.hidden = false;
        var line = el("div", "uc-log__line");
        line.appendChild(el("span", "uc-log__dot"));
        line.appendChild(el("span", null, message));
        log.appendChild(line);
        log.scrollTop = log.scrollHeight;
    }

    /*
     * handleMockAction, DEMO stub for every action button.
     *
     * FUTURE REAL API INTEGRATION:
     *   switch (action.id) {
     *     case "start-patrol":    return spotApi.startMission(context.id, ...);
     *     case "generate-report": return reportApi.generate(context.id, ...);
     *     case "run-asset-scan":  return spotApi.runAssetScan(...);
     *     case "test-connection": return spotApi.ping();
     *   }
     */
    function handleMockAction(action, context, btn) {
        btn.classList.add("is-busy");
        btn.disabled = true;
        logLine(btn, "▶ " + action.label + ", running (demo)…");

        window.setTimeout(function () {
            btn.classList.remove("is-busy");
            btn.disabled = false;
            logLine(btn, "✓ " + action.label + ", completed (mock data, no robot connected).");
            if (ui.toast) ui.toast(action.label + " completed (demo).", "ok");
        }, 900);
    }

    window.BridgeDemo = {
        open: function (id) {
            var target = findById(id);
            if (target) openModal(target);
        },
        find: findById,
        render: renderLists,
        useCases: USE_CASES,
        admin: ADMIN_INFO
    };
})();
