function debounce(callback, delay) {
  let timeoutId = null;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => callback(...args), delay);
  };
}

const ACTION_SCROLL_KEY = "inventory-management:action-scroll";

function saveActionScrollPosition() {
  try {
    window.sessionStorage.setItem(
      ACTION_SCROLL_KEY,
      JSON.stringify({
        pathname: window.location.pathname,
        x: window.scrollX,
        y: window.scrollY,
        savedAt: Date.now(),
      }),
    );
  } catch {
    // Session storage can be unavailable in strict browser modes.
  }
}

function restoreActionScrollPosition() {
  let position = null;

  try {
    const raw = window.sessionStorage.getItem(ACTION_SCROLL_KEY);
    if (!raw) {
      return;
    }
    window.sessionStorage.removeItem(ACTION_SCROLL_KEY);
    position = JSON.parse(raw);
  } catch {
    return;
  }

  if (!position || position.pathname !== window.location.pathname || Date.now() - Number(position.savedAt || 0) > 15000) {
    return;
  }

  const left = Number(position.x || 0);
  const top = Number(position.y || 0);
  if (!Number.isFinite(top)) {
    return;
  }

  const previousScrollRestoration =
    "scrollRestoration" in window.history ? window.history.scrollRestoration : null;
  if (previousScrollRestoration !== null) {
    window.history.scrollRestoration = "manual";
  }

  const restore = () => {
    window.scrollTo({
      left: Number.isFinite(left) ? left : 0,
      top,
      behavior: "auto",
    });
  };

  window.requestAnimationFrame(() => {
    restore();
    window.requestAnimationFrame(restore);
    window.setTimeout(() => {
      restore();
      if (previousScrollRestoration !== null) {
        window.history.scrollRestoration = previousScrollRestoration;
      }
    }, 120);
  });
}

function currentReturnPath(fallbackHash = "") {
  const hash = window.location.hash || fallbackHash || "";
  return `${window.location.pathname}${window.location.search}${hash}`;
}

function restoreAttribute(element, name, value) {
  if (value === undefined || value === "__unset__") {
    element.removeAttribute(name);
    return;
  }
  element.setAttribute(name, value);
}

function setButtonLoading(button, loading, options = {}) {
  if (!button) {
    return;
  }

  const isIconButton =
    button.classList.contains("icon-button") ||
    (button.children.length === 1 && Boolean(button.querySelector(".button-icon")));

  if (loading) {
    if (button.dataset.loadingActive === "true") {
      return;
    }

    const label =
      options.label ||
      button.dataset.loadingLabel ||
      button.dataset.ledLoadingLabel ||
      "Working";
    const title = options.title || button.dataset.loadingTitle || label;

    button.dataset.loadingActive = "true";
    button.dataset.loadingOriginalHtml = button.innerHTML;
    button.dataset.loadingOriginalDisabled = button.disabled ? "true" : "false";
    button.dataset.loadingOriginalTitle = button.getAttribute("title") ?? "__unset__";
    button.dataset.loadingOriginalAriaLabel = button.getAttribute("aria-label") ?? "__unset__";
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.setAttribute("aria-label", title);
    button.setAttribute("title", title);
    button.classList.add("button-loading");

    if (isIconButton) {
      button.classList.add("icon-button-loading");
      return;
    }

    button.textContent = "";
    const spinner = document.createElement("span");
    spinner.className = "button-spinner";
    spinner.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = label;
    button.append(spinner, text);
    return;
  }

  if (button.dataset.loadingActive !== "true") {
    return;
  }

  if (button.dataset.loadingOriginalHtml !== undefined) {
    button.innerHTML = button.dataset.loadingOriginalHtml;
  }
  button.disabled = button.dataset.loadingOriginalDisabled === "true";
  button.removeAttribute("aria-busy");
  restoreAttribute(button, "title", button.dataset.loadingOriginalTitle);
  restoreAttribute(button, "aria-label", button.dataset.loadingOriginalAriaLabel);
  button.classList.remove("button-loading", "icon-button-loading");
  delete button.dataset.loadingActive;
  delete button.dataset.loadingOriginalHtml;
  delete button.dataset.loadingOriginalDisabled;
  delete button.dataset.loadingOriginalTitle;
  delete button.dataset.loadingOriginalAriaLabel;
}

function findFormSubmitButton(form, event, selector) {
  if (event?.submitter?.matches?.(selector)) {
    return event.submitter;
  }

  const localButton = form.querySelector(selector);
  if (localButton) {
    return localButton;
  }

  if (!form.id) {
    return null;
  }

  return Array.from(document.querySelectorAll(selector)).find(
    (button) => button.getAttribute("form") === form.id,
  );
}

function wireActionScrollRestore() {
  restoreActionScrollPosition();

  document.addEventListener("submit", (event) => {
    if (event.defaultPrevented) {
      return;
    }

    const form = event.target;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }

    const method = (form.getAttribute("method") || "get").toLowerCase();
    if (method !== "post" || form.target || form.dataset.disableScrollRestore === "true") {
      return;
    }

    saveActionScrollPosition();
  });
}

