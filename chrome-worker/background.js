/* global chrome */
// ===========================================================================
// AffiliateOS Worker — background service worker (Manifest V3)
// Version 0.5.0 · Base44 Job Bridge
//
// This extension is the implementation of the protocol expected by the
// AffiliateOS web app's WorkerService (src/lib/worker/chromeWorkerAdapter.js).
// It listens on chrome.runtime.onMessageExternal and responds to exactly the
// message types the web app sends. No new protocol is invented here.
//
// Phase (this build): prove the bridge — PING handshake + START_JOB accepted +
// workspace opened + WORKSPACE_READY/FLOW_READY/TIKTOK_READY reported via
// STATUS polling. Real video generation and TikTok publishing are NOT
// implemented yet (do not fake them).
// ===========================================================================

const VERSION = "0.5.2";
const EXECUTION = "CHROME_WORKER";
const MODE = "LOCAL_WORKER";

// --- Security: only these origins may talk to the Worker -------------------
const ALLOWED_ORIGINS = new Set([
  "https://affiliate-os.base44.app",
  "https://affiliate-flow-os.base44.app",
]);

// --- Only these external message types are accepted ------------------------
const ALLOWED_TYPES = new Set([
  "AFFILIATEOS_PING",
  "AFFILIATEOS_STATUS",
  "AFFILIATEOS_START_JOB",
  "AFFILIATEOS_CANCEL_JOB",
  "AFFILIATEOS_GET_DEBUG",
]);

// --- Workspace tab URLs (configure for your environment) -------------------
// The bridge proof only requires the tabs to open and report ready when
// loaded — no generation/publishing happens yet.
const GOOGLE_FLOW_URL = "https://flow.google/";
const TIKTOK_STUDIO_URL = "https://www.tiktok.com/tiktokstudio/upload";

// Phase progression used to derive readiness flags for STATUS.
const PHASE_RANK = {
  IDLE: 0,
  OPENING_WORKSPACE: 1,
  WORKSPACE_READY: 2,
  FLOW_PAGE_VALIDATED: 3,
  FLOW_READY: 4,
  TIKTOK_READY: 5,
  FAILED: 0,
};

// In-memory state. Key fields are persisted to storage so the workspace window
// can be reused across service-worker restarts.
const state = {
  phase: "IDLE",
  jobId: null,
  flowStatus: "NOT_OPEN", // NOT_OPEN | READY
  tiktokStatus: "NOT_OPEN",
  workspaceWindowId: null,
  flowTabId: null,
  tiktokTabId: null,
  flowUrl: null,
  flowUrlValid: false,
  flowCommOk: false,
  lastJobId: null,
  lastAction: "Idle",
  flowError: null,
};

let currentRunner = null; // { cancelled: boolean }

