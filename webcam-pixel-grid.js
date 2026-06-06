/**
 * webcam-pixel-grid.js — WALLEXA
 * Animated pixel grid background for the WallexAI page.
 * Works WITHOUT webcam — pure canvas wave animation as default.
 * Upgrades to live webcam if permission is granted.
 */
(function () {
  "use strict";

  var canvas, ctx, animId, running = false, t = 0;
  var video = null, offscreen, offCtx;
  var W = 0, H = 0;

  var COLS = 30, ROWS = 18;
  var COLOR = [184, 131, 122]; // WALLEXA mauve
  var BG    = "rgba(10,8,6,1)";
  var GAP   = 0.3;

  /* ── resize ── */
  function resize() {
    if (!canvas) return;
    W = canvas.offsetWidth  || window.innerWidth;
    H = canvas.offsetHeight || window.innerHeight;
    canvas.width  = W;
    canvas.height = H;
  }

  /* ── wave fallback render ── */
  function drawWave() {
    ctx.clearRect(0, 0, W, H);

    var depth = Math.min(1, Math.max(0, H / 900));
    var horizon = H * (0.26 + depth * 0.04);
    var dw = W / COLS;
    var dh = (H - horizon) / ROWS;
    var cellSize = Math.min(dw, dh) * (1 - GAP);

    for (var row = 0; row < ROWS; row++) {
      for (var col = 0; col < COLS; col++) {
        var cx = col * dw + dw / 2;
        var rowNorm = row / Math.max(1, ROWS - 1);
        var perspective = 0.58 + rowNorm * 0.72;
        var cy = horizon + Math.pow(rowNorm, 1.35) * (H - horizon) + dh / 2;

        // layered sine waves for organic feel
        var wave1 = Math.sin(t * 1.1 + col * 0.28 + row * 0.18);
        var wave2 = Math.sin(t * 0.7 + col * 0.15 - row * 0.22 + 1.5);
        var wave3 = Math.sin(t * 1.6 - col * 0.10 + row * 0.30 + 3.0);
        var combined = (wave1 + wave2 * 0.6 + wave3 * 0.4) / 2.0; // -1..1
        var norm = combined * 0.5 + 0.5; // 0..1

        // pulse from center
        var distX = (col / COLS) - 0.5;
        var distY = (row / ROWS) - 0.5;
        var dist  = Math.sqrt(distX * distX + distY * distY);
        var pulse = Math.sin(t * 1.8 - dist * 6.0) * 0.5 + 0.5;

        var v = norm * 0.65 + pulse * 0.35;

        var alpha  = 0.025 + v * 0.3;
        var scale  = 0.24  + v * 0.56;
        var hw     = (cellSize * scale * perspective) / 2;
        var r      = hw * 0.3;

        var red   = COLOR[0];
        var green = COLOR[1];
        var blue  = COLOR[2];

        // add slight hue shift on high values
        if (v > 0.7) {
          red   = Math.min(255, red   + (v - 0.7) * 120);
          green = Math.min(255, green + (v - 0.7) *  60);
        }

        ctx.beginPath();
        ctx.roundRect(cx - hw, cy - hw, hw * 2, hw * 2, r);
        ctx.fillStyle = "rgba(" + (red|0) + "," + (green|0) + "," + (blue|0) + "," + alpha.toFixed(3) + ")";
        ctx.fill();
      }
    }
  }

  /* ── webcam render ── */
  function drawWebcam() {
    if (!video || video.readyState < 2) { drawWave(); return; }

    offscreen.width  = COLS * 4;
    offscreen.height = ROWS  * 4;
    offCtx.save();
    offCtx.translate(offscreen.width, 0);
    offCtx.scale(-1, 1);
    offCtx.drawImage(video, 0, 0, offscreen.width, offscreen.height);
    offCtx.restore();

    var imgData = offCtx.getImageData(0, 0, offscreen.width, offscreen.height);
    var cellW = offscreen.width  / COLS;
    var cellH = offscreen.height / ROWS;
    var horizon = H * 0.26;
    var dw = W / COLS, dh = (H - horizon) / ROWS;

    ctx.clearRect(0, 0, W, H);

    for (var row = 0; row < ROWS; row++) {
      for (var col = 0; col < COLS; col++) {
        var x0 = Math.floor(col * cellW), y0 = Math.floor(row * cellH);
        var x1 = Math.min(x0 + Math.ceil(cellW), offscreen.width  - 1);
        var y1 = Math.min(y0 + Math.ceil(cellH), offscreen.height - 1);
        var r = 0, g = 0, b = 0, n = 0;
        for (var y = y0; y < y1; y += 2) {
          for (var x = x0; x < x1; x += 2) {
            var i = (y * offscreen.width + x) * 4;
            r += imgData.data[i]; g += imgData.data[i+1]; b += imgData.data[i+2]; n++;
          }
        }
        if (!n) continue;
        r = r/n * 0.5; g = g/n * 0.5; b = b/n * 0.5;

        var brightness = (r + g + b) / 765;
        var alpha = 0.08 + brightness * 0.38;
        var scale = 0.3  + brightness * 0.46;
        var rowNorm = row / Math.max(1, ROWS - 1);
        var perspective = 0.58 + rowNorm * 0.72;
        var hw    = (Math.min(W/COLS, (H-horizon)/ROWS) * (1-GAP) * scale * perspective) / 2;
        var cx    = col * dw + dw / 2;
        var cy    = horizon + Math.pow(rowNorm, 1.35) * (H - horizon) + dh / 2;

        ctx.beginPath();
        ctx.roundRect(cx - hw, cy - hw, hw * 2, hw * 2, hw * 0.3);
        ctx.fillStyle = "rgba(" + (r|0) + "," + (g|0) + "," + (b|0) + "," + alpha.toFixed(3) + ")";
        ctx.fill();
      }
    }
  }

  /* ── main loop ── */
  function loop() {
    if (!running) return;
    animId = requestAnimationFrame(loop);
    t += 0.022;
    if (video && video.readyState >= 2) drawWebcam();
    else drawWave();
  }

  /* ── start webcam (optional upgrade) ── */
  function tryWebcam() {
    if (!navigator.mediaDevices) return;
    navigator.mediaDevices.getUserMedia({ video: { width:320, height:240 }, audio: false })
      .then(function(stream) {
        video = document.createElement("video");
        video.srcObject = stream; video.playsInline = true; video.muted = true;
        video.play();
        offscreen = document.createElement("canvas");
        offCtx    = offscreen.getContext("2d");
      })
      .catch(function() { /* no webcam — wave animation continues */ });
  }

  /* ── inject canvas into the WallexAI page ── */
  function inject() {
    var page = document.getElementById("page-wallexai");
    if (!page) return false;

    var old = page.querySelector(".wxa-pixel-canvas");
    if (old) old.remove();

    canvas = document.createElement("canvas");
    canvas.className = "wxa-pixel-canvas";
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.cssText = [
      "position:absolute",
      "inset:0",
      "width:100%",
      "height:100%",
      "z-index:0",
      "pointer-events:none",
      "display:block"
    ].join(";");

    page.insertBefore(canvas, page.firstChild);
    ctx = canvas.getContext("2d");
    resize();
    return true;
  }

  /* ── public start ── */
  function start() {
    if (running) return;
    if (!inject()) return;
    running = true;
    loop();
    tryWebcam();
  }

  /* ── public stop ── */
  function stop() {
    running = false;
    if (animId) { cancelAnimationFrame(animId); animId = null; }
    if (video && video.srcObject) {
      video.srcObject.getTracks().forEach(function(t){ t.stop(); });
      video = null;
    }
  }

  /* ── watch for WallexAI page becoming active ── */
  function watch() {
    var page = document.getElementById("page-wallexai");
    if (!page) {
      document.addEventListener("DOMContentLoaded", watch);
      return;
    }

    // already active on load?
    if (page.classList.contains("active")) start();

    new MutationObserver(function() {
      if (page.classList.contains("active")) {
        if (!running) start();
      } else {
        stop();
        var c = page.querySelector(".wxa-pixel-canvas");
        if (c) c.remove();
        canvas = null; ctx = null;
      }
    }).observe(page, { attributes: true, attributeFilter: ["class"] });
  }

  window.addEventListener("resize", function(){ if (canvas) resize(); });
  watch();

  window.WALLEXA_PIXEL_BG = { start: start, stop: stop };
})();
