/*
 * BRIDGE SPOT — missions page.
 *
 * Two things happen here:
 *   1. The mission table (filter + search + row actions) over the demo
 *      dataset in platform.data.js.
 *   2. The Digital Twin + Natural Language Mission Builder: a small
 *      rule-based parser that turns a sentence into waypoints, then
 *      simulates the run.
 *
 * FUTURE REAL API INTEGRATION:
 *   - replace parseInstruction() with a call to the LLM mission planner
 *     (POST /api/missions/plan { instruction }) — the returned steps use the
 *     same { action, target, detail, duration } shape;
 *   - replace runMission()'s timer with a subscription to mission progress
 *     events from the Spot SDK (mission service / Autowalk).
 */
(function initMissions() {
    var ui = window.BridgeUI;
    var platform = window.BRIDGE_PLATFORM;
    if (!ui || !platform) return;

    var el = ui.el;
    var html = ui.html;

    /* ==================================================================
       1. Mission table
       ================================================================== */
    var missions = platform.MISSIONS.map(function (mission) {
        return Object.assign({}, mission);
    });
    var filter = "all";
    var search = "";
    var timers = {};

    var STATUS_CHIP = {
        running: "chip chip--info",
        scheduled: "chip",
        completed: "chip chip--ok",
        failed: "chip chip--bad"
    };

    function visibleMissions() {
        var needle = search.trim().toLowerCase();
        return missions.filter(function (mission) {
            if (filter !== "all" && mission.status !== filter) return false;
            if (!needle) return true;
            return (
                mission.name.toLowerCase().indexOf(needle) !== -1 ||
                mission.id.toLowerCase().indexOf(needle) !== -1 ||
                mission.route.toLowerCase().indexOf(needle) !== -1
            );
        });
    }

    function missionDetail(mission) {
        ui.openModal({
            title: mission.name,
            tagline: "Mission " + mission.id + " · " + mission.route + " route",
            icon: "mission",
            badge: "Demo",
            body: ui.statusGrid([
                { label: "Status", value: mission.status, tone: mission.status === "failed" ? "bad" : mission.status === "completed" ? "ok" : "info" },
                { label: "Progress", value: mission.progress + "%", tone: "info" },
                { label: "Waypoints", value: mission.done + " / " + mission.waypoints, tone: "info" },
                { label: "Findings", value: String(mission.findings), tone: mission.findings ? "warn" : "ok" },
                { label: "Operator", value: mission.operator, tone: "info" },
                { label: "Started", value: mission.started, tone: "info" }
            ]),
            footer: [
                { label: "Open route", href: mission.page, variant: "dark" },
                { label: "View module", dismiss: false, onClick: function () {
                    if (window.BridgeDemo) window.BridgeDemo.open(mission.module);
                } },
                { label: "Close", dismiss: true }
            ]
        });
    }

    function startMission(mission) {
        if (timers[mission.id]) return;
        mission.status = "running";
        if (mission.progress >= 100) mission.progress = 0;
        renderMissions();
        ui.toast(mission.name + " started (demo run).");

        timers[mission.id] = window.setInterval(function () {
            mission.progress = Math.min(100, mission.progress + 7);
            mission.done = Math.round((mission.progress / 100) * mission.waypoints);
            if (mission.progress >= 100) {
                window.clearInterval(timers[mission.id]);
                delete timers[mission.id];
                mission.status = "completed";
                ui.toast(mission.name + " completed.", "ok");
            }
            renderMissions();
        }, 700);
    }

    function stopMission(mission) {
        if (timers[mission.id]) {
            window.clearInterval(timers[mission.id]);
            delete timers[mission.id];
        }
        mission.status = "scheduled";
        renderMissions();
        ui.toast(mission.name + " paused.", "warn");
    }

    function renderMissions() {
        var body = document.querySelector("[data-role='missions']");
        if (!body) return;
        body.innerHTML = "";

        var rows = visibleMissions();
        if (!rows.length) {
            var empty = el("tr");
            var cell = el("td", null, "No missions match this filter.");
            cell.colSpan = 7;
            cell.className = "cell-muted";
            empty.appendChild(cell);
            body.appendChild(empty);
            return;
        }

        rows.forEach(function (mission) {
            var row = el("tr");
            var title = html(
                "td",
                null,
                '<span class="cell-strong">' + mission.name + '</span><br><span class="cell-muted">' + mission.id + "</span>"
            );
            title.classList.add("is-clickable");
            title.addEventListener("click", function () {
                missionDetail(mission);
            });
            row.appendChild(title);
            row.appendChild(el("td", null, mission.route));
            row.appendChild(html("td", null, '<span class="' + (STATUS_CHIP[mission.status] || "chip") + '">' + mission.status + "</span>"));
            row.appendChild(
                html(
                    "td",
                    null,
                    '<span class="meter"><span class="meter__track"><span class="meter__fill is-accent" style="width:' +
                        mission.progress + '%"></span></span><span class="meter__value">' + mission.progress + "%</span></span>"
                )
            );
            row.appendChild(el("td", null, mission.done + " / " + mission.waypoints));
            row.appendChild(html("td", null, '<span class="cell-muted">' + mission.started + "</span>"));

            var actions = el("td");
            var wrap = el("div", "page-head__actions");
            var toggle = el("button", "btn btn--sm", mission.status === "running" ? "Pause" : "Run");
            toggle.type = "button";
            toggle.addEventListener("click", function (event) {
                event.stopPropagation();
                if (mission.status === "running") stopMission(mission);
                else startMission(mission);
            });
            wrap.appendChild(toggle);

            var open = el("a", "btn btn--sm btn--ghost", "Open");
            open.href = mission.page;
            wrap.appendChild(open);
            actions.appendChild(wrap);
            row.appendChild(actions);

            body.appendChild(row);
        });
    }

    function bindTable() {
        var seg = document.querySelector("[data-role='filter']");
        if (seg) {
            seg.addEventListener("click", function (event) {
                var btn = event.target.closest("[data-status]");
                if (!btn) return;
                Array.prototype.forEach.call(seg.querySelectorAll("button"), function (node) {
                    node.classList.toggle("is-active", node === btn);
                });
                filter = btn.getAttribute("data-status");
                renderMissions();
            });
        }

        var searchInput = document.querySelector("[data-role='search']");
        if (searchInput) {
            searchInput.addEventListener("input", function () {
                search = searchInput.value;
                renderMissions();
            });
        }

        var newBtn = document.querySelector("[data-role='new-mission']");
        if (newBtn) {
            newBtn.addEventListener("click", function () {
                var input = document.querySelector("[data-role='mission-input']");
                var builder = document.getElementById("builder");
                if (builder) builder.scrollIntoView({ behavior: "smooth", block: "start" });
                if (input) window.setTimeout(function () { input.focus(); }, 300);
            });
        }
    }

    /* ==================================================================
       2. Natural-language mission builder
       ================================================================== */
    var SAMPLES = [
        "Inspect the east server room and the loading dock, then log any open panels.",
        "Patrol Bay 3 for blocked walkways and take thermal readings of the switchgear.",
        "Check the coolant pump in Bay 2, capture photos, then return to dock."
    ];

    // Areas the digital twin knows about. FUTURE: pull from the twin/map API.
    var LOCATIONS = [
        "east server room", "server room", "loading dock", "utility room", "switchgear",
        "coolant pump", "bay 1", "bay 2", "bay 3", "bay 4", "roof", "yard",
        "training bay", "walkway", "loading bay", "control room", "warehouse", "dock"
    ];

    var ACTIONS = [
        { keys: ["inspect", "inspection", "survey"], action: "Inspect", detail: "RGB + zoom capture", duration: 3 },
        { keys: ["patrol", "walk", "sweep", "tour"], action: "Patrol", detail: "Continuous capture along route", duration: 4 },
        { keys: ["thermal", "temperature", "heat"], action: "Thermal scan", detail: "Spot CAM+IR reading", duration: 2 },
        { keys: ["photo", "picture", "capture", "image", "snapshot"], action: "Capture", detail: "High-resolution stills", duration: 1 },
        { keys: ["check", "verify", "confirm", "look"], action: "Check", detail: "Vision model comparison vs. baseline", duration: 2 },
        { keys: ["log", "record", "report", "note"], action: "Log findings", detail: "Write results to the inspection log", duration: 1 },
        { keys: ["count", "measure", "read", "gauge"], action: "Read gauge", detail: "OCR + gauge reading", duration: 2 },
        { keys: ["monitor", "watch", "observe"], action: "Monitor", detail: "Timed observation window", duration: 3 },
        { keys: ["return", "dock", "home"], action: "Return to dock", detail: "Navigate to charging dock", duration: 2 }
    ];

    var steps = [];
    var runTimer = null;

    function titleCase(value) {
        return value.charAt(0).toUpperCase() + value.slice(1);
    }

    function findLocation(clause) {
        var lower = clause.toLowerCase();
        var best = null;
        LOCATIONS.forEach(function (loc) {
            if (lower.indexOf(loc) !== -1) {
                if (!best || loc.length > best.length) best = loc;
            }
        });
        return best;
    }

    function findAction(clause) {
        var lower = clause.toLowerCase();
        for (var i = 0; i < ACTIONS.length; i += 1) {
            for (var k = 0; k < ACTIONS[i].keys.length; k += 1) {
                if (lower.indexOf(ACTIONS[i].keys[k]) !== -1) return ACTIONS[i];
            }
        }
        return null;
    }

    /**
     * parseInstruction — rule-based stand-in for the mission planner.
     * Splits the sentence into clauses, then maps each clause to a waypoint.
     */
    function parseInstruction(text) {
        var clauses = text
            .split(/,| and | then |;|\.|\n/i)
            .map(function (part) {
                return part.trim();
            })
            .filter(function (part) {
                return part.length > 2;
            });

        var parsed = [];
        clauses.forEach(function (clause) {
            var action = findAction(clause);
            var location = findLocation(clause);
            if (!action && !location) return;

            parsed.push({
                action: action ? action.action : "Inspect",
                target: location ? titleCase(location) : "Current area",
                detail: action ? action.detail : "RGB + zoom capture",
                duration: action ? action.duration : 2
            });
        });

        if (!parsed.length) return [];

        parsed.unshift({ action: "Undock", target: "Charging dock", detail: "Power on, localize against the twin", duration: 1 });
        var last = parsed[parsed.length - 1];
        if (last.action !== "Return to dock") {
            parsed.push({ action: "Return to dock", target: "Charging dock", detail: "Upload captures and sync the digital twin", duration: 2 });
        }
        return parsed;
    }

    function renderSteps() {
        var host = document.querySelector("[data-role='steps']");
        var count = document.querySelector("[data-role='step-count']");
        var runBtn = document.querySelector("[data-role='run']");
        if (!host) return;

        host.innerHTML = "";
        if (!steps.length) {
            host.appendChild(html("li", "empty-state", "No mission built yet."));
            if (count) count.textContent = "0 steps";
            if (runBtn) runBtn.disabled = true;
            return;
        }

        steps.forEach(function (step, index) {
            var li = el("li", "step" + (step.state ? " is-" + step.state : ""));
            li.appendChild(el("span", "step__index", String(index + 1)));
            var body = el("div");
            body.appendChild(html("div", null, "<strong>" + step.action + "</strong> — " + step.target));
            body.appendChild(html("div", "cell-muted", step.detail));
            li.appendChild(body);
            li.appendChild(el("span", "step__meta", "~" + step.duration + " min"));
            host.appendChild(li);
        });

        if (count) count.textContent = steps.length + (steps.length === 1 ? " step" : " steps");
        if (runBtn) runBtn.disabled = false;
    }

    function log(message) {
        var box = document.querySelector("[data-role='log']");
        if (!box) return;
        if (box.getAttribute("data-clean") !== "1") {
            box.innerHTML = "";
            box.setAttribute("data-clean", "1");
        }
        var line = el("p", null, "[" + ui.formatTime(new Date()) + "] " + message);
        box.appendChild(line);
        box.scrollTop = box.scrollHeight;
    }

    function setProgress(percent) {
        var fill = document.querySelector("[data-role='progress']");
        if (fill) fill.style.width = percent + "%";
    }

    function setRunState(text, tone) {
        var chip = document.querySelector("[data-role='run-state']");
        if (!chip) return;
        chip.className = "chip chip--plain" + (tone ? " chip--" + tone : "");
        chip.textContent = text;
    }

    function buildMission() {
        var input = document.querySelector("[data-role='mission-input']");
        if (!input) return;
        var text = input.value.trim();
        if (!text) {
            ui.toast("Describe the mission first — for example “Inspect Bay 3 and log open panels”.", "warn");
            input.focus();
            return;
        }

        steps = parseInstruction(text);
        if (!steps.length) {
            ui.toast("Could not find any tasks in that instruction. Try naming an area and an action.", "warn");
            renderSteps();
            return;
        }

        setProgress(0);
        setRunState("Ready", "info");
        renderSteps();
        log("Parsed “" + text + "” into " + steps.length + " waypoints.");
        ui.toast(steps.length + " waypoints created from your instruction.", "ok");
    }

    function runMission() {
        if (!steps.length || runTimer) return;
        var index = 0;
        var runBtn = document.querySelector("[data-role='run']");
        if (runBtn) runBtn.disabled = true;
        setRunState("Running", "info");
        log("Mission started (demo run — no robot connected).");

        var advance = function () {
            if (index > 0) {
                steps[index - 1].state = "done";
                log("✓ " + steps[index - 1].action + " — " + steps[index - 1].target + " complete.");
            }
            if (index >= steps.length) {
                window.clearInterval(runTimer);
                runTimer = null;
                setProgress(100);
                setRunState("Completed", "ok");
                renderSteps();
                log("Mission complete. Digital twin updated for " + steps.length + " waypoints.");
                if (runBtn) runBtn.disabled = false;
                offerReport();
                return;
            }
            steps[index].state = "active";
            log("▶ " + steps[index].action + " — " + steps[index].target + "…");
            setProgress(Math.round((index / steps.length) * 100));
            renderSteps();
            index += 1;
        };

        advance();
        runTimer = window.setInterval(advance, 1200);
    }

    /*
     * A completed mission can be turned into a report. Reports created here
     * are stored locally and picked up by reports.html.
     */
    function offerReport() {
        ui.openModal({
            title: "Mission complete",
            tagline: "The digital twin has been updated. Generate a report for this run?",
            icon: "check",
            badge: "Demo",
            body: ui.statusGrid([
                { label: "Waypoints", value: String(steps.length), tone: "ok" },
                { label: "Captures", value: String(steps.length * 3), tone: "info" },
                { label: "Findings", value: "1 open panel", tone: "warn" },
                { label: "Twin coverage", value: "94%", tone: "ok" }
            ]),
            footer: [
                {
                    label: "Generate report",
                    variant: "accent",
                    onClick: function () {
                        var stored = ui.store.get("reports", []);
                        var id = "RPT-" + (2100 + stored.length);
                        stored.unshift({
                            id: id,
                            title: "NL mission run — " + (steps[1] ? steps[1].target : "Custom route"),
                            type: "Inspection",
                            module: "digital-twin-mission",
                            created: ui.formatDateTime(new Date()),
                            author: "Spot Admin",
                            findings: 1,
                            status: "ready",
                            custom: true,
                            steps: steps.map(function (step) {
                                return step.action + " — " + step.target;
                            })
                        });
                        ui.store.set("reports", stored);
                        ui.toast("Report " + id + " added to Reports.", "ok");
                    }
                },
                { label: "Not now", dismiss: true }
            ]
        });
    }

    function clearMission() {
        if (runTimer) {
            window.clearInterval(runTimer);
            runTimer = null;
        }
        steps = [];
        var input = document.querySelector("[data-role='mission-input']");
        if (input) input.value = "";
        var box = document.querySelector("[data-role='log']");
        if (box) {
            box.innerHTML = "<p>Waiting for a mission…</p>";
            box.setAttribute("data-clean", "0");
        }
        setProgress(0);
        setRunState("Idle");
        renderSteps();
    }

    function renderSamples() {
        var host = document.querySelector("[data-role='samples']");
        if (!host) return;
        host.innerHTML = "";
        SAMPLES.forEach(function (sample) {
            var btn = el("button", "chip chip--plain", sample.length > 46 ? sample.slice(0, 44) + "…" : sample);
            btn.type = "button";
            btn.title = sample;
            btn.style.cursor = "pointer";
            btn.addEventListener("click", function () {
                var input = document.querySelector("[data-role='mission-input']");
                if (!input) return;
                input.value = sample;
                input.focus();
            });
            host.appendChild(btn);
        });
    }

    function bindBuilder() {
        var build = document.querySelector("[data-role='build']");
        if (build) build.addEventListener("click", buildMission);
        var run = document.querySelector("[data-role='run']");
        if (run) run.addEventListener("click", runMission);
        var clear = document.querySelector("[data-role='clear']");
        if (clear) clear.addEventListener("click", clearMission);

        var input = document.querySelector("[data-role='mission-input']");
        if (input) {
            input.addEventListener("keydown", function (event) {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") buildMission();
            });
            // Pre-fill from the use-case sample so #builder deep links feel alive.
            if (!input.value && window.BridgeDemo) {
                var uc = window.BridgeDemo.find("digital-twin-mission");
                if (uc && uc.samplePrompt) input.placeholder = uc.samplePrompt;
            }
        }
    }

    function start() {
        renderMissions();
        bindTable();
        renderSamples();
        renderSteps();
        bindBuilder();
        ui.hydrateIcons(document);

        if (window.location.hash === "#builder") {
            var builder = document.getElementById("builder");
            if (builder) builder.scrollIntoView({ behavior: "smooth", block: "start" });
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
    } else {
        start();
    }
})();
