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
