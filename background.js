const SETTINGS_KEY = "settings";
const ALARM_NAME = "jiggle-alarm";
const DEFAULT_SETTINGS = {
  enabled: false,
  intervalMs: 30_000,
  showIndicator: true
};
const MIN_INTERVAL_MS = 3_000;
const MAX_INTERVAL_MS = 300_000;
const MIN_ALARM_INTERVAL_MS = 30_000;
const USER_ACTIVITY_PAUSE_MS = 30_000;

let pauseUntil = 0;

async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
}

async function saveSettings(nextSettings) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: nextSettings });
  return nextSettings;
}

function clampInterval(intervalMs) {
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Number(intervalMs) || DEFAULT_SETTINGS.intervalMs));
}

function normalizeSettings(settings) {
  return {
    enabled: Boolean(settings.enabled),
    intervalMs: clampInterval(settings.intervalMs),
    showIndicator: settings.showIndicator !== false
  };
}

async function syncKeepAwake(enabled) {
  if (enabled) {
    // The power API is the reliable idle-prevention mechanism. Synthetic
    // mouse events are used only as a minimal companion signal for pages.
    await chrome.power.requestKeepAwake("display");
    return;
  }

  await chrome.power.releaseKeepAwake();
}

async function broadcast(message) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id) {
        return;
      }

      try {
        await chrome.tabs.sendMessage(tab.id, message);
      } catch {
        // Ignore tabs without an injected content script (for example chrome://).
      }
    })
  );
}

async function schedule(settings) {
  await chrome.alarms.clear(ALARM_NAME);

  if (!settings.enabled) {
    pauseUntil = 0;
    await syncKeepAwake(false);
    await broadcast({ type: "stop" });
    return;
  }

  await syncKeepAwake(true);

  const nextAt = Date.now() + settings.intervalMs;
  if (settings.intervalMs >= MIN_ALARM_INTERVAL_MS) {
    // One-shot alarms let the worker reschedule around recent user activity
    // without running any persistent timers.
    await chrome.alarms.create(ALARM_NAME, { when: Math.max(nextAt, pauseUntil) });
  }

  await broadcast({
    type: "settings-updated",
    enabled: true,
    intervalMs: settings.intervalMs,
    showIndicator: settings.showIndicator
  });
}

async function applySettings(partialSettings = {}) {
  const current = await getSettings();
  const next = normalizeSettings({
    ...current,
    ...partialSettings
  });
  await saveSettings(next);
  await schedule(next);
  return next;
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = normalizeSettings(await getSettings());
  await saveSettings(settings);
  await schedule(settings);
});

chrome.runtime.onStartup.addListener(async () => {
  await schedule(normalizeSettings(await getSettings()));
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) {
    return;
  }

  const settings = normalizeSettings(await getSettings());
  if (!settings.enabled) {
    return;
  }

  if (Date.now() < pauseUntil) {
    await chrome.alarms.create(ALARM_NAME, { when: pauseUntil });
    return;
  }

  const [activeTab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });

  if (!activeTab?.id) {
    await chrome.alarms.create(ALARM_NAME, { when: Date.now() + settings.intervalMs });
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(activeTab.id, {
      type: "jiggle",
      showIndicator: settings.showIndicator
    });

    if (response?.deferredUntil) {
      pauseUntil = Math.max(pauseUntil, response.deferredUntil);
    }
  } catch {
    // Ignore pages where content scripts are unavailable.
  }

  if (settings.enabled) {
    const nextAt = Math.max(Date.now() + settings.intervalMs, pauseUntil);
    await chrome.alarms.create(ALARM_NAME, { when: nextAt });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    if (message?.type === "get-settings") {
      sendResponse(normalizeSettings(await getSettings()));
      return;
    }

    if (message?.type === "set-enabled") {
      sendResponse(await applySettings({ enabled: Boolean(message.enabled) }));
      return;
    }

    if (message?.type === "set-interval") {
      sendResponse(await applySettings({ intervalMs: message.intervalMs }));
      return;
    }

    if (message?.type === "set-show-indicator") {
      sendResponse(await applySettings({ showIndicator: Boolean(message.showIndicator) }));
      return;
    }

    if (message?.type === "user-activity") {
      pauseUntil = Date.now() + USER_ACTIVITY_PAUSE_MS;
      const settings = normalizeSettings(await getSettings());
      if (settings.enabled && settings.intervalMs >= MIN_ALARM_INTERVAL_MS) {
        await chrome.alarms.create(ALARM_NAME, { when: pauseUntil });
      }
      sendResponse({ ok: true, pauseUntil });
    }
  })();

  return true;
});
