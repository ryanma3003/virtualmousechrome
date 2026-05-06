const MIN_INTERVAL_MS = 5_000;
const MIN_ALARM_INTERVAL_MS = 30_000;
const USER_ACTIVITY_PAUSE_MS = 10_000;

let enabled = false;
let intervalMs = 30_000;
let timeoutId = null;
let lastUserActivityAt = Date.now();
let lastPointer = {
  clientX: Math.floor(window.innerWidth / 2),
  clientY: Math.floor(window.innerHeight / 2),
  screenX: 0,
  screenY: 0
};
let jiggleDirection = 1;

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

function dispatchMinimalMousemove() {
  if (shouldPauseForUserActivity()) {
    return;
  }

  // Dispatch only two tiny synthetic events. No loops, no DOM writes, no layout
  // reads beyond the cached pointer position, which keeps the jiggler cheap.
  const base = lastPointer;
  const delta = jiggleDirection;
  const targets = [document, window];

  for (const target of targets) {
    target.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        cancelable: false,
        view: window,
        clientX: base.clientX + delta,
        clientY: base.clientY,
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
  enabled = Boolean(nextEnabled);
  intervalMs = Math.max(MIN_INTERVAL_MS, Number(nextIntervalMs) || MIN_ALARM_INTERVAL_MS);
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
