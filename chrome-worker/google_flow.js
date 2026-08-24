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
  // Runtime build identifier — included in every snapshot/diagnostic so the Admin
  // viewer can prove which google_flow.js revision is actually executing in the
  // running Chrome extension (stale-code detection). If a diagnostic lacks this
  // field, the extension is running an older revision.
  const FLOW_WORKER_BUILD = "0.5.3-build3";

  function dbg(entry) {
    try { window.__affiliateosDebug.steps.push({ t: Date.now(), ...entry }); } catch {}
  }
  function nowIso() { try { return new Date().toISOString(); } catch { return ""; } }
  function visible(el) {
    try { return !!(el && el.getClientRects && el.getClientRects().length); }
    catch { return false; }
  }

  // --- Diagnostic collectors (diagnostics ONLY — never drive interaction) ---
  // These traverse the main document, same-origin iframes, and accessible open
  // shadow roots to build a complete picture of the page's inputs/buttons for
  // the Admin diagnostic viewer. They do NOT affect findPromptInput /
  // findGenerateButton / verification — those selectors are unchanged.
  const DIAG_INPUT_SEL = 'textarea, input[type="text"], input[type="search"], [contenteditable="true"], [role="textbox"]';
  const DIAG_BUTTON_SEL = 'button, [role="button"]';

  function describeInput(el, i) {
    return {
      i,
      tag: el.tagName.toLowerCase(),
      id: el.id || "",
      className: (typeof el.className === "string" ? el.className : "").slice(0, 200),
      placeholder: (el.getAttribute("placeholder") || "").trim(),
      ariaLabel: (el.getAttribute("aria-label") || "").trim(),
      role: el.getAttribute("role") || "",
      text: ((el.innerText || el.value || "") + "").trim().slice(0, 120),
      visible: visible(el),
      outerHTML: (el.outerHTML || "").slice(0, 500),
    };
  }

  function describeButton(el, i) {
    return {
      i,
      text: ((el.innerText || el.getAttribute("aria-label") || "") + "").trim().slice(0, 80),
      ariaLabel: (el.getAttribute("aria-label") || "").trim(),
      disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
      visible: visible(el),
      outerHTML: (el.outerHTML || "").slice(0, 500),
    };
  }

  // Recursively collect inputs/buttons from a root (document, iframe doc, or
  // open shadow root). Descends into open shadow roots and same-origin iframes.
  function collectFromRoot(root, source, acc, depth) {
    if (depth > 4) return;
    try {
      root.querySelectorAll(DIAG_INPUT_SEL).forEach((el) => {
        acc.inputs.push(Object.assign({ source }, describeInput(el, acc.inputs.length)));
      });
    } catch {}
    try {
      root.querySelectorAll(DIAG_BUTTON_SEL).forEach((el) => {
        const t = ((el.innerText || el.getAttribute("aria-label") || "") + "").trim();
        if (!t || !visible(el)) return;
        acc.buttons.push(Object.assign({ source }, describeButton(el, acc.buttons.length)));
      });
    } catch {}
    // Descend into accessible open shadow roots.
    try {
      root.querySelectorAll("*").forEach((el) => {
        if (el && el.shadowRoot) {
          collectFromRoot(el.shadowRoot, source + ">shadow", acc, depth + 1);
        }
      });
    } catch {}
  }

  // Collect same-origin iframes (cross-origin iframes only expose their src).
  function collectIframes(doc, acc) {
    const iframes = Array.from(doc.querySelectorAll("iframe"));
    iframes.forEach((f, i) => {
      const info = { i, src: f.src || "", visible: visible(f), sameOrigin: false, url: "" };
      try {
        const cdoc = f.contentDocument;
        if (cdoc) {
          info.sameOrigin = true;
          info.url = cdoc.location.href;
          collectFromRoot(cdoc, "iframe[" + i + "]", acc, 0);
        }
      } catch {}
      acc.iframes.push(info);
    });
  }

  function snapshot() {
    const acc = { inputs: [], buttons: [], iframes: [] };
    collectFromRoot(document, "main", acc, 0);
    collectIframes(document, acc);
    const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
      .map((h) => (h.innerText || "").trim().slice(0, 120)).filter(Boolean);
    const bodyText = document.body ? (document.body.innerText || "") : "";
    const needsLogin = /sign\s*in|log\s*in|use your google account|choose an account|sign in with google/i.test(bodyText);
    return {
      url: location.href, title: document.title, readyState: document.readyState,
      needsLogin,
      videoCount: document.querySelectorAll("video").length,
      iframeCount: acc.iframes.length,
      iframes: acc.iframes,
      headings: headings.slice(0, 20),
      inputs: acc.inputs.slice(0, 50),
      buttons: acc.buttons.slice(0, 60),
      bodyExcerpt: bodyText.slice(0, 600),
      flowWorkerBuild: FLOW_WORKER_BUILD,
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

  // Read the current text from an input/contenteditable element — used to verify
  // that setText() actually registered the prompt in the editor's internal state.
  function getPromptText(el) {
    if (!el) return "";
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return (el.value || "").trim();
    return ((el.innerText || el.textContent || "") + "").trim();
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
      return true;
    }

    // Google Flow uses a Slate contenteditable editor. Directly assigning innerText
    // is not enough for Slate/React state — the UI can still show the placeholder
    // and keep Create disabled even though the DOM contains our text. We use the
    // browser's real editing command (document.execCommand('insertText')) which
    // fires the beforeinput/input events that Slate listens to for state updates.
    // This is the same path the browser takes when a user types — Slate's internal
    // model is updated, not just the DOM.
    el.focus();
    let inserted = false;
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      // Delete existing selection first so we start clean — without this, Slate
      // may keep the old text and append, or the selection may not be properly
      // cleared, causing execCommand('insertText') to insert at the wrong position.
      sel.deleteFromSelection();
      // execCommand('insertText') fires the proper beforeinput/input events that
      // Slate and other contenteditable frameworks listen to for state updates. This
      // is the same path the browser takes when a user types into the editor.
      inserted = document.execCommand("insertText", false, text);
    } catch {}

    // Fallback: if execCommand failed or is unavailable, try dispatching a
    // beforeinput event with insertText inputType — Slate listens for this to
    // update its internal model. As a last resort, set textContent and fire input.
    if (!inserted) {
      const current = getPromptText(el);
      if (current !== String(text).trim()) {
        try {
          el.textContent = text;
          el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, data: text, inputType: "insertText" }));
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
        } catch {
          el.textContent = text;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return inserted;
  }

  function videoSrc(v) {
    return (v.currentSrc || v.src || v.getAttribute("src") || "").trim();
  }

  function processingSignals() {
    const sigs = [];
    let bodyText = document.body ? (document.body.innerText || "") : "";
    // Strip static UI placeholder texts that contain processing keywords but are NOT
    // actual processing states. "Start creating or drop media" is Google Flow's
    // empty-state instruction — it contains "creating" but means NO generation is
    // happening. Without stripping it, the "text:creating" signal is present both
    // before AND after clicking Generate, so it never appears as a NEW signal and
    // masks the real generation state change. Stripping it ensures the only
    // "creating" match is the real "Creating..." / "Generating..." progress text.
    bodyText = bodyText.replace(/start\s+creating\s+or\s+drop\s+media/gi, "");
    bodyText = bodyText.replace(/drop\s+(media|files?|your)\s+(here|to\s+upload)/gi, "");
    bodyText = bodyText.replace(/drag\s+and\s+drop|drag\s+&\s+drop/gi, "");
    bodyText = bodyText.replace(/start\s+creating\b/gi, "");
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
      const isDisabled = gen.disabled === true || gen.getAttribute("aria-disabled") === "true";
      const isBusy = gen.getAttribute("aria-busy") === "true";
      // A disabled or busy Create/Generate button is a reliable processing signal —
      // Google Flow disables the button while generation is in progress. This is
      // detected as a NEW signal in detectGenerationStart() because it was not
      // present before the click.
      if (isDisabled || isBusy) sigs.push("generate-disabled");
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
      busy: gen.getAttribute("aria-busy") === "true",
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
          const busy = gen.getAttribute("aria-busy") === "true";
          // A disabled OR busy state change on the Create/Generate button proves the
          // click caused a real generation state transition (button becomes disabled
          // while processing). This catches the case where the button text doesn't
          // change but the disabled/busy attribute does.
          if (dis !== beforeGen.disabled) genChanged = true;
          if (busy !== beforeGen.busy) genChanged = true;
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

  // --- Landing-page → workspace entry (diagnostics + real UI clicks) --------
  // Used when the Flow landing page has no visible prompt input. The real entry
  // point is the visible "New project" button (per diagnostic evidence — not
  // "Get started"). These helpers traverse open shadow roots to find it, click
  // it, then re-inspect. They do NOT touch findPromptInput / findGenerateButton
  // / verification — those remain unchanged. "Edit project" / "Delete project"
  // are never matched.
  // Collect clickable elements from the main document AND all open shadow roots,
  // tagging each with its source so diagnostics can report where the match came
  // from. Does NOT rely on Google-generated class names.
  function collectClickableDeep() {
    const acc = [];
    function walk(root, source) {
      try {
        root.querySelectorAll('button, [role="button"], a').forEach((el) => acc.push({ el, source }));
      } catch {}
      try {
        root.querySelectorAll("*").forEach((el) => {
          if (el.shadowRoot) walk(el.shadowRoot, source + ">shadow");
        });
      } catch {}
    }
    walk(document, "main");
    return acc;
  }

  // Normalize a button's label by removing Material Symbol / icon text so a button
  // rendered as "<button><span>add_2</span>New project</button>" (raw text
  // "add_2\nNew project") yields the clean label "New project". Removes icon
  // elements by selector, then strips a leading Material Symbol ligature token
  // (lowercase letters/digits/underscores, e.g. "add_2", "edit", "delete")
  // that precedes the real label. The real label starts with an uppercase
  // letter, so a lowercase-leading real label is never stripped.
  function normalizeButtonLabel(el) {
    let clone;
    try { clone = el.cloneNode(true); } catch { clone = el; }
    try {
      clone.querySelectorAll('i, svg, mat-icon, [class*="material-symbols" i], [class*="material-icons" i], [class*="mat-icon" i], [class*="symbol" i], [aria-hidden="true"]').forEach((n) => n.remove());
    } catch {}
    let text = ((clone.textContent || "") + "").replace(/\s+/g, " ").trim();
    // Strip a leading Material Symbol ligature token (e.g. "add_2") that
    // precedes the real label. Ligature tokens are lowercase letters/digits/
    // underscores with no spaces; the real label starts uppercase.
    text = text.replace(/^[a-z][a-z0-9_]*\s+(?=[A-Z0-9])/, "").trim();
    return text;
  }

  function findLandingCta(excludeTexts) {
    const excl = new Set((excludeTexts || []).map((t) => String(t).trim().toLowerCase()));
    // The ONLY accepted landing/workspace-entry CTA is the real "New project"
    // button (normalized label). Promotional/banner CTAs ("Get started", "Learn
    // More", "Explore Tools", "Create your avatar", "Try now", …) and
    // project-row actions ("Edit project", "Delete project") are explicitly
    // rejected — never clicked, even as a fallback. This guarantees "Get
    // started" can never open the avatar modal. "New project" always wins.
    const reject = /^(get started|learn more|explore tools|create your avatar|edit project|delete project|try omi now|try now|start now|create now|create a character)$/i;
    const target = "new project";
    // Diagnostics: every visible button candidate (raw + normalized label) so the
    // admin viewer shows exactly why a match did or did not happen.
    const candidates = [];
    let matched = null;

    // Scan visible MAIN-DOCUMENT buttons first. The diagnostic proved the visible
    // "New project" button lives in the main document with raw text
    // "add_2\nNew project" — normalizeButtonLabel strips the icon ligature so the
    // normalized label is exactly "New project". No shadow-root traversal, CTA
    // heuristics, or fallback labels are required for this exact match.
    try {
      document.querySelectorAll('button, [role="button"]').forEach((el) => {
        if (!visible(el)) return;
        if (el.disabled === true || el.getAttribute("aria-disabled") === "true") return;
        const raw = (el.innerText || el.getAttribute("aria-label") || "").trim();
        const clean = normalizeButtonLabel(el);
        const c = { index: candidates.length, rawText: raw, clean, tag: (el.tagName || "").toLowerCase(), source: "main", outerHTML: (el.outerHTML || "").slice(0, 500) };
        candidates.push(c);
        if (!matched && clean && clean.toLowerCase() === target && !excl.has(clean.toLowerCase()) && !reject.test(clean)) {
          matched = c;
        }
      });
    } catch {}

    // Shadow-root fallback only if the main-document scan did not find the target.
    if (!matched) {
      try {
        document.querySelectorAll("*").forEach((el) => {
          if (matched || !el.shadowRoot) return;
          try {
            el.shadowRoot.querySelectorAll('button, [role="button"]').forEach((btn) => {
              if (matched) return;
              if (!visible(btn)) return;
              if (btn.disabled === true || btn.getAttribute("aria-disabled") === "true") return;
              const raw = (btn.innerText || btn.getAttribute("aria-label") || "").trim();
              const clean = normalizeButtonLabel(btn);
              const c = { index: candidates.length, rawText: raw, clean, tag: (btn.tagName || "").toLowerCase(), source: "shadow", outerHTML: (btn.outerHTML || "").slice(0, 500) };
              candidates.push(c);
              if (clean && clean.toLowerCase() === target && !excl.has(clean.toLowerCase()) && !reject.test(clean)) {
                matched = c;
              }
            });
          } catch {}
        });
      } catch {}
    }

    if (matched) {
      return {
        ok: true,
        text: matched.clean,
        rawText: matched.rawText,
        tag: matched.tag,
        source: matched.source,
        outerHTML: matched.outerHTML,
        url: location.href,
        landingButtonCandidates: candidates.slice(0, 50),
        matchedNewProject: matched.clean,
        matchedOuterHTML: matched.outerHTML,
        matchedIndex: matched.index,
      };
    }
    return {
      ok: false,
      text: null,
      rawText: null,
      tag: null,
      source: null,
      outerHTML: null,
      url: location.href,
      landingButtonCandidates: candidates.slice(0, 50),
      matchedNewProject: null,
      matchedOuterHTML: null,
      matchedIndex: null,
    };
  }

  function clickLandingCta(text) {
    const target = String(text || "").trim().toLowerCase();
    for (const { el, source } of collectClickableDeep()) {
      if (!visible(el)) continue;
      if (el.disabled === true || el.getAttribute("aria-disabled") === "true") continue;
      const clean = normalizeButtonLabel(el);
      if (!clean) continue;
      if (clean.toLowerCase() === target) {
        const urlBefore = location.href;
        el.click();
        dbg({ step: "clickLandingCta", text: clean, source });
        return { ok: true, clickedText: clean, source, urlBefore };
      }
    }
    return { ok: false, state: "CTA_NOT_FOUND", text };
  }

  function getPromptCandidates() {
    const found = findPromptInput();
    const sel = 'textarea, [contenteditable="true"], [role="textbox"], input[type="text"], input[type="search"]';
    const candidates = [];
    for (const el of document.querySelectorAll(sel)) {
      candidates.push(describeInput(el, candidates.length));
    }
    return {
      ok: true,
      url: location.href,
      hasVisiblePrompt: !!(found && visible(found)),
      foundText: found ? (found.getAttribute("placeholder") || found.getAttribute("aria-label") || (found.innerText || "").slice(0, 80) || "") : null,
      candidates: candidates.slice(0, 50),
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
          const needsLogin = /sign\s*in|log\s*in|use your google account|choose an account|sign in with google/i.test(bodyText.slice(0, 400));
          return { ok: true, url, title, is404, needsLogin, bodyExcerpt: bodyText.slice(0, 300) };
        }
        if (action === "inspect") {
          return { ok: true, state: "INSPECTED", snapshot: snapshot() };
        }
        if (action === "enterPrompt") {
          const snap = snapshot();
          if (snap.needsLogin) return { ok: false, state: "NEEDS_LOGIN", snapshot: snap };
          const prompt = String(msg.prompt || "");
          const input = findPromptInput();
          if (!input) return { ok: false, state: "NO_PROMPT_INPUT", snapshot: snap };
          const inserted = setText(input, prompt);

          // Verify the editor actually accepted the prompt before allowing the worker
          // to click Create. This prevents a false "ENTERED" result when Slate/React
          // ignored the input (e.g. execCommand failed, internal state didn't update)
          // and the Create button remains disabled. We wait briefly for Slate to sync
          // its internal model, then check that the editor's current text matches.
          await new Promise((r) => setTimeout(r, 300));
          const actual = getPromptText(input);
          // Accept if the editor contains the prompt text (check a meaningful prefix
          // and the full length, since Slate may add extra whitespace/nodes).
          const promptTrim = prompt.trim();
          const prefix = promptTrim.slice(0, Math.min(80, promptTrim.length));
          const accepted = !!promptTrim && actual.includes(prefix) && actual.length >= promptTrim.length * 0.5;
          const snapAfter = snapshot();
          const btn = findGenerateButton();
          const btnDisabled = btn ? (btn.disabled === true || btn.getAttribute("aria-disabled") === "true") : null;
          dbg({ step: "enterPrompt", length: promptTrim.length, inserted, accepted, actualLength: actual.length, actualExcerpt: actual.slice(0, 80), generateButtonDisabled: btnDisabled });
          if (!accepted) return { ok: false, state: "PROMPT_NOT_ACCEPTED", inserted, snapshot: snapAfter, actualText: actual.slice(0, 200), generateButtonDisabled: btnDisabled };
          return { ok: true, state: "ENTERED", inserted, snapshot: snapAfter, actualText: actual.slice(0, 200), generateButtonDisabled: btnDisabled };
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
        if (action === "getPromptCandidates") {
          return getPromptCandidates();
        }
        if (action === "findLandingCta") {
          return findLandingCta(msg.excludeTexts || []);
        }
        if (action === "clickLandingCta") {
          return clickLandingCta(msg.text || "");
        }
        return { ok: false, state: "UNKNOWN_ACTION" };
      } catch (e) {
        return { ok: false, state: "EXCEPTION", error: String((e && e.message) || e) };
      }
    })().then((result) => sendResponse(result));
    return true; // keep the message channel open for the async response
  });
}