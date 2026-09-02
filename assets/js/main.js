/* WorldSculpt project page — UI behaviours (no dependencies) */
(function () {
  "use strict";

  /* ---------- scroll reveal ---------- */
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
  );
  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

  /* ---------- animated counters ---------- */
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const cio = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        cio.unobserve(e.target);
        const el = e.target;
        const target = parseFloat(el.dataset.count);
        const dur = 1400;
        const t0 = performance.now();
        (function tick(now) {
          const p = Math.min(1, (now - t0) / dur);
          const v = Math.round(target * easeOut(p));
          el.textContent = v.toLocaleString("en-US");
          if (p < 1) requestAnimationFrame(tick);
        })(t0);
      }
    },
    { threshold: 0.5 }
  );
  document.querySelectorAll("[data-count]").forEach((el) => cio.observe(el));

  /* ---------- comparison tabs ---------- */
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      const pane = document.getElementById(btn.dataset.tab);
      if (pane) {
        pane.classList.add("active");
        pane.querySelectorAll(".reveal").forEach((el) => el.classList.add("in"));
      }
    });
  });

  /* ---------- hero video-marquee background ---------- */
  const heroBg = document.getElementById("hero-bg");
  if (heroBg && window.WS_CONFIG && window.WS_CONFIG.heroRows) {
    const allVids = [];
    for (const row of window.WS_CONFIG.heroRows) {
      const rowEl = document.createElement("div");
      rowEl.className = "marquee-row";
      rowEl.dataset.dir = row.dir || "left";
      if (row.dur) rowEl.style.setProperty("--dur", row.dur + "s");
      const track = document.createElement("div");
      track.className = "marquee-track";
      // duplicate the clip set once for a seamless -50% translate loop
      for (const src of row.clips.concat(row.clips)) {
        const v = document.createElement("video");
        v.src = src;
        v.muted = true;
        v.loop = true;
        v.playsInline = true;
        v.autoplay = true;
        v.preload = "auto";
        v.addEventListener("error", () => { v.remove(); }, { once: true });
        track.appendChild(v);
        allVids.push(v);
      }
      rowEl.appendChild(track);
      heroBg.appendChild(rowEl);
    }
    // play only while the hero is on screen (saves CPU/battery)
    const vio = new IntersectionObserver((entries) => {
      const on = entries.some((e) => e.isIntersecting);
      for (const v of allVids) {
        if (on) { v.play().catch(() => {}); }
        else v.pause();
      }
      heroBg.querySelectorAll(".marquee-track").forEach((t) => {
        t.style.animationPlayState = on ? "running" : "paused";
      });
    }, { threshold: 0.02 });
    vio.observe(heroBg);
  }

  /* ---------- bibtex copy ---------- */
  const copyBtn = document.getElementById("copy-bib");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const txt = document.getElementById("bib-text").textContent;
      try {
        await navigator.clipboard.writeText(txt);
      } catch (_) {
        const ta = document.createElement("textarea");
        ta.value = txt;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      const span = copyBtn.querySelector("span");
      span.textContent = "Copied!";
      setTimeout(() => (span.textContent = "Copy"), 1600);
    });
  }
})();
