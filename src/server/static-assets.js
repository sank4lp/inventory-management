import { createReadStream, existsSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";

const PUBLIC_FILES = new Map([
  ["/styles.css", "styles.css"],
  ["/theme.css", "theme.css"],
  ["/app.js", "app.js"],
]);

export function serveStatic(response, publicDir, pathname) {
  const filename = PUBLIC_FILES.get(pathname) || clientModulePath(pathname);
  if (!filename) {
    return false;
  }

  const filePath = join(publicDir, filename);
  if (!existsSync(filePath)) {
    return false;
  }

  const extension = extname(filePath);
  const contentType =
    extension === ".css"
      ? "text/css; charset=utf-8"
      : extension === ".js"
        ? "application/javascript; charset=utf-8"
        : "application/octet-stream";
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  createReadStream(filePath).pipe(response);
  return true;
}

function clientModulePath(pathname) {
  if (!pathname.startsWith("/client/") || !pathname.endsWith(".js")) {
    return null;
  }

  if (pathname.split("/").includes("..")) {
    return null;
  }

  const normalized = normalize(pathname.slice(1));
  if (normalized.startsWith(`..${sep}`) || normalized.includes(`${sep}..${sep}`)) {
    return null;
  }
  return normalized;
}