function wireControllerHealthForms() {
  document.querySelectorAll("[data-controller-health-form]").forEach((form) => {
    if (form.dataset.controllerHealthBound === "true") {
      return;
    }
    form.dataset.controllerHealthBound = "true";

    form.addEventListener("submit", (event) => {
      if (event.defaultPrevented) {
        return;
      }

      const returnTo = form.querySelector("[data-controller-health-return-to]");
      if (returnTo) {
        returnTo.value = currentReturnPath("#controller-health");
      }

      const button = form.querySelector("[data-controller-health-submit]");
      if (!button) {
        return;
      }

      window.setTimeout(() => {
        setButtonLoading(button, true, {
          label: "Checking",
          title: "Checking controller health",
        });
      }, 0);
    });
  });
}

function wireLedCommandForms() {
  document.querySelectorAll("[data-led-command-form]").forEach((form) => {
    if (form.dataset.ledCommandBound === "true") {
      return;
    }
    form.dataset.ledCommandBound = "true";

    form.addEventListener("submit", (event) => {
      if (event.defaultPrevented) {
        return;
      }

      const returnTo = form.querySelector("[data-led-command-return-to]");
      if (returnTo) {
        returnTo.value = currentReturnPath(form.dataset.ledReturnHash || "");
      }

      const button = findFormSubmitButton(form, event, "[data-led-command-submit]");
      if (!button) {
        return;
      }

      window.setTimeout(() => {
        setButtonLoading(button, true, {
          label: button.dataset.ledLoadingLabel || form.dataset.ledLoadingLabel || "Sending",
          title: button.dataset.ledLoadingTitle || form.dataset.ledLoadingTitle || "Sending command",
        });
      }, 0);
    });
  });
}

