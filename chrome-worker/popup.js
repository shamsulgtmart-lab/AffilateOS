// Popup diagnostics — reads live state from the background service worker.
// The popup is NOT required for normal operation; the Worker runs in the
// background and AffiliateOS detects it automatically via PING.

function setRow(id, ready, readyText, notOpenText) {
  const el = document.getElementById(id);
  if (ready) {
    el.innerHTML = `<span class="dot green"></span>${readyText}`;
    el.className = "val ok";
  } else {
    el.innerHTML = `<span class="dot slate"></span>${notOpenText}`;
    el.className = "val muted";
  }
}

function render(s) {
  setRow("flow", s.flowStatus === "READY", "Ready", "Not Open");
  setRow("tiktok", s.tiktokStatus === "READY", "Ready", "Not Open");
  document.getElementById("lastjob").textContent = s.lastJobId ? s.lastJobId.slice(0, 8) + "…" : "—";
  document.getElementById("lastaction").textContent = s.lastAction || "Idle";
}

async function refresh() {
  try {
    chrome.runtime.sendMessage({ type: "POPUP_GET_STATUS" }, (resp) => {
      if (chrome.runtime.lastError || !resp) return;
      render(resp);
    });
  } catch {}
}

document.addEventListener("DOMContentLoaded", () => {
  const m = chrome.runtime.getManifest();
  document.getElementById("version").textContent = `v${m.version} · Base44 Job Bridge`;
  refresh();
  setInterval(refresh, 1500);
});