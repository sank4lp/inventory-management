import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import { serveStatic } from "../src/server/static-assets.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

class CaptureResponse extends Writable {
  constructor() {
    super();
    this.statusCode = null;
    this.headers = null;
    this.body = "";
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  _write(chunk, _encoding, callback) {
    this.body += chunk.toString("utf8");
    callback();
  }
}

function serve(pathname) {
  const response = new CaptureResponse();
  const handled = serveStatic(response, join(rootDir, "public"), pathname);
  return new Promise((resolve) => {
    if (!handled) {
      resolve({ handled, response });
      return;
    }
    response.on("finish", () => resolve({ handled, response }));
  });
}

test("static asset server exposes browser modules and rejects traversal", async () => {
  const moduleResult = await serve("/client/dom.js");
  assert.equal(moduleResult.handled, true);
  assert.equal(moduleResult.response.statusCode, 200);
  assert.match(moduleResult.response.headers["Content-Type"], /javascript/);
  assert.match(moduleResult.response.body, /setButtonLoading/);
  assert.match(moduleResult.response.body, /lockButtonSize/);
  assert.match(moduleResult.response.body, /unlockButtonSize/);

  const stylesResult = await serve("/styles.css");
  assert.equal(stylesResult.response.statusCode, 200);
  assert.match(stylesResult.response.body, /\.button-loading-compact/);
  assert.match(stylesResult.response.body, /\.button-loading-label/);
  assert.match(stylesResult.response.body, /--text-button-height:\s*42px/);
  assert.match(
    stylesResult.response.body,
    /\.mini-link\s*\{[^}]*height:\s*var\(--text-button-height\)/s,
  );
  assert.match(
    stylesResult.response.body,
    /\.report-toolbar-control > button\s*\{[^}]*height:\s*var\(--text-button-height\)/s,
  );
  assert.match(
    stylesResult.response.body,
    /\.report-toolbar-control > button\s*\{[^}]*font-size:\s*var\(--font-size-sm\)/s,
  );

  const traversalResult = await serve("/client/../app.js");
  assert.equal(traversalResult.handled, false);
});
