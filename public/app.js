function debounce(callback, delay) {
  let timeoutId = null;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => callback(...args), delay);
  };
}

async function updateLiveResults(form) {
  const input = form.querySelector("[data-live-input]");
  const target = document.querySelector(form.dataset.target);
  const endpoint = form.dataset.endpoint;
  const showResultsWhenEmpty = form.dataset.showResultsWhenEmpty === "true";
  const emptyHtml = form.dataset.emptyHtml || "";

  if (!input || !target || !endpoint) {
    return;
  }

  const query = input.value.trim();
  if (!query && !showResultsWhenEmpty) {
    target.innerHTML = emptyHtml;
    return;
  }

  const params = new URLSearchParams();
  const inputName = form.dataset.queryParam || input.getAttribute("name") || "q";
  params.set(inputName, query);

  const response = await fetch(`${endpoint}?${params.toString()}`, {
    headers: {
      "X-Requested-With": "fetch",
    },
  });

  if (!response.ok) {
    return;
  }

  target.innerHTML = await response.text();
}

function wireLiveSearch() {
  const forms = document.querySelectorAll("[data-live-search-form]");
  for (const form of forms) {
    const input = form.querySelector("[data-live-input]");
    if (!input) {
      continue;
    }

    const debouncedUpdate = debounce(() => {
      updateLiveResults(form).catch(() => {});
    }, 180);

    input.addEventListener("input", debouncedUpdate);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      updateLiveResults(form).catch(() => {});
    });
  }
}

function wireNavState() {
  const pathname = window.location.pathname;
  const links = document.querySelectorAll(".nav-links a");

  for (const link of links) {
    const href = link.getAttribute("href");
    if (!href) {
      continue;
    }

    let isActive = false;
    if (href === "/") {
      isActive = pathname === "/";
    } else {
      isActive = pathname === href || pathname.startsWith(`${href}/`);
    }

    link.classList.toggle("nav-link-active", isActive);
  }
}

function closeAllCombos(except = null) {
  document.querySelectorAll("[data-combo-box]").forEach((combo) => {
    if (combo === except) {
      return;
    }
    const panel = combo.querySelector("[data-combo-panel]");
    if (panel) {
      panel.hidden = true;
    }
    combo.classList.remove("combo-open");
  });
}

