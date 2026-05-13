export function sendHtml(response, html, statusCode = 200, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    ...headers,
  });
  response.end(html);
}

export function sendText(response, text, statusCode = 200, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    ...headers,
  });
  response.end(text);
}

export function sendJson(response, payload, statusCode = 200, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

export function sendRedirect(response, location, headers = {}) {
  response.writeHead(302, {
    Location: location,
    ...headers,
  });
  response.end();
}

export function appendFlash(path, message, tone = "info") {
  const url = new URL(path, "http://localhost");
  url.searchParams.set("flash", message);
  url.searchParams.set("tone", tone);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function safeLocalPath(value, fallback = "/") {
  const text = String(value || "").trim();
  if (!text) {
    return fallback;
  }

  try {
    const url = new URL(text, "http://localhost");
    if (url.origin !== "http://localhost") {
      return fallback;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

export function getFlash(url) {
  const message = url.searchParams.get("flash");
  if (!message) {
    return null;
  }

  return {
    message,
    tone: url.searchParams.get("tone") || "info",
  };
}