// --- helpers ---------------------------------------------------------------
function allowedOrigin(origin) {
  if (!origin) return false;
  try {
    return ALLOWED_ORIGINS.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

// Recognize the canonical Google Flow URL (https://flow.google/) AND the URL
// Google redirects it to (https://labs.google/fx/tools/flow). The legacy
// https://labs.google.com/flow URL is a 404 and must NEVER validate.
function isFlowUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    if (h === "flow.google") return true;
    // Redirect target: labs.google (NOT labs.google.com). Accept the Flow tool
    // route and any subpath/query/hash under it.
    if (h === "labs.google" && /\/fx\/tools\/flow(\/|$|\?|#)/.test(u.pathname + u.hash)) return true;
    return false;
  } catch {
    return false;
  }
}

function isTiktokUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return /(^|\.)tiktok\.com$/.test(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

// TikTok Studio upload page specifically (for tab reuse — do not duplicate).
function isTiktokStudioUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (!/(^|\.)tiktok\.com$/.test(u.hostname.toLowerCase())) return false;
    return /\/tiktokstudio\/upload(\/|$|\?|#)/.test(u.pathname + u.hash);
  } catch {
    return false;
  }
}

// The AffiliateOS web app origins. The Chrome window containing one of these
// tabs is the single workspace window — we never create a new window.
const AFFILIATEOS_URL_RE = /^https:\/\/(affiliate-os|affiliate-flow-os)\.base44\.app\//;
function isAffiliateOsUrl(url) {
  if (!url) return false;
  return AFFILIATEOS_URL_RE.test(url);
}

function setStatus(patch) {
  Object.assign(state, patch);
  persist();
}

function persist() {
  try {
    chrome.storage.local.set({
      workerState: {
        phase: state.phase,
        jobId: state.jobId,
        workspaceWindowId: state.workspaceWindowId,
        lastJobId: state.lastJobId,
        lastAction: state.lastAction,
      },
    });
  } catch {}
}

async function restore() {
  try {
    const stored = await chrome.storage.local.get("workerState");
    const s = stored?.workerState;
    if (s) {
      state.phase = s.phase || "IDLE";
      state.jobId = s.jobId || null;
      state.workspaceWindowId = s.workspaceWindowId || null;
      state.lastJobId = s.lastJobId || null;
      state.lastAction = s.lastAction || "Idle";
    }
  } catch {}
}
restore();

// --- external message listener (the web app ↔ Worker protocol) -------------
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  // [diagnostic] log every external message that reaches the service worker.
  console.log("[AffiliateOS Worker] external message received", {
    origin: sender.origin,
    type: msg && msg.type,
    requestId: msg && msg.requestId,
  });
  // Security: reject unknown origins and unknown message types.
  if (!allowedOrigin(sender.origin)) {
    console.warn("[AffiliateOS Worker] rejected origin", { origin: sender.origin });
    return false;
  }
  if (!msg || !ALLOWED_TYPES.has(msg.type)) {
    console.warn("[AffiliateOS Worker] unknown message type", { type: msg && msg.type });
    return false;
  }

  const requestId = msg.requestId || "";

  switch (msg.type) {
    case "AFFILIATEOS_PING":
      // Immediate. workerOnline === true means the extension is alive.
      console.log("[AffiliateOS Worker] PING received", { requestId });
      sendResponse({
        ok: true,
        type: "AFFILIATEOS_PONG",
        requestId,
        workerOnline: true,
        version: VERSION,
        execution: EXECUTION,
        mode: MODE,
      });
      console.log("[AffiliateOS Worker] PONG sent", { requestId, version: VERSION });
      return false;

    case "AFFILIATEOS_STATUS": {
      // The web app polls this. It reads `phase` + workspace/flow/tiktok
      // readiness. Worker Online is independent of Flow/TikTok being open.
      sendResponse({
        ok: true,
        type: "AFFILIATEOS_STATUS_RESPONSE",
        requestId,
        workerOnline: true,
        version: VERSION,
        execution: EXECUTION,
        mode: MODE,
        phase: state.phase,
        status: state.phase,
        lastAction: state.lastAction,
        flowError: state.flowError,
        workspace: {
          windowId: state.workspaceWindowId,
          flowTabId: state.flowTabId,
          flowUrl: state.flowUrl,
          flowUrlValid: state.flowUrlValid,
          flowCommOk: state.flowCommOk,
          flowStatus: state.flowStatus,
          tiktokTabId: state.tiktokTabId,
          tiktokStatus: state.tiktokStatus,
        },
        lastJobId: state.lastJobId,
        jobId: state.jobId,
      });
      return false;
    }

    case "AFFILIATEOS_START_JOB": {
      const job = msg.job || {};
      if (!job.id) {
        sendResponse({ ok: false, type: "AFFILIATEOS_JOB_REJECTED", requestId, error: "missing job id" });
        return false;
      }
      setStatus({ jobId: job.id, lastJobId: job.id, lastAction: "Job received", phase: "OPENING_WORKSPACE" });
      // Immediate ack — do not treat accepted as completed.
      sendResponse({ ok: true, type: "AFFILIATEOS_JOB_ACCEPTED", requestId, jobId: job.id });
      // Execute asynchronously — do NOT block the external callback.
      runJob(job).catch((e) => {
        setStatus({ phase: "FAILED", lastAction: "Job failed: " + (e?.message || String(e)) });
      });
      return false;
    }

    case "AFFILIATEOS_CANCEL_JOB": {
      if (currentRunner) currentRunner.cancelled = true;
      setStatus({ phase: "IDLE", lastAction: "Job cancelled" });
      sendResponse({ ok: true, type: "AFFILIATEOS_JOB_CANCELLED", requestId });
      return false;
    }

    case "AFFILIATEOS_GET_DEBUG": {
      // Admin-only: return the full diagnostic captured during the last run.
      const jobId = msg.jobId || state.lastJobId;
      chrome.storage.local.get([`flowDebug_${jobId}`, `flowDetail_${jobId}`]).then((res) => {
        sendResponse({
          ok: true,
          type: "AFFILIATEOS_DEBUG_RESPONSE",
          requestId,
          jobId,
          flowDebug: res[`flowDebug_${jobId}`] || null,
          flowDetail: res[`flowDetail_${jobId}`] || null,
        });
      });
      return true; // async — keep the channel open for the storage read
    }
  }
  return false;
});

