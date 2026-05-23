import {
  currentReturnPath,
  debounce,
  findFormSubmitButton,
  setButtonLoading,
} from "./client/dom.js";

const ACTION_SCROLL_KEY = "inventory-management:action-scroll";
const COMBO_RECENCY_KEY_PREFIX = "inventory-management:combo-recency:";
const SYSTEM_HEALTH_POLL_MS = 30 * 1000;
let productFindLedClearWindowBound = false;
let recommendationLedClearWindowBound = false;

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

function wireSystemHealthNotice() {
  const notice = document.querySelector("[data-system-notice]");
  if (!notice) {
    return;
  }

  const refresh = async () => {
    try {
      const response = await fetch("/api/system/health", {
        headers: {
          Accept: "application/json",
        },
      });
      if (!response.ok) {
        return;
      }
      const payload = await response.json();
      if (payload.degraded) {
        notice.textContent = `System warning: ${payload.message || "System is running with warnings."}`;
        notice.hidden = false;
      } else {
        notice.textContent = "";
        notice.hidden = true;
      }
    } catch {
      // Health polling is only for live notice updates; page navigation still renders the latest state.
    }
  };

  window.setInterval(refresh, SYSTEM_HEALTH_POLL_MS);
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

      const asyncCommand = form.hasAttribute("data-led-command-async");
      const returnTo = form.querySelector("[data-led-command-return-to]");
      if (returnTo) {
        returnTo.value = currentReturnPath(form.dataset.ledReturnHash || "");
      }

      const button = findFormSubmitButton(form, event, "[data-led-command-submit]");
      if (!button) {
        if (asyncCommand) {
          event.preventDefault();
        }
        return;
      }

      if (asyncCommand) {
        event.preventDefault();
        submitLedCommandFormAsync(form, button);
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

async function submitLedCommandFormAsync(form, button) {
  const originalHtml = button.innerHTML;
  const originalTitle = button.getAttribute("title");
  const restoreButton = () => {
    if (button.dataset.loadingActive === "true") {
      return;
    }
    button.innerHTML = originalHtml;
    if (originalTitle === null) {
      button.removeAttribute("title");
    } else {
      button.setAttribute("title", originalTitle);
    }
  };

  setButtonLoading(button, true, {
    label: button.dataset.ledLoadingLabel || form.dataset.ledLoadingLabel || "Sending",
    title: button.dataset.ledLoadingTitle || form.dataset.ledLoadingTitle || "Sending command",
  });

  try {
    const response = await fetch(form.action, {
      method: (form.getAttribute("method") || "post").toUpperCase(),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "fetch",
      },
      body: new URLSearchParams(new FormData(form)),
      credentials: "same-origin",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false || payload.degraded) {
      throw new Error(payload.error || payload.message || "Command failed.");
    }

    setButtonLoading(button, false);
    button.textContent = "Sent";
    window.setTimeout(restoreButton, 1000);
  } catch (error) {
    setButtonLoading(button, false);
    button.textContent = "Failed";
    button.setAttribute("title", error.message || "Command failed.");
    window.setTimeout(restoreButton, 1400);
  }
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

function wireCopyButtons() {
  document.querySelectorAll("[data-copy-value]").forEach((button) => {
    if (button.dataset.copyBound === "true") {
      return;
    }
    button.dataset.copyBound = "true";

    button.addEventListener("click", async () => {
      const value = button.dataset.copyValue || "";
      const status =
        button.closest(".card")?.querySelector("[data-copy-status]") ||
        document.querySelector("[data-copy-status]");

      try {
        await navigator.clipboard.writeText(value);
        button.classList.add("copy-button-done");
        if (status) {
          status.textContent = "Registration key copied.";
          status.className = "copy-status flash flash-success";
        }
        window.setTimeout(() => {
          button.classList.remove("copy-button-done");
          if (status) {
            status.textContent = "";
            status.className = "copy-status";
          }
        }, 2400);
      } catch {
        if (status) {
          status.textContent = "Copy failed. Select the key text and copy it manually.";
          status.className = "copy-status flash flash-warning";
        }
      }
    });
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

function wireQuantityShortcuts() {
  const syncQuantityShortcutState = (form) => {
    const quantityInput = form?.querySelector('input[name="quantity"]');
    if (!quantityInput) {
      return;
    }

    const currentValue = Number(quantityInput.value);
    form.querySelectorAll("[data-fill-quantity]").forEach((shortcutButton) => {
      const shortcutValue = Number(shortcutButton.dataset.fillQuantity);
      const isActive =
        quantityInput.value !== "" &&
        Number.isFinite(currentValue) &&
        Number.isFinite(shortcutValue) &&
        currentValue === shortcutValue;
      shortcutButton.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
  };

  document.querySelectorAll("form").forEach((form) => {
    if (form.dataset.quantityShortcutSyncBound === "true") {
      return;
    }

    const quantityInput = form.querySelector('input[name="quantity"]');
    if (!quantityInput || !form.querySelector("[data-fill-quantity]")) {
      return;
    }

    form.dataset.quantityShortcutSyncBound = "true";
    quantityInput.addEventListener("input", () => syncQuantityShortcutState(form));
    syncQuantityShortcutState(form);
  });

  document.querySelectorAll("[data-fill-quantity]").forEach((button) => {
    if (button.dataset.quantityShortcutBound === "true") {
      return;
    }
    button.dataset.quantityShortcutBound = "true";

    button.addEventListener("click", () => {
      const form = button.closest("form");
      const quantityInput = form?.querySelector('input[name="quantity"]');
      if (!quantityInput) {
        return;
      }
      quantityInput.value = button.dataset.fillQuantity || "";
      quantityInput.dispatchEvent(new Event("input", { bubbles: true }));
      quantityInput.focus();
      syncQuantityShortcutState(form);
    });
  });
}

function wireCompletionRedirects() {
  document.querySelectorAll("[data-completion-redirect]").forEach((panel) => {
    if (panel.dataset.completionRedirectBound === "true") {
      return;
    }
    panel.dataset.completionRedirectBound = "true";

    const target = panel.dataset.redirectTarget || "/";
    const seconds = Math.max(1, Number(panel.dataset.redirectSeconds || 10));
    const countdown = panel.querySelector("[data-completion-countdown]");
    const progress = panel.querySelector("[data-completion-progress]");
    const overviewLink = panel.querySelector("[data-completion-overview]");
    const startedAt = window.performance.now();
    let redirected = false;

    document.body.classList.add("modal-open");

    const redirect = () => {
      if (redirected) {
        return;
      }
      redirected = true;
      window.location.replace(target);
    };

    overviewLink?.addEventListener("click", (event) => {
      event.preventDefault();
      redirect();
    });

    window.setTimeout(redirect, seconds * 1000);

    const render = (now) => {
      if (redirected) {
        return;
      }

      const elapsedSeconds = Math.max(0, (now - startedAt) / 1000);
      const remainingSeconds = Math.max(0, seconds - elapsedSeconds);
      const roundedSeconds = Math.ceil(remainingSeconds);
      const progressScale = seconds > 0 ? remainingSeconds / seconds : 0;

      if (countdown) {
        countdown.textContent = `Redirecting to Overview in ${roundedSeconds} ${
          roundedSeconds === 1 ? "second" : "seconds"
        }`;
      }
      if (progress) {
        progress.style.transform = `scaleX(${progressScale})`;
      }

      if (remainingSeconds <= 0) {
        redirect();
        return;
      }

      window.requestAnimationFrame(render);
    };

    window.requestAnimationFrame(render);
  });
}

function wireQuantityChangeConfirmations() {
  document.querySelectorAll("[data-quantity-change-form]").forEach((form) => {
    if (form.dataset.quantityChangeBound === "true") {
      return;
    }
    form.dataset.quantityChangeBound = "true";

    const formatQuantity = (value) =>
      Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
    const formInputs = () =>
      Array.from(document.querySelectorAll("[data-quantity-change-input]")).filter(
        (input) => input.form === form || form.contains(input),
      );

    form.addEventListener("submit", (event) => {
      if (event.defaultPrevented) {
        return;
      }

      const originalTotal = Number(form.dataset.originalTotal || 0);
      if (!Number.isFinite(originalTotal)) {
        return;
      }

      const nextTotal = formInputs().reduce((sum, input) => {
        const value = Number(input.value || 0);
        return Number.isFinite(value) ? sum + value : sum;
      }, 0);

      if (Math.abs(nextTotal - originalTotal) < 0.000001) {
        return;
      }

      const confirmed = window.confirm(
        `This changes the task quantity from ${formatQuantity(originalTotal)} to ${formatQuantity(nextTotal)}. Continue?`,
      );
      if (!confirmed) {
        event.preventDefault();
      }
    });
  });
}

function wireProductSummaryForms() {
  document.querySelectorAll("[data-product-summary-form]").forEach((form) => {
    if (form.dataset.productSummaryBound === "true") {
      return;
    }
    form.dataset.productSummaryBound = "true";

    const productInput = form.querySelector('input[name="product_id"]');
    if (!productInput) {
      return;
    }

    productInput.addEventListener("change", () => {
      const productId = String(productInput.value || "").trim();
      if (!productId) {
        return;
      }

      const summaryPath = form.dataset.productSummaryPath || window.location.pathname;
      const url = new URL(summaryPath, window.location.origin);
      url.searchParams.set("product_id", productId);

      const quantity = form.querySelector('input[name="quantity"]')?.value?.trim();
      if (quantity) {
        url.searchParams.set("quantity", quantity);
      }

      const preferredCellId =
        form.querySelector('input[name="context_cell_id"]')?.value?.trim() ||
        form.querySelector('input[name="preferred_cell_id"]')?.value?.trim();
      if (preferredCellId) {
        url.searchParams.set("cell_id", preferredCellId);
      }

      window.location.assign(`${url.pathname}${url.search}`);
    });
  });
}

function wireMovementStockSummaries(root = document) {
  root.querySelectorAll("[data-movement-stock-summary]").forEach((section) => {
    if (section.dataset.movementStockBound === "true") {
      return;
    }
    section.dataset.movementStockBound = "true";

    const tbody = section.querySelector("[data-movement-stock-rows]");
    const button = section.querySelector("[data-movement-stock-load-more]");
    const status = section.querySelector("[data-movement-stock-status]");
    const footer = section.querySelector("[data-movement-stock-footer]");

    if (!tbody || !button || !footer) {
      return;
    }

    const totalCount = Number(section.dataset.movementStockTotal || 0);
    const pageSize = Math.max(1, Number(section.dataset.movementStockLimit || 5));
    const rowCount = () => tbody.querySelectorAll("[data-stock-cell-row]").length;
    const updateStatus = () => {
      const loadedCount = rowCount();
      const offset = Math.max(0, Number(section.dataset.movementStockOffset || loadedCount));
      if (status) {
        status.textContent = `Showing ${Math.min(loadedCount, totalCount)} Of ${totalCount} Locations`;
      }
      if (loadedCount >= totalCount || offset >= totalCount) {
        footer.hidden = true;
      }
    };

    button.addEventListener("click", async () => {
      const endpoint = section.dataset.movementStockEndpoint;
      if (!endpoint || button.disabled) {
        return;
      }

      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      try {
        const offset = Math.max(0, Number(section.dataset.movementStockOffset || rowCount()));
        const url = new URL(endpoint, window.location.origin);
        url.searchParams.set("offset", String(offset));
        url.searchParams.set("limit", String(pageSize));

        const response = await fetch(`${url.pathname}${url.search}`, {
          headers: { "X-Requested-With": "fetch" },
        });
        if (!response.ok) {
          return;
        }

        const template = document.createElement("template");
        template.innerHTML = await response.text();
        const existingCellIds = new Set(
          Array.from(tbody.querySelectorAll("[data-stock-cell-row]")).map(
            (row) => row.dataset.cellId || "",
          ),
        );
        template.content.querySelectorAll("[data-stock-cell-row]").forEach((row) => {
          const cellId = row.dataset.cellId || "";
          if (cellId && existingCellIds.has(cellId)) {
            return;
          }
          existingCellIds.add(cellId);
          tbody.append(row);
        });

        section.dataset.movementStockOffset = String(offset + pageSize);
        updateStatus();
      } finally {
        button.disabled = false;
        button.removeAttribute("aria-busy");
      }
    });

    updateStatus();
  });
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

function wireNavOverflow() {
  const nav = document.querySelector("[data-nav-links]");
  if (!nav || nav.dataset.navOverflowBound === "true") {
    return;
  }

  const links = Array.from(nav.querySelectorAll("[data-nav-link]"));
  const overflow = nav.querySelector("[data-nav-overflow]");
  const toggle = nav.querySelector("[data-nav-overflow-toggle]");
  const menu = nav.querySelector("[data-nav-overflow-menu]");
  if (!links.length || !overflow || !toggle || !menu) {
    return;
  }

  nav.dataset.navOverflowBound = "true";
  let layoutFrame = null;

  const setOpen = (open) => {
    const nextOpen = Boolean(open && !overflow.hidden && menu.children.length);
    menu.hidden = !nextOpen;
    toggle.setAttribute("aria-expanded", nextOpen ? "true" : "false");
  };

  const renderOverflowMenu = (hiddenLinks) => {
    menu.textContent = "";
    for (const link of hiddenLinks) {
      const menuLink = link.cloneNode(true);
      menuLink.hidden = false;
      menuLink.removeAttribute("data-nav-link");
      menuLink.classList.add("nav-overflow-link");
      menu.append(menuLink);
    }

    overflow.hidden = hiddenLinks.length === 0;
    toggle.classList.toggle(
      "nav-overflow-active",
      hiddenLinks.some((link) => link.classList.contains("nav-link-active")),
    );
    if (!hiddenLinks.length) {
      setOpen(false);
    }
  };

  const layout = () => {
    layoutFrame = null;
    setOpen(false);
    links.forEach((link) => {
      link.hidden = false;
    });
    overflow.hidden = true;
    toggle.classList.remove("nav-overflow-active");
    menu.textContent = "";

    if (!nav.clientWidth) {
      return;
    }

    const styles = window.getComputedStyle(nav);
    const gap = Number.parseFloat(styles.columnGap || styles.gap || "0") || 0;
    const navWidth = nav.getBoundingClientRect().width;
    const linkWidths = links.map((link) => link.getBoundingClientRect().width);
    const linksWidth = (count) =>
      linkWidths.slice(0, count).reduce((sum, width) => sum + width, 0) +
      Math.max(0, count - 1) * gap;
    const allLinksWidth = linksWidth(links.length);

    if (allLinksWidth <= navWidth) {
      return;
    }

    overflow.hidden = false;
    const overflowWidth = overflow.getBoundingClientRect().width;
    let visibleCount = links.length;
    while (
      visibleCount > 0 &&
      linksWidth(visibleCount) + gap + overflowWidth > navWidth
    ) {
      visibleCount -= 1;
    }

    links.forEach((link, index) => {
      link.hidden = index >= visibleCount;
    });
    const hiddenLinks = links.slice(visibleCount);
    renderOverflowMenu(hiddenLinks);
  };

  const scheduleLayout = () => {
    if (layoutFrame !== null) {
      window.cancelAnimationFrame(layoutFrame);
    }
    layoutFrame = window.requestAnimationFrame(layout);
  };

  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    setOpen(menu.hidden);
  });

  document.addEventListener("click", (event) => {
    if (!nav.contains(event.target)) {
      setOpen(false);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setOpen(false);
    }
  });

  window.addEventListener("resize", scheduleLayout);
  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(scheduleLayout);
    observer.observe(nav);
    observer.observe(nav.closest(".top-nav-shell") || nav);
  }
  document.fonts?.ready?.then(scheduleLayout).catch(() => {});
  scheduleLayout();
}

function wireReportsWorkspace() {
  const workspace = document.querySelector("[data-reports-workspace]");
  if (!workspace || workspace.dataset.reportsWorkspaceBound === "true") {
    return;
  }
  workspace.dataset.reportsWorkspaceBound = "true";

  const modal = workspace.querySelector("[data-report-modal]");
  const modalTitle = workspace.querySelector("[data-report-modal-title]");
  const modalDescription = workspace.querySelector("[data-report-modal-description]");
  const modalContent = workspace.querySelector("[data-report-modal-content]");
  const printMenu = workspace.querySelector("[data-report-print-menu]");
  const reportButtons = Array.from(workspace.querySelectorAll("[data-report-open]"));
  const reportTemplates = new Map(
    Array.from(workspace.querySelectorAll("[data-report-template]")).map((template) => [
      template.dataset.reportTemplate,
      template,
    ]),
  );

  let activeReportKey = "";
  let lastFocusedElement = null;

  const reportKeyFromHash = () => window.location.hash.replace(/^#/, "");
  const hasOpenReportSurface = () => Boolean((modal && !modal.hidden) || (printMenu && !printMenu.hidden));
  const syncBodyModalState = () => {
    document.body.classList.toggle("modal-open", hasOpenReportSurface());
  };
  const restoreFocus = () => {
    if (lastFocusedElement instanceof HTMLElement && document.contains(lastFocusedElement)) {
      lastFocusedElement.focus();
    }
    lastFocusedElement = null;
  };
  const setActiveReportButton = (key) => {
    reportButtons.forEach((button) => {
      const active = button.dataset.reportOpen === key;
      button.classList.toggle("report-overview-card-active", active);
      if (active) {
        button.setAttribute("aria-expanded", "true");
      } else {
        button.setAttribute("aria-expanded", "false");
      }
    });
  };

  const closePrintMenu = ({ restore = true } = {}) => {
    if (printMenu) {
      printMenu.hidden = true;
    }
    syncBodyModalState();
    if (restore) {
      restoreFocus();
    }
  };

  const openReport = (key, { updateHash = false, focus = true } = {}) => {
    const template = reportTemplates.get(key);
    if (!template || !modal || !modalContent) {
      return false;
    }

    if (focus) {
      lastFocusedElement = document.activeElement;
    }
    activeReportKey = key;
    modalTitle.textContent = template.dataset.reportTitle || "Report";
    modalDescription.textContent = template.dataset.reportDescription || "";
    modalContent.innerHTML = template.innerHTML;
    modal.hidden = false;
    if (printMenu) {
      printMenu.hidden = true;
    }
    setActiveReportButton(key);
    syncBodyModalState();

    if (updateHash && window.location.hash !== `#${key}`) {
      window.history.pushState(null, "", `${window.location.pathname}${window.location.search}#${key}`);
    }

    if (focus) {
      modal.querySelector("[data-report-close]")?.focus();
    }
    return true;
  };

  const closeReport = ({ clearHash = true, restore = true } = {}) => {
    if (modal) {
      modal.hidden = true;
    }
    if (modalContent) {
      modalContent.replaceChildren();
    }
    activeReportKey = "";
    setActiveReportButton("");
    syncBodyModalState();

    if (clearHash && reportTemplates.has(reportKeyFromHash())) {
      window.history.pushState(null, "", `${window.location.pathname}${window.location.search}`);
    }
    if (restore) {
      restoreFocus();
    }
  };

  const openPrintMenu = () => {
    if (!printMenu) {
      return;
    }
    lastFocusedElement = document.activeElement;
    printMenu.hidden = false;
    syncBodyModalState();
    printMenu.querySelector("[data-report-print-close]")?.focus();
  };

  const printActiveReport = () => {
    if (!activeReportKey) {
      openPrintMenu();
      return;
    }

    document.body.classList.add("report-printing");
    window.setTimeout(() => {
      document.body.classList.remove("report-printing");
    }, 60000);
    window.print();
  };

  reportButtons.forEach((button) => {
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", () => {
      openReport(button.dataset.reportOpen || "", { updateHash: true });
    });
  });

  workspace.querySelector("[data-report-print-open]")?.addEventListener("click", openPrintMenu);
  workspace.querySelector("[data-report-print-current]")?.addEventListener("click", printActiveReport);
  workspace.querySelectorAll("[data-report-close]").forEach((button) => {
    button.addEventListener("click", () => closeReport());
  });
  workspace.querySelectorAll("[data-report-print-close]").forEach((button) => {
    button.addEventListener("click", () => closePrintMenu());
  });
  workspace.querySelectorAll("[data-report-print-option]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.reportPrintOption || "";
      closePrintMenu({ restore: false });
      if (openReport(key, { updateHash: true, focus: false })) {
        printActiveReport();
      }
    });
  });

  modal?.addEventListener("click", (event) => {
    if (event.target === modal) {
      closeReport();
    }
  });
  printMenu?.addEventListener("click", (event) => {
    if (event.target === printMenu) {
      closePrintMenu();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    if (printMenu && !printMenu.hidden) {
      event.preventDefault();
      closePrintMenu();
      return;
    }
    if (modal && !modal.hidden) {
      event.preventDefault();
      closeReport();
    }
  });
  window.addEventListener("afterprint", () => {
    document.body.classList.remove("report-printing");
  });
  window.addEventListener("hashchange", () => {
    const key = reportKeyFromHash();
    if (reportTemplates.has(key)) {
      openReport(key, { focus: false });
    } else if (modal && !modal.hidden) {
      closeReport({ clearHash: false, restore: false });
    }
  });
  window.addEventListener("popstate", () => {
    const key = reportKeyFromHash();
    if (reportTemplates.has(key)) {
      openReport(key, { focus: false });
    } else if (modal && !modal.hidden) {
      closeReport({ clearHash: false, restore: false });
    }
  });

  if (reportTemplates.has(reportKeyFromHash())) {
    openReport(reportKeyFromHash(), { focus: false });
  }
}

function wireReportFormatEditors() {
  document.querySelectorAll("[data-report-format-editor]").forEach((editor) => {
    if (editor.dataset.reportFormatBound === "true") {
      return;
    }
    editor.dataset.reportFormatBound = "true";

    const form = editor.querySelector("[data-report-format-form]");
    const preview = editor.querySelector("[data-report-format-preview]");
    if (!form || !preview) {
      return;
    }

    const field = (name) => form.querySelector(`[data-report-format-field="${name}"]`);
    const companyPreview = preview.querySelector("[data-report-format-preview-company]");
    const labelPreview = preview.querySelector("[data-report-format-preview-label]");
    const numberValue = (name, fallback, min, max) => {
      const value = Number(field(name)?.value || fallback);
      if (!Number.isInteger(value)) {
        return fallback;
      }
      return Math.min(max, Math.max(min, value));
    };

    const applyPreview = () => {
      const companyName = String(field("companyName")?.value || "Inventory Management").trim();
      const headerLabel = String(field("headerLabel")?.value || "Inventory report").trim();
      const fontSelect = field("fontFamily");
      const fontCss = fontSelect?.selectedOptions?.[0]?.dataset.fontCss || "";
      const bodySize = numberValue("bodyFontSize", 13, 10, 18);
      const headingSize = numberValue("headingFontSize", 24, 18, 34);
      const subheadingSize = numberValue("subheadingFontSize", 13, 10, 18);
      const accentColor = String(field("accentColor")?.value || "#3158e8");

      if (fontCss) {
        preview.style.setProperty("--report-font-family", fontCss);
      }
      preview.style.setProperty("--report-body-size", `${bodySize}px`);
      preview.style.setProperty("--report-heading-size", `${headingSize}px`);
      preview.style.setProperty("--report-subheading-size", `${subheadingSize}px`);
      preview.style.setProperty("--report-accent-color", accentColor);

      if (companyPreview) {
        companyPreview.textContent = companyName || "Inventory Management";
      }
      if (labelPreview) {
        labelPreview.textContent = headerLabel || "Inventory report";
      }
    };

    form.addEventListener("input", applyPreview);
    form.addEventListener("change", applyPreview);
    applyPreview();
  });
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
    const originalOptionOrder = new Map(options.map((option, index) => [option, index]));
    const requiredMessage = combo.dataset.requiredMessage || "Choose an option from the list.";
    const recencyStorageKey = combo.dataset.comboRecencyKey
      ? `${COMBO_RECENCY_KEY_PREFIX}${combo.dataset.comboRecencyKey}`
      : "";

    if (!input || !hidden || !panel || !toggle) {
      continue;
    }

    let activeIndex = -1;

    const readRecentComboValues = () => {
      if (!recencyStorageKey) {
        return [];
      }

      try {
        const values = JSON.parse(window.localStorage.getItem(recencyStorageKey) || "[]");
        return Array.isArray(values)
          ? values.map((value) => String(value || "").trim()).filter(Boolean)
          : [];
      } catch {
        return [];
      }
    };

    const rememberRecentComboValue = (value) => {
      const normalized = String(value || "").trim();
      if (!recencyStorageKey || !normalized) {
        return;
      }

      try {
        const nextValues = [
          normalized,
          ...readRecentComboValues().filter((recentValue) => recentValue !== normalized),
        ].slice(0, 12);
        window.localStorage.setItem(recencyStorageKey, JSON.stringify(nextValues));
      } catch {
        // Local storage can be unavailable in strict browser modes.
      }
    };

    const applyComboRecencyOrder = () => {
      const recentRank = new Map(
        readRecentComboValues().map((value, index) => [value, index]),
      );
      if (!recentRank.size) {
        return;
      }

      options.sort((left, right) => {
        const leftRecentRank = recentRank.get(left.dataset.value || "");
        const rightRecentRank = recentRank.get(right.dataset.value || "");
        const leftHasRecentRank = leftRecentRank !== undefined;
        const rightHasRecentRank = rightRecentRank !== undefined;

        if (leftHasRecentRank && rightHasRecentRank) {
          return leftRecentRank - rightRecentRank;
        }
        if (leftHasRecentRank) {
          return -1;
        }
        if (rightHasRecentRank) {
          return 1;
        }
        return originalOptionOrder.get(left) - originalOptionOrder.get(right);
      });

      for (const option of options) {
        panel.insertBefore(option, empty || null);
      }
    };

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
      rememberRecentComboValue(hidden.value);
      applyComboRecencyOrder();
      hidden.dispatchEvent(new Event("change", { bubbles: true }));
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
      hidden.dispatchEvent(new Event("change", { bubbles: true }));
    };

    const selectOption = (option) => {
      input.value = option.dataset.label || "";
      hidden.value = option.dataset.value || "";
      input.setCustomValidity("");
      rememberRecentComboValue(hidden.value);
      applyComboRecencyOrder();
      hidden.dispatchEvent(new Event("change", { bubbles: true }));
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

    applyComboRecencyOrder();
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
    const locateButton = form.querySelector("[data-adjustment-locate-cell]");
    const lightQuantityButton = form.querySelector("[data-adjustment-light-quantity]");
    const status = form.querySelector("[data-adjustment-led-status]");

    if (!lines || !template || !addButton) {
      continue;
    }

    let nextIndex = lines.querySelectorAll("[data-adjustment-line]").length;
    let cellLoadSequence = 0;
    const selectedCellId = () => form.querySelector('input[name="cell_id"]')?.value || "";
    const enteredQuantities = () =>
      Array.from(form.querySelectorAll('input[name^="absolute_quantity_"]'))
        .map((input) => input.value.trim())
        .filter(Boolean);
    const normalizeQuantityValue = (value) => {
      const text = String(value || "").trim();
      if (!text) {
        return "";
      }
      const number = Number(text);
      return Number.isFinite(number) ? String(number) : text;
    };

    const setAdjustmentStatus = (message, tone = "info") => {
      if (!status) {
        return;
      }
      status.textContent = message || "";
      status.className = message
        ? `adjustment-guidance-status flash flash-${tone}`
        : "adjustment-guidance-status";
    };

    const setLinesMessage = (message, tone = "info") => {
      lines.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = `adjustment-empty-state adjustment-empty-state-${tone}`;
      empty.dataset.adjustmentEmpty = "true";
      empty.textContent = message;
      lines.appendChild(empty);
    };

    const refreshLineState = (line) => {
      const originalProductId = String(line.dataset.originalProductId || "").trim();
      const originalQuantity = normalizeQuantityValue(line.dataset.originalQuantity || "");
      const productId = String(line.querySelector('input[name^="product_id_"]')?.value || "").trim();
      const quantity = normalizeQuantityValue(
        line.querySelector('input[name^="absolute_quantity_"]')?.value || "",
      );
      const hasLineValue = Boolean(productId || quantity);
      const matchesSaved =
        Boolean(originalProductId) &&
        productId === originalProductId &&
        quantity === originalQuantity;
      const isDirty =
        !matchesSaved && Boolean(originalProductId || originalQuantity || hasLineValue);
      const state = line.querySelector("[data-adjustment-line-state]");

      line.classList.toggle("adjustment-line-saved", matchesSaved);
      line.classList.toggle("adjustment-line-dirty", isDirty);
      line.classList.toggle("adjustment-line-new", !matchesSaved && !isDirty);

      if (state) {
        state.textContent = matchesSaved ? "Saved" : isDirty ? "Changed" : "New";
      }
    };

    const refreshLineStates = () => {
      lines.querySelectorAll("[data-adjustment-line]").forEach(refreshLineState);
    };

    const refreshActionControls = () => {
      const cellId = selectedCellId();
      addButton.disabled = !cellId;
      if (locateButton) {
        locateButton.disabled = !cellId;
        setLocateButtonState(locateButton, Boolean(cellId && activeLocates.has(String(cellId))));
      }
      if (lightQuantityButton) {
        lightQuantityButton.disabled = !cellId || enteredQuantities().length === 0;
      }
    };

    const refreshLineControls = () => {
      const currentLines = Array.from(lines.querySelectorAll("[data-adjustment-line]"));
      if (currentLines.length) {
        lines.querySelector("[data-adjustment-empty]")?.remove();
      }
      currentLines.forEach((line) => {
        const removeButton = line.querySelector("[data-adjustment-remove]");
        if (removeButton) {
          removeButton.disabled = false;
        }
      });
    };

    addButton.addEventListener("click", () => {
      if (!selectedCellId()) {
        setLinesMessage("Select a cell before adding product counts.", "warning");
        refreshActionControls();
        return;
      }
      const wrapper = document.createElement("div");
      wrapper.innerHTML = template.innerHTML.replaceAll("__INDEX__", String(nextIndex)).trim();
      const line = wrapper.firstElementChild;
      if (!line) {
        return;
      }
      lines.querySelector("[data-adjustment-empty]")?.remove();
      lines.appendChild(line);
      wireComboBoxes(line);
      nextIndex += 1;
      refreshLineState(line);
      refreshLineControls();
      refreshActionControls();
      line.querySelector("[data-combo-input]")?.focus();
    });

    form.addEventListener("click", (event) => {
      const removeButton = event.target.closest("[data-adjustment-remove]");
      if (!removeButton) {
        return;
      }
      removeButton.closest("[data-adjustment-line]")?.remove();
      if (!lines.querySelector("[data-adjustment-line]")) {
        setLinesMessage(
          selectedCellId()
            ? "No product lines selected for this cell."
            : "Select a cell to load saved product counts.",
          "info",
        );
      }
      refreshLineControls();
      refreshActionControls();
    });

    form.addEventListener("input", () => {
      refreshLineStates();
      refreshActionControls();
    });
    form.addEventListener("change", () => {
      refreshLineStates();
      refreshActionControls();
    });
    form.addEventListener("click", (event) => {
      if (event.target.closest("[data-adjustment-locate-cell], [data-adjustment-light-quantity]")) {
        return;
      }
      window.requestAnimationFrame(refreshActionControls);
    });

    form.querySelector('input[name="cell_id"]')?.addEventListener("change", async () => {
      const cellId = selectedCellId();
      const requestId = (cellLoadSequence += 1);

      setAdjustmentStatus("");
      if (!cellId) {
        nextIndex = 0;
        setLinesMessage("Select a cell to load saved product counts.", "info");
        refreshActionControls();
        return;
      }

      setLinesMessage("Loading saved product counts...", "info");
      refreshActionControls();

      try {
        const response = await fetch(
          `/api/admin/adjustments/cell-products?cell_id=${encodeURIComponent(cellId)}`,
          {
            headers: {
              "X-Requested-With": "fetch",
            },
          },
        );
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "Saved products could not be loaded.");
        }
        if (requestId !== cellLoadSequence) {
          return;
        }

        if (payload.linesHtml && payload.linesHtml.trim()) {
          lines.innerHTML = payload.linesHtml;
          wireComboBoxes(lines);
          nextIndex =
            Number(payload.nextIndex) || lines.querySelectorAll("[data-adjustment-line]").length;
          refreshLineStates();
        } else {
          nextIndex = 0;
          setLinesMessage(
            `No saved products in ${payload.cell?.logicalCode || "this cell"}. Add a product line to count into this cell.`,
            "info",
          );
        }
      } catch (error) {
        if (requestId !== cellLoadSequence) {
          return;
        }
        nextIndex = 0;
        setLinesMessage(error.message || "Saved products could not be loaded.", "warning");
        setAdjustmentStatus(error.message || "Saved products could not be loaded.", "error");
      } finally {
        if (requestId === cellLoadSequence) {
          refreshLineControls();
          refreshActionControls();
        }
      }
    });

    locateButton?.addEventListener("click", async () => {
      const cellId = selectedCellId();
      if (!cellId || locateButton.disabled) {
        setAdjustmentStatus("Choose a cell before locating it.", "warning");
        return;
      }

      for (const [activeCellId, activeEntry] of Array.from(activeLocates.entries())) {
        if (activeEntry.button === locateButton && activeCellId !== String(cellId)) {
          await sendLocateCommand(activeCellId, false).catch(() => {});
          clearLocateUi(activeCellId);
        }
      }

      const activeEntry = activeLocates.get(String(cellId));
      setButtonLoading(locateButton, true, {
        label: activeEntry ? "Clearing" : "Sending",
        title: activeEntry ? "Clearing locate command" : "Sending locate command",
      });

      try {
        if (activeEntry) {
          await sendLocateCommand(cellId, false);
          setButtonLoading(locateButton, false);
          clearLocateUi(cellId);
          setAdjustmentStatus("Locate cleared.", "info");
          return;
        }

        const payload = await sendLocateCommand(cellId, true);
        setButtonLoading(locateButton, false);
        setLocateButtonState(locateButton, true);
        activeLocates.set(String(cellId), {
          button: locateButton,
          timeoutId: window.setTimeout(() => {
            if (!activeLocates.has(String(cellId))) {
              return;
            }
            sendLocateCommand(cellId, false).catch(() => {}).finally(() => clearLocateUi(cellId));
          }, LOCATION_LOCATE_TIMEOUT_MS),
        });
        setAdjustmentStatus(`Locating ${payload.cell?.logicalCode || "selected cell"}.`, "success");
      } catch (error) {
        setButtonLoading(locateButton, false);
        setAdjustmentStatus(error.message || "Locate command failed.", "error");
      } finally {
        refreshActionControls();
      }
    });

    lightQuantityButton?.addEventListener("click", async () => {
      if (!selectedCellId()) {
        setAdjustmentStatus("Choose a cell before lighting the quantity.", "warning");
        return;
      }
      if (!enteredQuantities().length) {
        setAdjustmentStatus("Enter at least one quantity before lighting the LED.", "warning");
        return;
      }

      const body = new URLSearchParams(new FormData(form));
      setButtonLoading(lightQuantityButton, true, {
        label: "Sending",
        title: "Sending quantity to LED",
      });

      try {
        const response = await fetch("/api/admin/adjustments/light", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Requested-With": "fetch",
          },
          body,
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "Quantity LED command failed.");
        }
        setAdjustmentStatus(
          payload.message ||
            `Showing ${payload.displayQuantity || "the entered quantity"} on ${
              payload.cell?.logicalCode || "the selected cell"
            }.`,
          payload.degraded ? "warning" : "success",
        );
      } catch (error) {
        setAdjustmentStatus(error.message || "Quantity LED command failed.", "error");
      } finally {
        setButtonLoading(lightQuantityButton, false);
        refreshActionControls();
      }
    });

    refreshLineControls();
    refreshActionControls();
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

    const syncCombinedPutRows = () => {
      section.querySelectorAll("[data-put-task-cell-control]").forEach((control) => {
        const hidden = control.querySelector("[data-combo-hidden]");
        const input = control.querySelector("[data-combo-input]");
        const confirmHidden = control.querySelector("[data-put-confirm-cell-for]");
        const label = control.querySelector("[data-put-task-cell-name]");
        const originalCellId = String(control.dataset.originalCellId || "");
        const selectedCellId = String(hidden?.value || "");
        const changed = selectedCellId !== originalCellId;
        const selectedLabel =
          (input?.value || "").split("·")[0].trim() ||
          control.dataset.originalLabel ||
          "";

        if (confirmHidden && hidden) {
          confirmHidden.value = hidden.value;
        }
        if (label) {
          label.textContent = selectedLabel || label.dataset.originalLabel || "";
          label.classList.toggle("mapping-cell-name-dirty", changed);
          label.classList.toggle("mapping-cell-name-saved", !changed);
        }
        input?.classList.toggle("cell-mapping-select-dirty", changed);
        control.classList.toggle("put-task-cell-control-dirty", changed);
      });

      section.querySelectorAll("[data-put-actual-qty-for]").forEach((input) => {
        const lineId = input.dataset.putActualQtyFor;
        const planQty = lineId ? section.querySelector(`[data-put-plan-qty-for="${lineId}"]`) : null;
        if (planQty) {
          planQty.value = input.value;
        }
      });
    };

    const refreshTotal = () => {
      syncCombinedPutRows();
      const currentTotal = quantityInputs().reduce((sum, input) => {
        const value = Number(input.value || 0);
        return Number.isFinite(value) ? sum + value : sum;
      }, 0);
      const matches = Math.abs(currentTotal - expectedTotal) < 0.000001;
      if (totalLabel) {
        totalLabel.textContent = `Adjusted total: ${formatQuantity(currentTotal)} · Original: ${formatQuantity(expectedTotal)}`;
        totalLabel.classList.toggle("flash-warning", !matches);
      }
      if (submitButton) {
        submitButton.disabled = false;
      }
    };

    section.addEventListener("input", (event) => {
      if (
        event.target.closest("[data-put-plan-qty]") ||
        event.target.closest("[data-put-actual-qty-for]")
      ) {
        refreshTotal();
      }
    });

    section.addEventListener("change", (event) => {
      if (
        event.target.closest("[data-put-task-cell-control]") ||
        event.target.closest("[data-put-actual-qty-for]") ||
        event.target.closest("[data-put-plan-qty]")
      ) {
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
  const modules = panel.querySelector('input[name="module_count"]');
  const submitButton = panel.querySelector("[data-firmware-flash-form] button[type='submit']");
  if (submitButton && input && identity && controller && modules) {
    submitButton.disabled =
      !input.value.trim() || !identity.value.trim() || !controller.value.trim() || !modules.value.trim();
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
      const moduleInput = panel.querySelector('input[name="module_count"]');
      moduleInput?.addEventListener("input", () => {
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

function formLedClearBody(form) {
  const body = new URLSearchParams(new FormData(form));
  body.set("active", "0");
  return body;
}

function sendRecommendationLedClear(form, { beacon = true } = {}) {
  const endpoint = form.dataset.recommendationLedClearEndpoint || "/recommended-actions/clear-leds";
  const body = formLedClearBody(form);

  if (navigator.sendBeacon) {
    const blob = new Blob([body.toString()], {
      type: "application/x-www-form-urlencoded; charset=UTF-8",
    });
    if (beacon && navigator.sendBeacon(endpoint, blob)) {
      return Promise.resolve();
    }
  }

  return fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "fetch",
    },
    body,
    keepalive: true,
  }).catch(() => {});
}

function sendProductFindLedClear(form, { beacon = true } = {}) {
  const endpoint = form.dataset.productFindLedClearEndpoint;
  if (!endpoint) {
    return Promise.resolve();
  }
  const body = formLedClearBody(form);

  if (navigator.sendBeacon) {
    const blob = new Blob([body.toString()], {
      type: "application/x-www-form-urlencoded; charset=UTF-8",
    });
    if (beacon && navigator.sendBeacon(endpoint, blob)) {
      return Promise.resolve();
    }
  }

  return fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "fetch",
    },
    body,
    keepalive: true,
  }).catch(() => {});
}