function wireToasts() {
  document.querySelectorAll("[data-toast]").forEach((toast) => {
    if (toast.dataset.toastBound === "true") {
      return;
    }
    toast.dataset.toastBound = "true";

    const close = toast.querySelector("[data-toast-close]");
    const dismiss = () => {
      toast.hidden = true;
      if (!toast.parentElement?.querySelector("[data-toast]:not([hidden])")) {
        toast.parentElement?.remove();
      }
    };

    close?.addEventListener("click", dismiss);
    window.setTimeout(dismiss, 7000);
  });
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
    const rowCollapser = target.closest("[data-row-collapser]");
    if (rowCollapser) {
      resetRowCollapser(rowCollapser);
      wireRowCollapsers(rowCollapser);
    }
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
  const rowCollapser = target.closest("[data-row-collapser]");
  if (rowCollapser) {
    resetRowCollapser(rowCollapser);
    wireRowCollapsers(rowCollapser);
  }
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

    const syncVisibleOptions = (forcedQuery = null) => {
      const query = normalizedValue(forcedQuery === null ? input.value : forcedQuery);
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

    const inputMatchesSelection = () =>
      options.some(
        (option) =>
          option.dataset.value === hidden.value &&
          normalizedValue(option.dataset.label || "") === normalizedValue(input.value),
      );

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

    const openPanel = ({ showAll = false } = {}) => {
      closeAllCombos(combo);
      syncVisibleOptions(showAll ? "" : null);
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

    input.addEventListener("focus", () => openPanel({ showAll: inputMatchesSelection() }));
    input.addEventListener("click", () => openPanel({ showAll: inputMatchesSelection() }));
    input.addEventListener("input", () => {
      clearSelection();
      openPanel();
    });

    toggle.addEventListener("click", () => {
      if (panel.hidden) {
        openPanel({ showAll: true });
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
        openPanel({ showAll: inputMatchesSelection() });
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

function wirePutPlanForms() {
  const sections = document.querySelectorAll("[data-put-plan-form]");

  for (const section of sections) {
    if (section.dataset.putPlanBound === "true") {
      continue;
    }
    section.dataset.putPlanBound = "true";

    const lines = section.querySelector("[data-put-plan-lines]");
    const template = section.querySelector("template[data-put-plan-template]");
    const addButton = section.querySelector("[data-put-plan-add]");
    const totalLabel = section.querySelector("[data-put-plan-total]");
    const submitButton = section.querySelector("[data-put-plan-submit]");
    const expectedTotal = Number(section.dataset.expectedTotal || 0);
    let nextIndex = 1;

    const formatQuantity = (value) =>
      Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
    const quantityInputs = () => Array.from(section.querySelectorAll("[data-put-plan-qty]"));

    const refreshTotal = () => {
      const currentTotal = quantityInputs().reduce((sum, input) => {
        const value = Number(input.value || 0);
        return Number.isFinite(value) ? sum + value : sum;
      }, 0);
      const matches = Math.abs(currentTotal - expectedTotal) < 0.000001;
      if (totalLabel) {
        totalLabel.textContent = `Adjusted total: ${formatQuantity(currentTotal)} / ${formatQuantity(expectedTotal)}`;
        totalLabel.classList.toggle("flash-error", !matches);
      }
      if (submitButton) {
        submitButton.disabled = !matches;
      }
    };

    section.addEventListener("input", (event) => {
      if (event.target.closest("[data-put-plan-qty]")) {
        refreshTotal();
      }
    });

    section.addEventListener("click", (event) => {
      const removeButton = event.target.closest("[data-put-plan-remove]");
      if (removeButton) {
        removeButton.closest("[data-put-plan-row]")?.remove();
        refreshTotal();
        return;
      }

      if (!event.target.closest("[data-put-plan-add]") || !template || !lines) {
        return;
      }
      const wrapper = document.createElement("div");
      wrapper.innerHTML = template.innerHTML.replaceAll("__INDEX__", String(nextIndex)).trim();
      const row = wrapper.firstElementChild;
      if (!row) {
        return;
      }
      lines.appendChild(row);
      wireComboBoxes(row);
      nextIndex += 1;
      refreshTotal();
      row.querySelector("[data-combo-input]")?.focus();
    });

    if (addButton) {
      addButton.disabled = !template || !lines;
    }
    refreshTotal();
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

function firmwareControllerName(port) {
  if (port?.flashRecordAmbiguous) {
    return "";
  }
  return port?.flashRecord?.controllerName || port?.flashRecord?.deviceName || "";
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
  const controller = panel.querySelector('input[name="controller_name"]');
  const submitButton = panel.querySelector("[data-firmware-flash-form] button[type='submit']");
  if (submitButton && input && identity && controller) {
    submitButton.disabled = !input.value.trim() || !identity.value.trim() || !controller.value.trim();
  }
}

function selectedFirmwarePort(panel) {
  const input = panel.querySelector("[data-firmware-port-input]");
  const identity = panel.querySelector("[data-firmware-device-identity]");
  return Boolean(input?.value.trim() && identity?.value.trim());
}

function currentFirmwareWizardStep(panel) {
  const wizard = panel.querySelector("[data-firmware-wizard]");
  return Number(wizard?.dataset.currentStep || 0);
}

function setFirmwareWizardStep(panel, nextStep) {
  const wizard = panel.querySelector("[data-firmware-wizard]");
  if (!wizard) {
    return;
  }

  const steps = Array.from(wizard.querySelectorAll("[data-firmware-step]"));
  const maxStep = Math.max(0, steps.length - 1);
  const safeStep = Math.min(Math.max(Number(nextStep) || 0, 0), maxStep);
  wizard.dataset.currentStep = String(safeStep);

  for (const step of steps) {
    step.hidden = Number(step.dataset.firmwareStep || 0) !== safeStep;
  }

  wizard.querySelectorAll("[data-firmware-step-indicator]").forEach((indicator) => {
    const indicatorStep = Number(indicator.dataset.firmwareStepIndicator || 0);
    const isComplete = indicatorStep < safeStep;
    const isActive = indicatorStep === safeStep;
    const isUpcoming = indicatorStep > safeStep;
    indicator.classList.toggle("wizard-step-indicator-complete", isComplete);
    indicator.classList.toggle("wizard-step-indicator-active", isActive);
    indicator.classList.toggle("wizard-step-indicator-upcoming", isUpcoming);
    if (isActive) {
      indicator.setAttribute("aria-current", "step");
    } else {
      indicator.removeAttribute("aria-current");
    }
  });
}

function setFirmwareDetectStatus(panel, message, tone = "missing") {
  const status = panel.querySelector("[data-firmware-detect-status]");
  if (!status) {
    return;
  }
  status.textContent = message || "";
  status.hidden = !message;
  status.classList.toggle("firmware-port-status-ok", tone === "ok");
  status.classList.toggle("firmware-port-status-missing", tone !== "ok");
}

function advanceFirmwareWizardAfterDetection(panel) {
  const status = panel.querySelector("[data-firmware-port-status]");
  if (selectedFirmwarePort(panel)) {
    setFirmwareDetectStatus(panel, "");
    setFirmwareWizardStep(panel, 2);
    return;
  }

  setFirmwareDetectStatus(
    panel,
    "No new ESP32 was detected. Click Back, disconnect the controller, then repeat the setup flow.",
  );
  if (status) {
    status.textContent =
      "No new ESP32 was selected. Go Back, disconnect the controller, then run the setup flow again.";
    status.classList.add("firmware-port-status-missing");
    status.classList.remove("firmware-port-status-ok");
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
      ? "No added serial device detected yet. Plug in the ESP32 USB cable, then click Next."
      : "Unplug the ESP32 and click Next to capture the current peripherals first.";
    target.appendChild(empty);
    return;
  }

  for (const port of ports) {
    const ambiguous = port.flashRecordAmbiguous || (port.flashRecords || []).length > 1;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "firmware-port-choice";
    if (port.path === selectedPort) {
      button.classList.add("firmware-port-choice-active");
    }
    button.dataset.firmwarePortChoice = "true";
    button.dataset.portPath = port.path;
    button.dataset.deviceIdentity = firmwarePortIdentity(port) || "";
    button.dataset.controllerName = firmwareControllerName(port);
    button.dataset.controllerAmbiguous = ambiguous ? "true" : "false";

    const label = document.createElement("strong");
    label.textContent = port.newlyConnected
      ? "Added serial device"
      : ambiguous
        ? "Shared USB adapter identity"
        : port.flashRecord?.deviceName || port.deviceName || "ESP32 controller";
    const badge = document.createElement("span");
    const flashed = port.flashStatus === "configured";
    badge.className = `badge ${flashed ? "badge-flashed" : "badge-new"}`;
    badge.textContent = ambiguous ? "choose target" : flashed ? "flashed" : port.badge || "new";
    const summary = document.createElement("span");
    summary.className = "firmware-device-summary";
    if (ambiguous) {
      const names = (port.flashRecords || [])
        .map((record) => record.controllerName || record.deviceName)
        .filter(Boolean)
        .join(", ");
      summary.textContent = `This USB-UART identity is shared by ${names || "multiple controllers"}. Choose the exact Controller name above before flashing.`;
    } else if (flashed && port.flashRecord) {
      const flashedBy = port.flashRecord.flashedBy?.name || port.flashRecord.flashedBy?.username || "unknown user";
      const configuredAt = port.flashRecord.configuredAt
        ? new Date(port.flashRecord.configuredAt).toLocaleString()
        : "unknown time";
      summary.textContent = `Already flashed · id ${port.flashRecord.controllerAddress || "unknown"} · ${port.flashRecord.moduleCount} LED module(s) · ${configuredAt} · by ${flashedBy}`;
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
    const ambiguous = port.flashRecordAmbiguous || (port.flashRecords || []).length > 1;
    const item = document.createElement("button");
    item.type = "button";
    item.className = "firmware-other-device";
    item.dataset.firmwarePortChoice = "true";
    item.dataset.portPath = port.path;
    item.dataset.deviceIdentity = firmwarePortIdentity(port) || "";
    item.dataset.controllerName = firmwareControllerName(port);
    item.dataset.controllerAmbiguous = ambiguous ? "true" : "false";
    const name = document.createElement("strong");
    name.textContent = port.deviceName || port.label || "Serial device";
    const reason = document.createElement("span");
    reason.textContent =
      ambiguous
        ? "Shared USB adapter identity. Select only as an upload port, then choose the exact controller name before flashing."
        : port.flashStatus === "configured"
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
          : (port.flashStatus === "configured" || port.flashStatus === "ambiguous") &&
              esp32Identities.has(firmwarePortIdentity(port)),
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
  const controllerInput = panel.querySelector('input[name="controller_name"]');
  const selectedControllerName = firmwareControllerName(selectedCandidate);
  const selectedAmbiguous = selectedCandidate?.flashRecordAmbiguous || (selectedCandidate?.flashRecords || []).length > 1;
  if (controllerInput) {
    if (selectedAmbiguous) {
      controllerInput.value = "";
    } else if (selectedControllerName) {
      controllerInput.value = selectedControllerName;
    }
  }

  if (status) {
    const newCount = primaryPorts.filter((port) => port.newlyConnected).length;
    const flashedCount = primaryPorts.filter((port) => port.flashStatus === "configured").length;
    const ambiguousCount = primaryPorts.filter((port) => port.flashStatus === "ambiguous").length;
    if (mode === "baseline") {
      status.textContent = `Baseline saved with ${ports.length} serial device${ports.length === 1 ? "" : "s"}. Now plug in the ESP32 and click Next.`;
    } else if (newCount > 0) {
      status.textContent = `New serial device connected. If this is the ESP32, select it and flash it.`;
    } else if (ambiguousCount > 0) {
      status.textContent = `${ambiguousCount} serial port${ambiguousCount === 1 ? "" : "s"} match multiple configured controllers. Choose the exact Controller name before flashing.`;
    } else if (flashedCount > 0) {
      status.textContent = `${flashedCount} already flashed ESP32 controller${flashedCount === 1 ? "" : "s"} detected.`;
    } else if (baselineAvailable) {
      status.textContent =
        "No newly added serial device detected. Keep the existing peripherals connected, plug in the ESP32, then click Next again.";
    } else {
      status.textContent =
        "Start by unplugging the ESP32 and clicking Next. Then plug in the ESP32 and continue.";
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
  if (settings.mode === "detect") {
    setFirmwareDetectStatus(panel, "Checking for a serial device added after the baseline scan...");
  } else {
    setFirmwareDetectStatus(panel, "");
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
    if (settings.mode === "detect" && selectedFirmwarePort(panel)) {
      setFirmwareDetectStatus(panel, "ESP32 serial device detected. Continue to configure it.", "ok");
    }
  } catch (error) {
    if (status) {
      status.textContent = error.message;
      status.classList.add("firmware-port-status-missing");
      status.classList.remove("firmware-port-status-ok");
    }
    if (settings.mode === "detect") {
      setFirmwareDetectStatus(panel, error.message);
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
    const message = job.status === "completed" ? job.verificationHint : job.recoveryHint;
    hint.textContent = message || "";
    hint.hidden = !message;
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
      setFirmwareWizardStep(panel, currentFirmwareWizardStep(panel));

      panel.addEventListener("click", (event) => {
        const baselineButton = event.target.closest("[data-firmware-scan-baseline]");
        if (baselineButton) {
          refreshFirmwarePorts(panel, { captureBaseline: true, mode: "baseline" })
            .then(() => {
              clearFirmwareSelection(panel);
              syncFirmwareSubmitState(panel);
              if (baselineButton.dataset.firmwareNextOnSuccess !== undefined) {
                setFirmwareWizardStep(panel, 1);
              }
            })
            .catch(() => {});
          return;
        }

        const refreshButton = event.target.closest("[data-firmware-refresh-ports]");
        if (refreshButton) {
          refreshFirmwarePorts(panel, { mode: "detect" })
            .then(() => {
              if (refreshButton.dataset.firmwareNextOnSuccess !== undefined) {
                advanceFirmwareWizardAfterDetection(panel);
              }
            })
            .catch(() => {});
          return;
        }

        const previousButton = event.target.closest("[data-firmware-prev]");
        if (previousButton) {
          setFirmwareWizardStep(panel, currentFirmwareWizardStep(panel) - 1);
          return;
        }

        const nextButton = event.target.closest("[data-firmware-next]");
        if (nextButton) {
          if (currentFirmwareWizardStep(panel) === 2 && !selectedFirmwarePort(panel)) {
            advanceFirmwareWizardAfterDetection(panel);
            return;
          }
          setFirmwareWizardStep(panel, currentFirmwareWizardStep(panel) + 1);
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
        const controllerInput = panel.querySelector('input[name="controller_name"]');
        if (controllerInput) {
          if (portChoice.dataset.controllerAmbiguous === "true") {
            controllerInput.value = "";
          } else if (portChoice.dataset.controllerName) {
            controllerInput.value = portChoice.dataset.controllerName;
          }
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
      const controllerInput = panel.querySelector('input[name="controller_name"]');
      controllerInput?.addEventListener("input", () => {
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

function activeLocateCellIds() {
  return Array.from(activeLocates.keys());
}

function locateClearAllBody() {
  const body = new URLSearchParams();
  body.set("active", "0");
  body.set("cell_ids", activeLocateCellIds().join(","));
  return body;
}

function sendLocateClearAll({ beacon = true } = {}) {
  const body = locateClearAllBody();
  if (navigator.sendBeacon) {
    const blob = new Blob([body.toString()], {
      type: "application/x-www-form-urlencoded; charset=UTF-8",
    });
    if (beacon && navigator.sendBeacon("/api/cells/locate/clear-all", blob)) {
      return Promise.resolve();
    }
  }

  return fetch("/api/cells/locate/clear-all", {
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
    setButtonLoading(button, true, {
      label: activeEntry ? "Clearing" : "Sending",
      title: activeEntry ? "Clearing locate command" : "Sending locate command",
    });

    try {
      if (activeEntry) {
        await sendLocateCommand(cellId, false);
        setButtonLoading(button, false);
        clearLocateUi(cellId);
        return;
      }

      await sendLocateCommand(cellId, true);
      setButtonLoading(button, false);
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
      setButtonLoading(button, false);
      button.textContent = "Failed";
      window.setTimeout(() => {
        if (!activeLocates.has(String(cellId))) {
          setLocateButtonState(button, false);
        }
      }, 1400);
    } finally {
      setButtonLoading(button, false);
    }
  });

  document.addEventListener(
    "click",
    async (event) => {
      const link = event.target.closest("a[href]");
      if (!link || activeLocates.size === 0) {
        return;
      }
      if (link.target || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }

      const nextUrl = new URL(link.href, window.location.href);
      if (nextUrl.origin !== window.location.origin || nextUrl.pathname === window.location.pathname) {
        return;
      }

      event.preventDefault();
      await sendLocateClearAll({ beacon: false });
      clearAllLocateUi();
      window.location.href = nextUrl.href;
    },
    { capture: true },
  );

  window.addEventListener("pagehide", () => {
    sendLocateClearAll();
    clearAllLocateUi();
  });
}

function wireConfigurationWorkspace() {
  const workspace = document.querySelector("[data-config-workspace]");
  if (!workspace || workspace.dataset.configWorkspaceBound === "true") {
    return;
  }
  workspace.dataset.configWorkspaceBound = "true";

  const modal = workspace.querySelector("[data-config-modal]");
  const modalTitle = workspace.querySelector("[data-config-modal-title]");
  const modalDescription = workspace.querySelector("[data-config-modal-description]");
  const modalClose = workspace.querySelector("[data-config-modal-close]");
  const sectionHost = workspace.querySelector("[data-config-section-host]");
  const sectionGroups = {
    "controller-setup": ["controller-setup"],
    "cell-create": ["cell-create"],
    "cell-management": ["cell-management"],
    "cell-mapping": ["cell-mapping"],
  };
  const sectionCopy = {
    "controller-setup": {
      title: "Add Controller",
      description: "Follow the guided ESP32 setup without leaving the Configuration console.",
    },
    "cell-create": {
      title: "Add Cells",
      description: "Create storage cells in a focused dialog, then return to the console.",
    },
    "cell-management": {
      title: "Manage Cells",
      description: "Delete and review active storage cells in a focused flow.",
    },
    "cell-mapping": {
      title: "Cell Mapping",
      description: "Ping modules and assign them to physical storage cells.",
    },
  };
  const sectionLinks = Array.from(workspace.querySelectorAll("[data-config-section-link]"));
  let sectionRequestId = 0;
  const activeFromHash = () => window.location.hash.replace(/^#/, "");
  const hasDirtyMapping = () =>
    document.querySelector("[data-cell-mapping-form]")?.dataset.mappingDirty === "true";
  const sectionLoadingHtml = (message = "Loading configuration flow...") =>
    `<div class="configuration-flow-loading">${message}</div>`;

  const bindLoadedSection = (section) => {
    if (!section) {
      return;
    }
    wireFirmwareFlash();
    wireLedCommandForms();
    wireCellMappingForm();
    wireCellDeleteForms();
    wireRowCollapsers(section);
  };

  const loadSection = async (activeKey) => {
    if (!sectionHost || !sectionGroups[activeKey]) {
      return;
    }
    if (
      sectionHost.dataset.activeSection === activeKey &&
      sectionHost.querySelector(`[data-config-section="${activeKey}"]`)
    ) {
      bindLoadedSection(sectionHost.querySelector(`[data-config-section="${activeKey}"]`));
      return;
    }

    const requestId = ++sectionRequestId;
    sectionHost.dataset.activeSection = activeKey;
    sectionHost.innerHTML = sectionLoadingHtml();

    try {
      const response = await fetch(`/devices/sections/${encodeURIComponent(activeKey)}`, {
        headers: {
          "X-Requested-With": "fetch",
        },
      });
      if (!response.ok) {
        throw new Error("Configuration flow could not be loaded.");
      }
      const html = await response.text();
      if (requestId !== sectionRequestId || sectionHost.dataset.activeSection !== activeKey) {
        return;
      }
      sectionHost.innerHTML = html;
      const section = sectionHost.querySelector(`[data-config-section="${activeKey}"]`);
      if (section) {
        section.hidden = false;
      }
      bindLoadedSection(section);
    } catch (error) {
      if (requestId !== sectionRequestId) {
        return;
      }
      sectionHost.innerHTML = sectionLoadingHtml(error.message || "Configuration flow could not be loaded.");
    }
  };

  const unloadInactiveSection = () => {
    if (!sectionHost || hasDirtyMapping()) {
      return;
    }
    sectionRequestId += 1;
    sectionHost.dataset.activeSection = "";
    sectionHost.innerHTML = sectionLoadingHtml("Select a configuration flow to continue.");
  };

  const clearActiveHash = () => {
    if (hasDirtyMapping()) {
      document.dispatchEvent(
        new CustomEvent("inventory:mapping-request-navigation", {
          detail: {
            kind: "link",
            href: `${window.location.pathname}${window.location.search}`,
          },
        }),
      );
      return;
    }
    if (window.location.hash) {
      window.history.pushState(null, "", `${window.location.pathname}${window.location.search}`);
    }
    render();
  };

  const render = () => {
    const activeKey = activeFromHash();
    const visibleIds = new Set(sectionGroups[activeKey] || []);
    const activeCopy = sectionCopy[activeKey] || null;

    if (modal) {
      modal.hidden = visibleIds.size === 0;
      document.body.classList.toggle("modal-open", visibleIds.size > 0);
    }
    if (modalTitle && activeCopy) {
      modalTitle.textContent = activeCopy.title;
    }
    if (modalDescription && activeCopy) {
      modalDescription.textContent = activeCopy.description;
    }

    sectionLinks.forEach((link) => {
      const linkKey = link.dataset.configSectionLink || "";
      const active = linkKey === activeKey;
      link.classList.toggle("operation-tile-active", active);
      link.setAttribute("aria-expanded", active ? "true" : "false");
      if (active) {
        link.setAttribute("aria-current", "page");
      } else {
        link.removeAttribute("aria-current");
      }
    });

    if (visibleIds.size > 0) {
      loadSection(activeKey).catch(() => {});
    } else {
      unloadInactiveSection();
    }
  };

  sectionLinks.forEach((link) => {
    link.setAttribute("aria-expanded", "false");
    link.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }

      event.preventDefault();
      const nextKey = link.dataset.configSectionLink;
      if (!nextKey) {
        return;
      }

      const nextHash = `#${nextKey}`;
      if (window.location.hash !== nextHash) {
        window.history.pushState(null, "", `${window.location.pathname}${window.location.search}${nextHash}`);
      }
      render();
    });
  });

  modalClose?.addEventListener("click", clearActiveHash);
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) {
      clearActiveHash();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !modal || modal.hidden) {
      return;
    }
    if (document.querySelector("[data-mapping-unsaved-modal]:not([hidden])")) {
      return;
    }
    event.preventDefault();
    clearActiveHash();
  });
  window.addEventListener("hashchange", render);
  window.addEventListener("popstate", render);
  render();
}

function cleanMappingLabel(label) {
  return (label || "")
    .split("·")[0]
    .trim();
}

function mappingControlLabel(control) {
  if (control.matches("select")) {
    const selected = control.selectedOptions?.[0];
    return cleanMappingLabel(selected?.textContent || control.value || "");
  }
  return cleanMappingLabel(control.dataset.currentLabel || control.value || "");
}

function wireCellMappingForm() {
  const form = document.querySelector("[data-cell-mapping-form]");
  if (!form || form.dataset.mappingBound === "true") {
    return;
  }
  form.dataset.mappingBound = "true";

  const controls = Array.from(form.querySelectorAll("[data-mapping-control], [data-mapping-select]"));
  const optionsByLabel = new Map();
  form.querySelectorAll("#cell-mapping-options option").forEach((option) => {
    const id = option.dataset.cellId || option.value;
    const label = option.dataset.cellLabel || option.value;
    const keys = [option.value, option.getAttribute("label"), label]
      .map((value) => cleanMappingLabel(value).toLowerCase())
      .filter(Boolean);
    keys.forEach((key) => optionsByLabel.set(key, { id, label }));
  });
  const saveButton = document.querySelector("[data-mapping-save]");
  const returnToInput = form.querySelector("[data-mapping-return-to]");
  const dirtyCount = document.querySelector("[data-mapping-dirty-count]");
  const modal = document.querySelector("[data-mapping-unsaved-modal]");
  const modalList = modal?.querySelector("[data-mapping-unsaved-list]");
  const modalSave = modal?.querySelector("[data-mapping-modal-save]");
  const modalDiscard = modal?.querySelector("[data-mapping-modal-discard]");
  const modalReview = modal?.querySelector("[data-mapping-modal-review]");
  const state = {
    allowNavigation: false,
    pending: null,
    submittingMapping: false,
  };

  const changedSelections = () =>
    controls.filter((control) => String(control.value) !== String(control.dataset.originalValue || ""));

  const inputFor = (control) => {
    const key = control.dataset.mappingKey;
    return key ? form.querySelector(`[data-mapping-input-for="${key}"]`) : null;
  };

  const syncControlFromInput = (control) => {
    if (control.matches("select")) {
      return true;
    }

    const input = inputFor(control);
    if (!input) {
      return true;
    }

    const match = optionsByLabel.get(cleanMappingLabel(input.value).toLowerCase());
    if (match) {
      control.value = match.id;
      control.dataset.currentLabel = match.label;
      input.setCustomValidity("");
      return true;
    }

    control.value = "";
    control.dataset.currentLabel = input.value;
    input.setCustomValidity(input.value.trim() ? "Choose a cell from the list." : "");
    return !input.value.trim();
  };

  const syncAllMappingControls = () => {
    let valid = true;
    for (const control of controls) {
      if (!syncControlFromInput(control)) {
        valid = false;
      }
    }
    return valid;
  };

  const describeChange = (control) => {
    const from = control.dataset.originalLabel || "Unassigned";
    const to = mappingControlLabel(control) || "Unassigned";
    const controller = control.dataset.controllerName || "Controller";
    const module = control.dataset.moduleName || "?";
    return `${controller} module ${module}: ${from} -> ${to}`;
  };

  const refreshMappingState = () => {
    syncAllMappingControls();
    const changes = changedSelections();
    for (const control of controls) {
      const changed = String(control.value) !== String(control.dataset.originalValue || "");
      const field = control.matches("select") ? control : inputFor(control);
      const label = control.closest(".mapping-cell-control")?.querySelector("[data-mapping-cell-name]");
      if (label) {
        label.textContent = mappingControlLabel(control) || label.dataset.originalLabel || "";
        label.classList.toggle("mapping-cell-name-dirty", changed);
        label.classList.toggle("mapping-cell-name-saved", !changed);
      }
      field?.classList.toggle("cell-mapping-select-dirty", changed);
    }

    form.dataset.mappingDirty = changes.length ? "true" : "false";
    if (saveButton) {
      saveButton.disabled = changes.length === 0;
    }
    if (dirtyCount) {
      dirtyCount.textContent = changes.length
        ? `${changes.length} unsaved mapping${changes.length === 1 ? "" : "s"}`
        : "All mappings saved";
    }
  };

  const isDirty = () => changedSelections().length > 0;

  const closeModal = () => {
    if (modal) {
      modal.hidden = true;
    }
  };

  const showUnsavedModal = (pending) => {
    state.pending = pending;
    if (!modal || !modalList) {
      return;
    }
    modalList.replaceChildren();
    for (const select of changedSelections()) {
      const item = document.createElement("li");
      item.textContent = describeChange(select);
      modalList.appendChild(item);
    }
    modal.hidden = false;
  };

  const localPath = (url) => `${url.pathname}${url.search}${url.hash}`;

  document.addEventListener("inventory:mapping-request-navigation", (event) => {
    if (!isDirty() || state.allowNavigation || state.submittingMapping) {
      return;
    }
    showUnsavedModal(event.detail || {
      kind: "link",
      href: `${window.location.pathname}${window.location.search}`,
    });
  });

  controls.forEach((control) => {
    if (control.dataset.originalValue) {
      control.value = control.dataset.originalValue;
    }
    const field = control.matches("select") ? control : inputFor(control);
    field?.addEventListener("input", refreshMappingState);
    field?.addEventListener("change", refreshMappingState);
  });

  form.addEventListener("submit", (event) => {
    const valid = syncAllMappingControls();
    if (!valid) {
      event.preventDefault();
      inputFor(controls.find((control) => !control.value))?.reportValidity();
      refreshMappingState();
      return;
    }
    if (!isDirty()) {
      event.preventDefault();
      refreshMappingState();
      return;
    }
    state.submittingMapping = true;
  });

  document.addEventListener(
    "click",
    (event) => {
      if (!isDirty() || state.allowNavigation || state.submittingMapping) {
        return;
      }
      if (event.target.closest("[data-mapping-unsaved-modal]")) {
        return;
      }

      const link = event.target.closest("a[href]");
      if (!link || link.target || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }

      const nextUrl = new URL(link.href, window.location.href);
      if (nextUrl.origin !== window.location.origin || nextUrl.href === window.location.href) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      showUnsavedModal({
        kind: "link",
        href: localPath(nextUrl),
      });
    },
    { capture: true },
  );

  document.addEventListener(
    "submit",
    (event) => {
      if (!isDirty() || state.allowNavigation || state.submittingMapping || event.target === form) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      showUnsavedModal({
        kind: "form",
        form: event.target,
        submitter: event.submitter || null,
      });
    },
    { capture: true },
  );

  modalSave?.addEventListener("click", () => {
    if (returnToInput) {
      returnToInput.value =
        state.pending?.kind === "link"
          ? state.pending.href
          : `${window.location.pathname}${window.location.search}#cell-mapping`;
    }
    state.submittingMapping = true;
    closeModal();
    if (saveButton) {
      form.requestSubmit(saveButton);
    } else {
      form.requestSubmit();
    }
  });

  modalDiscard?.addEventListener("click", () => {
    const pending = state.pending;
    closeModal();
    state.pending = null;
    state.allowNavigation = true;

    if (pending?.kind === "link") {
      window.location.href = pending.href;
      return;
    }

    if (pending?.kind === "form" && pending.form) {
      if (pending.submitter && typeof pending.form.requestSubmit === "function") {
        pending.form.requestSubmit(pending.submitter);
      } else {
        pending.form.submit();
      }
      window.setTimeout(() => {
        state.allowNavigation = false;
      }, 500);
    }
  });

  modalReview?.addEventListener("click", () => {
    closeModal();
    state.pending = null;
    document.querySelector("#cell-mapping")?.scrollIntoView({ block: "start" });
  });

  window.addEventListener("beforeunload", (event) => {
    if (!isDirty() || state.allowNavigation || state.submittingMapping) {
      return;
    }
    event.preventDefault();
    event.returnValue = "";
  });

  refreshMappingState();
}

function wireCellDeleteForms() {
  document.querySelectorAll("[data-delete-cell-form]").forEach((form) => {
    if (form.dataset.deleteCellBound === "true") {
      return;
    }
    form.dataset.deleteCellBound = "true";
    form.addEventListener("submit", (event) => {
      const cellName = form.dataset.cellName || "this cell";
      const hasData = form.dataset.cellHasData === "true";
      const deleteDataInput = form.querySelector("[data-delete-data-confirmed]");

      if (!window.confirm(`Delete ${cellName}? This cannot be undone.`)) {
        event.preventDefault();
        return;
      }

      if (hasData) {
        const confirmed = window.confirm(
          `${cellName} has stock, task history, or hardware events. Deleting it will delete that associated data too. Continue?`,
        );
        if (!confirmed) {
          event.preventDefault();
          return;
        }
        if (deleteDataInput) {
          deleteDataInput.value = "1";
        }
      }
    });
  });
}

function resetRowCollapser(section) {
  section.querySelectorAll("[data-row-collapse-footer]").forEach((footer) => footer.remove());
  section.querySelectorAll("tbody tr[hidden]").forEach((row) => {
    row.hidden = false;
  });
  delete section.dataset.rowCollapserBound;
}

function rowCollapseIcon() {
  return `
    <svg class="row-collapse-chevron" aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path d="M6 9l6 6 6-6" />
    </svg>
  `;
}

function wireRowCollapsers(root = document) {
  const sections = [];
  if (root instanceof Element && root.matches("[data-row-collapser]")) {
    sections.push(root);
  }
  root.querySelectorAll?.("[data-row-collapser]").forEach((section) => sections.push(section));

  sections.forEach((section) => {
    if (section.dataset.rowCollapserBound === "true") {
      return;
    }

    const tableWrap = section.querySelector(".table-wrap");
    const tbody = tableWrap?.querySelector("tbody");
    const rows = Array.from(tbody?.querySelectorAll("tr") || []);
    const limit = Math.max(1, Number(section.dataset.rowLimit || 4));

    if (!tableWrap || !tbody || rows.length <= limit) {
      return;
    }
    section.dataset.rowCollapserBound = "true";

    const label = section.dataset.rowLabel || "rows";
    const iconToggle = true;
    const footer = document.createElement("div");
    footer.className = "row-collapse-footer";
    footer.dataset.rowCollapseFooter = "true";
    if (iconToggle) {
      footer.classList.add("row-collapse-footer-glow");
    }

    const status = document.createElement("span");
    status.className = "muted row-collapse-status";

    const button = document.createElement("button");
    button.type = "button";
    button.className = iconToggle ? "row-collapse-icon-button" : "ghost-button";
    button.setAttribute("aria-expanded", "false");
    if (iconToggle) {
      button.innerHTML = rowCollapseIcon();
    }

    footer.append(status, button);

    const tableOwner = tableWrap.closest("form");
    if (tableOwner && section.contains(tableOwner)) {
      tableOwner.insertAdjacentElement("afterend", footer);
    } else {
      tableWrap.insertAdjacentElement("afterend", footer);
    }

    const render = (expanded) => {
      rows.forEach((row, index) => {
        row.hidden = !expanded && index >= limit;
      });
      if (iconToggle) {
        footer.classList.toggle("row-collapse-footer-expanded", expanded);
        button.classList.toggle("row-collapse-icon-button-expanded", expanded);
        button.setAttribute("aria-label", expanded ? `Show fewer ${label}` : `Show more ${label}`);
      } else {
        button.textContent = expanded ? "Show less" : "Show more";
      }
      button.setAttribute("aria-expanded", expanded ? "true" : "false");
      status.textContent = expanded
        ? `Showing all ${rows.length} ${label}`
        : `Showing ${limit} of ${rows.length} ${label}`;
    };

    button.addEventListener("click", () => {
      render(button.getAttribute("aria-expanded") !== "true");
    });

    render(false);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  wireActionScrollRestore();
  wireToasts();
  wireNavState();
  wireLiveSearch();
  wireComboBoxes();
  wireAdjustmentForms();
  wirePutPlanForms();
  wireFirmwareFlash();
  wireLocationLocate();
  wireControllerHealthForms();
  wireLedCommandForms();
  wireConfigurationWorkspace();
  wireCellMappingForm();
  wireCellDeleteForms();
  wireRowCollapsers();
});