function wireComboBoxes(root = document) {
  const combos = root.querySelectorAll("[data-combo-box]");

  for (const combo of combos) {
    if (combo.dataset.comboBound === "true") {
      continue;
    }
    combo.dataset.comboBound = "true";

    const input = combo.querySelector("[data-combo-input]");
    const hidden = combo.querySelector("[data-combo-hidden]");
    const panel = combo.querySelector("[data-combo-panel]");
    const toggle = combo.querySelector("[data-combo-toggle]");
    const empty = combo.querySelector("[data-combo-empty]");
    const options = Array.from(combo.querySelectorAll("[data-combo-option]"));
    const requiredMessage = combo.dataset.requiredMessage || "Choose an option from the list.";

    if (!input || !hidden || !panel || !toggle) {
      continue;
    }

    let activeIndex = -1;

    const visibleOptions = () => options.filter((option) => !option.hidden);

    const normalizedValue = (value) => value.trim().toLowerCase();

    const setActiveOption = (index) => {
      visibleOptions().forEach((option, visibleIndex) => {
        option.classList.toggle("combo-option-active", visibleIndex === index);
      });
      activeIndex = index;
    };

    const syncVisibleOptions = () => {
      const query = normalizedValue(input.value);
      let visibleCount = 0;

      for (const option of options) {
        const haystack = option.dataset.searchText || option.dataset.label?.toLowerCase() || "";
        const matches = !query || haystack.includes(query);
        option.hidden = !matches;
        option.style.display = matches ? "" : "none";
        option.setAttribute("aria-hidden", matches ? "false" : "true");
        if (matches) {
          visibleCount += 1;
        }
      }

      if (empty) {
        empty.hidden = visibleCount !== 0;
      }

      setActiveOption(visibleCount > 0 ? 0 : -1);
    };

    const syncSelectionFromInput = () => {
      const query = normalizedValue(input.value);
      const exactMatch = options.find((option) => normalizedValue(option.dataset.label || "") === query);

      if (!exactMatch) {
        return false;
      }

      hidden.value = exactMatch.dataset.value || "";
      input.value = exactMatch.dataset.label || "";
      input.setCustomValidity("");
      return true;
    };

    const openPanel = () => {
      closeAllCombos(combo);
      syncVisibleOptions();
      panel.hidden = false;
      combo.classList.add("combo-open");
    };

    const closePanel = () => {
      panel.hidden = true;
      combo.classList.remove("combo-open");
    };

    const clearSelection = () => {
      hidden.value = "";
      input.setCustomValidity("");
    };

    const selectOption = (option) => {
      input.value = option.dataset.label || "";
      hidden.value = option.dataset.value || "";
      input.setCustomValidity("");
      closePanel();
      window.requestAnimationFrame(() => {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
    };

    input.addEventListener("focus", openPanel);
    input.addEventListener("click", openPanel);
    input.addEventListener("input", () => {
      clearSelection();
      openPanel();
    });

    toggle.addEventListener("click", () => {
      if (panel.hidden) {
        openPanel();
      } else {
        closePanel();
      }
    });

    options.forEach((option) => {
      option.addEventListener("mousedown", (event) => {
        event.preventDefault();
      });
      option.addEventListener("click", () => selectOption(option));
    });

    input.form?.addEventListener("submit", (event) => {
      if (input.hasAttribute("required") && !hidden.value) {
        event.preventDefault();
        input.setCustomValidity(requiredMessage);
        input.reportValidity();
      } else {
        input.setCustomValidity("");
      }
    });

    combo.addEventListener("keydown", (event) => {
      const currentVisible = visibleOptions();

      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && panel.hidden) {
        openPanel();
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (!currentVisible.length) {
          return;
        }
        const nextIndex = Math.min(activeIndex + 1, currentVisible.length - 1);
        setActiveOption(nextIndex);
        currentVisible[nextIndex]?.scrollIntoView({ block: "nearest" });
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (!currentVisible.length) {
          return;
        }
        const nextIndex = Math.max(activeIndex - 1, 0);
        setActiveOption(nextIndex);
        currentVisible[nextIndex]?.scrollIntoView({ block: "nearest" });
      }

      if (event.key === "Enter" && !panel.hidden) {
        const activeOption = currentVisible[activeIndex] || currentVisible[0];
        if (activeOption) {
          event.preventDefault();
          selectOption(activeOption);
        } else if (syncSelectionFromInput()) {
          event.preventDefault();
          closePanel();
        }
      }

      if (event.key === "Escape") {
        closePanel();
        input.blur();
      }
    });

    input.addEventListener("blur", () => {
      window.setTimeout(() => {
        syncSelectionFromInput();
        if (!combo.contains(document.activeElement)) {
          closePanel();
        }
      }, 120);
    });
  }

  if (document.body.dataset.comboDocumentBound !== "true") {
    document.body.dataset.comboDocumentBound = "true";
    document.addEventListener("click", (event) => {
      const combo = event.target.closest("[data-combo-box]");
      if (!combo) {
        closeAllCombos();
      }
    });
  }
}

function wireAdjustmentForms() {
  const forms = document.querySelectorAll("[data-adjustment-form]");

  for (const form of forms) {
    if (form.dataset.adjustmentBound === "true") {
      continue;
    }
    form.dataset.adjustmentBound = "true";

    const lines = form.querySelector("[data-adjustment-lines]");
    const template = form.querySelector("template[data-adjustment-template]");
    const addButton = form.querySelector("[data-adjustment-add]");

    if (!lines || !template || !addButton) {
      continue;
    }

    let nextIndex = lines.querySelectorAll("[data-adjustment-line]").length;

    const refreshLineControls = () => {
      const currentLines = Array.from(lines.querySelectorAll("[data-adjustment-line]"));
      currentLines.forEach((line) => {
        const removeButton = line.querySelector("[data-adjustment-remove]");
        if (removeButton) {
          removeButton.disabled = currentLines.length <= 1;
        }
      });
    };

    addButton.addEventListener("click", () => {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = template.innerHTML.replaceAll("__INDEX__", String(nextIndex)).trim();
      const line = wrapper.firstElementChild;
      if (!line) {
        return;
      }
      lines.appendChild(line);
      wireComboBoxes(line);
      nextIndex += 1;
      refreshLineControls();
      line.querySelector("[data-combo-input]")?.focus();
    });

    form.addEventListener("click", (event) => {
      const removeButton = event.target.closest("[data-adjustment-remove]");
      if (!removeButton) {
        return;
      }
      if (lines.querySelectorAll("[data-adjustment-line]").length <= 1) {
        return;
      }
      removeButton.closest("[data-adjustment-line]")?.remove();
      refreshLineControls();
    });

    refreshLineControls();
  }
}

function firmwareStageLabel(stage) {
  const labels = {
    queued: "Queued",
    compiling: "Compiling",
    uploading: "Uploading",
    configuring: "Configuring",
    completed: "Completed",
    failed: "Failed",
  };
  return labels[stage] || "Running";
}

function renderFirmwareModules(target, modules = []) {
  if (!target) {
    return;
  }

  target.replaceChildren();
  for (const moduleNumber of modules) {
    const chip = document.createElement("span");
    chip.className = "module-chip";
    chip.textContent = `Module ${moduleNumber}`;
    target.appendChild(chip);
  }
  target.hidden = modules.length === 0;
}

function normalizeFirmwarePorts(ports = []) {
  return ports.map((port) => {
    if (typeof port === "string") {
      return {
        path: port,
        label: port.split("/").pop() || port,
        recommended: true,
      };
    }
    return port;
  });
}

function firmwarePortIdentity(port) {
  return port.deviceIdentity || port.path;
}

function firmwareTtyPath(port) {
  if (port.ttyPath) {
    return port.ttyPath;
  }
  return (port.aliases || []).find((alias) => /\/dev\/(?:tty|cu)[A-Za-z0-9._-]+$/.test(alias)) || "";
}

function appendFirmwarePortMeta(parent, label, value) {
  if (!value) {
    return;
  }
  const meta = document.createElement("span");
  meta.className = "firmware-port-meta";
  const strong = document.createElement("strong");
  strong.textContent = label;
  const code = document.createElement("code");
  code.textContent = value;
  meta.append(strong, code);
  parent.appendChild(meta);
}

function getFirmwareBaseline(panel) {
  try {
    return new Set(JSON.parse(panel.dataset.firmwareBaseline || "[]"));
  } catch {
    return new Set();
  }
}

function setFirmwareBaseline(panel, ports) {
  const identities = ports.map((port) => firmwarePortIdentity(port)).filter(Boolean);
  panel.dataset.firmwareBaseline = JSON.stringify(identities);
  panel.dataset.firmwareBaselineCount = String(identities.length);
}

function hasFirmwareBaseline(panel) {
  return Boolean(panel.dataset.firmwareBaseline);
}

function clearFirmwareSelection(panel) {
  const input = panel.querySelector("[data-firmware-port-input]");
  const identityInput = panel.querySelector("[data-firmware-device-identity]");
  if (input) {
    input.value = "";
  }
  if (identityInput) {
    identityInput.value = "";
  }
  panel.querySelectorAll("[data-firmware-port-choice]").forEach((choice) => {
    choice.classList.remove("firmware-port-choice-active");
  });
}

function syncFirmwareSubmitState(panel) {
  const input = panel.querySelector("[data-firmware-port-input]");
  const identity = panel.querySelector("[data-firmware-device-identity]");
  const submitButton = panel.querySelector("[data-firmware-flash-form] button[type='submit']");
  if (submitButton && input && identity) {
    submitButton.disabled = !input.value.trim() || !identity.value.trim();
  }
}

function renderFirmwarePortList(panel, ports, selectedPort) {
  const target = panel.querySelector("[data-firmware-port-list]");
  if (!target) {
    return;
  }

  target.replaceChildren();
  if (!ports.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = hasFirmwareBaseline(panel)
      ? "No added serial device detected yet. Plug in the ESP32 USB cable, then click Detect added ESP32."
      : "Unplug the ESP32 and click Scan without ESP32 to capture the current peripherals first.";
    target.appendChild(empty);
    return;
  }

  for (const port of ports) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "firmware-port-choice";
    if (port.path === selectedPort) {
      button.classList.add("firmware-port-choice-active");
    }
    button.dataset.firmwarePortChoice = "true";
    button.dataset.portPath = port.path;
    button.dataset.deviceIdentity = firmwarePortIdentity(port) || "";

    const label = document.createElement("strong");
    label.textContent = port.newlyConnected
      ? "Added serial device"
      : port.flashRecord?.deviceName || port.deviceName || "ESP32 controller";
    const badge = document.createElement("span");
    const flashed = port.flashStatus === "configured";
    badge.className = `badge ${flashed ? "badge-flashed" : "badge-new"}`;
    badge.textContent = flashed ? "flashed" : port.badge || "new";
    const summary = document.createElement("span");
    summary.className = "firmware-device-summary";
    if (flashed && port.flashRecord) {
      const flashedBy = port.flashRecord.flashedBy?.name || port.flashRecord.flashedBy?.username || "unknown user";
      const configuredAt = port.flashRecord.configuredAt
        ? new Date(port.flashRecord.configuredAt).toLocaleString()
        : "unknown time";
      summary.textContent = `Already flashed · ${port.flashRecord.moduleCount} LED module(s) · ${configuredAt} · by ${flashedBy}`;
    } else {
      summary.textContent = port.newlyConnected
        ? "New serial device detected after refresh. Select it only if this is the ESP32."
        : "ESP32 candidate. Flash this controller before mapping cells.";
    }

    button.append(label, badge);
    appendFirmwarePortMeta(button, "Flash path", port.path);
    appendFirmwarePortMeta(button, "TTY alias", firmwareTtyPath(port));
    button.append(summary);
    target.appendChild(button);
  }
}

