/*
 * BRIDGE SPOT - home page behaviour.
 *
 * Wires the launcher screen: quick-action tiles, the "Start Inspection"
 * split button, and the Smart Assistant panel (text box + collapse). The
 * online/offline switch inside the panel is bound by
 * voice_assistant_simple.js, which owns the assistant itself.
 */
(function initHome() {
    var ui = window.BridgeUI;
    if (!ui) return;

    var host = window.location.hostname || "localhost";

    /* ------------------------------------------------------------------
       Quick actions
       ------------------------------------------------------------------ */
    var QUICK_ACTIONS = [
        {
            icon: "map",
            title: "Guided Tour",
            text: "Explore Spot's capabilities",
            // The guided tour app runs as its own service (scripts/start_guided_tour.ps1).
            href: "http://" + host + ":8004/",
            external: true
        },
        {
            icon: "doc",
            title: "Digital Twin + NLP Mission Builder",
            text: "Create missions with natural language",
            href: "missions.html#builder"
        },
        {
            icon: "clipboard",
            title: "Generate Report",
            text: "Download mission reports",
            href: "reports.html?generate=1"
        },
        {
            icon: "userGear",
            title: "Spot Admin",
            text: "Manage users and permissions",
            demo: "spot-admin"
        }
    ];

    function renderQuickActions() {
        var grid = document.querySelector("[data-role='quick-actions']");
        if (!grid) return;
        grid.innerHTML = "";

        QUICK_ACTIONS.forEach(function (action) {
            var node;
            if (action.href) {
                node = ui.el("a", "quick-card");
                node.href = action.href;
                if (action.external) {
                    node.target = "_blank";
                    node.rel = "noopener";
                }
            } else {
                node = ui.el("button", "quick-card");
                node.type = "button";
            }
            if (action.demo) node.setAttribute("data-open-demo", action.demo);

            node.appendChild(ui.html("span", "quick-card__icon", ui.icon(action.icon)));
            var body = ui.el("div");
            body.appendChild(ui.el("h3", "quick-card__title", action.title));
            body.appendChild(ui.el("p", "quick-card__text", action.text));
            node.appendChild(body);
            grid.appendChild(node);
        });
    }

    /* ------------------------------------------------------------------
       Smart Assistant panel
       ------------------------------------------------------------------ */
    function assistantInstance() {
        // voice_assistant_simple.js declares `let simpleAssistant` at script
        // scope, so it is not reachable through `window`.
        try {
            return typeof simpleAssistant !== "undefined" ? simpleAssistant : null;
        } catch (err) {
            return null;
        }
    }

    function askAssistant(question) {
        var assistant = assistantInstance();
        if (!assistant) {
            ui.toast("Smart Assistant is still starting up, try again in a moment.", "warn");
            return;
        }

        if (!assistant.isListening) {
            if (assistant.recognition) {
                // Normal path: start the full voice session, then send the text.
                assistant.start();
            } else {
                // No speech recognition in this browser, run text-only.
                assistant.isListening = true;
                if (typeof assistant.showBubble === "function") assistant.showBubble();
            }
        }

        if (typeof assistant.handleQuery === "function") {
            assistant.handleQuery(question, "text-input");
        }
    }

    function bindAssistant() {
        var card = document.querySelector("[data-role='assistant-card']");
        if (!card) return;

        var form = card.querySelector("[data-role='assistant-form']");
        var input = card.querySelector("[data-role='assistant-input']");
        if (form && input) {
            form.addEventListener("submit", function (event) {
                event.preventDefault();
                var question = input.value.trim();
                if (!question) {
                    input.focus();
                    return;
                }
                input.value = "";
                askAssistant(question);
            });
        }

        var collapse = card.querySelector("[data-role='assistant-collapse']");
        if (collapse) {
            var applyCollapsed = function (collapsed) {
                card.classList.toggle("is-collapsed", collapsed);
                collapse.setAttribute("aria-expanded", String(!collapsed));
                collapse.style.transform = collapsed ? "rotate(-90deg)" : "";
            };
            applyCollapsed(ui.store.get("assistant-collapsed", false));
            collapse.addEventListener("click", function () {
                var collapsed = !card.classList.contains("is-collapsed");
                ui.store.set("assistant-collapsed", collapsed);
                applyCollapsed(collapsed);
            });
        }
    }

    // Settings → "Default mode" / "Start listening on load" are applied here,
    // once voice_assistant_simple.js has created its instance.
    function applyAssistantDefaults() {
        var assistant = assistantInstance();
        if (!assistant) return;

        var mode = ui.store.get("assistant-mode", "online");
        if (mode === "offline" && typeof assistant.setMode === "function") {
            assistant.setMode("offline");
        }
        if (ui.store.get("assistant-autostart", false) && assistant.recognition && !assistant.isListening) {
            assistant.start();
        }
    }

    /* ------------------------------------------------------------------
       "Start Inspection" menu, the default route from Settings goes first.
       ------------------------------------------------------------------ */
    function bindInspectionMenu() {
        var menu = document.getElementById("inspection-menu");
        if (!menu) return;
        ui.bindMenu(menu);

        var pop = menu.querySelector(".bs-pop");
        if (!pop) return;
        var preferred = ui.store.get("default-route", "digital_factory.html");
        var target = pop.querySelector('a[href="' + preferred + '"]');
        if (!target) return;
        if (target !== pop.firstElementChild) pop.insertBefore(target, pop.firstElementChild);
        if (!target.querySelector(".badge")) target.appendChild(ui.el("span", "badge", "Default"));
    }

    function start() {
        renderQuickActions();
        bindAssistant();
        bindInspectionMenu();
        applyAssistantDefaults();
        ui.hydrateIcons(document);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
    } else {
        start();
    }

    // Exposed so other pages/scripts can push a question into the assistant.
    window.BridgeAssistant = { ask: askAssistant };
})();
