export function debounce(callback, delay) {
  let timeoutId = null;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => callback(...args), delay);
  };
}

export function currentReturnPath(fallbackHash = "") {
  const hash = window.location.hash || fallbackHash || "";
  return `${window.location.pathname}${window.location.search}${hash}`;
}

const loadingButtonStyles = new WeakMap();

function lockButtonSize(button) {
  loadingButtonStyles.set(button, {
    width: button.style.width,
    minWidth: button.style.minWidth,
    maxWidth: button.style.maxWidth,
    height: button.style.height,
    minHeight: button.style.minHeight,
    maxHeight: button.style.maxHeight,
  });

  const bounds = button.getBoundingClientRect();
  if (bounds.width > 0) {
    const width = `${bounds.width}px`;
    button.style.width = width;
    button.style.minWidth = width;
    button.style.maxWidth = width;
  }
  if (bounds.height > 0) {
    const height = `${bounds.height}px`;
    button.style.height = height;
    button.style.minHeight = height;
    button.style.maxHeight = height;
  }
}

function unlockButtonSize(button) {
  const styles = loadingButtonStyles.get(button);
  if (!styles) {
    return;
  }
  button.style.width = styles.width;
  button.style.minWidth = styles.minWidth;
  button.style.maxWidth = styles.maxWidth;
  button.style.height = styles.height;
  button.style.minHeight = styles.minHeight;
  button.style.maxHeight = styles.maxHeight;
  loadingButtonStyles.delete(button);
}

function restoreAttribute(element, name, value) {
  if (value === undefined || value === "__unset__") {
    element.removeAttribute(name);
    return;
  }
  element.setAttribute(name, value);
}

export function setButtonLoading(button, loading, options = {}) {
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

    lockButtonSize(button);
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
    text.className = "button-loading-label";
    text.textContent = label;
    button.append(spinner, text);
    if (text.scrollWidth > text.clientWidth + 1) {
      text.classList.add("sr-only");
      button.classList.add("button-loading-compact");
    }
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
  button.classList.remove("button-loading", "button-loading-compact", "icon-button-loading");
  unlockButtonSize(button);
  delete button.dataset.loadingActive;
  delete button.dataset.loadingOriginalHtml;
  delete button.dataset.loadingOriginalDisabled;
  delete button.dataset.loadingOriginalTitle;
  delete button.dataset.loadingOriginalAriaLabel;
}

export function findFormSubmitButton(form, event, selector) {
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
