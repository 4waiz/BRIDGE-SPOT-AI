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
    // Which element the canvas is currently rendering into. The overlay borrows
    // it rather than building a second renderer: the model is 21 MB, and two
    // copies of it in memory to show the same robot twice would be wasteful.
    var stageEl = host;
    var clips = {};
    var current = null;
    var frame = null;
    var poll = null;
    var disposed = false;
    var spinning = true;      // turntable; paused while the model is dragged

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
    // While a pose is being previewed from the overlay, the poll below leaves
    // the model alone: otherwise the next tick would snap it back and the
    // buttons would look broken.
    var previewing = false;

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
                if (previewing) {
                    setBadge("Previewing pose", false);
                    return;
                }
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
       Twin viewer overlay

       Clicking the hero opens a larger stage with the baked clips as buttons.
       The canvas is moved into the overlay rather than a second renderer being
       built beside it: the model is 21 MB, and holding two copies to show the
       same robot twice would be wasteful.

       The poses animate the model only. Driving the real robot from here would
       be a second control path for motion commands, and there is already one on
       the Control page.
       ------------------------------------------------------------------ */

    // Ordered for the operator, not alphabetically: the two resting poses come
    // first because they are what the twin is normally showing.
    var POSE_ORDER = ["stand", "sit", "stand_up", "walk", "walk_fast", "run", "scan_360"];
    var POSE_LABELS = {
        stand: "Stand", sit: "Sit", stand_up: "Stand up", walk: "Walk",
        walk_fast: "Walk fast", run: "Run", scan_360: "Scan 360"
    };

    function setupViewer() {
        var openBtn = document.querySelector("[data-role='twin-open']");
        var modal = document.querySelector("[data-role='twin-modal']");
        if (!openBtn || !modal) return;

        var stage = modal.querySelector("[data-role='twin-modal-stage']");
        var poseHost = modal.querySelector("[data-role='twin-poses']");
        var spinBtn = modal.querySelector("[data-role='twin-spin']");
        var liveBtn = modal.querySelector("[data-role='twin-live']");
        var stateEl = modal.querySelector("[data-role='twin-modal-state']");
        var closeEl = modal.querySelector(".twin-modal__close");
        var lastFocus = null;
        var built = false;

        function setState() {
            if (!stateEl) return;
            stateEl.textContent = previewing
                ? "Previewing a pose. The model is not following the robot."
                : (mirroring ? "Following the live robot." : "Robot offline, showing the idle pose.");
        }

        function markActive(name) {
            Array.prototype.forEach.call(poseHost.children, function (btn) {
                btn.classList.toggle("is-active", btn.getAttribute("data-pose") === name);
            });
        }

        function buildPoses() {
            if (built) return;
            built = true;
            poseHost.innerHTML = "";
            // Anything in the file but not in POSE_ORDER still gets a button, so
            // a re-exported model with new clips does not silently lose them.
            var names = POSE_ORDER.filter(function (n) { return clips[n]; })
                .concat(Object.keys(clips).filter(function (n) { return POSE_ORDER.indexOf(n) < 0; }));

            names.forEach(function (name) {
                var btn = document.createElement("button");
                btn.type = "button";
                btn.className = "twin-modal__pose";
                btn.setAttribute("data-pose", name);
                btn.textContent = POSE_LABELS[name] || name.replace(/_/g, " ");
                btn.addEventListener("click", function () {
                    previewing = true;
                    mirroring = false;
                    play(name, 0.25);
                    setBadge("Previewing pose", false);
                    markActive(name);
                    setState();
                });
                poseHost.appendChild(btn);
            });
        }

        function open() {
            buildPoses();
            lastFocus = document.activeElement;
            modal.hidden = false;
            document.body.style.overflow = "hidden";

            stage.appendChild(canvas);
            stageEl = stage;
            size();

            // The hero would otherwise be an empty box while the canvas is away.
            if (fallback) fallback.style.display = "block";
            setState();
            if (closeEl) closeEl.focus();
        }

        function close() {
            modal.hidden = true;
            document.body.style.overflow = "";

            host.appendChild(canvas);
            stageEl = host;
            size();

            if (fallback) fallback.style.display = "none";
            if (lastFocus && lastFocus.focus) lastFocus.focus();
        }

        openBtn.addEventListener("click", open);

        Array.prototype.forEach.call(modal.querySelectorAll("[data-role='twin-dismiss']"),
            function (el) { el.addEventListener("click", close); });

        document.addEventListener("keydown", function (event) {
            if (event.key === "Escape" && !modal.hidden) close();
        });

        if (spinBtn) {
            spinBtn.addEventListener("click", function () {
                spinning = !spinning;
                spinBtn.textContent = spinning ? "Pause turntable" : "Resume turntable";
                spinBtn.setAttribute("aria-pressed", String(spinning));
            });
        }

        if (liveBtn) {
            liveBtn.addEventListener("click", function () {
                previewing = false;
                markActive(null);
                pollJoints();
                setState();
            });
        }

        /* Drag to turn. Pointer events cover mouse and touch alike, and the
           stage sets touch-action: none so a drag turns the model rather than
           scrolling the page behind it. */
        var dragging = false, lastX = 0, spinBeforeDrag = true;

        stage.addEventListener("pointerdown", function (event) {
            dragging = true;
            lastX = event.clientX;
            spinBeforeDrag = spinning;
            spinning = false;
            stage.setPointerCapture(event.pointerId);
        });

        stage.addEventListener("pointermove", function (event) {
            if (!dragging || !model) return;
            model.rotation.y += (event.clientX - lastX) * 0.01;
            lastX = event.clientX;
        });

        function endDrag(event) {
            if (!dragging) return;
            dragging = false;
            spinning = spinBeforeDrag;
            if (event.pointerId !== undefined && stage.hasPointerCapture &&
                stage.hasPointerCapture(event.pointerId)) {
                stage.releasePointerCapture(event.pointerId);
            }
        }

        stage.addEventListener("pointerup", endDrag);
        stage.addEventListener("pointercancel", endDrag);

        openBtn.hidden = false;
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
    // Points on the volume the model sweeps as the turntable turns. Rotating
    // about Y turns the bounding box into a cylinder, so rings of points at the
    // top and bottom of that cylinder bound every rotation it can reach. That
    // is a far tighter bound than the bounding sphere this used to fit: Spot is
    // roughly twice as long as it is tall, so a sphere sized by its length left
    // the robot filling barely a third of the frame height.
    var sweptPoints = [];
    var fitDistance = 0;
    var aimLift = 0;          // world units the camera rises, dropping the model
    var scratch = null;       // reused projection target

    var FILL = 0.94;          // fraction of the frame the swept volume fills
    var FLOOR = 0.02;         // gap left beneath the model, fraction of frame

    function placeCamera() {
        var aim = fitCentre.clone();
        aim.y += aimLift;
        camera.position.copy(VIEW_DIR).multiplyScalar(fitDistance).add(aim);
        camera.near = Math.max(0.01, fitDistance - fitRadius * 4);
        camera.far = fitDistance + fitRadius * 4;
        camera.lookAt(aim);
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
    }

    /* Clip-space bounds of the swept volume at the current camera. */
    function projectSweep() {
        var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (var i = 0; i < sweptPoints.length; i++) {
            scratch.copy(sweptPoints[i]).project(camera);
            if (scratch.x < minX) minX = scratch.x;
            if (scratch.x > maxX) maxX = scratch.x;
            if (scratch.y < minY) minY = scratch.y;
            if (scratch.y > maxY) maxY = scratch.y;
        }
        return { minX: minX, maxX: maxX, minY: minY, maxY: maxY };
    }

    /*
     * Solve distance and vertical placement by projecting the swept volume and
     * measuring it in clip space, which needs no frame to have been rendered.
     * That matters: requestAnimationFrame does not run while a tab is hidden,
     * so a fit deferred to the render loop can be skipped entirely and leave
     * the model framed against a container that has no size yet.
     *
     * Clip space spans two units on both axes whatever the aspect ratio, so the
     * two directions are directly comparable and neither can crop the model.
     */
    function frameCamera() {
        if (!camera || !sweptPoints.length || !VIEW_DIR || !scratch) return;
        if (!fitDistance) fitDistance = fitRadius * 4;

        for (var pass = 0; pass < 6; pass++) {
            placeCamera();
            var box = projectSweep();
            var wide = box.maxX - box.minX, tall = box.maxY - box.minY;
            if (!(wide > 0) || !(tall > 0)) return;
            fitDistance *= Math.max(wide, tall) / (2 * FILL);

            placeCamera();
            box = projectSweep();
            // Clip-space -1 is the bottom edge; stand the model just above it.
            var want = -1 + 2 * FLOOR + (box.maxY - box.minY) / 2;
            var have = (box.minY + box.maxY) / 2;
            // Raising the camera lowers the model, and one clip unit is
            // fitDistance * tan(vFov/2) of world at the aim point.
            aimLift += (have - want) * fitDistance *
                       Math.tan((camera.fov * Math.PI / 180) / 2);
        }
        placeCamera();
    }

    /* Bounds of the posed model, in the model own local space.

       Box3.setFromObject reads geometry bounding boxes, and for a skinned mesh
       those describe the bind pose, not where the clip has actually put the
       limbs. Framing against them put the robot's feet on the floor of the
       frame and its body out through the top, because the posed model is
       taller than the box that was being measured.

       getVertexPosition applies the bone transforms, so it reports the truth,
       but running it over every vertex of a 21 MB model costs seconds and
       stalls the loop. Vertices are sampled instead: a bounding box only needs
       the extremes, and the margin added by the caller covers a missed one.  */
    var VERTEX_BUDGET = 24000;

    function eachPosedVertex(THREE, root, visit, modelLocal) {
        var v = new THREE.Vector3();
        root.updateMatrixWorld(true);
        // The model carries a uniform scale, so local and world units differ by
        // that factor. Mixing them silently mis-sizes the fit, which is what
        // made the camera zoom past the model and crop it.
        var toLocal = modelLocal
            ? new THREE.Matrix4().copy(root.matrixWorld).invert()
            : null;

        root.traverse(function (node) {
            var geom = node.geometry;
            var pos = geom && geom.getAttribute && geom.getAttribute("position");
            if (!pos) return;

            var emit = function (index) {
                node.getVertexPosition(index, v);
                v.applyMatrix4(node.matrixWorld);
                if (toLocal) v.applyMatrix4(toLocal);
                visit(v);
            };

            if (node.isSkinnedMesh && node.getVertexPosition) {
                var step = Math.max(1, Math.ceil(pos.count / VERTEX_BUDGET));
                for (var i = 0; i < pos.count; i += step) emit(i);
                // The last vertex is often an extreme; a stride can step past it.
                emit(pos.count - 1);
            } else if (node.isMesh) {
                if (!geom.boundingBox) geom.computeBoundingBox();
                var b = geom.boundingBox.clone().applyMatrix4(node.matrixWorld);
                if (toLocal) b.applyMatrix4(toLocal);
                [b.min, b.max].forEach(function (corner) { visit(corner); });
            }
        });
    }

    function posedBox(THREE, root, modelLocal) {
        var box = new THREE.Box3().makeEmpty();
        eachPosedVertex(THREE, root, function (point) { box.expandByPoint(point); }, modelLocal);
        return box.isEmpty() ? null : box;
    }

    /* How far the posed model reaches from the turntable axis, at each height.

       Returns bands from the model's base to its top, each carrying the largest
       radius found within it. Rotating about Y sweeps each band into a ring, so
       a fit to the whole stack cannot crop at any angle while still following
       the model's actual shape. */
    function radialProfile(THREE, root, bands) {
        var v = new THREE.Vector3();
        var axis = root.position;
        var low = Infinity, high = -Infinity;
        var samples = [];

        eachPosedVertex(THREE, root, function (point) {
            var y = point.y;
            if (y < low) low = y;
            if (y > high) high = y;
            samples.push(y, Math.hypot(point.x - axis.x, point.z - axis.z));
        });

        if (!samples.length || !(high > low)) return null;

        var radii = new Array(bands).fill(0);
        var span = high - low;
        for (var i = 0; i < samples.length; i += 2) {
            var index = Math.min(bands - 1, Math.floor(((samples[i] - low) / span) * bands));
            if (samples[i + 1] > radii[index]) radii[index] = samples[i + 1];
        }

        // Each band is widened to its neighbours' radius as well. A band edge
        // that falls mid-limb would otherwise clip the part of the limb that
        // reaches past it.
        var out = [], maxRadius = 0;
        for (var b = 0; b < bands; b++) {
            var r = Math.max(radii[b],
                             b > 0 ? radii[b - 1] : 0,
                             b < bands - 1 ? radii[b + 1] : 0);
            if (r > maxRadius) maxRadius = r;
            out.push({ low: low + (b / bands) * span,
                       high: low + ((b + 1) / bands) * span,
                       radius: r });
        }
        return { bands: out, top: high, bottom: low, maxRadius: maxRadius };
    }

    /* Put the posed model on its own rotation axis and measure what it sweeps.

       The turntable spins the model about its local origin. That origin came
       from the bind-pose centre, so the posed robot sat off-axis and swung
       round a circle as it turned; with the camera looking down on it, that
       showed as the model bobbing vertically. Shifting the children rather than
       the model keeps the origin where the camera aims.  */
    function recentreOnPose(THREE) {
        if (!model) return;

        // Step one, in the model's own space: move the content onto the origin
        // the turntable spins about, by shifting the children rather than the
        // model, so the origin stays where the camera aims.
        var local = posedBox(THREE, model, true);
        if (!local) return;
        var centre = local.getCenter(new THREE.Vector3());
        model.children.forEach(function (child) { child.position.sub(centre); });
        model.updateMatrixWorld(true);

        // Step two, in world space: the swept points are projected through the
        // camera, so they have to be world coordinates.
        //
        // The bound is a stack of rings, not one cylinder. A single cylinder has
        // to take the model's widest radius, which is the body, and apply it at
        // every height including the feet. With the camera looking down, the
        // front rim of that oversized bottom ring projects well below where the
        // feet actually are, so the frame reserved room under the robot that
        // nothing ever occupied. Measuring the radius at each height instead
        // narrows the bound where the model is narrow.
        var BANDS = 16, SPOKES = 16, POSE_MARGIN = 1.06;
        var profile = radialProfile(THREE, model, BANDS);
        if (!profile) return;

        var axis = model.position;
        sweptPoints = [];
        for (var b = 0; b < profile.bands.length; b++) {
            var band = profile.bands[b];
            if (!(band.radius > 0)) continue;
            // Margin covers the poses this fit was not taken against: the clips
            // move the legs, and a walk cycle reaches further than the pose
            // measured at load. Cheaper than refitting on every pose change,
            // which would make the model visibly rescale as it walked.
            var r = band.radius * POSE_MARGIN;
            var lo = axis.y + (band.low - axis.y) * POSE_MARGIN;
            var hi = axis.y + (band.high - axis.y) * POSE_MARGIN;
            for (var k = 0; k < SPOKES; k++) {
                var a = (k / SPOKES) * Math.PI * 2;
                var x = axis.x + Math.cos(a) * r, z = axis.z + Math.sin(a) * r;
                sweptPoints.push(new THREE.Vector3(x, lo, z));
                sweptPoints.push(new THREE.Vector3(x, hi, z));
            }
        }
        if (!sweptPoints.length) return;

        var top = axis.y + (profile.top - axis.y) * POSE_MARGIN;
        var bottom = axis.y + (profile.bottom - axis.y) * POSE_MARGIN;
        fitCentre = new THREE.Vector3(axis.x, (top + bottom) / 2, axis.z);
        fitRadius = Math.hypot(profile.maxRadius * POSE_MARGIN, (top - bottom) / 2);
        fitDistance = 0;
        aimLift = 0;
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
        var width = stageEl.clientWidth || 480;
        var height = stageEl.clientHeight || 360;
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
                /** Clip-space box of the swept volume; -1 to 1 is the frame. */
                fitReport: function (aspect) {
                    if (aspect) { camera.aspect = aspect; frameCamera(); }
                    return projectSweep();
                },
                /** Preview one of the baked clips. Pauses live mirroring. */
                preview: function (name) {
                    if (!clips[name]) return false;
                    previewing = true;
                    mirroring = false;
                    play(name, 0.25);
                    setBadge("Previewing pose", false);
                    return true;
                },
                /** Hand the model back to live robot state. */
                live: function () {
                    previewing = false;
                    pollJoints();
                },
                isPreviewing: function () { return previewing; },
                /** Move the canvas into another element, e.g. the overlay. */
                mount: function (el) {
                    if (!el || el === stageEl) return;
                    el.appendChild(canvas);
                    stageEl = el;
                    size();
                },
                /** Put the canvas back in the hero band. */
                unmount: function () {
                    if (stageEl === host) return;
                    host.appendChild(canvas);
                    stageEl = host;
                    size();
                },
                /** Turn the model by hand; used by drag-to-rotate. */
                turn: function (delta) { if (model) model.rotation.y += delta; },
                setSpin: function (on) { spinning = !!on; },
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
            scratch = new THREE.Vector3();
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
            setupViewer();

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
        if (model && !mirroring && spinning) model.rotation.y += 0.0016;
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