function wireProductFindLedCleanup() {
  document.querySelectorAll("[data-product-find-led-clear-form]").forEach((form) => {
    if (form.dataset.productFindLedClearBound === "true") {
      return;
    }
    form.dataset.productFindLedClearBound = "true";
    form.dataset.productFindLedSkipClear = "false";

    form.addEventListener("submit", (event) => {
      if (event.defaultPrevented) {
        return;
      }
      if (!event.submitter?.matches?.("[data-product-find-submit]")) {
        return;
      }
      form.dataset.productFindLedSkipClear = "true";
      window.setTimeout(() => {
        form.dataset.productFindLedSkipClear = "false";
      }, 5000);
    });
  });

  if (productFindLedClearWindowBound) {
    return;
  }
  productFindLedClearWindowBound = true;
  window.addEventListener("pagehide", () => {
    document.querySelectorAll("[data-product-find-led-clear-form]").forEach((form) => {
      if (form.dataset.productFindLedSkipClear === "true") {
        return;
      }
      sendProductFindLedClear(form);
    });
  });
}

function wireRecommendationLedCleanup() {
  document.querySelectorAll("[data-recommendation-led-clear-form]").forEach((form) => {
    if (form.dataset.recommendationLedClearBound === "true") {
      return;
    }
    form.dataset.recommendationLedClearBound = "true";
    form.dataset.recommendationLedSkipClear = "false";

    form.addEventListener("submit", (event) => {
      if (event.defaultPrevented) {
        return;
      }
      form.dataset.recommendationLedSkipClear = "true";
      window.setTimeout(() => {
        form.dataset.recommendationLedSkipClear = "false";
      }, 5000);
    });
  });

  if (recommendationLedClearWindowBound) {
    return;
  }
  recommendationLedClearWindowBound = true;
  window.addEventListener("pagehide", () => {
    document.querySelectorAll("[data-recommendation-led-clear-form]").forEach((form) => {
      if (form.dataset.recommendationLedSkipClear === "true") {
        return;
      }
      sendRecommendationLedClear(form);
    });
  });
}

