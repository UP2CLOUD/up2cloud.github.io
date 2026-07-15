/*
  UP2CLOUD hero — real-3D cloud operations core.

  Resurrects the hero's ".hero-3d-orbit" element (a CSS cube whose base styles
  were lost, leaving faint unstyled text fragments) as a proper WebGL scene:
  one tumbling capability cube (AWS / GCP / Azure / K8s / IaC / FinOps faces,
  the same real capability labels the markup always carried), two tilted dashed
  orbit rings echoing the original CSS design, and three satellite dots in the
  brand accents (sky = cloud, violet = platform, orange = FinOps).

  Progressive enhancement only:
  - Three.js is imported lazily from unpkg (pinned) — both the meta CSP and
    _headers already whitelist unpkg for script-src. No bundler, no build step.
  - Desktop only (matches the mount's existing `hidden lg:block`), never under
    prefers-reduced-motion (no module fetch at all), and any failure —
    import error, WebGL init throw, later context loss — silently removes the
    canvas and leaves the existing CSS hero exactly as it is today.
  - The render loop pauses (setAnimationLoop(null)) whenever the hero scrolls
    out of view instead of tearing the context down: destroying/recreating a
    WebGL context on scroll churn is how the sister portfolio site's hero
    broke, so the context here stays alive and idle-cheap for the visit.
*/
(function () {
  "use strict";

  var mount = document.querySelector(".hero-3d-orbit");
  var hero = document.getElementById("hero");
  if (!mount || !hero) return;

  // Never for reduced-motion visitors (and never fetch the chunk), never on
  // small viewports — same gate as the mount's `hidden lg:block` class, so we
  // never pay for a scene that CSS is hiding anyway.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (!window.matchMedia("(min-width: 1024px)").matches) return;

  var THREE_URL = "https://unpkg.com/three@0.170.0/build/three.module.js";

  var SKY = 0x38bdf8;
  var VIOLET = 0xc084fc;
  var ORANGE = 0xf97316;

  // One capability label per cube face — the same six the markup always
  // declared, only capitalization and content preserved (no invented copy).
  var FACES = ["AWS", "GCP", "Azure", "K8s", "IaC", "FinOps"];
  // FinOps face carries the orange accent (brand rule: orange = cost);
  // everything else stays in the sky/violet family.
  var FACE_ACCENTS = ["#38bdf8", "#c084fc", "#38bdf8", "#c084fc", "#38bdf8", "#f97316"];

  function faceTexture(THREE, label, accent) {
    var size = 256;
    var c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    var ctx = c.getContext("2d");

    // Dark glassy face with a soft top-left sheen, echoing the site's
    // glass-card language.
    var bg = ctx.createLinearGradient(0, 0, size, size);
    bg.addColorStop(0, "#101a30");
    bg.addColorStop(0.55, "#0b1426");
    bg.addColorStop(1, "#131f3a");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size, size);

    var sheen = ctx.createRadialGradient(size * 0.28, size * 0.2, 8, size * 0.28, size * 0.2, size * 0.72);
    sheen.addColorStop(0, "rgba(56,189,248,0.20)");
    sheen.addColorStop(1, "rgba(56,189,248,0)");
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, size, size);

    // Inset border frame — reads as a mounted panel, not a sticker.
    ctx.strokeStyle = accent + "88";
    ctx.lineWidth = 5;
    ctx.strokeRect(10, 10, size - 20, size - 20);

    // Label, with a soft glow pass beneath the crisp pass.
    ctx.font = "700 64px 'Space Grotesk', 'DM Sans', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = accent;
    ctx.shadowBlur = 26;
    ctx.fillStyle = accent;
    ctx.fillText(label, size / 2, size / 2 + 4);
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(255,255,255,0.96)";
    ctx.fillText(label, size / 2, size / 2 + 4);

    var tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  function dashedRing(THREE, radius, color, dashSize, gapSize) {
    var pts = [];
    var SEGMENTS = 128;
    for (var i = 0; i <= SEGMENTS; i++) {
      var a = (i / SEGMENTS) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
    }
    var geo = new THREE.BufferGeometry().setFromPoints(pts);
    var mat = new THREE.LineDashedMaterial({
      color: color,
      dashSize: dashSize,
      gapSize: gapSize,
      transparent: true,
      opacity: 0.7,
    });
    var ring = new THREE.Line(geo, mat);
    ring.computeLineDistances();
    return ring;
  }

  function init(THREE) {
    var renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
    } catch (e) {
      return; // no WebGL — the CSS hero stands on its own
    }

    // DPR clamp: this is a decorative background layer; 1.75 is visually
    // indistinguishable from native DPR here and meaningfully cheaper on
    // 2x/3x displays.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));

    var canvas = renderer.domElement;
    canvas.style.position = "absolute";
    canvas.style.inset = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.opacity = "0";
    canvas.style.transition = "opacity 1.2s ease";
    canvas.setAttribute("aria-hidden", "true");
    mount.appendChild(canvas);

    var dead = false;
    canvas.addEventListener(
      "webglcontextlost",
      function (e) {
        e.preventDefault();
        dead = true;
        renderer.setAnimationLoop(null);
        canvas.remove(); // degrade to the plain CSS hero, permanently this visit
      },
      { once: true }
    );

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(38, 1, 0.1, 60);
    // Pulled back far enough that the outer ring (Ø 5.8 units) fits the
    // frustum with margin (visible height ≈ 6.4 units at z 9.4) — at the
    // original 7.2 the rings cropped at the canvas edges and the whole
    // scene read as a fragment. Slightly elevated for a gentle top-down
    // ellipse on the rings.
    camera.position.set(0, 1.1, 9.4);
    camera.lookAt(0, 0, 0);

    // Real lighting is the point of the upgrade: ambient fill + a keylight for
    // shading and a sky rim from behind-left so cube edges separate from the
    // dark hero gradient. No postprocessing — plain and cheap.
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    var key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(3.5, 4, 4.5);
    scene.add(key);
    var rim = new THREE.DirectionalLight(SKY, 1.4);
    rim.position.set(-4, 1.5, -3);
    scene.add(rim);

    var group = new THREE.Group();
    scene.add(group);

    // ── The capability cube ─────────────────────────────────────────────
    var materials = FACES.map(function (label, i) {
      var tex = faceTexture(THREE, label, FACE_ACCENTS[i]);
      return new THREE.MeshStandardMaterial({
        map: tex,
        emissiveMap: tex,
        emissive: 0xffffff,
        // High enough to punch through the hero's translucent decoration
        // layers sitting above this canvas — at lower values the cube read
        // as a ghost behind them.
        emissiveIntensity: 0.85,
        metalness: 0.35,
        roughness: 0.42,
      });
    });
    var cube = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.7, 1.7), materials);
    group.add(cube);

    // Sky edge glow on the cube — the "lights on" line that separates it from
    // the void, same job the rim light does on the sister site's blocks.
    var edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(cube.geometry),
      new THREE.LineBasicMaterial({ color: SKY, transparent: true, opacity: 0.9 })
    );
    cube.add(edges);

    // ── Orbit rings + satellites ────────────────────────────────────────
    var ringOuter = dashedRing(THREE, 2.9, SKY, 0.22, 0.16);
    var ringInner = dashedRing(THREE, 2.15, VIOLET, 0.16, 0.13);
    // Tilt echoes the original CSS rings' rotateX(68deg) perspective.
    ringOuter.rotation.x = THREE.MathUtils.degToRad(-16);
    ringInner.rotation.x = THREE.MathUtils.degToRad(-24);
    ringInner.rotation.z = THREE.MathUtils.degToRad(9);
    group.add(ringOuter, ringInner);

    var satColors = [SKY, VIOLET, ORANGE];
    var sats = satColors.map(function (color, i) {
      var s = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 16, 16),
        new THREE.MeshBasicMaterial({ color: color })
      );
      s.userData.ring = i === 1 ? ringInner : ringOuter;
      s.userData.radius = i === 1 ? 2.15 : 2.9;
      s.userData.phase = (i / satColors.length) * Math.PI * 2;
      s.userData.speed = i === 1 ? -0.34 : 0.22;
      s.userData.ring.add(s);
      return s;
    });

    // ── Sizing ──────────────────────────────────────────────────────────
    function resize() {
      var w = mount.clientWidth || 1;
      var h = mount.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    resize();
    var ro = new ResizeObserver(resize);
    ro.observe(mount);

    // ── Pointer parallax (eased, hero-wide) ─────────────────────────────
    var targetRX = 0;
    var targetRY = 0;
    hero.addEventListener("pointermove", function (e) {
      var r = hero.getBoundingClientRect();
      var nx = (e.clientX - r.left) / r.width - 0.5;  // -0.5 .. 0.5
      var ny = (e.clientY - r.top) / r.height - 0.5;
      targetRY = nx * 0.28;
      targetRX = ny * 0.18;
    });
    hero.addEventListener("pointerleave", function () {
      targetRX = 0;
      targetRY = 0;
    });

    // ── Entrance + frame loop ───────────────────────────────────────────
    // Entrance: the whole group scales 0.82→1 and the canvas fades in over
    // ~1.1s on first render — one quiet orchestrated beat, no blocking, the
    // H1/CTAs are visible from first paint regardless.
    var born = -1;
    var clockLast = 0;

    function frame(tMs) {
      if (dead) return;
      var t = tMs / 1000;
      var dt = clockLast ? Math.min(t - clockLast, 0.05) : 0.016;
      clockLast = t;

      if (born < 0) {
        born = t;
        canvas.style.opacity = "0.95";
      }
      var lifeIn = Math.min((t - born) / 1.1, 1);
      var easeIn = 1 - Math.pow(1 - lifeIn, 3);
      group.scale.setScalar(0.82 + 0.18 * easeIn);

      // Slow tumble so every capability face gets its moment; float bob keeps
      // the settled scene alive at a whisper.
      cube.rotation.y += dt * 0.32;
      cube.rotation.x = Math.sin(t * 0.23) * 0.28;
      cube.position.y = Math.sin(t * 0.7) * 0.08;

      ringOuter.rotation.y += dt * 0.1;
      ringInner.rotation.y -= dt * 0.14;

      sats.forEach(function (s) {
        s.userData.phase += dt * s.userData.speed;
        s.position.set(
          Math.cos(s.userData.phase) * s.userData.radius,
          0,
          Math.sin(s.userData.phase) * s.userData.radius
        );
      });

      // Eased parallax on the whole group.
      group.rotation.y += (targetRY - group.rotation.y) * Math.min(dt * 4, 1);
      group.rotation.x += (targetRX - group.rotation.x) * Math.min(dt * 4, 1);

      renderer.render(scene, camera);
    }

    // Pause the loop when the hero scrolls out of view — context stays alive
    // (see file header for why this must NOT be a teardown), work drops to 0.
    var running = false;
    function setRunning(on) {
      if (dead || on === running) return;
      running = on;
      renderer.setAnimationLoop(on ? frame : null);
      if (!on) clockLast = 0; // avoid a giant dt on resume
    }
    var io = new IntersectionObserver(
      function (entries) {
        setRunning(entries[0].isIntersecting);
      },
      { rootMargin: "160px 0px 160px 0px" }
    );
    io.observe(hero);
    setRunning(true);
  }

  function boot() {
    import(THREE_URL)
      .then(function (THREE) {
        // Draw face labels only after webfonts settle so 'Space Grotesk'
        // actually reaches the canvas textures.
        var ready = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
        return ready.then(function () {
          init(THREE);
        });
      })
      .catch(function () {
        /* decorative: any failure leaves the CSS hero untouched */
      });
  }

  // Defer the ~150KB module fetch out of the critical path.
  if ("requestIdleCallback" in window) {
    requestIdleCallback(boot, { timeout: 2500 });
  } else {
    setTimeout(boot, 900);
  }
})();