// --- internal listener (popup diagnostics only) ----------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "POPUP_GET_STATUS") {
    sendResponse({
      version: VERSION,
      phase: state.phase,
      flowStatus: state.flowStatus,
      tiktokStatus: state.tiktokStatus,
      lastJobId: state.lastJobId,
      lastAction: state.lastAction,
    });
    return false;
  }
  return false;
});

// --- tab tracking: clear stale IDs when tabs navigate away or close ---------
// A stale flowTabId must NEVER be enough to report flowStatus: READY. When a
// tracked tab navigates to a non-Flow URL (e.g. a 404 or login redirect), its
// ID is cleared immediately. The same applies to the TikTok tab.
chrome.tabs.onUpdated.addListener((tabId, _change, tab) => {
  if (!tab || !tab.url) return;
  // Ignore transitional/blank URLs — only clear on a real navigated URL.
  if (/^(about:|chrome:|edge:|view-source:)/i.test(tab.url)) return;
  if (state.flowTabId === tabId) {
    state.flowUrl = tab.url;
    const valid = isFlowUrl(tab.url);
    state.flowUrlValid = valid;
    if (!valid) {
      setStatus({ flowTabId: null, flowStatus: "NOT_OPEN", flowError: "FLOW_TAB_NAVIGATED_AWAY", flowUrlValid: false, flowCommOk: false });
    }
  }
  if (state.tiktokTabId === tabId && !isTiktokUrl(tab.url)) {
    setStatus({ tiktokTabId: null, tiktokStatus: "NOT_OPEN" });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.flowTabId === tabId) {
    setStatus({ flowTabId: null, flowStatus: "NOT_OPEN", flowUrl: null, flowUrlValid: false, flowCommOk: false, flowError: "FLOW_TAB_CLOSED" });
  }
  if (state.tiktokTabId === tabId) {
    setStatus({ tiktokTabId: null, tiktokStatus: "NOT_OPEN" });
  }
});

// --- workspace + job runner ------------------------------------------------
async function getWorkspaceWindowId() {
  const id = state.workspaceWindowId;
  if (!id) return null;
  try {
    await chrome.windows.get(id);
    return id;
  } catch {
    return null;
  }
}

// Find the Chrome window that already contains the AffiliateOS web app tab.
// This is the single window the workspace lives in — we NEVER create a new
// window and never open about:blank. Fallback: chrome.windows.getLastFocused().
async function findAffiliateOsWindow() {
  // 1. Reuse a previously recorded workspace window if it still exists and
  //    contains the AffiliateOS tab.
  const prevId = await getWorkspaceWindowId();
  if (prevId) {
    try {
      const tabs = await chrome.tabs.query({ windowId: prevId });
      if (tabs.some((t) => t.url && isAffiliateOsUrl(t.url))) {
        return { windowId: prevId };
      }
    } catch {}
  }
  // 2. Search every tab for an AffiliateOS origin.
  const allTabs = await chrome.tabs.query({});
  const aoTab = allTabs.find((t) => t.url && isAffiliateOsUrl(t.url));
  if (aoTab) return { windowId: aoTab.windowId };
  // 3. Fallback: the last focused window. NEVER chrome.windows.create().
  try {
    const win = await chrome.windows.getLastFocused();
    if (win && win.id) return { windowId: win.id };
  } catch {}
  return null;
}

// Reuse an existing tab in the window that matches `matcher`, or create a new
// tab in the SAME window. For Flow, an existing tracked tab whose URL is no
// longer valid is navigated back to the canonical URL instead of duplicating.
async function ensureTab(winId, url, stateKey, matcher, active = false) {
  const tabs = await chrome.tabs.query({ windowId: winId });
  // Prefer the currently tracked tab if it still lives in this window.
  let existing = null;
  if (stateKey && state[stateKey]) {
    existing = tabs.find((t) => t.id === state[stateKey]);
  }
  // Otherwise look for any tab already on a valid target URL.
  if (!existing) {
    existing = tabs.find((t) => t.url && matcher(t.url));
  }
  let tab;
  if (existing) {
    // If the existing tab is not on a valid URL, navigate it back to canonical.
    if (!matcher(existing.url)) {
      try { await chrome.tabs.update(existing.id, { url }); } catch {}
    }
    tab = existing;
  } else {
    tab = await chrome.tabs.create({ windowId: winId, url, active });
  }
  if (stateKey) setStatus({ [stateKey]: tab.id });
  return tab;
}

