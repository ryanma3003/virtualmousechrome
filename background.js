const SETTINGS_KEY = "settings";
const ALARM_NAME = "jiggle-alarm";
const DEFAULT_SETTINGS = {
  enabled: false,
  intervalMs: 30_000
};
const MIN_ALARM_INTERVAL_MS = 30_000;

async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
}

async function saveSettings(nextSettings) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: nextSettings });
  return nextSettings;
}

function clampInterval(intervalMs) {
  return Math.max(3_000, Math.min(300_000, Number(intervalMs) || DEFAULT_SETTINGS.intervalMs));
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
    await syncKeepAwake(false);
    await broadcast({ type: "stop" });
    return;
  }

  await syncKeepAwake(true);

  if (settings.intervalMs >= MIN_ALARM_INTERVAL_MS) {
    await chrome.alarms.create(ALARM_NAME, {
      periodInMinutes: settings.intervalMs / 60_000
    });
  }

  await broadcast({
    type: "settings-updated",
    enabled: true,
    intervalMs: settings.intervalMs
  });
}

async function applySettings(partialSettings = {}) {
  const current = await getSettings();
  const next = {
    ...current,
    ...partialSettings
  };
  next.intervalMs = clampInterval(next.intervalMs);
  await saveSettings(next);
  await schedule(next);
  return next;
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await saveSettings({
    enabled: Boolean(settings.enabled),
    intervalMs: clampInterval(settings.intervalMs)
  });
  await schedule(await getSettings());
});

chrome.runtime.onStartup.addListener(async () => {
  await schedule(await getSettings());
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) {
    return;
  }

  const settings = await getSettings();
  if (!settings.enabled) {
    return;
  }

  const [activeTab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });

  if (!activeTab?.id) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(activeTab.id, { type: "jiggle" });
  } catch {
    // Ignore pages where content scripts are unavailable.
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    if (message?.type === "get-settings") {
      sendResponse(await getSettings());
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
  })();

  return true;
});
