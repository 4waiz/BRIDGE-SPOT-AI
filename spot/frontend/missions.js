/*
 * BRIDGE SPOT - missions page.
 *
 * The mission table (filter + search + row actions) over the demo dataset in
 * platform.data.js.
 *
 * The routine builder further down the page is not here: it runs on the robot
 * and lives in routine-builder.js.
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

    /* The natural-language builder that used to live here simulated its runs
       with timers and never reached the robot. The real one is in
       routine-builder.js, which reads instructions on the server and runs them. */

    function start() {
        renderMissions();
        bindTable();
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
