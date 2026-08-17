/*
 * BRIDGE SPOT - shared behaviour for the live inspection pages
 * (digital_factory.html and hsse.html).
 *
 * The data plumbing still lives in digital_factory.js / hsse.js (they call
 * /analyzefromspot and read /latest/<route>/*.json). This file only adds the
 * presentation layer the redesign needs:
 *   - a readable verdict pill next to each frame (Pass / Attention)
 *   - an empty state when a frame has not been captured yet
 *   - button busy state + toast while Spot is queried
 *   - Escape closes the fullscreen viewer
 */
(function initInspectionPage() {
    var ui = window.BridgeUI;

    function labelFor(container) {
        var label = container.querySelector(".verdict-label");
        if (!label) {
            label = document.createElement("span");
            label.className = "verdict-label";
            container.appendChild(label);
        }
        return label;
    }

    function isVisible(node) {
        return !!node && node.style.display !== "none" && node.style.display !== "";
    }

    function syncVerdict(container) {
        var tick = container.querySelector(".tick");
        var cross = container.querySelector(".cross");
        var label = labelFor(container);

        if (isVisible(tick)) {
            container.classList.add("is-ok");
            container.classList.remove("is-bad", "is-pending");
            label.textContent = "Pass";
        } else if (isVisible(cross)) {
            container.classList.add("is-bad");
            container.classList.remove("is-ok", "is-pending");
            label.textContent = "Attention";
        } else {
            container.classList.add("is-pending");
            container.classList.remove("is-ok", "is-bad");
            label.textContent = "Awaiting analysis";
        }
    }

    function watchVerdicts() {
        var containers = document.querySelectorAll(".icon-container");
        Array.prototype.forEach.call(containers, function (container) {
            syncVerdict(container);
            if (!window.MutationObserver) return;
            var observer = new MutationObserver(function () {
                syncVerdict(container);
            });
            observer.observe(container, {
                attributes: true,
                attributeFilter: ["style"],
                subtree: true
            });
        });
    }

    // A missing capture returns 404 from /latest/<route>/…, show a friendly
    // placeholder rather than a broken image icon.
    function watchImages() {
        Array.prototype.forEach.call(document.querySelectorAll(".main_img"), function (img) {
            var card = img.closest(".image-container");
            img.addEventListener("error", function () {
                if (card) card.classList.add("is-empty");
            });
            img.addEventListener("load", function () {
                if (card) card.classList.remove("is-empty");
            });
            if (img.complete && img.naturalWidth === 0 && card) card.classList.add("is-empty");
        });
    }

    function stamp() {
        var node = document.querySelector("[data-role='last-updated']");
        if (node && ui) node.textContent = "Updated " + ui.formatTime(new Date());
    }

    /*
     * Wrap the page's refresh() so the button reports progress. The real
     * request is still issued by digital_factory.js / hsse.js.
     */
    function bindRefresh() {
        var button = document.querySelector("[data-role='refresh']");
        if (!button) return;
        var route = button.getAttribute("data-route");

        button.addEventListener("click", function () {
            if (typeof window.refresh !== "function") return;
            button.classList.add("is-busy");
            button.disabled = true;
            if (ui) ui.toast("Requesting the latest capture from Spot…");

            Promise.resolve(window.refresh(route))
                .then(function () {
                    if (ui) ui.toast("Inspection data updated.", "ok");
                })
                .catch(function (error) {
                    console.error(error);
                    if (ui) ui.toast("Could not reach Spot. Check the network and try again.", "bad");
                })
                .then(function () {
                    button.classList.remove("is-busy");
                    button.disabled = false;
                    stamp();
                });
        });
    }

    function bindFullscreen() {
        document.addEventListener("keydown", function (event) {
            var container = document.getElementById("fullscreen_container");
            if (event.key === "Escape" && container && container.style.display === "flex") {
                if (typeof window.closeFullscreen === "function") window.closeFullscreen();
            }
        });
    }

    function start() {
        watchVerdicts();
        watchImages();
        bindRefresh();
        bindFullscreen();
        stamp();
        if (ui) ui.hydrateIcons(document);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
    } else {
        start();
    }
})();
