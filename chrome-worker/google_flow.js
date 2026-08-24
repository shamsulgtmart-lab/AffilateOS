/* global chrome */
// ===========================================================================
// AffiliateOS Worker — Google Flow content script (Phase 2, diagnostic build)
// Injected into the Google Flow tab by the background worker on demand.
//
// DIAGNOSTIC + STRICT verification. FLOW_GENERATED is emitted ONLY after:
//   1. The Generate click caused a real state change (processing state began).
//   2. That processing state finished.
//   3. A NEW <video> exists whose src/currentSrc was NOT present before Generate.
//   4. That video is FULLY loaded: readyState >= 4 (HAVE_ENOUGH_DATA) AND a
//      finite duration > 0 AND a durable src scheme (http(s) or blob:).
// A new <video>, a blob: URL, readyState >= 1, a poster, or an
// export/download/share button appearing is NEVER sufficient by itself.
//
// Regardless of pass/fail, a FULL diagnostic is captured and returned so the
// exact DOM evidence from the real browser run can be inspected in Admin.
//
// Responds to { type: "AFFILIATEOS_FLOW_RUN", action, ... }.
// ===========================================================================
if (!window.__affiliateosFlowInjected) {
  window.__affiliateosFlowInjected = true;
  window.__affiliateosDebug = { steps: [] };

  function dbg(entry) {
    try { window.__affiliateosDebug.steps.push({ t: Date.now(), ...entry }); } catch {}
  }
  function nowIso() { try { return new Date().toISOString(); } catch { return ""; } }
  function visible(el) {
    try { return !!(el && el.getClientRects && el.getClientRects().length); }
    catch { return false; }
  }

  function snapshot() {
    const inputs = Array.from(document.querySelectorAll(
      'textarea, input[type="text"], input[type="search"], [contenteditable="true"], [role="textbox"]'
    )).map((el, i) => ({
      i, tag: el.tagName.toLowerCase(),
      placeholder: (el.getAttribute("placeholder") || "").trim(),
      ariaLabel: (el.getAttribute("aria-label") || "").trim(),
      text: ((el.innerText || el.value || "") + "").trim().slice(0, 120),
      visible: visible(el),
    }));
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
      .map((el, i) => ({
        i, text: ((el.innerText || el.getAttribute("aria-label") || "") + "").trim().slice(0, 80),
        disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
        visible: visible(el),
      }))
      .filter((b) => b.text && b.visible);
    const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
      .map((h) => (h.innerText || "").trim().slice(0, 120)).filter(Boolean);
    const bodyText = document.body ? (document.body.innerText || "") : "";
    const needsLogin = /sign\s*in|log\s*in|use your google account|choose an account|sign in with google/i.test(bodyText);
    return {
      url: location.href, title: document.title, readyState: document.readyState,
      needsLogin, videoCount: document.querySelectorAll("video").length,
      headings: headings.slice(0, 20), inputs: inputs.slice(0, 25),
      buttons: buttons.slice(0, 40), bodyExcerpt: bodyText.slice(0, 600),
    };
  }

  function findPromptInput() {
    const hints = /prompt|describe|video|idea|create|make|enter|type|imagine|scene|story|what|tell|generate/i;
    let fallback = null;
    for (const el of document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"], input[type="text"]')) {
      if (!visible(el)) continue;
      const ph = (el.getAttribute("placeholder") || "") + " " + (el.getAttribute("aria-label") || "");
      if (hints.test(ph)) return el;
      if (!fallback) fallback = el;
    }
    return fallback;
  }

  function findGenerateButton() {
    const strong = /^(generate|create|make|build|render|produce|run|start|go|submit|send)$/i;
    const weak = /generate|create|make|build|render|produce video|make video|create video/i;
    let fallback = null;
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      if (!visible(el)) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      const t = (el.innerText || el.getAttribute("aria-label") || "").trim();
      if (!t) continue;
      if (strong.test(t)) return el;
      if (weak.test(t) && !fallback) fallback = el;
    }
    return fallback;
  }

  function setText(el, text) {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      try {
        const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value");
        if (setter) setter.set.call(el, text); else el.value = text;
      } catch { el.value = text; }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      el.focus();
      el.innerText = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    }
  }

  function videoSrc(v) {
    return (v.currentSrc || v.src || v.getAttribute("src") || "").trim();
  }

  function processingSignals() {
    const sigs = [];
    const bodyText = document.body ? (document.body.innerText || "") : "";
    const kw = bodyText.match(/(generating|rendering|processing|creating|queued|in progress|in queue|working on|preparing|building|encoding|seconds?\s*(?:left|remaining)|\d{1,3}\s*%)/i);
    if (kw) sigs.push("text:" + kw[0].toLowerCase());
    for (const el of document.querySelectorAll('[role="progressbar"], [aria-busy="true"], [aria-valuenow]')) {
      if (visible(el)) { sigs.push("progressbar"); break; }
    }
    for (const el of document.querySelectorAll('[class*="spin" i], [class*="loading" i], [class*="progress" i]')) {
      if (visible(el)) { sigs.push("spinner"); break; }
    }
    const gen = findGenerateButton();
    if (gen) {
      const t = (gen.innerText || gen.getAttribute("aria-label") || "").trim().toLowerCase();
      if (gen.disabled || gen.getAttribute("aria-disabled") === "true") sigs.push("generate-disabled");
      else if (/generating|rendering|processing|creating|working/.test(t)) sigs.push("generate-label");
    }
    return Array.from(new Set(sigs));
  }

  // Broad diagnostic counts (NOT verification selectors — used only to report
  // before/after counts in the diagnostic, never to confirm a result).
  function countResultCards() {
    try {
      return document.querySelectorAll('[class*="result" i], [class*="card" i], [data-result], [role="article"], article').length;
    } catch { return 0; }
  }
  function exportButtonEls() {
    const re = /export|download|share|save|publish/i;
    return Array.from(document.querySelectorAll('button, [role="button"], a'))
      .filter((b) => re.test((b.innerText || b.getAttribute("aria-label") || "") + ""));
  }

  function captureBefore() {
    const videos = Array.from(document.querySelectorAll("video"));
    const srcs = videos.map(videoSrc).filter(Boolean);
    const currentSrcs = videos.map((v) => v.currentSrc || "").filter(Boolean);
    const gen = findGenerateButton();
    const genState = gen ? {
      text: (gen.innerText || gen.getAttribute("aria-label") || "").trim().slice(0, 80),
      disabled: gen.disabled === true || gen.getAttribute("aria-disabled") === "true",
    } : null;
    const fp = {
      timestamp: nowIso(),
      videoCount: videos.length,
      videoSrcs: srcs,
      videoCurrentSrcs: currentSrcs,
      generateButton: genState,
      processingSignals: processingSignals(),
      resultCardCount: countResultCards(),
      exportButtonCount: exportButtonEls().length,
      url: location.href,
    };
    window.__affiliateosBefore = fp;
    dbg({ step: "captureBefore", videoCount: fp.videoCount, videoSrcs: srcs.length, resultCardCount: fp.resultCardCount, exportButtonCount: fp.exportButtonCount });
    return fp;
  }

  function detectGenerationStart(maxMs) {
    return new Promise((resolve) => {
      const before = window.__affiliateosBefore || {};
      const beforeSigs = new Set(before.processingSignals || []);
      const beforeGen = before.generateButton || null;
      const start = Date.now();
      function check() {
        const sigs = processingSignals();
        const newSigs = sigs.filter((s) => !beforeSigs.has(s));
        let genChanged = false;
        const gen = findGenerateButton();
        if (gen && beforeGen) {
          const t = (gen.innerText || gen.getAttribute("aria-label") || "").trim().slice(0, 80);
          const dis = gen.disabled === true || gen.getAttribute("aria-disabled") === "true";
          if (dis !== beforeGen.disabled) genChanged = true;
          if (t !== beforeGen.text) genChanged = true;
        }
        if (newSigs.length || genChanged) {
          dbg({ step: "generationStateDetected", newSigs, genChanged, allSigs: sigs });
          return resolve({ ok: true, state: "GENERATION_STARTED", signals: newSigs, allSignals: sigs, genChanged, tStarted: nowIso() });
        }
        if (Date.now() - start > maxMs) {
          dbg({ step: "generationStateNotDetected", sigs });
          return resolve({ ok: false, state: "FLOW_GENERATION_DID_NOT_START", signals: sigs, tFailed: nowIso() });
        }
        setTimeout(check, 800);
      }
      check();
    });
  }

  function findNewResult() {
    const before = window.__affiliateosBefore;
    if (!before) return null;
    const beforeSrcs = new Set(before.videoSrcs || []);
    const beforeCurrentSrcs = new Set(before.videoCurrentSrcs || []);
    const videos = Array.from(document.querySelectorAll("video"));
    for (const v of videos) {
      const s = videoSrc(v);
      const cs = v.currentSrc || "";
      if ((s && !beforeSrcs.has(s)) || (cs && !beforeCurrentSrcs.has(cs))) {
        return { by: "new-video", src: (s || cs).slice(0, 160), countBefore: before.videoCount, countAfter: videos.length };
      }
    }
    return null;
  }

  function waitForProcessing(maxMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      function check() {
        const sigs = processingSignals();
        const nr = findNewResult();
        if (!sigs.length && nr) {
          dbg({ step: "processingFinished", newResult: nr, finishingSignals: sigs });
          return resolve({ ok: true, state: "PROCESSING_DONE", newResult: nr, finishingSignals: sigs, tFinished: nowIso() });
        }
        if (Date.now() - start > maxMs) {
          dbg({ step: "processingTimeout", sigs, newResult: nr });
          return resolve({ ok: false, state: "FLOW_GENERATION_TIMEOUT", signals: sigs, newResult: nr, tFailed: nowIso() });
        }
        setTimeout(check, 1500);
      }
      check();
    });
  }

  // Full evidence for a single element — exactly what the admin diagnostic needs
  // to identify the DOM node that caused (or failed) verification.
  function describeElement(el) {
    if (!el) return null;
    let rect = {};
    try {
      const r = el.getBoundingClientRect();
      rect = { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, left: r.left, bottom: r.bottom, right: r.right };
    } catch {}
    return {
      tag: (el.tagName || "").toLowerCase(),
      id: el.id || "",
      className: (typeof el.className === "string" ? el.className : "").slice(0, 300),
      textContent: ((el.innerText || el.textContent || "") + "").trim().slice(0, 300),
      href: el.getAttribute ? (el.getAttribute("href") || "") : "",
      src: el.getAttribute ? (el.getAttribute("src") || "") : "",
      currentSrc: el.currentSrc || "",
      poster: el.getAttribute ? (el.getAttribute("poster") || "") : "",
      duration: (typeof el.duration === "number" && isFinite(el.duration)) ? el.duration : null,
      readyState: (typeof el.readyState === "number") ? el.readyState : null,
      networkState: (typeof el.networkState === "number") ? el.networkState : null,
      rect,
      outerHTML: (el.outerHTML || "").slice(0, 800),
    };
  }

  // Collect the complete before/after DOM diagnostic. Always returned with the
  // verification result so a real run can be fully inspected — pass or fail.
  function collectDiagnostic() {
    const before = window.__affiliateosBefore || null;
    const beforeSrcs = new Set(before?.videoSrcs || []);
    const beforeCurrentSrcs = new Set(before?.videoCurrentSrcs || []);
    const videos = Array.from(document.querySelectorAll("video"));
    const videoDescs = videos.map((v) => {
      const s = videoSrc(v);
      const cs = v.currentSrc || "";
      return {
        ...describeElement(v),
        srcIsNew: (!!s && !beforeSrcs.has(s)) || (!!cs && !beforeCurrentSrcs.has(cs)),
      };
    });
    return {
      timestamp: nowIso(),
      url: location.href,
      before: before ? {
        timestamp: before.timestamp,
        url: before.url,
        videoCount: before.videoCount,
        videoSrcs: before.videoSrcs,
        videoCurrentSrcs: before.videoCurrentSrcs,
        generateButton: before.generateButton,
        processingSignals: before.processingSignals,
        resultCardCount: before.resultCardCount,
        exportButtonCount: before.exportButtonCount,
      } : null,
      after: {
        videoCount: videos.length,
        videos: videoDescs,
        resultCardCount: countResultCards(),
        exportButtonCount: exportButtonEls().length,
        exportButtons: exportButtonEls().map(describeElement).slice(0, 20),
        processingSignals: processingSignals(),
      },
    };
  }

  // STRICT verification. Returns { ok, state, ... , diagnostic } always.
  function verifyResult() {
    const diag = collectDiagnostic();
    const before = window.__affiliateosBefore;
    if (!before) {
      return { ok: false, state: "FLOW_RESULT_NOT_CONFIRMED", reason: "no_before_state", diagnostic: diag };
    }
    const beforeSrcs = new Set(before.videoSrcs || []);
    const beforeCurrentSrcs = new Set(before.videoCurrentSrcs || []);
    const videos = Array.from(document.querySelectorAll("video"));
    // Candidate new videos: src OR currentSrc not present before Generate.
    const candidates = videos.filter((v) => {
      const s = videoSrc(v);
      const cs = v.currentSrc || "";
      return (!!s && !beforeSrcs.has(s)) || (!!cs && !beforeCurrentSrcs.has(cs));
    });
    // STRONG PROOF: a candidate that is fully loaded with a real duration.
    // Excludes placeholders/previews (readyState < 4 or no finite duration).
    let proven = null;
    for (const v of candidates) {
      const s = videoSrc(v);
      const durableSrc = /^(blob:|https?:)/.test(s);
      const loaded = v.readyState >= 4; // HAVE_ENOUGH_DATA
      const dur = (typeof v.duration === "number" && isFinite(v.duration) && v.duration > 0);
      if (durableSrc && loaded && dur) { proven = v; break; }
    }
    if (proven) {
      return { ok: true, state: "VERIFIED", by: "new-video", proof: describeElement(proven), diagnostic: diag };
    }
    return {
      ok: false,
      state: "FLOW_RESULT_NOT_CONFIRMED",
      reason: "no_proven_new_video",
      candidates: candidates.map(describeElement),
      diagnostic: diag,
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "AFFILIATEOS_FLOW_RUN") return false;
    const action = msg.action;
    (async () => {
      try {
        if (action === "validatePage") {
          const url = location.href;
          const title = document.title || "";
          const bodyText = document.body ? (document.body.innerText || "") : "";
          const is404 = /404|not found on this server|requested url .* was not found/i.test(title + " " + bodyText.slice(0, 400));
          const needsLogin = /sign\s*in|log\s*in|use your google account|choose an account|sign in with google/i.test(bodyText);
          return { ok: true, url, title, is404, needsLogin, bodyExcerpt: bodyText.slice(0, 300) };
        }
        if (action === "inspect") {
          return { ok: true, state: "INSPECTED", snapshot: snapshot() };
        }
        if (action === "enterPrompt") {
          const snap = snapshot();
          if (snap.needsLogin) return { ok: false, state: "NEEDS_LOGIN", snapshot: snap };
          const input = findPromptInput();
          if (!input) return { ok: false, state: "NO_PROMPT_INPUT", snapshot: snap };
          setText(input, msg.prompt || "");
          dbg({ step: "enterPrompt", length: (msg.prompt || "").length });
          return { ok: true, state: "ENTERED" };
        }
        if (action === "captureBefore") {
          return { ok: true, state: "CAPTURED", fingerprint: captureBefore() };
        }
        if (action === "clickGenerate") {
          const btn = findGenerateButton();
          if (!btn) return { ok: false, state: "NO_GENERATE_BUTTON", snapshot: snapshot() };
          dbg({ step: "clickGenerate", text: (btn.innerText || "").slice(0, 40) });
          btn.click();
          return { ok: true, state: "CLICKED" };
        }
        if (action === "detectGenerationStart") {
          return await detectGenerationStart(msg.maxWaitMs || 12000);
        }
        if (action === "waitForProcessing") {
          return await waitForProcessing(msg.maxWaitMs || 180000);
        }
        if (action === "verifyResult") {
          return verifyResult();
        }
        if (action === "collectDiagnostic") {
          return { ok: true, diagnostic: collectDiagnostic() };
        }
        if (action === "getDebug") {
          return { ok: true, debug: window.__affiliateosDebug };
        }
        return { ok: false, state: "UNKNOWN_ACTION" };
      } catch (e) {
        return { ok: false, state: "EXCEPTION", error: String((e && e.message) || e) };
      }
    })().then((result) => sendResponse(result));
    return true; // keep the message channel open for the async response
  });
}