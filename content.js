const MIN_INTERVAL_MS = 3_000;
const MIN_ALARM_INTERVAL_MS = 30_000;
const USER_ACTIVITY_PAUSE_MS = 10_000;
const INDICATOR_RESET_MS = 180;
const VISUAL_DELTA_PX = 12;

let enabled = false;
let intervalMs = 30_000;
let timeoutId = null;
let lastUserActivityAt = 0;
let lastPointer = {
  clientX: Math.floor(window.innerWidth / 2),
  clientY: Math.floor(window.innerHeight / 2),
  screenX: 0,
  screenY: 0
};
let jiggleDirection = 1;
let indicatorRoot = null;
let indicatorImage = null;
let indicatorResetTimeoutId = null;

function recordActivity(event) {
  lastUserActivityAt = Date.now();

  if (typeof event.clientX === "number" && typeof event.clientY === "number") {
    lastPointer = {
      clientX: event.clientX,
      clientY: event.clientY,
      screenX: typeof event.screenX === "number" ? event.screenX : lastPointer.screenX,
      screenY: typeof event.screenY === "number" ? event.screenY : lastPointer.screenY
    };
  }
}

function shouldPauseForUserActivity() {
  return Date.now() - lastUserActivityAt < USER_ACTIVITY_PAUSE_MS;
}

function getSafePointer() {
  const fallbackX = Math.max(0, Math.floor(window.innerWidth / 2));
  const fallbackY = Math.max(0, Math.floor(window.innerHeight / 2));

  const clientX = Number.isFinite(lastPointer.clientX) ? lastPointer.clientX : fallbackX;
  const clientY = Number.isFinite(lastPointer.clientY) ? lastPointer.clientY : fallbackY;
  const screenX = Number.isFinite(lastPointer.screenX) ? lastPointer.screenX : 0;
  const screenY = Number.isFinite(lastPointer.screenY) ? lastPointer.screenY : 0;

  return { clientX, clientY, screenX, screenY };
}

function ensureIndicator() {
  if (indicatorRoot || !enabled || !document.documentElement) {
    return;
  }

  indicatorRoot = document.createElement("div");
  indicatorRoot.setAttribute("data-jiggler-indicator", "true");
  indicatorRoot.style.cssText = [
    "position:fixed",
    "left:50%",
    "top:50%",
    "z-index:2147483647",
    "display:block",
    "pointer-events:none",
    "transform:translate3d(-50%,-50%,0)"
  ].join(";");

  indicatorImage = document.createElement("img");
  indicatorImage.src = chrome.runtime.getURL("assets/respect.webp");
  indicatorImage.alt = "Virtual cursor";
  indicatorImage.style.cssText = [
    "width:100px",
    "height:100px",
    "display:block",
    "object-fit:contain",
    "user-select:none",
    "-webkit-user-drag:none",
    "transform:translate3d(0,0,0)"
  ].join(";");

  indicatorRoot.append(indicatorImage);
  document.documentElement.appendChild(indicatorRoot);
}

function removeIndicator() {
  if (indicatorResetTimeoutId !== null) {
    clearTimeout(indicatorResetTimeoutId);
    indicatorResetTimeoutId = null;
  }

  indicatorRoot?.remove();
  indicatorRoot = null;
  indicatorImage = null;
}

function syncIndicator() {
  if (enabled) {
    ensureIndicator();
    return;
  }

  removeIndicator();
}

function moveIndicator() {
  if (!enabled) {
    return;
  }

  ensureIndicator();
  if (!indicatorRoot) {
    return;
  }

  const base = getSafePointer();
  indicatorRoot.style.left = `${Math.max(0, Math.round(base.clientX))}px`;
  indicatorRoot.style.top = `${Math.max(0, Math.round(base.clientY))}px`;
  indicatorRoot.style.transform = `translate3d(-50%,-50%,0)`;
  indicatorImage.style.transform = `translate3d(${jiggleDirection * VISUAL_DELTA_PX}px,0,0)`;

  if (indicatorResetTimeoutId !== null) {
    clearTimeout(indicatorResetTimeoutId);
  }

  indicatorResetTimeoutId = window.setTimeout(() => {
    if (!indicatorRoot) {
      return;
    }

    indicatorImage.style.transform = "translate3d(0,0,0)";
    indicatorResetTimeoutId = null;
  }, INDICATOR_RESET_MS);
}

function dispatchMinimalMousemove() {
  if (shouldPauseForUserActivity()) {
    return;
  }

  // Dispatch only two tiny synthetic events. No loops, no DOM writes, no layout
  // reads beyond the cached pointer position, which keeps the jiggler cheap.
  const base = getSafePointer();
  const delta = jiggleDirection;
  const targets = [document, window];
  const nextX = base.clientX + delta;
  const nextY = base.clientY;

  for (const target of targets) {
    target.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        cancelable: false,
        view: window,
        clientX: nextX,
        clientY: nextY,
        screenX: base.screenX + delta,
        screenY: base.screenY
      })
    );

    target.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        cancelable: false,
        view: window,
        clientX: base.clientX,
        clientY: base.clientY,
        screenX: base.screenX,
        screenY: base.screenY
      })
    );
  }

  console.info("System activity simulated to prevent sleep");
  console.info(`Virtual cursor moved to: ${nextX} ${nextY}`);
  console.info("Mouse moved to:", { x: nextX, y: nextY });

  moveIndicator();
  jiggleDirection *= -1;
}

function clearLocalTimer() {
  if (timeoutId !== null) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
}

function runLocalTick() {
  if (!enabled || intervalMs >= MIN_ALARM_INTERVAL_MS) {
    clearLocalTimer();
    return;
  }

  dispatchMinimalMousemove();
  timeoutId = window.setTimeout(runLocalTick, intervalMs);
}

function syncLocalScheduler() {
  clearLocalTimer();

  if (!enabled) {
    return;
  }

  if (intervalMs < MIN_ALARM_INTERVAL_MS) {
    timeoutId = window.setTimeout(runLocalTick, intervalMs);
  }
}

function applySettings(nextEnabled, nextIntervalMs) {
  const wasEnabled = enabled;
  enabled = Boolean(nextEnabled);
  intervalMs = Math.max(MIN_INTERVAL_MS, Number(nextIntervalMs) || MIN_ALARM_INTERVAL_MS);
  if (enabled && !wasEnabled) {
    // Allow the first scheduled jiggle to run on time after Start is pressed.
    lastUserActivityAt = 0;
  }
  syncIndicator();
  syncLocalScheduler();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "settings-updated") {
    applySettings(message.enabled, message.intervalMs);
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "stop") {
    applySettings(false, intervalMs);
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "jiggle") {
    dispatchMinimalMousemove();
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

const passiveListener = { passive: true };
window.addEventListener("mousemove", recordActivity, passiveListener);
window.addEventListener("mousedown", recordActivity, passiveListener);
window.addEventListener("keydown", recordActivity, passiveListener);
window.addEventListener("wheel", recordActivity, passiveListener);
window.addEventListener("touchstart", recordActivity, passiveListener);

chrome.runtime.sendMessage({ type: "get-settings" }, (settings) => {
  if (chrome.runtime.lastError || !settings) {
    return;
  }

  applySettings(settings.enabled, settings.intervalMs);
});