async function ensureWorkspace() {
  const found = await findAffiliateOsWindow();
  if (!found) {
    setStatus({ phase: "FAILED", flowError: "NO_AFFILIATEOS_WINDOW", lastAction: "No open Chrome window found" });
    throw new Error("NO_AFFILIATEOS_WINDOW");
  }
  const winId = found.windowId;
  setStatus({ workspaceWindowId: winId, lastAction: "Using existing Chrome window" });
  // Flow tab — active so the user sees it load. Reuse if already present.
  await ensureTab(winId, GOOGLE_FLOW_URL, "flowTabId", isFlowUrl, true);
  // TikTok Studio tab — inactive initially. Reuse if already present.
  await ensureTab(winId, TIKTOK_STUDIO_URL, "tiktokTabId", isTiktokStudioUrl, false);
  setStatus({ phase: "WORKSPACE_READY", lastAction: "Workspace ready" });
  return winId;
}

async function waitForTab(winId, url, runner, matcher) {
  const matchUrl = matcher || ((tab) => !!(tab.url && tab.url.startsWith(url.split("?")[0])));
  const tabs = await chrome.tabs.query({ windowId: winId });
  const found = tabs.find(matchUrl);
  if (found && found.status === "complete") return;
  return new Promise((resolve) => {
    const listener = (_tabId, change, tab) => {
      if (runner.cancelled) {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
        return;
      }
      if (tab && tab.windowId === winId && matchUrl(tab) && change.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Safety: never hang forever (60s).
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 60000);
  });
}

async function runJob(job) {
  const runner = { cancelled: false };
  currentRunner = runner;

  setStatus({ phase: "OPENING_WORKSPACE", lastAction: "Opening workspace" });
  const winId = await ensureWorkspace();
  if (runner.cancelled) return;

  // Google Flow tab loaded → validate it is REALLY Google Flow before READY.
  await waitForTab(winId, GOOGLE_FLOW_URL, runner, isFlowUrl);
  if (runner.cancelled) return;

  setStatus({ phase: "FLOW_PAGE_VALIDATED", lastAction: "Validating Google Flow page" });
  const validation = await validateFlowPage(state.flowTabId, runner);
  if (runner.cancelled) return;
  if (!validation.ok) {
    flowFail(runner, validation.reason, validation);
    return;
  }
  setStatus({ flowStatus: "READY", phase: "FLOW_READY", flowError: null, lastAction: "Google Flow ready" });

  // Phase 2: real Google Flow generation. The strict verification pipeline in
  // google_flow.js only emits FLOW_GENERATED after a proven, fully-loaded new
  // video (readyState >= 4, finite duration, durable src). Diagnostics
  // (flowDebug_<jobId>/flowDetail_<jobId>) are captured regardless of outcome.
  await runGoogleFlow(job, runner);
}

// --- Google Flow driving (Phase 2) -----------------------------------------
// Injects the content script into the Google Flow tab and steps through the
// real UI: inspect → enter prompt → click generate → wait for completion.
// Never fakes success. Each phase is set only after the step confirms.
function flowFail(runner, reason, detail) {
  if (runner.cancelled) return { ok: false, state: reason, detail };
  setStatus({ phase: "FLOW_FAILED", flowError: reason, lastAction: "Google Flow failed: " + reason });
  if (detail) {
    try { chrome.storage.local.set({ [`flowDetail_${state.jobId}`]: { reason, detail } }); } catch {}
  }
  console.warn("[AffiliateOS Worker] FLOW_FAILED", { reason, detail });
  return { ok: false, state: reason, detail };
}

// Persist the Flow diagnostic to flowDebug_<jobId>. Called at multiple stages
// (INSPECT, NO_PROMPT_INPUT, …) so a diagnostic is ALWAYS available even when
// the run fails before verification. The verification stage later overwrites
// this with the full before/after DOM diagnostic when reached.
function persistFlowDebug(patch) {
  const jobId = state.jobId || state.lastJobId;
  if (!jobId) return;
  try {
    chrome.storage.local.set({
      [`flowDebug_${jobId}`]: Object.assign(
        { jobId, capturedAt: new Date().toISOString() },
        patch
      ),
    });
  } catch {}
}

function buildPrompt(job) {
  const j = job || {};
  if (j.video_prompt && String(j.video_prompt).trim()) return String(j.video_prompt);
  const parts = [j.hook, j.script, j.caption, j.cta].filter(Boolean);
  if (parts.length) return parts.join("\n\n");
  return "";
}

function sendToFlow(flowTabId, payload, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeoutMs || 30000);
    try {
      chrome.tabs.sendMessage(flowTabId, payload, (resp) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) resolve(null);
        else resolve(resp);
      });
    } catch { if (!done) { done = true; resolve(null); } }
  });
}