function wireLocationLocate() {
  const page = document.querySelector("[data-location-page], [data-config-workspace]");
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
    "cell-management": ["cell-management"],
    "cell-mapping": ["cell-mapping"],
  };
  const sectionCopy = {
    "controller-setup": {
      title: "Add Controller",
      description: "Follow the guided ESP32 setup without leaving the Configuration console.",
    },
    "cell-management": {
      title: "Manage Locations",
      description: "Add, rename, delete, and review active storage locations in a focused flow.",
    },
    "cell-mapping": {
      title: "Cell Mapping",
      description: "Ping modules and assign them to physical storage locations.",
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
    const from = control.dataset.originalLabel || "Empty";
    const to = mappingControlLabel(control) || "Empty";
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
        ? `${changes.length} Unsaved Mapping${changes.length === 1 ? "" : "s"}`
        : "All Mappings Saved";
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
  const isPhysicalLedCommand = (target) =>
    Boolean(target?.closest?.("[data-locate-cell], [data-led-command-submit], [data-led-command-form]"));

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
      if (isPhysicalLedCommand(event.target)) {
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
      if (event.target.matches?.("[data-led-command-form]")) {
        if (event.target.hasAttribute("data-led-command-async")) {
          return;
        }
        state.allowNavigation = true;
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
      const hasStock = form.dataset.cellHasStock === "true";

      if (hasStock) {
        event.preventDefault();
        window.alert(`Move all stock out of ${cellName} before deleting it.`);
        return;
      }

      if (!window.confirm(`Delete ${cellName}? The location must be empty. Any mapped LED module will remain available in Cell Mapping.`)) {
        event.preventDefault();
      }
    });
  });
}