function renderOtherFirmwareDevices(panel, ports, primaryPorts) {
  const details = panel.querySelector("[data-firmware-other-devices]");
  const target = panel.querySelector("[data-firmware-other-device-list]");
  if (!details || !target) {
    return;
  }

  const primary = new Set(primaryPorts.map((port) => firmwarePortIdentity(port)));
  const otherPorts = ports.filter((port) => !primary.has(firmwarePortIdentity(port)));
  target.replaceChildren();
  details.hidden = otherPorts.length === 0;

  for (const port of otherPorts) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "firmware-other-device";
    item.dataset.firmwarePortChoice = "true";
    item.dataset.portPath = port.path;
    item.dataset.deviceIdentity = firmwarePortIdentity(port) || "";
    const name = document.createElement("strong");
    name.textContent = port.deviceName || port.label || "Serial device";
    const reason = document.createElement("span");
    reason.textContent =
      port.flashStatus === "configured"
        ? "Previously configured ESP32. Select to reflash."
        : "Existing serial device. Select only if this is the ESP32 you want to flash.";
    item.append(name);
    appendFirmwarePortMeta(item, "Flash path", port.path);
    appendFirmwarePortMeta(item, "TTY alias", firmwareTtyPath(port));
    item.append(reason);
    target.appendChild(item);
  }
}

