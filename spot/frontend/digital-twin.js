/*
 * BRIDGE SPOT — digital twin hero.
 *
 * Replaces the still photo on the home page with the rigged Spot model from the
 * spot-digital-twin project, and drives its animation from live robot state:
 * when the real Spot is powered on the model stands, when it is not it sits.
 *
 * Degrades on purpose. WebGL may be unavailable, the demo network may be
 * offline (three.js comes from a CDN, as in the twin project's own viewer), and
 * the 21 MB model may simply not be present. In any of those cases the photo
 * that was always there stays put — a hero that silently falls back is better
 * than a blank rectangle on the landing page.
 *
 * Loaded as a module so `import` is available; the page works without it.
 */
(function (window, document) {
    "use strict";

    var MODEL_URL = "spot_twin_web.glb";
    var STATE_POLL_MS = 3000;
    var CDN = "https://cdn.jsdelivr.net/npm/three@0.160.0";

    var host = document.querySelector("[data-role='twin-host']");
    if (!host) return;

    var canvas = host.querySelector("[data-role='twin-canvas']");
    var fallback = host.querySelector("[data-role='twin-fallback']");
    var badge = host.querySelector("[data-role='twin-badge']");
    var badgeText = host.querySelector("[data-role='twin-badge-text']");

    // Bail before loading anything heavy if the browser cannot render it.
    function webglAvailable() {
        try {
            var test = document.createElement("canvas");
            return !!(window.WebGLRenderingContext &&
                      (test.getContext("webgl") || test.getContext("experimental-webgl")));
        } catch (err) {
            return false;
        }
    }

    if (!webglAvailable()) return;

    var renderer, scene, camera, mixer, clock, model;
    var clips = {};
    var current = null;
    var frame = null;
    var poll = null;
    var disposed = false;

    function setBadge(text, live) {
        if (!badge) return;
        badge.hidden = false;
        if (badgeText) badgeText.textContent = text;
        badge.classList.toggle("is-live", !!live);
    }

    /* ------------------------------------------------------------------
       Animation selection

       The API reports power, lease and dock state but no posture, so the
       mapping only uses what is actually known. Nothing here guesses at a
       gait the robot may or may not be walking.
       ------------------------------------------------------------------ */

    function clipForState(state) {
        if (!state || !state.connected) return "stand";
        if (!state.powered_on) return "sit";
        return "stand";
    }

    function play(name, fade) {
        var clip = clips[name];
        if (!clip || !mixer) return;
        var next = mixer.clipAction(clip);
        if (current === next) return;
        next.reset().play();
        if (current) current.crossFadeTo(next, fade === undefined ? 0.35 : fade, false);
        current = next;
    }

    /* ------------------------------------------------------------------
       Live state
       ------------------------------------------------------------------ */

    function pollState() {
        fetch("/api/robot/state")
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (state) {
                if (disposed) return;
                play(clipForState(state));
                if (state && state.connected) {
                    var battery = state.battery && typeof state.battery.percentage === "number"
                        ? " · " + Math.round(state.battery.percentage) + "%" : "";
                    setBadge("Live twin" + battery, true);
                } else {
                    setBadge("Digital twin", false);
                }
            })
            .catch(function () { /* keep whatever it was doing */ });
    }

    /* ------------------------------------------------------------------
       Scene
       ------------------------------------------------------------------ */

    function size() {
        var width = host.clientWidth || 480;
        var height = host.clientHeight || 360;
        if (renderer) renderer.setSize(width, height, false);
        if (camera) {
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
        }
    }

    function boot(THREE, GLTFLoader) {
        renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.outputColorSpace = THREE.SRGBColorSpace;

        scene = new THREE.Scene();
        camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
        camera.position.set(2.6, 1.15, 3.0);
        camera.lookAt(0, 0.45, 0);

        // Soft key/fill so the yellow reads correctly against both themes
        // without the model looking like a lit studio render.
        scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 2.1));
        var key = new THREE.DirectionalLight(0xffffff, 2.0);
        key.position.set(3, 5, 4);
        scene.add(key);
        var rim = new THREE.DirectionalLight(0xffffff, 0.7);
        rim.position.set(-4, 2, -3);
        scene.add(rim);

        clock = new THREE.Clock();
        size();

        new GLTFLoader().load(MODEL_URL, function (gltf) {
            if (disposed) return;
            model = gltf.scene;

            // Centre on the origin and scale to a consistent hero size,
            // whatever units the export used.
            var box = new THREE.Box3().setFromObject(model);
            var centre = box.getCenter(new THREE.Vector3());
            var span = box.getSize(new THREE.Vector3());
            var scale = 1.6 / Math.max(span.x, span.y, span.z);
            model.scale.setScalar(scale);
            model.position.sub(centre.multiplyScalar(scale));
            model.position.y += 0.15;
            model.rotation.y = -0.5;
            scene.add(model);

            mixer = new THREE.AnimationMixer(model);
            gltf.animations.forEach(function (clip) { clips[clip.name] = clip; });
            play("stand", 0);

            canvas.hidden = false;
            if (fallback) fallback.style.display = "none";
            setBadge("Digital twin", false);

            pollState();
            poll = setInterval(pollState, STATE_POLL_MS);
            loop();
        }, undefined, function () {
            // Model missing or corrupt: leave the photo in place.
            teardown();
        });

        window.addEventListener("resize", size);
    }

    function loop() {
        if (disposed) return;
        frame = requestAnimationFrame(loop);
        if (mixer) mixer.update(clock.getDelta());
        // Slow turntable so the hero has life without demanding attention.
        if (model) model.rotation.y += 0.0016;
        renderer.render(scene, camera);
    }

    function teardown() {
        disposed = true;
        if (frame) cancelAnimationFrame(frame);
        if (poll) clearInterval(poll);
        if (renderer) renderer.dispose();
        if (canvas) canvas.hidden = true;
        if (fallback) fallback.style.display = "";
        if (badge) badge.hidden = true;
    }

    // three.js is not vendored locally, so it comes from a CDN exactly as the
    // spot-digital-twin viewer does. Imported through the page's import map:
    // GLTFLoader resolves 'three' as a bare specifier and fails without it.
    // A failure here is not fatal — the photo stays.
    Promise.all([import("three"), import("three/addons/loaders/GLTFLoader.js")])
        .then(function (mods) { boot(mods[0], mods[1].GLTFLoader); })
        .catch(function (err) {
            // Logged rather than swallowed: a silent failure here is
            // indistinguishable from "the model just did not appear".
            if (window.console) console.warn("[twin] unavailable, using still image:", err.message);
        });

    window.addEventListener("pagehide", teardown);
})(window, document);

/*
 * Home page voice-control status line. Lives here rather than in a file of its
 * own because it needs the same /api/robot/state poll the twin already runs.
 */
(function () {
    "use strict";
    var out = document.querySelector("[data-role='home-voice-state']");
    if (!out) return;

    function refresh() {
        fetch("/api/robot/state")
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (s) {
                if (!s || !s.connected) {
                    out.textContent = "Spot is not connected — voice commands will say so.";
                    out.classList.remove("is-ready");
                    return;
                }
                var estop = s.estop || {};
                var ready = estop.registered && estop.clear && s.lease_held && s.powered_on;
                out.textContent = ready
                    ? "Connected and ready for spoken commands."
                    : "Connected — finish bring-up to unlock motion commands.";
                out.classList.toggle("is-ready", !!ready);
            })
            .catch(function () {
                out.textContent = "Spot service unreachable.";
                out.classList.remove("is-ready");
            });
    }
    refresh();
    setInterval(refresh, 5000);
})();
