/*
 * BRIDGE SPOT — dashboard page.
 *
 * Renders KPIs, the inspection activity chart, recent missions, open findings
 * and asset health from platform.data.js (demo dataset).
 *
 * FUTURE: swap the three read* helpers for fetches against the BRIDGE
 * backend; everything below is pure rendering.
 */
(function initDashboard() {
    var ui = window.BridgeUI;
    var data = window.BRIDGE_PLATFORM;
    if (!ui || !data) return;

    var el = ui.el;
    var html = ui.html;
    var range = 7;

    /* ---------------- KPIs ---------------- */
    function renderKpis() {
        var host = document.querySelector("[data-role='kpis']");
        if (!host) return;
        host.innerHTML = "";
        data.KPIS.forEach(function (kpi) {
            var card = el("div", "kpi");
            var head = el("div", "kpi__head");
            head.appendChild(el("span", "kpi__label", kpi.label));
            head.appendChild(html("span", "kpi__icon", ui.icon(kpi.icon)));
            card.appendChild(head);
            card.appendChild(el("span", "kpi__value", kpi.value));
            card.appendChild(
                el("span", "kpi__delta" + (kpi.tone === "down" ? " is-down" : kpi.tone === "flat" ? " is-flat" : ""), kpi.delta)
            );
            host.appendChild(card);
        });
    }

    /* ---------------- Activity chart ---------------- */
    function series() {
        if (range === 7) return data.ACTIVITY.slice();
        // 30-day view: fold the weekly pattern into 4 weekly buckets + a
        // partial week, so the demo chart stays believable.
        var weeks = [];
        for (var w = 0; w < 4; w += 1) {
            var missions = 0;
            var findings = 0;
            data.ACTIVITY.forEach(function (day, i) {
                missions += Math.max(1, day.missions - ((w + i) % 3));
                findings += Math.max(0, day.findings - (w % 2));
            });
            weeks.push({ label: "Wk " + (w + 1), missions: missions, findings: findings });
        }
        return weeks;
    }

    function renderChart() {
        var host = document.querySelector("[data-role='activity-chart']");
        if (!host) return;
        var rows = series();
        var width = 640;
        var height = 220;
        var padL = 34;
        var padB = 26;
        var padT = 12;
        var max = rows.reduce(function (acc, row) {
            return Math.max(acc, row.missions, row.findings);
        }, 4);
        var step = (width - padL - 10) / rows.length;
        var barW = Math.min(22, step / 3);
        var scale = function (value) {
            return (height - padB - padT) * (value / max);
        };

        var parts = [];
        // horizontal grid + y labels
        for (var g = 0; g <= 4; g += 1) {
            var value = Math.round((max / 4) * g);
            var y = height - padB - scale(value);
            parts.push('<line class="grid" x1="' + padL + '" y1="' + y + '" x2="' + (width - 6) + '" y2="' + y + '"/>');
            parts.push('<text class="label" x="' + (padL - 8) + '" y="' + (y + 3) + '" text-anchor="end">' + value + "</text>");
        }

        rows.forEach(function (row, i) {
            var x = padL + i * step + step / 2;
            var mh = scale(row.missions);
            var fh = scale(row.findings);
            parts.push(
                '<rect class="bar" x="' + (x - barW - 2) + '" y="' + (height - padB - mh) + '" width="' + barW +
                    '" height="' + Math.max(mh, 1) + '" rx="3"><title>' + row.label + ": " + row.missions + " missions</title></rect>"
            );
            parts.push(
                '<rect class="bar is-muted" x="' + (x + 2) + '" y="' + (height - padB - fh) + '" width="' + barW +
                    '" height="' + Math.max(fh, 1) + '" rx="3"><title>' + row.label + ": " + row.findings + " findings</title></rect>"
            );
            parts.push('<text class="label" x="' + x + '" y="' + (height - 8) + '" text-anchor="middle">' + row.label + "</text>");
        });

        parts.push('<line class="axis" x1="' + padL + '" y1="' + (height - padB) + '" x2="' + (width - 6) + '" y2="' + (height - padB) + '"/>');

        host.innerHTML =
            '<svg class="chart" viewBox="0 0 ' + width + " " + height + '" role="img" aria-label="Inspection activity chart">' +
            parts.join("") +
            "</svg>";

        var caption = document.querySelector("[data-role='chart-caption']");
        if (caption) caption.textContent = range === 7 ? "Last 7 days" : "Last 30 days";
    }

    /* ---------------- Missions table ---------------- */
    var STATUS_CHIP = {
        running: "chip chip--info",
        scheduled: "chip",
        completed: "chip chip--ok",
        failed: "chip chip--bad"
    };

    function missionModal(mission) {
        var body = document.createDocumentFragment();
        body.appendChild(
            ui.statusGrid([
                { label: "Status", value: mission.status, tone: mission.status === "failed" ? "bad" : mission.status === "completed" ? "ok" : "info" },
                { label: "Route", value: mission.route, tone: "info" },
                { label: "Waypoints", value: mission.done + " / " + mission.waypoints, tone: "info" },
                { label: "Findings", value: String(mission.findings), tone: mission.findings ? "warn" : "ok" },
                { label: "Operator", value: mission.operator, tone: "info" },
                { label: "Duration", value: mission.duration, tone: "info" }
            ])
        );
        var meter = el("div", "uc-section");
        meter.appendChild(el("h4", "uc-section__title", "Progress"));
        meter.appendChild(
            html(
                "div",
                "meter",
                '<span class="meter__track"><span class="meter__fill is-accent" style="width:' + mission.progress + '%"></span></span>' +
                    '<span class="meter__value">' + mission.progress + "%</span>"
            )
        );
        body.appendChild(meter);

        ui.openModal({
            title: mission.name,
            tagline: "Mission " + mission.id + " · started " + mission.started,
            icon: "mission",
            badge: "Demo",
            body: body,
            footer: [
                { label: "Open route", href: mission.page, variant: "dark" },
                { label: "View module", onClick: function () {
                    if (window.BridgeDemo) window.BridgeDemo.open(mission.module);
                }, dismiss: false },
                { label: "Close", dismiss: true }
            ]
        });
    }

    function renderMissions() {
        var body = document.querySelector("[data-role='missions']");
        if (!body) return;
        body.innerHTML = "";
        data.MISSIONS.forEach(function (mission) {
            var row = el("tr", "is-clickable");
            row.appendChild(html("td", null, '<span class="cell-strong">' + mission.name + '</span><br><span class="cell-muted">' + mission.id + "</span>"));
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
            row.appendChild(el("td", null, String(mission.findings)));
            row.appendChild(html("td", null, '<span class="cell-muted">' + mission.started + "</span>"));
            row.addEventListener("click", function () {
                missionModal(mission);
            });
            body.appendChild(row);
        });
    }

    /* ---------------- Findings ---------------- */
    var SEVERITY_ICON = { critical: "alert", warning: "alert", info: "info" };
    var SEVERITY_TONE = { critical: "bad", warning: "warn", info: "info" };

    function renderFindings() {
        var host = document.querySelector("[data-role='findings']");
        if (!host) return;
        host.innerHTML = "";
        data.FINDINGS.forEach(function (finding) {
            var card = el("button", "module-card");
            card.type = "button";
            card.appendChild(html("span", "icon-tile", ui.icon(SEVERITY_ICON[finding.severity] || "info")));
            var body = el("div", "module-card__body");
            body.appendChild(html("span", "chip chip--" + SEVERITY_TONE[finding.severity], finding.severity));
            body.appendChild(el("h3", "module-card__title", finding.title));
            body.appendChild(el("p", "module-card__text", finding.route + " · " + finding.time));
            card.appendChild(body);
            card.appendChild(html("span", "module-card__chevron", ui.icon("chevronRight")));
            card.addEventListener("click", function () {
                ui.openModal({
                    title: finding.title,
                    tagline: "Finding " + finding.id + " · " + finding.route + " route",
                    icon: SEVERITY_ICON[finding.severity] || "info",
                    badge: finding.severity,
                    body: ui.statusGrid([
                        { label: "Severity", value: finding.severity, tone: SEVERITY_TONE[finding.severity] },
                        { label: "Asset", value: finding.asset, tone: "info" },
                        { label: "Detected", value: finding.time, tone: "info" },
                        { label: "Route", value: finding.route, tone: "info" }
                    ]),
                    footer: [
                        { label: "Open asset", href: "assets.html", variant: "dark" },
                        { label: "Acknowledge", dismiss: true, onClick: function () {
                            ui.toast("Finding " + finding.id + " acknowledged (demo).", "ok");
                        } }
                    ]
                });
            });
            host.appendChild(card);
        });
    }

    /* ---------------- Asset health summary ---------------- */
    function renderAssetHealth() {
        var host = document.querySelector("[data-role='asset-health']");
        if (!host) return;
        host.innerHTML = "";
        data.ASSETS.slice()
            .sort(function (a, b) {
                return a.health - b.health;
            })
            .slice(0, 5)
            .forEach(function (asset) {
                var tone = asset.health < 50 ? "is-bad" : asset.health < 75 ? "is-warn" : "";
                var row = el("div");
                row.appendChild(html("div", null, '<span class="cell-strong">' + asset.name + '</span> <span class="cell-muted">· ' + asset.area + "</span>"));
                row.appendChild(
                    html(
                        "div",
                        "meter",
                        '<span class="meter__track"><span class="meter__fill ' + tone + '" style="width:' + asset.health +
                            '%"></span></span><span class="meter__value">' + asset.health + "%</span>"
                    )
                );
                host.appendChild(row);
            });
    }

    /* ---------------- Activity timeline ---------------- */
    function renderTimeline() {
        var host = document.querySelector("[data-role='timeline']");
        if (!host) return;
        host.innerHTML = "";
        var events = [
            { text: "Digital Factory sweep reached waypoint 5 of 8", time: "09:51" },
            { text: "Thermal anomaly raised on Coolant pump P-102", time: "09:51" },
            { text: "Open panel detected in Utility room", time: "09:47" },
            { text: "HSSE patrol scheduled for 14:00", time: "09:05" },
            { text: "Weekly asset health digest generated", time: "08:05" }
        ];
        events.forEach(function (event) {
            var li = el("li");
            li.appendChild(el("strong", null, event.text));
            li.appendChild(el("time", null, "Today, " + event.time));
            host.appendChild(li);
        });
    }

    /* ---------------- Toolbar ---------------- */
    function bindToolbar() {
        var seg = document.querySelector("[data-role='range']");
        if (seg) {
            seg.addEventListener("click", function (event) {
                var btn = event.target.closest("[data-range]");
                if (!btn) return;
                Array.prototype.forEach.call(seg.querySelectorAll("button"), function (node) {
                    node.classList.toggle("is-active", node === btn);
                });
                range = Number(btn.getAttribute("data-range"));
                renderChart();
            });
        }

        var refresh = document.querySelector("[data-role='refresh']");
        if (refresh) {
            refresh.addEventListener("click", function () {
                // FUTURE: re-fetch /api/activity and /api/missions here.
                renderAll();
                ui.toast("Dashboard refreshed (demo data).", "ok");
            });
        }

        var exportBtn = document.querySelector("[data-role='export']");
        if (exportBtn) {
            exportBtn.addEventListener("click", function () {
                var header = "id,name,route,status,progress,findings,operator,started,duration";
                var lines = data.MISSIONS.map(function (m) {
                    return [m.id, '"' + m.name + '"', m.route, m.status, m.progress, m.findings, '"' + m.operator + '"', '"' + m.started + '"', m.duration].join(",");
                });
                ui.download("bridge-spot-missions.csv", header + "\n" + lines.join("\n"), "text/csv");
                ui.toast("Mission log exported as CSV.", "ok");
            });
        }
    }

    function renderAll() {
        renderKpis();
        renderChart();
        renderMissions();
        renderFindings();
        renderAssetHealth();
        renderTimeline();
        ui.hydrateIcons(document);
    }

    function start() {
        renderAll();
        bindToolbar();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
    } else {
        start();
    }
})();
