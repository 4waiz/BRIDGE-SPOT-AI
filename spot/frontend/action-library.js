/*
 * BRIDGE SPOT — inspection action library UI.
 *
 * Attaches reusable capture actions to waypoints on an Autowalk route. Lives in
 * the Autowalk panel on the Missions page and is driven by the mission
 * autowalk.js selects, so the two stay on the same mission.
 *
 * The preview is the point of this screen. A capture action is only as good as
 * its framing, and pan/tilt/zoom numbers mean nothing on their own — so Aim
 * drives the real Spot CAM to those angles and pulls back the actual frame the
 * action would record. That moves the camera but never the robot, so it needs
 * a connection and neither the lease nor the E-stop.
 */
(function (window, document) {
    "use strict";

    var $ = function (s, r) { return (r || document).querySelector(s); };

    var Svc = window.RobotService;
    var templates = [];
    var waypoints = [];
    var actions = [];
    var previewUrl = null;

    function mission() {
        // autowalk.js owns the selection; read it rather than duplicating it.
        return window.AutowalkSelection && window.AutowalkSelection();
    }

    function toast(msg, tone) {
        if (window.BridgeUI && window.BridgeUI.toast) window.BridgeUI.toast(msg, tone);
    }

    /* ------------------------------------------------------------------
       Attached actions
       ------------------------------------------------------------------ */

    function renderList() {
        var host = $("[data-role='al-list']");
        if (!host) return;
        host.innerHTML = "";

        if (!actions.length) {
            host.innerHTML = '<p class="ctl-note">No inspection actions yet. This route will ' +
                "walk and dock without capturing anything.</p>";
            return;
        }

        actions.forEach(function (action) {
            var template = templates.find(function (t) { return t.id === action.template; }) || {};
            var wp = waypoints.find(function (w) { return w.id === action.waypoint; }) || {};
            var params = Object.keys(action.params || {})
                .map(function (k) { return k + " " + action.params[k]; })
                .join(" · ");

            var row = document.createElement("div");
            row.className = "al-item";
            row.innerHTML =
                '<div class="al-item__main">' +
                '<span class="al-item__name">' + escapeHtml(action.name) + "</span>" +
                '<span class="al-item__meta">' + escapeHtml(template.title || action.template) +
                " · " + escapeHtml(wp.name || "unknown waypoint") +
                (params ? " · " + escapeHtml(params) : "") + "</span></div>" +
                '<button type="button" class="btn btn--sm btn--ghost" data-remove="' +
                action.id + '">Remove</button>';

            row.querySelector("[data-remove]").addEventListener("click", function () {
                remove(action.id);
            });
            host.appendChild(row);
        });
    }

    function escapeHtml(text) {
        var div = document.createElement("div");
        div.textContent = String(text == null ? "" : text);
        return div.innerHTML;
    }

    /* ------------------------------------------------------------------
       Editor
       ------------------------------------------------------------------ */

    function currentTemplate() {
        var select = $("[data-role='al-template']");
        return templates.find(function (t) { return t.id === (select && select.value); });
    }

    function renderParams() {
        var host = $("[data-role='al-params']");
        var template = currentTemplate();
        if (!host || !template) return;

        host.innerHTML = "";
        var blurb = $("[data-role='al-blurb']");
        if (blurb) blurb.textContent = template.blurb;

        // Templates that do not drive the PTZ have nothing to frame, so the
        // aim control would be misleading.
        var aim = $("[data-role='al-aim']");
        if (aim) aim.disabled = !template.uses_ptz;
        var note = $("[data-role='al-preview-note']");
        if (note) {
            note.textContent = template.uses_ptz
                ? "Aiming moves the Spot CAM only — the robot stays put."
                : "This action captures " + template.sources.join(", ") + " and does not use the PTZ.";
        }

        template.params.forEach(function (spec) {
            var wrap = document.createElement("label");
            wrap.className = "al-field al-field--range";
            wrap.innerHTML =
                "<span>" + spec.label + ' <em data-out="' + spec.id + '">' +
                spec.default + spec.unit + "</em></span>" +
                '<input type="range" data-param="' + spec.id + '" min="' + spec.min +
                '" max="' + spec.max + '" step="1" value="' + spec.default + '">';
            var input = wrap.querySelector("input");
            input.addEventListener("input", function () {
                wrap.querySelector("[data-out]").textContent = input.value + spec.unit;
            });
            host.appendChild(wrap);
        });
    }

    function readParams() {
        var out = {};
        Array.prototype.forEach.call(document.querySelectorAll("[data-param]"), function (input) {
            out[input.getAttribute("data-param")] = parseFloat(input.value);
        });
        return out;
    }

    function openEditor() {
        if (!mission()) { toast("Select a mission first.", "warn"); return; }
        $("[data-role='al-editor']").hidden = false;
        renderParams();
    }

    function closeEditor() {
        $("[data-role='al-editor']").hidden = true;
    }

    /* ------------------------------------------------------------------
       Preview
       ------------------------------------------------------------------ */

    function aimAndPreview() {
        var template = currentTemplate();
        if (!template) return;
        var btn = $("[data-role='al-aim']");
        var img = $("[data-role='al-preview-img']");
        var empty = $("[data-role='al-preview-empty']");
        if (btn) btn.disabled = true;

        var params = readParams();
        Svc.call("aim", "/actions/aim", { body: params })
            .then(function (result) {
                if (!result.ok) {
                    if (empty) { empty.textContent = result.error; empty.style.display = ""; }
                    return;
                }
                // The PTZ autofocuses after it moves. Grabbing the frame too
                // early returns a blurred image, which looks like a bad camera
                // rather than a still-settling one — 2.5s clears it.
                return new Promise(function (resolve) { setTimeout(resolve, 2500); })
                    .then(function () {
                        var source = template.sources[0] === "ir" ? "cam-ir" : "cam-ptz";
                        return fetch("/api/robot/camera/" + source);
                    })
                    .then(function (res) {
                        if (!res.ok) throw new Error("no frame");
                        return res.blob();
                    })
                    .then(function (blob) {
                        if (previewUrl) URL.revokeObjectURL(previewUrl);
                        previewUrl = URL.createObjectURL(blob);
                        img.src = previewUrl;
                        img.style.display = "block";
                        if (empty) empty.style.display = "none";
                    });
            })
            .catch(function () {
                if (empty) { empty.textContent = "Could not fetch a preview frame."; empty.style.display = ""; }
            })
            .then(function () { if (btn) btn.disabled = false; });
    }

    /* ------------------------------------------------------------------
       Persistence
       ------------------------------------------------------------------ */

    function save() {
        var template = currentTemplate();
        var wpSelect = $("[data-role='al-waypoint']");
        if (!template || !wpSelect || !wpSelect.value) {
            toast("Pick an action type and a waypoint.", "warn");
            return;
        }
        var body = {
            mission: mission(),
            waypoint: wpSelect.value,
            template: template.id,
            name: ($("[data-role='al-name']").value || "").trim(),
            params: readParams()
        };
        Svc.call("add_action", "/actions", { body: body }).then(function (result) {
            if (!result.ok) { toast(result.error, "bad"); return; }
            toast("Action attached.", "ok");
            $("[data-role='al-name']").value = "";
            closeEditor();
            refresh();
        });
    }

    function remove(id) {
        Svc.call("remove_action",
            "/actions?mission=" + encodeURIComponent(mission()) + "&action=" + encodeURIComponent(id),
            { method: "DELETE" }
        ).then(function (result) {
            if (!result.ok) { toast(result.error, "bad"); return; }
            toast("Action removed.", "ok");
            refresh();
        });
    }

    function refresh() {
        var id = mission();
        if (!id) return Promise.resolve();
        return Svc.call("actions", "/actions?mission=" + encodeURIComponent(id), { method: "GET" })
            .then(function (result) {
                if (!result.ok) return;
                actions = result.data.actions || [];
                waypoints = result.data.waypoints || [];

                var select = $("[data-role='al-waypoint']");
                if (select && select.options.length !== waypoints.length) {
                    select.innerHTML = "";
                    waypoints.forEach(function (w) {
                        var option = document.createElement("option");
                        option.value = w.id;
                        option.textContent = w.name;
                        select.appendChild(option);
                    });
                }
                renderList();
            });
    }

    /* ------------------------------------------------------------------
       Boot
       ------------------------------------------------------------------ */

    function init() {
        if (!$("[data-role='al-list']") || !Svc) return;

        Svc.call("templates", "/actions/templates", { method: "GET" }).then(function (result) {
            if (!result.ok) return;
            templates = result.data.templates || [];
            var select = $("[data-role='al-template']");
            if (select) {
                select.innerHTML = "";
                templates.forEach(function (t) {
                    var option = document.createElement("option");
                    option.value = t.id;
                    option.textContent = t.title;
                    select.appendChild(option);
                });
                select.addEventListener("change", renderParams);
            }
            renderParams();
            refresh();
        });

        $("[data-role='al-add']").addEventListener("click", openEditor);
        $("[data-role='al-cancel']").addEventListener("click", closeEditor);
        $("[data-role='al-save']").addEventListener("click", save);
        $("[data-role='al-aim']").addEventListener("click", aimAndPreview);

        // autowalk.js announces a mission change; reload this panel to match.
        document.addEventListener("autowalk:selected", refresh);

        window.addEventListener("pagehide", function () {
            if (previewUrl) URL.revokeObjectURL(previewUrl);
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})(window, document);
