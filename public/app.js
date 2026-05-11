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

function updateFirmwarePanel(panel, job) {
  const progressWrap = panel.querySelector("[data-firmware-progress]");
  const progressBar = panel.querySelector("[data-firmware-progress-bar]");
  const stage = panel.querySelector("[data-firmware-stage]");
  const percent = panel.querySelector("[data-firmware-percent]");
  const log = panel.querySelector("[data-firmware-log]");
  const modules = panel.querySelector("[data-firmware-modules]");

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
}

function wireFirmwareFlash() {
  const forms = document.querySelectorAll("[data-firmware-flash-form]");

  for (const form of forms) {
    if (form.dataset.firmwareBound === "true") {
      continue;
    }
    form.dataset.firmwareBound = "true";

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

document.addEventListener("DOMContentLoaded", () => {
  wireNavState();
  wireLiveSearch();
  wireComboBoxes();
  wireAdjustmentForms();
  wireFirmwareFlash();
});