function updateFirmwarePorts(panel, options, { captureBaseline = false, mode = "detect" } = {}) {
  const ports = normalizeFirmwarePorts(options.ports || []);
  const esp32Ports = normalizeFirmwarePorts(options.esp32Ports || options.ports || []);
  const input = panel.querySelector("[data-firmware-port-input]");
  const identityInput = panel.querySelector("[data-firmware-device-identity]");
  const datalist = panel.querySelector("#firmware-ports");
  const status = panel.querySelector("[data-firmware-port-status]");
  const currentPort = input?.value.trim() || "";

  if (captureBaseline) {
    setFirmwareBaseline(panel, ports);
  }

  const baseline = getFirmwareBaseline(panel);
  const baselineAvailable = hasFirmwareBaseline(panel);
  const esp32Identities = new Set(esp32Ports.map((port) => firmwarePortIdentity(port)));
  let primaryPorts = ports
    .map((port) => ({
      ...port,
      newlyConnected: !baseline.has(firmwarePortIdentity(port)),
    }))
    .filter(
      (port) =>
        baselineAvailable
          ? port.newlyConnected
          : port.flashStatus === "configured" && esp32Identities.has(firmwarePortIdentity(port)),
    );
  if (mode === "baseline") {
    primaryPorts = [];
  }
  const selectedCandidate =
    primaryPorts.find((port) => port.path === currentPort) ||
    primaryPorts.find((port) => port.newlyConnected) ||
    primaryPorts.find((port) => port.flashStatus === "configured") ||
    null;
  const selectedPort = selectedCandidate?.path || "";

  if (datalist) {
    datalist.replaceChildren();
    for (const port of primaryPorts) {
      const option = document.createElement("option");
      option.value = port.path;
      option.label = port.deviceName || port.label || port.path;
      datalist.appendChild(option);
    }
  }

  if (input) {
    input.value = selectedPort;
  }
  if (identityInput) {
    identityInput.value = selectedCandidate ? firmwarePortIdentity(selectedCandidate) : "";
  }

  if (status) {
    const newCount = primaryPorts.filter((port) => port.newlyConnected).length;
    const flashedCount = primaryPorts.filter((port) => port.flashStatus === "configured").length;
    if (mode === "baseline") {
      status.textContent = `Baseline saved with ${ports.length} serial device${ports.length === 1 ? "" : "s"}. Now plug in the ESP32 and click Detect added ESP32.`;
    } else if (newCount > 0) {
      status.textContent = `New serial device connected. If this is the ESP32, select it and flash it.`;
    } else if (flashedCount > 0) {
      status.textContent = `${flashedCount} already flashed ESP32 controller${flashedCount === 1 ? "" : "s"} detected.`;
    } else if (baselineAvailable) {
      status.textContent =
        "No newly added serial device detected. Keep the existing peripherals connected, plug in the ESP32, then click Detect added ESP32 again.";
    } else {
      status.textContent =
        "Start by unplugging the ESP32 and clicking Scan without ESP32. Then plug in the ESP32 and detect the added port.";
    }
    status.classList.toggle("firmware-port-status-ok", primaryPorts.length > 0);
    status.classList.toggle("firmware-port-status-missing", primaryPorts.length === 0);
  }

  renderFirmwarePortList(panel, primaryPorts, selectedPort);
  renderOtherFirmwareDevices(panel, ports, primaryPorts);
  syncFirmwareSubmitState(panel);
}

