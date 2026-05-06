const intervalSelect = document.getElementById("interval");
const showIndicatorCheckbox = document.getElementById("showIndicator");
const toggleButton = document.getElementById("toggleButton");
const statusBadge = document.getElementById("statusBadge");

function setBusy(busy) {
  intervalSelect.disabled = busy;
  showIndicatorCheckbox.disabled = busy;
  toggleButton.disabled = busy;
}

function render(settings) {
  intervalSelect.value = String(settings.intervalMs);
  showIndicatorCheckbox.checked = Boolean(settings.showIndicator);
  statusBadge.textContent = settings.enabled ? "Running" : "Stopped";
  statusBadge.className = `status ${settings.enabled ? "running" : "stopped"}`;
  toggleButton.textContent = settings.enabled ? "Stop" : "Start";
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }

      resolve(response);
    });
  });
}

async function refresh() {
  render(await sendMessage({ type: "get-settings" }));
}

intervalSelect.addEventListener("change", async () => {
  setBusy(true);
  try {
    const settings = await sendMessage({
      type: "set-interval",
      intervalMs: Number(intervalSelect.value)
    });
    render(settings);
  } finally {
    setBusy(false);
  }
});

showIndicatorCheckbox.addEventListener("change", async () => {
  setBusy(true);
  try {
    const settings = await sendMessage({
      type: "set-show-indicator",
      showIndicator: showIndicatorCheckbox.checked
    });
    render(settings);
  } finally {
    setBusy(false);
  }
});

toggleButton.addEventListener("click", async () => {
  setBusy(true);
  try {
    const current = await sendMessage({ type: "get-settings" });
    const settings = await sendMessage({
      type: "set-enabled",
      enabled: !current.enabled
    });
    render(settings);
  } finally {
    setBusy(false);
  }
});

void refresh();
