/*
 * BRIDGE SPOT — dataset labelling.
 *
 * Built for throughput. There are 623 door images and 290 fire-safety images to
 * get through, so every decision is one keystroke and the next image is already
 * decoded before the current one is answered. Anything that costs a round trip
 * per image would make the job take an afternoon instead of half an hour.
 *
 * Two modes, chosen by the dataset rather than the operator:
 *   classify — one class per image, number keys, auto-advance
 *   detect   — drag boxes on the image, Enter to save
 *
 * Labels are written to a sidecar on the server; nothing moves the source
 * images, and Z undoes the last decision.
 */
(function (window, document) {
    "use strict";

    var API = "/api/labeling";
    // How many names to hold locally. Large enough that the operator never
    // waits on the network, small enough to stay responsive on first load.
    var QUEUE_SIZE = 60;
    var PRELOAD = 3;

    var $ = function (s, r) { return (r || document).querySelector(s); };

    var dataset = null;       // active dataset spec
    var items = [];           // pending image names
    var cursor = 0;
    var totals = { total: 0, labelled: 0 };
    var boxes = [];           // detect mode: boxes for the current image
    var activeClass = null;
    var preloaded = [];
    var busy = false;

    /* ------------------------------------------------------------------
       Fetch helper
       ------------------------------------------------------------------ */

    function api(path, options) {
        var opts = options || {};
        var init = { method: opts.method || "GET", headers: {} };
        if (opts.body !== undefined) {
            init.headers["Content-Type"] = "application/json";
            init.body = JSON.stringify(opts.body);
        }
        return fetch(API + path, init).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (data) {
                if (!res.ok) throw new Error((data && data.detail) || res.statusText);
                return data;
            });
        });
    }

    function toast(message, tone) {
        if (window.BridgeUI && window.BridgeUI.toast) window.BridgeUI.toast(message, tone);
    }

    function setBanner(message, tone) {
        var el = $("[data-role='lb-banner']");
        if (!el) return;
        if (!message) { el.hidden = true; return; }
        el.hidden = false;
        el.className = "lb-banner is-" + (tone || "info");
        el.textContent = message;
    }

    /* ------------------------------------------------------------------
       Dataset picker
       ------------------------------------------------------------------ */

    function renderPicker(list) {
        var host = $("[data-role='lb-datasets']");
        if (!host) return;
        host.innerHTML = "";

        list.forEach(function (spec) {
            var card = document.createElement("button");
            card.type = "button";
            card.className = "lb-dataset" + (spec.remaining === 0 ? " is-complete" : "");
            card.disabled = !spec.available;

            var pct = spec.total ? Math.round((spec.labelled / spec.total) * 100) : 0;
            card.innerHTML =
                '<span class="lb-dataset__mode">' + (spec.mode === "detect" ? "Bounding boxes" : "Classification") + "</span>" +
                '<h3 class="lb-dataset__title">' + spec.title + "</h3>" +
                '<p class="lb-dataset__model">trains <code>' + spec.model + "</code></p>" +
                '<div class="lb-bar"><span style="width:' + pct + '%"></span></div>' +
                '<p class="lb-dataset__count">' + spec.labelled + " / " + spec.total +
                " labelled" + (spec.remaining ? " · " + spec.remaining + " to go" : " · complete") + "</p>";

            card.addEventListener("click", function () { openDataset(spec); });
            host.appendChild(card);
        });
    }

    /* ------------------------------------------------------------------
       Opening a dataset
       ------------------------------------------------------------------ */

    function openDataset(spec) {
        dataset = spec;
        cursor = 0;
        items = [];
        boxes = [];
        activeClass = spec.classes[0] ? spec.classes[0].id : null;

        $("[data-role='lb-picker']").hidden = true;
        $("[data-role='lb-stage']").hidden = false;
        $("[data-role='lb-back']").hidden = false;
        $("[data-role='lb-question']").textContent = spec.question;

        var detect = spec.mode === "detect";
        $("[data-role='lb-save']").hidden = !detect;
        $("[data-role='lb-clear-boxes']").hidden = !detect;
        $("[data-role='lb-boxes']").hidden = !detect;

        renderClasses();
        renderKeys();
        loadQueue().then(showCurrent).then(refreshStats);
    }

    function closeDataset() {
        dataset = null;
        $("[data-role='lb-picker']").hidden = false;
        $("[data-role='lb-stage']").hidden = true;
        $("[data-role='lb-back']").hidden = true;
        $("[data-role='lb-progress']").textContent = "—";
        loadDatasets();
    }

    function renderClasses() {
        var host = $("[data-role='lb-classes']");
        host.innerHTML = "";
        dataset.classes.forEach(function (cls, index) {
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "lb-class";
            btn.setAttribute("data-class", cls.id);
            btn.innerHTML =
                '<kbd>' + (index + 1) + "</kbd>" +
                '<span class="lb-class__label">' + cls.label + "</span>" +
                '<span class="lb-class__hint">' + cls.hint + "</span>";
            btn.addEventListener("click", function () { chooseClass(cls.id); });
            host.appendChild(btn);
        });
        highlightActiveClass();
    }

    function renderKeys() {
        var host = $("[data-role='lb-keys']");
        var rows = dataset.classes.map(function (c, i) {
            return "<li><kbd>" + (i + 1) + "</kbd> " +
                (dataset.mode === "detect" ? "select " : "") + c.label + "</li>";
        });
        if (dataset.mode === "detect") {
            rows.push("<li><kbd>drag</kbd> draw a box</li>");
            rows.push("<li><kbd>Enter</kbd> save and next</li>");
            rows.push("<li><kbd>Backspace</kbd> remove last box</li>");
        }
        rows.push("<li><kbd>Z</kbd> undo last image</li>");
        rows.push("<li><kbd>S</kbd> skip</li>");
        host.innerHTML = rows.join("");
    }

    function highlightActiveClass() {
        Array.prototype.forEach.call(document.querySelectorAll(".lb-class"), function (btn) {
            btn.classList.toggle("is-active",
                dataset.mode === "detect" && btn.getAttribute("data-class") === activeClass);
        });
    }

    /* ------------------------------------------------------------------
       Queue
       ------------------------------------------------------------------ */

    function loadQueue() {
        return api("/queue?dataset=" + encodeURIComponent(dataset.id) + "&limit=" + QUEUE_SIZE)
            .then(function (data) {
                items = data.items.map(function (i) { return i.name; });
                cursor = 0;
                totals = { total: data.total, labelled: data.labelled };
                updateProgress(data.remaining);
            })
            .catch(function (err) { setBanner(err.message, "warn"); });
    }

    function currentName() { return items[cursor] || null; }

    function imageUrl(name) {
        return API + "/image?dataset=" + encodeURIComponent(dataset.id) +
               "&name=" + encodeURIComponent(name);
    }

    /** Decode the next few images now so advancing is instant. */
    function preloadAhead() {
        preloaded = [];
        for (var i = 1; i <= PRELOAD; i++) {
            var name = items[cursor + i];
            if (!name) break;
            var img = new Image();
            img.src = imageUrl(name);
            preloaded.push(img);
        }
    }

    function showCurrent() {
        var name = currentName();
        var img = $("[data-role='lb-image']");
        var done = $("[data-role='lb-done']");

        if (!name) {
            img.removeAttribute("src");
            img.style.display = "none";
            done.hidden = false;
            $("[data-role='lb-counter']").textContent = "";
            return;
        }

        done.hidden = true;
        img.style.display = "";
        img.src = imageUrl(name);
        boxes = [];
        redrawBoxes();
        $("[data-role='lb-counter']").textContent = name;
        preloadAhead();
    }

    function updateProgress(remaining) {
        var labelled = totals.labelled;
        var total = totals.total;
        var pct = total ? Math.round((labelled / total) * 100) : 0;

        var fill = $("[data-role='lb-bar-fill']");
        if (fill) fill.style.width = pct + "%";
        var text = $("[data-role='lb-bar-text']");
        if (text) text.textContent = labelled + " of " + total + " labelled (" + pct + "%)";
        var chip = $("[data-role='lb-progress']");
        if (chip) chip.textContent = dataset.title + " · " + (remaining !== undefined ? remaining : "?") + " left";
    }

    function refreshStats() {
        if (!dataset) return Promise.resolve();
        return api("/stats?dataset=" + encodeURIComponent(dataset.id)).then(function (data) {
            var host = $("[data-role='lb-stats']");
            if (!host) return;
            var rows = dataset.classes.map(function (c) {
                return "<div><dt>" + c.label + "</dt><dd>" + (data.counts[c.id] || 0) + "</dd></div>";
            });
            if (data.boxes !== undefined) {
                rows.push("<div><dt>Total boxes</dt><dd>" + data.boxes + "</dd></div>");
                rows.push("<div><dt>Empty frames</dt><dd>" + data.empty_frames + "</dd></div>");
            }
            host.innerHTML = rows.join("");
        }).catch(function () { /* stats are advisory */ });
    }

    /* ------------------------------------------------------------------
       Recording a decision
       ------------------------------------------------------------------ */

    function chooseClass(classId) {
        if (!dataset) return;
        if (dataset.mode === "detect") {
            activeClass = classId;
            highlightActiveClass();
            return;
        }
        submit({ label: classId });
    }

    function submit(payload) {
        var name = currentName();
        if (!name || busy) return;
        busy = true;

        var body = { dataset: dataset.id, name: name };
        if (payload.label !== undefined) body.label = payload.label;
        if (payload.boxes !== undefined) body.boxes = payload.boxes;

        // Advance immediately: the operator should never wait on the network
        // between images. A failure rewinds and says so.
        var advancedFrom = cursor;
        cursor++;
        totals.labelled++;
        showCurrent();
        updateProgress(items.length - cursor);

        api("/label", { method: "POST", body: body })
            .then(function () {
                if (cursor >= items.length - 5) loadQueue().then(showCurrent);
                if (totals.labelled % 10 === 0) refreshStats();
            })
            .catch(function (err) {
                cursor = advancedFrom;
                totals.labelled--;
                showCurrent();
                toast("Could not save: " + err.message, "bad");
            })
            .then(function () { busy = false; });
    }

    function undo() {
        if (!dataset || busy) return;
        busy = true;
        api("/undo?dataset=" + encodeURIComponent(dataset.id), { method: "POST" })
            .then(function (data) {
                // Put the restored image back at the front of the queue.
                if (cursor > 0) cursor--;
                else items.unshift(data.name);
                totals.labelled = Math.max(0, totals.labelled - 1);
                showCurrent();
                updateProgress(items.length - cursor);
                refreshStats();
                toast("Undone.", "ok");
            })
            .catch(function (err) { toast(err.message, "warn"); })
            .then(function () { busy = false; });
    }

    function skip() {
        if (!currentName()) return;
        cursor++;
        showCurrent();
        updateProgress(items.length - cursor);
    }

    /* ------------------------------------------------------------------
       Bounding boxes (detect mode)
       ------------------------------------------------------------------ */

    function boxCanvas() { return $("[data-role='lb-boxes']"); }

    function syncCanvasSize() {
        var img = $("[data-role='lb-image']");
        var canvas = boxCanvas();
        if (!img || !canvas || !img.clientWidth) return;
        if (canvas.width !== img.clientWidth || canvas.height !== img.clientHeight) {
            canvas.width = img.clientWidth;
            canvas.height = img.clientHeight;
        }
        canvas.style.width = img.clientWidth + "px";
        canvas.style.height = img.clientHeight + "px";
    }

    function classColour(classId) {
        var index = dataset.classes.findIndex(function (c) { return c.id === classId; });
        return index === 0 ? "#ff5622" : "#2f6df6";
    }

    function redrawBoxes(preview) {
        if (!dataset || dataset.mode !== "detect") return;
        var canvas = boxCanvas();
        if (!canvas) return;
        syncCanvasSize();
        var ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        function paint(box, dim) {
            var x = box.x * canvas.width, y = box.y * canvas.height;
            var w = box.w * canvas.width, h = box.h * canvas.height;
            ctx.strokeStyle = classColour(box.cls);
            ctx.lineWidth = 2;
            ctx.globalAlpha = dim ? 0.7 : 1;
            ctx.strokeRect(x - w / 2, y - h / 2, w, h);
            var label = (dataset.classes.find(function (c) { return c.id === box.cls; }) || {}).label || box.cls;
            ctx.fillStyle = classColour(box.cls);
            ctx.font = "600 12px system-ui, sans-serif";
            var tw = ctx.measureText(label).width + 8;
            ctx.fillRect(x - w / 2, y - h / 2 - 16, tw, 16);
            ctx.fillStyle = "#fff";
            ctx.fillText(label, x - w / 2 + 4, y - h / 2 - 4);
            ctx.globalAlpha = 1;
        }

        boxes.forEach(function (b) { paint(b, false); });
        if (preview) paint(preview, true);
    }

    function setupBoxDrawing() {
        var canvas = boxCanvas();
        if (!canvas) return;
        var start = null;

        function pointAt(ev) {
            var rect = canvas.getBoundingClientRect();
            return {
                x: Math.min(Math.max((ev.clientX - rect.left) / rect.width, 0), 1),
                y: Math.min(Math.max((ev.clientY - rect.top) / rect.height, 0), 1)
            };
        }

        function toBox(a, b) {
            return {
                cls: activeClass,
                x: (a.x + b.x) / 2,
                y: (a.y + b.y) / 2,
                w: Math.abs(b.x - a.x),
                h: Math.abs(b.y - a.y)
            };
        }

        canvas.addEventListener("pointerdown", function (ev) {
            if (!dataset || dataset.mode !== "detect") return;
            start = pointAt(ev);
            canvas.setPointerCapture(ev.pointerId);
            ev.preventDefault();
        });

        canvas.addEventListener("pointermove", function (ev) {
            if (!start) return;
            redrawBoxes(toBox(start, pointAt(ev)));
        });

        ["pointerup", "pointercancel"].forEach(function (type) {
            canvas.addEventListener(type, function (ev) {
                if (!start) return;
                var box = toBox(start, pointAt(ev));
                start = null;
                // Ignore stray clicks: a box needs real area to be a label.
                if (box.w > 0.01 && box.h > 0.01) boxes.push(box);
                redrawBoxes();
            });
        });
    }

    function saveBoxes() {
        if (!dataset || dataset.mode !== "detect") return;
        // An empty list is a valid answer -- a frame with no equipment is a
        // negative example, which detection training needs.
        submit({ boxes: boxes.slice() });
    }

    /* ------------------------------------------------------------------
       Export
       ------------------------------------------------------------------ */

    function exportDataset() {
        var btn = $("[data-role='lb-export']");
        var out = $("[data-role='lb-export-result']");
        btn.disabled = true;
        out.textContent = "Exporting…";
        api("/export?dataset=" + encodeURIComponent(dataset.id), { method: "POST" })
            .then(function (data) {
                out.textContent = data.exported + " images written to " + data.path;
                toast("Export complete.", "ok");
            })
            .catch(function (err) { out.textContent = err.message; toast(err.message, "bad"); })
            .then(function () { btn.disabled = false; });
    }

    /* ------------------------------------------------------------------
       Keyboard
       ------------------------------------------------------------------ */

    function onKey(ev) {
        if (!dataset) return;
        var tag = (ev.target.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea" || ev.target.isContentEditable) return;

        var key = ev.key.toLowerCase();

        if (key >= "1" && key <= "9") {
            var index = parseInt(key, 10) - 1;
            if (dataset.classes[index]) {
                chooseClass(dataset.classes[index].id);
                ev.preventDefault();
            }
            return;
        }
        if (key === "z") { undo(); ev.preventDefault(); return; }
        if (key === "s") { skip(); ev.preventDefault(); return; }
        if (dataset.mode === "detect") {
            if (key === "enter") { saveBoxes(); ev.preventDefault(); return; }
            if (key === "backspace") { boxes.pop(); redrawBoxes(); ev.preventDefault(); return; }
        }
    }

    /* ------------------------------------------------------------------
       Boot
       ------------------------------------------------------------------ */

    function loadDatasets() {
        return api("/datasets")
            .then(function (data) { renderPicker(data.datasets); setBanner(null); })
            .catch(function (err) {
                setBanner("Could not load datasets: " + err.message, "warn");
            });
    }

    function init() {
        loadDatasets();
        setupBoxDrawing();

        $("[data-role='lb-back']").addEventListener("click", closeDataset);
        $("[data-role='lb-undo']").addEventListener("click", undo);
        $("[data-role='lb-skip']").addEventListener("click", skip);
        $("[data-role='lb-save']").addEventListener("click", saveBoxes);
        $("[data-role='lb-clear-boxes']").addEventListener("click", function () {
            boxes = []; redrawBoxes();
        });
        $("[data-role='lb-export']").addEventListener("click", exportDataset);
        $("[data-role='lb-image']").addEventListener("load", function () { redrawBoxes(); });
        window.addEventListener("resize", function () { redrawBoxes(); });
        document.addEventListener("keydown", onKey);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})(window, document);
