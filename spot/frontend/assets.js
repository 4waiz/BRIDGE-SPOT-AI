/*
 * BRIDGE SPOT - assets page.
 *
 * Sortable/filterable asset register backed by the demo dataset. Each row
 * opens a detail dialog with the thermal trend Spot has collected.
 *
 * FUTURE: GET /api/assets (register + latest reading) and
 * GET /api/assets/{id}/history for the trend series.
 */
(function initAssets() {
    var ui = window.BridgeUI;
    var platform = window.BRIDGE_PLATFORM;
    if (!ui || !platform) return;

    var el = ui.el;
    var html = ui.html;

    var assets = platform.ASSETS.map(function (asset) {
        return Object.assign({}, asset);
    });
    var filter = "all";
    var search = "";
    var sortKey = "health";
    var sortDir = 1;

    var STATUS_CHIP = { healthy: "chip chip--ok", watch: "chip chip--warn", critical: "chip chip--bad" };

    function healthTone(health) {
        return health < 50 ? "is-bad" : health < 75 ? "is-warn" : "";
    }

    /* ---------------- Stats ---------------- */
    function renderStats() {
        var host = document.querySelector("[data-role='stats']");
        if (!host) return;
        var counts = { healthy: 0, watch: 0, critical: 0 };
        assets.forEach(function (asset) {
            counts[asset.status] += 1;
        });

        var stats = [
            { label: "Assets tracked", value: String(assets.length), delta: "Across 6 areas", icon: "assets", tone: "flat" },
            { label: "Healthy", value: String(counts.healthy), delta: Math.round((counts.healthy / assets.length) * 100) + "% of register", icon: "check", tone: "up" },
            { label: "Watch list", value: String(counts.watch), delta: "Trending toward a threshold", icon: "alert", tone: "flat" },
            { label: "Critical", value: String(counts.critical), delta: "Needs intervention", icon: "alert", tone: "down" }
        ];

        host.innerHTML = "";
        stats.forEach(function (stat) {
            var card = el("div", "kpi");
            var head = el("div", "kpi__head");
            head.appendChild(el("span", "kpi__label", stat.label));
            head.appendChild(html("span", "kpi__icon", ui.icon(stat.icon)));
            card.appendChild(head);
            card.appendChild(el("span", "kpi__value", stat.value));
            card.appendChild(el("span", "kpi__delta" + (stat.tone === "down" ? " is-down" : stat.tone === "flat" ? " is-flat" : ""), stat.delta));
            host.appendChild(card);
        });
    }

    /* ---------------- Trend sparkline ---------------- */
    function trendChart(values) {
        var width = 420;
        var height = 130;
        var pad = 18;
        var min = Math.min.apply(null, values);
        var max = Math.max.apply(null, values);
        var span = Math.max(1, max - min);
        var stepX = (width - pad * 2) / (values.length - 1);

        var points = values.map(function (value, i) {
            var x = pad + i * stepX;
            var y = height - pad - ((value - min) / span) * (height - pad * 2);
            return x.toFixed(1) + "," + y.toFixed(1);
        });

        var area =
            "M" + pad + "," + (height - pad) + " L" + points.join(" L") + " L" + (width - pad) + "," + (height - pad) + " Z";

        return (
            '<svg class="chart" viewBox="0 0 ' + width + " " + height + '" role="img" aria-label="Thermal trend">' +
            '<path class="area" d="' + area + '"/>' +
            '<polyline class="line" points="' + points.join(" ") + '"/>' +
            values
                .map(function (value, i) {
                    var parts = points[i].split(",");
                    return '<circle cx="' + parts[0] + '" cy="' + parts[1] + '" r="2.6" fill="var(--accent)"><title>' + value + "</title></circle>";
                })
                .join("") +
            '<text class="label" x="' + pad + '" y="' + (height - 4) + '">7 inspections ago</text>' +
            '<text class="label" x="' + (width - pad) + '" y="' + (height - 4) + '" text-anchor="end">latest</text>' +
            "</svg>"
        );
    }

    function openAsset(asset) {
        var body = document.createDocumentFragment();
        body.appendChild(
            ui.statusGrid([
                { label: "Asset ID", value: asset.id, tone: "info" },
                { label: "Health score", value: asset.health + "%", tone: asset.health < 50 ? "bad" : asset.health < 75 ? "warn" : "ok" },
                { label: "Temperature", value: asset.temp, tone: "info" },
                { label: "Area", value: asset.area, tone: "info" },
                { label: "Type", value: asset.type, tone: "info" },
                { label: "Last inspected", value: asset.lastSeen, tone: "info" }
            ])
        );

        var trend = el("section", "uc-section");
        trend.appendChild(el("h4", "uc-section__title", "Thermal / condition trend"));
        trend.appendChild(html("div", null, trendChart(asset.trend)));
        body.appendChild(trend);

        var note = el("section", "uc-section");
        note.appendChild(el("h4", "uc-section__title", "Latest analysis"));
        note.appendChild(el("p", "uc-text", asset.note));
        body.appendChild(note);

        ui.openModal({
            title: asset.name,
            tagline: asset.type + " · " + asset.area,
            icon: asset.status === "critical" ? "alert" : "chartUp",
            badge: asset.status,
            body: body,
            footer: [
                {
                    label: "Add to next mission",
                    variant: "dark",
                    onClick: function () {
                        ui.toast(asset.id + " queued for the next inspection route (demo).", "ok");
                    }
                },
                {
                    label: "Raise work order",
                    dismiss: false,
                    onClick: function () {
                        // FUTURE: POST /api/workorders { assetId }
                        ui.toast("Work order drafted for " + asset.id + " (demo).", "ok");
                    }
                },
                { label: "Close", dismiss: true }
            ]
        });
    }

    /* ---------------- Table ---------------- */
    function visibleAssets() {
        var needle = search.trim().toLowerCase();
        var rows = assets.filter(function (asset) {
            if (filter !== "all" && asset.status !== filter) return false;
            if (!needle) return true;
            return (
                asset.name.toLowerCase().indexOf(needle) !== -1 ||
                asset.id.toLowerCase().indexOf(needle) !== -1 ||
                asset.area.toLowerCase().indexOf(needle) !== -1 ||
                asset.type.toLowerCase().indexOf(needle) !== -1
            );
        });

        return rows.sort(function (a, b) {
            var left = a[sortKey];
            var right = b[sortKey];
            if (typeof left === "number" && typeof right === "number") return (left - right) * sortDir;
            return String(left).localeCompare(String(right)) * sortDir;
        });
    }

    function renderTable() {
        var body = document.querySelector("[data-role='assets']");
        if (!body) return;
        body.innerHTML = "";

        var rows = visibleAssets();
        if (!rows.length) {
            var empty = el("tr");
            var cell = el("td", "cell-muted", "No assets match this filter.");
            cell.colSpan = 7;
            empty.appendChild(cell);
            body.appendChild(empty);
            return;
        }

        rows.forEach(function (asset) {
            var row = el("tr", "is-clickable");
            row.appendChild(
                html("td", null, '<span class="cell-strong">' + asset.name + '</span><br><span class="cell-muted">' + asset.id + "</span>")
            );
            row.appendChild(el("td", null, asset.area));
            row.appendChild(el("td", null, asset.type));
            row.appendChild(
                html(
                    "td",
                    null,
                    '<span class="meter"><span class="meter__track"><span class="meter__fill ' + healthTone(asset.health) +
                        '" style="width:' + asset.health + '%"></span></span><span class="meter__value">' + asset.health + "%</span></span>"
                )
            );
            row.appendChild(el("td", null, asset.temp));
            row.appendChild(html("td", null, '<span class="cell-muted">' + asset.lastSeen + "</span>"));
            row.appendChild(html("td", null, '<span class="' + STATUS_CHIP[asset.status] + '">' + asset.status + "</span>"));
            row.addEventListener("click", function () {
                openAsset(asset);
            });
            body.appendChild(row);
        });
    }

    /* ---------------- Interactions ---------------- */
    function runScan() {
        var button = document.querySelector("[data-role='scan']");
        if (button) {
            button.classList.add("is-busy");
            button.disabled = true;
        }
        ui.toast("Asset scan started, Spot is re-reading the register (demo).");

        // FUTURE: POST /api/missions { type: 'asset-scan' } and poll for results.
        window.setTimeout(function () {
            assets.forEach(function (asset) {
                var drift = Math.round((Math.random() - 0.45) * 6);
                asset.health = Math.max(18, Math.min(99, asset.health + drift));
                asset.status = asset.health < 50 ? "critical" : asset.health < 75 ? "watch" : "healthy";
                asset.lastSeen = "Today, " + ui.formatTime(new Date());
            });
            renderStats();
            renderTable();
            if (button) {
                button.classList.remove("is-busy");
                button.disabled = false;
            }
            ui.toast("Asset scan complete, health scores updated.", "ok");
        }, 1600);
    }

    function bindToolbar() {
        var seg = document.querySelector("[data-role='filter']");
        if (seg) {
            seg.addEventListener("click", function (event) {
                var btn = event.target.closest("[data-status]");
                if (!btn) return;
                Array.prototype.forEach.call(seg.querySelectorAll("button"), function (node) {
                    node.classList.toggle("is-active", node === btn);
                });
                filter = btn.getAttribute("data-status");
                renderTable();
            });
        }

        var searchInput = document.querySelector("[data-role='search']");
        if (searchInput) {
            searchInput.addEventListener("input", function () {
                search = searchInput.value;
                renderTable();
            });
        }

        Array.prototype.forEach.call(document.querySelectorAll("th[data-sort]"), function (th) {
            th.addEventListener("click", function () {
                var key = th.getAttribute("data-sort");
                if (sortKey === key) sortDir *= -1;
                else {
                    sortKey = key;
                    sortDir = 1;
                }
                Array.prototype.forEach.call(document.querySelectorAll("th[data-sort] .sort-mark"), function (mark) {
                    mark.textContent = "↕";
                });
                var mark = th.querySelector(".sort-mark");
                if (mark) mark.textContent = sortDir === 1 ? "↑" : "↓";
                renderTable();
            });
        });

        var scan = document.querySelector("[data-role='scan']");
        if (scan) scan.addEventListener("click", runScan);

        var exportBtn = document.querySelector("[data-role='export']");
        if (exportBtn) {
            exportBtn.addEventListener("click", function () {
                var header = "id,name,area,type,health,temperature,status,last_inspected";
                var lines = assets.map(function (asset) {
                    return [asset.id, '"' + asset.name + '"', asset.area, asset.type, asset.health, asset.temp, asset.status, '"' + asset.lastSeen + '"'].join(",");
                });
                ui.download("bridge-spot-assets.csv", header + "\n" + lines.join("\n"), "text/csv");
                ui.toast("Asset register exported.", "ok");
            });
        }
    }

    function start() {
        renderStats();
        renderTable();
        bindToolbar();
        ui.hydrateIcons(document);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
    } else {
        start();
    }
})();