async function refreshFirmwarePorts(panel, settings = {}) {
  const buttons = panel.querySelectorAll("[data-firmware-scan-baseline], [data-firmware-refresh-ports]");
  const status = panel.querySelector("[data-firmware-port-status]");
  for (const button of buttons) {
    button.disabled = true;
  }
  if (status) {
    status.textContent =
      settings.mode === "baseline"
        ? "Scanning current serial devices. Keep the ESP32 unplugged..."
        : "Checking for a serial device added after the baseline scan...";
  }

  try {
    const response = await fetch("/api/firmware/options", {
      headers: {
        "X-Requested-With": "fetch",
      },
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Serial ports could not be refreshed.");
    }
    updateFirmwarePorts(panel, payload, {
      captureBaseline: settings.captureBaseline === true,
      mode: settings.mode || "detect",
    });
  } catch (error) {
    if (status) {
      status.textContent = error.message;
      status.classList.add("firmware-port-status-missing");
      status.classList.remove("firmware-port-status-ok");
    }
  } finally {
    syncFirmwareSubmitState(panel);
    for (const button of buttons) {
      button.disabled = false;
    }
  }
}

function updateFirmwarePanel(panel, job) {
  const progressWrap = panel.querySelector("[data-firmware-progress]");
  const progressBar = panel.querySelector("[data-firmware-progress-bar]");
  const stage = panel.querySelector("[data-firmware-stage]");
  const percent = panel.querySelector("[data-firmware-percent]");
  const log = panel.querySelector("[data-firmware-log]");
  const modules = panel.querySelector("[data-firmware-modules]");
  const hint = panel.querySelector("[data-firmware-hint]");

  if (progressWrap) {
    progressWrap.hidden = false;
    progressWrap.dataset.status = job.status || "running";
  }
  if (progressBar) {
    progressBar.value = Number(job.progress || 0);
  }
  if (stage) {
    stage.textContent = job.error || firmwareStageLabel(job.stage);
  }
  if (percent) {
    percent.textContent = `${Math.round(Number(job.progress || 0))}%`;
  }
  if (log) {
    log.textContent = (job.logs || []).map((entry) => entry.line || "").join("\n");
    log.scrollTop = log.scrollHeight;
  }
  if (hint) {
    hint.textContent = job.recoveryHint || "";
    hint.hidden = !job.recoveryHint;
  }
  if (job.status === "completed") {
    renderFirmwareModules(modules, job.assignedModules || []);
  }
}

function showFirmwareError(panel, message) {
  updateFirmwarePanel(panel, {
    status: "failed",
    stage: "failed",
    progress: 100,
    error: message,
    logs: [{ line: `ERROR: ${message}` }],
  });
}

async function pollFirmwareJob(panel, jobId, submitButton) {
  const response = await fetch(`/api/firmware/jobs/${encodeURIComponent(jobId)}`, {
    headers: {
      "X-Requested-With": "fetch",
    },
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Firmware job status could not be loaded.");
  }

  updateFirmwarePanel(panel, payload.job);

  if (payload.job.status === "running") {
    window.setTimeout(() => {
      pollFirmwareJob(panel, jobId, submitButton).catch((error) => {
        showFirmwareError(panel, error.message);
        if (submitButton) {
          submitButton.disabled = false;
        }
      });
    }, 900);
    return;
  }

  if (submitButton) {
    submitButton.disabled = false;
  }

  if (payload.job.status === "completed") {
    window.setTimeout(() => {
      window.location.reload();
    }, 1200);
  }
}

function wireFirmwareFlash() {
  const forms = document.querySelectorAll("[data-firmware-flash-form]");

  for (const form of forms) {
    if (form.dataset.firmwareBound === "true") {
      continue;
    }
    form.dataset.firmwareBound = "true";
    const panel = form.closest("[data-firmware-panel]");

    if (panel) {
      panel.addEventListener("click", (event) => {
        const baselineButton = event.target.closest("[data-firmware-scan-baseline]");
        if (baselineButton) {
          refreshFirmwarePorts(panel, { captureBaseline: true, mode: "baseline" })
            .then(() => {
              clearFirmwareSelection(panel);
              syncFirmwareSubmitState(panel);
            })
            .catch(() => {});
          return;
        }

        const refreshButton = event.target.closest("[data-firmware-refresh-ports]");
        if (refreshButton) {
          refreshFirmwarePorts(panel, { mode: "detect" }).catch(() => {});
          return;
        }

        const portChoice = event.target.closest("[data-firmware-port-choice]");
        if (!portChoice) {
          return;
        }

        const input = panel.querySelector("[data-firmware-port-input]");
        const identityInput = panel.querySelector("[data-firmware-device-identity]");
        if (input) {
          input.value = portChoice.dataset.portPath || "";
        }
        if (identityInput) {
          identityInput.value = portChoice.dataset.deviceIdentity || "";
        }
        panel.querySelectorAll("[data-firmware-port-choice]").forEach((choice) => {
          choice.classList.toggle("firmware-port-choice-active", choice === portChoice);
        });
        syncFirmwareSubmitState(panel);
      });

      const portInput = panel.querySelector("[data-firmware-port-input]");
      portInput?.addEventListener("input", () => {
        const identityInput = panel.querySelector("[data-firmware-device-identity]");
        if (identityInput) {
          identityInput.value = "";
        }
        syncFirmwareSubmitState(panel);
      });
      syncFirmwareSubmitState(panel);
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const panel = form.closest("[data-firmware-panel]");
      const submitButton = form.querySelector('button[type="submit"]');
      if (!panel) {
        return;
      }

      if (submitButton) {
        submitButton.disabled = true;
      }
      updateFirmwarePanel(panel, {
        status: "running",
        stage: "queued",
        progress: 3,
        logs: [{ line: "Starting firmware job..." }],
      });

      try {
        const response = await fetch("/api/firmware/flash", {
          method: "POST",
          headers: {
            "X-Requested-With": "fetch",
          },
          body: new URLSearchParams(new FormData(form)),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "Firmware job could not be started.");
        }

        updateFirmwarePanel(panel, payload.job);
        await pollFirmwareJob(panel, payload.job.id, submitButton);
      } catch (error) {
        showFirmwareError(panel, error.message);
        if (submitButton) {
          submitButton.disabled = false;
        }
      }
    });
  }
}

const LOCATION_LOCATE_TIMEOUT_MS = 120000;
const activeLocates = new Map();

function setLocateButtonState(button, active) {
  if (!button) {
    return;
  }
  button.classList.toggle("locate-button-active", active);
  button.setAttribute("aria-pressed", active ? "true" : "false");
  button.textContent = active ? "Locating" : "Locate";
}

async function sendLocateCommand(cellId, active) {
  const body = new URLSearchParams();
  body.set("active", active ? "1" : "0");

  const response = await fetch(`/api/cells/${encodeURIComponent(cellId)}/locate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "fetch",
    },
    body,
  });
  const payload = await response.json();
  if (!response.ok || payload.degraded) {
    throw new Error(payload.error || payload.message || "Locate command failed.");
  }
  return payload;
}

function clearLocateUi(cellId) {
  const activeLocate = activeLocates.get(String(cellId));
  if (!activeLocate) {
    return;
  }
  window.clearTimeout(activeLocate.timeoutId);
  setLocateButtonState(activeLocate.button, false);
  activeLocates.delete(String(cellId));
}

function clearAllLocateUi() {
  for (const cellId of Array.from(activeLocates.keys())) {
    clearLocateUi(cellId);
  }
}

function sendLocateClearAll() {
  const body = new URLSearchParams();
  body.set("active", "0");
  if (navigator.sendBeacon) {
    const blob = new Blob([body.toString()], {
      type: "application/x-www-form-urlencoded; charset=UTF-8",
    });
    navigator.sendBeacon("/api/cells/locate/clear-all", blob);
    return;
  }

  fetch("/api/cells/locate/clear-all", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "fetch",
    },
    body,
    keepalive: true,
  }).catch(() => {});
}

function wireLocationLocate() {
  const page = document.querySelector("[data-location-page]");
  if (!page || page.dataset.locateBound === "true") {
    return;
  }
  page.dataset.locateBound = "true";

  page.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-locate-cell]");
    if (!button) {
      return;
    }

    const cellId = button.dataset.cellId;
    if (!cellId || button.disabled) {
      return;
    }

    const activeEntry = activeLocates.get(String(cellId));
    button.disabled = true;

    try {
      if (activeEntry) {
        await sendLocateCommand(cellId, false);
        clearLocateUi(cellId);
        return;
      }

      await sendLocateCommand(cellId, true);
      setLocateButtonState(button, true);
      activeLocates.set(String(cellId), {
        button,
        timeoutId: window.setTimeout(() => {
          if (!activeLocates.has(String(cellId))) {
            return;
          }
          sendLocateCommand(cellId, false).catch(() => {}).finally(() => clearLocateUi(cellId));
        }, LOCATION_LOCATE_TIMEOUT_MS),
      });
    } catch (error) {
      button.textContent = "Failed";
      window.setTimeout(() => {
        if (!activeLocates.has(String(cellId))) {
          setLocateButtonState(button, false);
        }
      }, 1400);
    } finally {
      button.disabled = false;
    }
  });

  window.addEventListener("pagehide", () => {
    sendLocateClearAll();
    clearAllLocateUi();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  wireNavState();
  wireLiveSearch();
  wireComboBoxes();
  wireAdjustmentForms();
  wireFirmwareFlash();
  wireLocationLocate();
});