// Wait for a visible prompt input to appear in the Flow tab after a landing
// CTA click. Re-injects the content script each poll (idempotent) so it works
// across full-page navigations too. Resolves { ok, url, candidates, foundText }.
async function waitForVisiblePrompt(flowTabId, runner, maxMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < maxMs) {
    if (runner.cancelled) return { ok: false, reason: "CANCELLED", last };
    try {
      await chrome.scripting.executeScript({ target: { tabId: flowTabId }, files: ["google_flow.js"] });
    } catch {}
    const res = await sendToFlow(flowTabId, { type: "AFFILIATEOS_FLOW_RUN", action: "getPromptCandidates" }, 8000);
    last = res;
    if (res && res.ok && res.hasVisiblePrompt) {
      return { ok: true, url: res.url, candidates: res.candidates, foundText: res.foundText };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { ok: false, reason: "WORKSPACE_LOAD_TIMEOUT", last };
}

// Validate the Google Flow tab is REALLY on Google Flow (not a 404, login, or
// other page) before ever claiming FLOW_READY. Checks: tab exists, current URL
// is a valid Flow URL, content script can respond, page is not a 404/login.
// Returns { ok, reason, ... }. Never fakes success.
async function validateFlowPage(flowTabId, runner) {
  if (runner.cancelled) return { ok: false, reason: "CANCELLED" };
  let tab;
  try { tab = await chrome.tabs.get(flowTabId); }
  catch { return { ok: false, reason: "FLOW_TAB_CLOSED" }; }
  if (!tab || !isFlowUrl(tab.url)) {
    return { ok: false, reason: "FLOW_PAGE_INVALID", url: tab ? tab.url : null };
  }
  // Inject the content script so the page can report its own state.
  try {
    await chrome.scripting.executeScript({ target: { tabId: flowTabId }, files: ["google_flow.js"] });
  } catch {
    return { ok: false, reason: "FLOW_INJECT_FAILED" };
  }
  const v = await sendToFlow(flowTabId, { type: "AFFILIATEOS_FLOW_RUN", action: "validatePage" }, 15000);
  state.flowCommOk = !!(v && v.ok);
  if (!v || !v.ok) {
    return { ok: false, reason: "FLOW_COMM_FAILED" };
  }
  // Update tracked URL state from the page itself.
  state.flowUrl = v.url;
  state.flowUrlValid = isFlowUrl(v.url);
  if (v.is404) return { ok: false, reason: "FLOW_PAGE_NOT_ACCESSIBLE", title: v.title, url: v.url, bodyExcerpt: v.bodyExcerpt };
  if (v.needsLogin) return { ok: false, reason: "NEEDS_LOGIN", title: v.title, url: v.url };
  if (!isFlowUrl(v.url)) return { ok: false, reason: "FLOW_PAGE_INVALID", url: v.url };
  return { ok: true, url: v.url, title: v.title };
}

async function runGoogleFlow(job, runner) {
  const flowTabId = state.flowTabId;
  if (!flowTabId) { flowFail(runner, "NO_FLOW_TAB"); return; }

  // Focus the Google Flow tab.
  try { await chrome.tabs.update(flowTabId, { active: true }); } catch {}

  // Inject the content script (idempotent — guarded against re-binding).
  try {
    await chrome.scripting.executeScript({ target: { tabId: flowTabId }, files: ["google_flow.js"] });
  } catch (e) {
    flowFail(runner, "INJECT_FAILED");
    return;
  }

  setStatus({ phase: "FLOW_STARTED", lastAction: "Google Flow started" });

  // 1. Inspect the real UI before acting.
  const inspect = await sendToFlow(flowTabId, { type: "AFFILIATEOS_FLOW_RUN", action: "inspect" });
  console.log("[AffiliateOS Worker] Google Flow inspection", inspect);
  if (!inspect || !inspect.ok) {
    persistFlowDebug({ stage: "NO_INSPECTION_RESPONSE", failureStage: "NO_INSPECTION_RESPONSE", snapshot: (inspect && inspect.snapshot) || null });
    flowFail(runner, "NO_INSPECTION_RESPONSE", inspect && inspect.snapshot);
    return;
  }
  if (inspect.snapshot && inspect.snapshot.needsLogin) {
    persistFlowDebug({ stage: "NEEDS_LOGIN", failureStage: "NEEDS_LOGIN", snapshot: inspect.snapshot });
    flowFail(runner, "NEEDS_LOGIN", inspect.snapshot);
    return;
  }

  // Persist the initial page snapshot immediately so a diagnostic is ALWAYS
  // available — even if the run fails before verification (e.g. NO_PROMPT_INPUT).
  const diagSteps = [];
  const logDiag = (entry) => { diagSteps.push(Object.assign({ t: new Date().toISOString() }, entry)); return diagSteps; };
  persistFlowDebug({ stage: "INSPECT", snapshot: inspect.snapshot, diagSteps: logDiag({ step: "INSPECT" }) });

  // 1b. Determine whether the real prompt input is already visible. If not, we
  // are on the Flow landing page and must enter the workspace via the real UI
  // (e.g. "Get started") before attempting enterPrompt. No CSS selectors are
  // guessed — only real visible buttons are clicked, and the DOM is re-inspected
  // after each action to decide the next step.
  const pc = await sendToFlow(flowTabId, { type: "AFFILIATEOS_FLOW_RUN", action: "getPromptCandidates" }, 10000);
  let promptReady = !!(pc && pc.ok && pc.hasVisiblePrompt);
  let lastSnapshot = inspect.snapshot;
  let lastCandidates = (pc && pc.candidates) || null;
  const clickedTexts = [];
  let lastUrlAfter = null;

  if (!promptReady) {
    // Landing page detected — no visible prompt input.
    persistFlowDebug({ stage: "LANDING_PAGE_DETECTED", snapshot: lastSnapshot, promptCandidates: lastCandidates, diagSteps: logDiag({ step: "LANDING_PAGE_DETECTED", hasVisiblePrompt: false }) });
    setStatus({ phase: "FLOW_ENTERING_WORKSPACE", lastAction: "Entering Google Flow workspace" });

    const MAX_LANDING_ATTEMPTS = 3;
    let attempt = 0;
    while (!promptReady && attempt < MAX_LANDING_ATTEMPTS && !runner.cancelled) {
      attempt++;
      // Find the next real visible CTA (excluding ones already clicked).
      const cta = await sendToFlow(flowTabId, { type: "AFFILIATEOS_FLOW_RUN", action: "findLandingCta", excludeTexts: clickedTexts }, 10000);
      if (!cta || !cta.ok || !cta.text) {
        persistFlowDebug({ stage: "NO_LANDING_CTA", failureStage: "NO_LANDING_CTA", ctaFound: false, attempt, candidateCount: cta && cta.candidateCount || 0, candidates: cta && cta.candidates || [], snapshot: lastSnapshot, clickedTexts, diagSteps: logDiag({ step: "NO_LANDING_CTA", attempt, candidateCount: cta && cta.candidateCount || 0 }) });
        flowFail(runner, "NO_LANDING_CTA", { attempt, clickedTexts, snapshot: lastSnapshot, candidateCount: cta && cta.candidateCount || 0, candidates: cta && cta.candidates || [] });
        return;
      }
      persistFlowDebug({ stage: "NEW_PROJECT_CTA_FOUND", ctaFound: true, attempt, ctaText: cta.text, ctaRawText: cta.rawText, ctaTag: cta.tag, ctaSource: cta.source, ctaOuterHTML: cta.outerHTML, snapshot: lastSnapshot, diagSteps: logDiag({ step: "NEW_PROJECT_CTA_FOUND", attempt, ctaText: cta.text, ctaRawText: cta.rawText, ctaTag: cta.tag, ctaSource: cta.source }) });
      const urlBefore = cta.url;
      const clicked = await sendToFlow(flowTabId, { type: "AFFILIATEOS_FLOW_RUN", action: "clickLandingCta", text: cta.text }, 10000);
      if (!clicked || !clicked.ok) {
        persistFlowDebug({ stage: "LANDING_CTA_CLICK_FAILED", failureStage: "LANDING_CTA_CLICK_FAILED", attempt, ctaText: cta.text, snapshot: lastSnapshot, diagSteps: logDiag({ step: "LANDING_CTA_CLICK_FAILED", attempt, ctaText: cta.text }) });
        flowFail(runner, "LANDING_CTA_CLICK_FAILED", { ctaText: cta.text, attempt });
        return;
      }
      clickedTexts.push(cta.text);
      persistFlowDebug({ stage: "NEW_PROJECT_CLICKED", attempt, clickedText: cta.text, clickedSource: clicked.source || cta.source, urlBefore, snapshot: lastSnapshot, diagSteps: logDiag({ step: "NEW_PROJECT_CLICKED", attempt, clickedText: cta.text, urlBefore }) });

      // Wait for the workspace/editor to load a visible prompt input.
      const ws = await waitForVisiblePrompt(flowTabId, runner, 30000);
      if (runner.cancelled) return;
      lastUrlAfter = (ws && ws.url) || null;
      if (ws && ws.ok) {
        // Re-inspect the workspace DOM.
        const reInspect = await sendToFlow(flowTabId, { type: "AFFILIATEOS_FLOW_RUN", action: "inspect" }, 15000);
        lastSnapshot = (reInspect && reInspect.snapshot) || lastSnapshot;
        lastCandidates = ws.candidates || lastCandidates;
        promptReady = true;
        persistFlowDebug({ stage: "WORKSPACE_LOADED", attempt, urlAfter: lastUrlAfter, clickedText: cta.text, snapshot: lastSnapshot, promptCandidates: lastCandidates, diagSteps: logDiag({ step: "WORKSPACE_LOADED", attempt, urlAfter: lastUrlAfter, clickedText: cta.text, foundText: ws.foundText }) });
      } else {
        // Workspace did not expose a visible prompt — re-inspect to find the
        // next real UI action from the DOM (do not guess selectors).
        const reInspect = await sendToFlow(flowTabId, { type: "AFFILIATEOS_FLOW_RUN", action: "inspect" }, 15000);
        lastSnapshot = (reInspect && reInspect.snapshot) || lastSnapshot;
        lastCandidates = (ws && ws.last && ws.last.candidates) || lastCandidates;
        persistFlowDebug({ stage: "WORKSPACE_NOT_LOADED", attempt, urlAfter: lastUrlAfter, snapshot: lastSnapshot, promptCandidates: lastCandidates, waitResult: ws && ws.reason, diagSteps: logDiag({ step: "WORKSPACE_NOT_LOADED", attempt, urlAfter: lastUrlAfter }) });
      }
    }

    if (!promptReady) {
      persistFlowDebug({ stage: "NO_PROMPT_INPUT_AFTER_LANDING_CTA", failureStage: "NO_PROMPT_INPUT_AFTER_LANDING_CTA", attempts: attempt, snapshot: lastSnapshot, promptCandidates: lastCandidates, clickedTexts, lastUrlAfter, diagSteps });
      flowFail(runner, "NO_PROMPT_INPUT_AFTER_LANDING_CTA", { attempts: attempt, snapshot: lastSnapshot, clickedTexts });
      return;
    }
    }

    // DRY-RUN navigation test: stop here. No prompt entry, no Generate click, no
    // video generation, no Flow credits spent. The complete per-step navigation
    // diagnostic (LANDING_PAGE_DETECTED → NEW_PROJECT_CTA_FOUND →
    // NEW_PROJECT_CLICKED → WORKSPACE_LOADED/NOT_LOADED) is captured in diagSteps
    // regardless of outcome. Real jobs (no dry_run flag) are unaffected.
    if (job.dry_run) {
    const navState = promptReady ? "NAV_TEST_PASSED" : "NAV_TEST_FAILED";
    const navTest = {
    ok: promptReady,
    state: navState,
    promptReady,
    landingPageDetected: !!(clickedTexts && clickedTexts.length),
    clickedTexts,
    lastUrlAfter,
    snapshot: lastSnapshot,
    promptCandidates: lastCandidates,
    };
    persistFlowDebug({
    stage: "FLOW_NAV_TEST_RESULT",
    navTest,
    diagSteps: logDiag({ step: "FLOW_NAV_TEST_RESULT", ok: promptReady, state: navState, clickedTexts, lastUrlAfter }),
    });
    setStatus({
    phase: promptReady ? "FLOW_NAV_TEST_DONE" : "FLOW_NAV_TEST_FAILED",
    lastAction: promptReady ? "Dry-run navigation test passed (no video generated)" : "Dry-run navigation test failed",
    flowError: promptReady ? null : "NAV_TEST_FAILED",
    });
    console.log("[AffiliateOS Worker] Dry-run navigation test complete", navTest);
    return;
    }

    setStatus({ phase: "FLOW_PROJECT_READY", lastAction: "Google Flow project ready" });

  // 2. Enter the prompt.
  const prompt = buildPrompt(job);
  if (!prompt) {
    persistFlowDebug({ stage: "NO_PROMPT", failureStage: "NO_PROMPT", snapshot: lastSnapshot, diagSteps });
    flowFail(runner, "NO_PROMPT");
    return;
  }
  const entered = await sendToFlow(flowTabId, { type: "AFFILIATEOS_FLOW_RUN", action: "enterPrompt", prompt });
  if (!entered || !entered.ok) {
    const reason = (entered && entered.state) || "NO_PROMPT_INPUT";
    const snap = (entered && entered.snapshot) || lastSnapshot;
    // Persist the failure snapshot to BOTH flowDebug and flowDetail (flowFail
    // writes flowDetail) so the Admin viewer shows evidence at NO_PROMPT_INPUT.
    persistFlowDebug({ stage: reason, failureStage: reason, snapshot: snap, diagSteps });
    flowFail(runner, reason, snap);
    return;
  }

  // Capture project/result state BEFORE generating (used to prove a NEW result).
  const before = await sendToFlow(flowTabId, { type: "AFFILIATEOS_FLOW_RUN", action: "captureBefore" });
  if (!before || !before.ok) { flowFail(runner, "NO_BEFORE_STATE"); return; }
  const tBeforeClick = new Date().toISOString();

  setStatus({ phase: "FLOW_PROMPT_ENTERED", lastAction: "Prompt entered" });

  // 3. Click generate.
  const clicked = await sendToFlow(flowTabId, { type: "AFFILIATEOS_FLOW_RUN", action: "clickGenerate" });
  const tClick = new Date().toISOString();
  if (!clicked || !clicked.ok) { flowFail(runner, (clicked && clicked.state) || "NO_GENERATE_BUTTON", clicked && clicked.snapshot); return; }

  setStatus({ phase: "FLOW_GENERATING", lastAction: "Generating video" });

  // 4. Confirm the Generate click actually caused a generation/processing state.
  const started = await sendToFlow(flowTabId, { type: "AFFILIATEOS_FLOW_RUN", action: "detectGenerationStart", maxWaitMs: 12000 }, 20000);
  if (!started || !started.ok) { flowFail(runner, (started && started.state) || "FLOW_GENERATION_DID_NOT_START", started); return; }

  // 5. Wait for that processing state to finish AND a new result to appear.
  const processed = await sendToFlow(flowTabId, { type: "AFFILIATEOS_FLOW_RUN", action: "waitForProcessing", maxWaitMs: 180000 }, 200000);
  if (!processed || !processed.ok) { flowFail(runner, (processed && processed.state) || "FLOW_GENERATION_TIMEOUT", processed); return; }

  setStatus({ phase: "VERIFYING_RESULT", lastAction: "Verifying result" });

  // 6. STRICT verification. ALWAYS capture + persist the full diagnostic so the
  //    real run can be inspected in Admin — whether it passes or fails. Only a
  //    proven, fully-loaded new video allows FLOW_GENERATED.
  const verified = await sendToFlow(flowTabId, { type: "AFFILIATEOS_FLOW_RUN", action: "verifyResult" }, 20000);
  const tVerified = new Date().toISOString();
  const dbg = await sendToFlow(flowTabId, { type: "AFFILIATEOS_FLOW_RUN", action: "getDebug" }, 10000);

  const flowDebug = {
    jobId: state.jobId,
    capturedAt: new Date().toISOString(),
    timestamps: {
      tBeforeClick,
      tClick,
      tStarted: started?.tStarted || null,
      tFinished: processed?.tFinished || null,
      tVerified,
    },
    generationStart: started ? { signals: started.signals, allSignals: started.allSignals, genChanged: started.genChanged } : null,
    processingFinish: processed ? { finishingSignals: processed.finishingSignals, newResult: processed.newResult } : null,
    verification: verified || null,
    debugSteps: (dbg && dbg.debug && dbg.debug.steps) || null,
  };
  try { chrome.storage.local.set({ [`flowDebug_${state.jobId}`]: flowDebug }); } catch {}

  if (!verified || !verified.ok) {
    flowFail(runner, (verified && verified.state) || "FLOW_RESULT_NOT_CONFIRMED", verified && verified.diagnostic);
    return;
  }

  setStatus({ phase: "FLOW_GENERATED", lastAction: "Video generated and verified (" + (verified.by || "") + ")", flowError: null });
  console.log("[AffiliateOS Worker] Google Flow generation complete and verified", verified);
}