function resetRowCollapser(section) {
  section.querySelectorAll("[data-row-collapse-footer]").forEach((footer) => footer.remove());
  section.querySelectorAll("[data-row-collapse-frame]").forEach((frame) => {
    const tableWrap = Array.from(frame.children).find((child) => child.classList?.contains("table-wrap"));
    if (tableWrap) {
      frame.insertAdjacentElement("beforebegin", tableWrap);
    }
    frame.remove();
  });
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

function createRowCollapseFrame(tableWrap) {
  const existingFrame = tableWrap.closest("[data-row-collapse-frame]");
  if (existingFrame) {
    return existingFrame;
  }

  const frame = document.createElement("div");
  frame.className = "row-collapse-frame";
  frame.dataset.rowCollapseFrame = "true";
  tableWrap.insertAdjacentElement("beforebegin", frame);
  frame.append(tableWrap);
  return frame;
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
    const displayLabel = label.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
    const iconToggle = section.dataset.rowToggleStyle !== "plain";
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

    const frame = createRowCollapseFrame(tableWrap);
    frame.append(footer);

    const render = (expanded) => {
      rows.forEach((row, index) => {
        row.hidden = !expanded && index >= limit;
      });
      frame.classList.toggle("row-collapse-frame-collapsed", !expanded);
      frame.classList.toggle("row-collapse-frame-expanded", expanded);
      if (iconToggle) {
        footer.classList.toggle("row-collapse-footer-expanded", expanded);
        button.classList.toggle("row-collapse-icon-button-expanded", expanded);
        button.setAttribute("aria-label", expanded ? `Show Fewer ${displayLabel}` : `Show More ${displayLabel}`);
      } else {
        button.textContent = expanded ? "Show Less" : "Show More";
      }
      button.setAttribute("aria-expanded", expanded ? "true" : "false");
      status.textContent = expanded
        ? `Showing All ${rows.length} ${displayLabel}`
        : `Showing ${limit} Of ${rows.length} ${displayLabel}`;
    };

    button.addEventListener("click", () => {
      render(button.getAttribute("aria-expanded") !== "true");
    });

    render(false);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  wireActionScrollRestore();
  wireSystemHealthNotice();
  wireToasts();
  wireCopyButtons();
  wireNavState();
  wireNavOverflow();
  wireLiveSearch();
  wireQuantityShortcuts();
  wireCompletionRedirects();
  wireQuantityChangeConfirmations();
  wireProductSummaryForms();
  wireMovementStockSummaries();
  wireReportsWorkspace();
  wireReportFormatEditors();
  wireComboBoxes();
  wireAdjustmentForms();
  wirePutPlanForms();
  wireFirmwareFlash();
  wireLocationLocate();
  wireControllerHealthForms();
  wireLedCommandForms();
  wireProductFindLedCleanup();
  wireRecommendationLedCleanup();
  wireConfigurationWorkspace();
  wireCellMappingForm();
  wireCellDeleteForms();
  wireRowCollapsers();
});
