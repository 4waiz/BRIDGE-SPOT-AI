/*
 * BRIDGE SPOT - digital twin hero.
 *
 * Replaces the still photo on the home page with the rigged Spot model from the
 * spot-digital-twin project, and drives its animation from live robot state:
 * when the real Spot is powered on the model stands, when it is not it sits.
 *
 * Degrades on purpose. WebGL may be unavailable, the demo network may be
 * offline (three.js comes from a CDN, as in the twin project's own viewer), and
 * the 21 MB model may simply not be present. In any of those cases the photo
 * that was always there stays put, a hero that silently falls back is better
 * than a blank rectangle on the landing page.
 *
 * Loaded as a module so `import` is available; the page works without it.
 */
(function (window, document) {
    "use strict";

    var MODEL_URL = "spot_twin_web.glb";
    // 10 Hz: fast enough that the twin tracks a walking robot rather
    // than teleporting between poses.
    var STATE_POLL_MS = 100;
    var CDN = "https://cdn.jsdelivr.net/npm/three@0.160.0";

    var host = document.querySelector("[data-role='twin-host']");
    if (!host) return;

    var canvas = host.querySelector("[data-role='twin-canvas']");
    var fallback = host.querySelector("[data-role='twin-fallback']");
    // Queried from the document, not the stage: the badge sits beside the
    // stage in normal flow so it cannot overlap the cards below.
    var badge = document.querySelector("[data-role='twin-badge']");
    var badgeText = document.querySelector("[data-role='twin-badge-text']");

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
       Joint mirroring

       The rig uses SDK joint names with dots stripped (fl.hx -> fl_hx) and
       every joint rotates on its local X axis, so each one needs a sign and an
       offset to convert the SDK angle into rig space:

           bone.rotation.x = SIGN * (sdkAngle - OFFSET)

       Offsets come from rig_mapping.json: the thigh and shin bind angles are
       where the rig's rest pose sits relative to the SDK zero. Getting these
       wrong bends a leg the wrong way rather than failing, which is why they
       are named constants and not inlined.
       ------------------------------------------------------------------ */

    /*
     * Calibrated against the robot rather than derived from the docs.
     *
     * With Spot sitting on the dock, the SDK reported kn = -2.64 while the
     * model's own `sit` clip holds that bone at -2.57: the same value, so the
     * knee maps straight through. The earlier attempt subtracted the shin bind
     * angle and flipped the sign, which put the bone 5.2 rad (~300 degrees)
     * away from the clip and folded the leg backwards.
     *
     * The rig's `stand` clip agrees: kn = -1.555, which is Spot's nominal
     * standing knee.
     *
     * hx and hy are pass-through on the same convention. They are NOT verified:
     * every baked clip in the asset leaves those bones at exactly 0, including
     * `walk`, so the file offers no reference pose to calibrate against. They
     * need checking with the robot standing.
     */
    var JOINT_MAP = {
        hx: { sign: 1, offset: 0 },
        hy: { sign: 1, offset: 0 },
        kn: { sign: 1, offset: 0 }
    };

    var bones = {};

    function indexBones(THREE, root) {
        root.traverse(function (node) {
            if (node.isBone || node.type === "Bone") bones[node.name] = node;
        });
    }

    function applyJoints(data) {
        if (!data || !data.joints) return false;
        var applied = 0;
        Object.keys(data.joints).forEach(function (name) {
            // fl.hx -> fl_hx, because Three.js strips dots from node names.
            var boneName = name.replace(".", "_");
            var bone = bones[boneName];
            if (!bone) return;
            var kind = name.split(".")[1];
            var rule = JOINT_MAP[kind];
            if (!rule) return;
            bone.rotation.x = rule.sign * (data.joints[name] - rule.offset);
            applied++;
        });
        return applied > 0;
    }

    /* ------------------------------------------------------------------
       Live state

       While the robot is reachable its real joint angles drive the skeleton.
       When it is not, the baked `stand` clip plays instead, so the hero is
       never a frozen model.
       ------------------------------------------------------------------ */

    var mirroring = false;

    function play(name, fade) {
        var clip = clips[name];
        if (!clip || !mixer) return;
        var next = mixer.clipAction(clip);
        if (current === next) return;
        next.reset().play();
        if (current) current.crossFadeTo(next, fade === undefined ? 0.35 : fade, false);
        current = next;
    }

    function stopClips() {
        // The mixer writes the same bone rotations we are about to set, so it
        // has to stop or the two fight every frame.
        if (mixer) mixer.stopAllAction();
        current = null;
    }

    function pollJoints() {
        fetch("/api/robot/joints")
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (data) {
                if (disposed) return;
                if (data && data.connected && applyJoints(data)) {
                    if (!mirroring) { stopClips(); mirroring = true; }
                    setBadge("Mirroring robot", true);
                } else {
                    mirroring = false;
                    play("stand");
                    setBadge("Digital twin", false);
                }
            })
            .catch(function () { /* hold the last pose */ });
    }

    /* ------------------------------------------------------------------
       Scene
       ------------------------------------------------------------------ */

    /*
     * Camera framing.
     *
     * A fixed camera position clips the model as soon as the container is a
     * different shape than it was designed against -- which is what a
     * responsive dashboard guarantees. So the distance is derived from the
     * model instead.
     *
     * Fitting to the bounding SPHERE rather than the box matters: the model
     * turns on its turntable and changes pose between sitting and standing,
     * and a sphere is the same size from every angle, so nothing can swing out
     * of frame.
     */
    var VIEW_DIR = null;      // unit direction the camera sits along
    var fitCentre = null;
    var fitRadius = 0;
    // Fit constants. The model is framed by its bounding sphere, which is the
    // one shape a turntable cannot rotate out of, so these two numbers alone
    // decide the framing at every rotation and every aspect ratio.
    //
    // PAD leaves the sphere occupying 1/PAD of the tighter axis; DROP then
    // shifts it down by that fraction of the frame. Keeping DROP + 0.5/PAD
    // under 0.5 is what guarantees the sphere, and so the robot inside it,
    // never touches an edge: 0.03 + 0.5/1.08 = 0.493.
    var PAD = 1.08;
    var DROP = 0.03;

    function frameCamera() {
        if (!camera || !fitRadius || !VIEW_DIR) return;

        var vFov = camera.fov * Math.PI / 180;
        var hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);

        // The horizontal field binds on a wide, short container and the
        // vertical one on a tall, narrow container; fit to whichever is tighter
        // so neither can crop the model.
        var fov = Math.min(vFov, hFov);
        var distance = (fitRadius / Math.sin(fov / 2)) * PAD;

        // Camera and aim point move together, which is a pure pan, so the fit
        // above still holds. Raising both drops the model in the frame, which
        // is what makes it read as standing on the band rather than floating.
        var aim = fitCentre.clone();
        aim.y += DROP * 2 * distance * Math.tan(vFov / 2);

        camera.position.copy(VIEW_DIR).multiplyScalar(distance).add(aim);
        camera.near = Math.max(0.01, distance - fitRadius * 4);
        camera.far = distance + fitRadius * 4;
        camera.lookAt(aim);
        camera.updateProjectionMatrix();
    }

    /* Centre of the posed model, in the model own local space.

       Taken from the bone positions rather than the mesh vertices. Box3 on a
       skinned mesh reports bind-pose bounds, which is not where the clip has
       put the limbs, but walking a couple of hundred thousand vertices through
       getVertexPosition to find out costs seconds and stalls the render loop.
       The skeleton sits inside the body, so its centre is close enough to the
       visual one to spin the turntable around, and it is two dozen points. */
    function posedCentre(THREE, root) {
        var box = new THREE.Box3().makeEmpty();
        var v = new THREE.Vector3();
        var found = 0;
        root.updateMatrixWorld(true);
        var toLocal = new THREE.Matrix4().copy(root.matrixWorld).invert();

        root.traverse(function (node) {
            if (!node.isBone) return;
            box.expandByPoint(v.setFromMatrixPosition(node.matrixWorld).applyMatrix4(toLocal));
            found++;
        });
        return found ? box.getCenter(new THREE.Vector3()) : null;
    }

    /* Put the posed model on its own rotation axis.

       The turntable spins the model about its local origin. That origin came
       from the bind-pose centre, so the posed robot sat off-axis and swung round
       a circle as it turned; because the camera looks down on it, that swing
       showed as the model bobbing vertically, and the framing had to reserve
       room for the whole orbit. Shifting the children rather than the model
       keeps the origin where the camera aims. */
    function recentreOnPose(THREE) {
        if (!model) return;
        var centre = posedCentre(THREE, model);
        if (!centre) return;
        model.children.forEach(function (child) { child.position.sub(centre); });
        model.updateMatrixWorld(true);

        // Measure the sphere about the rotation axis, not about the model's
        // own bounding-box centre: the camera aims at the axis, so that is the
        // point the radius has to be taken from for the fit to hold as it turns.
        var box = new THREE.Box3().setFromObject(model);
        fitCentre = model.position.clone();
        fitRadius = Math.max(
            box.max.distanceTo(fitCentre),
            box.min.distanceTo(fitCentre),
            new THREE.Vector3(box.max.x, box.max.y, box.min.z).distanceTo(fitCentre),
            new THREE.Vector3(box.min.x, box.max.y, box.max.z).distanceTo(fitCentre)
        );
    }

    /* Bounds of what is actually drawn, 0 = top/left, 1 = bottom/right.
       Subsampled: this runs only during calibration, but reading every pixel at
       every trial angle is a needless stall. */
    function measureRendered(step) {
        if (!renderer || !scene || !camera) return null;
        renderer.render(scene, camera);
        var gl = renderer.getContext();
        var w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
        if (!w || !h) return null;
        var px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

        var stride = step || 2;
        var top = h, bottom = -1, left = w, right = -1;
        for (var row = 0; row < h; row += stride) {
            for (var col = 0; col < w; col += stride) {
                if (px[(row * w + col) * 4 + 3] > 8) {
                    var y = h - 1 - row;      // readPixels starts bottom-left
                    if (y < top) top = y;
                    if (y > bottom) bottom = y;
                    if (col < left) left = col;
                    if (col > right) right = col;
                }
            }
        }
        if (bottom < 0) return null;
        return { top: top / h, bottom: bottom / h, left: left / w, right: right / w };
    }

    function size() {
        var width = host.clientWidth || 480;
        var height = host.clientHeight || 360;
        if (renderer) renderer.setSize(width, height, false);
        if (camera) {
            camera.aspect = width / height;
            frameCamera();
        }
    }

    function boot(THREE, GLTFLoader) {
        renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.outputColorSpace = THREE.SRGBColorSpace;

        scene = new THREE.Scene();
        // Position and clipping planes are set by frameCamera() once the
        // model is measured; the values here are only placeholders.
        camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);

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
            // Normalise to a known size, then sit the model exactly on the
            // origin so the camera has a stable point to orbit and aim at.
            var box = new THREE.Box3().setFromObject(model);
            var centre = box.getCenter(new THREE.Vector3());
            var span = box.getSize(new THREE.Vector3());
            var scale = 1.6 / Math.max(span.x, span.y, span.z);
            model.scale.setScalar(scale);
            model.position.sub(centre.multiplyScalar(scale));
            model.rotation.y = -0.5;
            scene.add(model);

            // Measure after scaling and centring, so the fit reflects what is
            // actually in the scene.
            var fitted = new THREE.Box3().setFromObject(model);
            var sphere = fitted.getBoundingSphere(new THREE.Sphere());
            fitCentre = sphere.center.clone();
            fitRadius = sphere.radius;
            // Three-quarter view, slightly above the robot.
            VIEW_DIR = new THREE.Vector3(0.62, 0.30, 0.72).normalize();
            frameCamera();

            indexBones(THREE, model);

            /*
             * Diagnostic handle. The joint sign/offset table has to be
             * calibrated against the real robot (see NOTES.md in the twin
             * project), and that is impossible without being able to read the
             * live bone rotations and the baked clip poses side by side.
             * Read-only; nothing in the render path depends on it.
             */
            window.SpotTwin = {
                bones: bones,
                clips: clips,
                jointMap: JOINT_MAP,
                isMirroring: function () { return mirroring; },
                /** Where the model actually lands in the frame, 0 = top, 1 = bottom.
                    Reads the rendered alpha rather than projecting a bounding
                    box: Box3 on a skinned mesh returns bind-pose bounds, which
                    is not where the posed robot draws. */
                visibleBounds: function (step) { return measureRendered(step || 1); },
                /** Bone rotations at a given time in a named clip. */
                sampleClip: function (name, time) {
                    var clip = clips[name];
                    if (!clip || !model) return null;
                    var probe = new THREE.AnimationMixer(model);
                    var action = probe.clipAction(clip);
                    action.play();
                    probe.setTime(time || 0);
                    var out = {};
                    Object.keys(bones).forEach(function (k) { out[k] = bones[k].rotation.x; });
                    probe.stopAllAction();
                    probe.uncacheRoot(model);
                    return out;
                }
            };
            mixer = new THREE.AnimationMixer(model);
            gltf.animations.forEach(function (clip) { clips[clip.name] = clip; });
            play("stand", 0);
            // Apply the first pose now rather than waiting for a frame: the fit
            // has to describe the posed robot, and requestAnimationFrame does
            // not run at all while the tab is hidden, so anything deferred to
            // the render loop may never happen before the user looks at it.
            mixer.update(0);
            recentreOnPose(THREE);
            frameCamera();

            canvas.hidden = false;
            if (fallback) fallback.style.display = "none";
            setBadge("Digital twin", false);

            pollJoints();
            poll = setInterval(pollJoints, STATE_POLL_MS);
            loop();
        }, undefined, function () {
            // Model missing or corrupt: leave the photo in place.
            teardown();
        });

        // size() re-runs frameCamera, and the fit is analytic, so a new aspect
        // ratio is handled without re-measuring anything.
        window.addEventListener("resize", size);
    }

    function loop() {
        if (disposed) return;
        frame = requestAnimationFrame(loop);
        if (mixer && !mirroring) mixer.update(clock.getDelta());
        // Slow turntable so the hero has life without demanding attention.
        // Turntable only while idle; mirroring should show the real facing.
        if (model && !mirroring) model.rotation.y += 0.0016;
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
    // A failure here is not fatal, the photo stays.
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
 * Home hero live values.
 *
 * Fills the status strip and tiles from /api/robot/state. Anything the API
 * does not report reads "Unavailable" rather than a plausible-looking number:
 * this is a robot dashboard, and an invented figure is worse than a blank.
 */
(function () {
    "use strict";
    var voice = document.querySelector("[data-role='home-voice-state']");
    if (!document.querySelector("[data-hb]") && !voice) return;

    function set(key, text, tone) {
        var el = document.querySelector("[data-hb='" + key + "']");
        if (!el) return;
        el.textContent = text;
        el.className = tone ? "is-" + tone : "";
    }

    function refresh() {
        fetch("/api/robot/state")
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (s) {
                if (!s || !s.connected) {
                    ["conn", "battery", "dock", "power", "estop", "lease", "faults"]
                        .forEach(function (k) { set(k, "Unavailable"); });
                    set("conn", "Offline", "bad");
                    if (voice) {
                        voice.textContent = "Spot is not connected, voice commands will say so.";
                        voice.classList.remove("is-ready");
                    }
                    return;
                }

                var estop = s.estop || {};
                var battery = s.battery || {};
                var comms = (s.comms && s.comms[0]) || {};

                set("conn", comms.essid || (comms.mode === "MODE_CLIENT" ? "Client" : "Online"), "ok");
                set("battery", typeof battery.percentage === "number"
                    ? Math.round(battery.percentage) + "%" : "Unavailable",
                    typeof battery.percentage === "number" && battery.percentage > 30 ? "ok" : "warn");
                set("dock", s.docking && s.docking.status
                    ? s.docking.status.replace("DOCK_STATUS_", "").toLowerCase() : "Unknown");
                set("power", s.powered_on ? "On" : "Off", s.powered_on ? "ok" : null);
                set("estop", !estop.registered ? "Not armed" : (estop.clear ? "Clear" : "ENGAGED"),
                    estop.registered && estop.clear ? "ok" : (estop.registered ? "bad" : null));
                set("lease", s.lease_held ? "Held" : "Not held", s.lease_held ? "ok" : null);
                var faults = (s.faults || []).length;
                set("faults", faults ? faults + " active" : "None", faults ? "bad" : "ok");

                if (voice) {
                    var ready = estop.registered && estop.clear && s.lease_held && s.powered_on;
                    voice.textContent = ready
                        ? "Connected and ready for spoken commands."
                        : "Connected, finish bring-up to unlock motion commands.";
                    voice.classList.toggle("is-ready", !!ready);
                }
            })
            .catch(function () { set("conn", "Service down", "bad"); });
    }

    // Recent missions come from the mission library on disk, not demo data.
    fetch("/api/robot/missions").then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
            var host = document.querySelector("[data-role='hb-missions']");
            if (!host) return;
            var lib = (d && d.library) || [];
            host.innerHTML = lib.length
                ? lib.map(function (m) {
                    return "<li><span class='hb__dot'></span><div><strong>" + m.name +
                        "</strong><small>" + m.waypoints + " waypoints, " + m.route_ft +
                        " ft, " + m.actions + " actions</small></div></li>";
                  }).join("")
                : "<li><div><small>No Autowalk routes loaded.</small></div></li>";
        }).catch(function () {});

    refresh();
    setInterval(refresh, 5000);
})();
