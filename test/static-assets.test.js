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

  const appResult = await serve("/app.js");
  assert.equal(appResult.response.statusCode, 200);
  assert.match(appResult.response.body, /const activeCounts = new Map\(\)/);
  assert.match(appResult.response.body, /sendLocationCountClearCommand/);
  assert.match(appResult.response.body, /wireCatalogProductQuantity/);
  assert.match(appResult.response.body, /sendProductFindLedClearEndpoint/);
  assert.match(appResult.response.body, /window\.addEventListener\("pagehide"/);

  const stylesResult = await serve("/styles.css");
  assert.equal(stylesResult.response.statusCode, 200);
  assert.match(stylesResult.response.body, /\.button-loading-compact/);
  assert.match(stylesResult.response.body, /\.button-loading-label/);
  assert.match(
    stylesResult.response.body,
    /--text-button-height:\s*clamp\(2\.5rem,\s*2\.2vw,\s*2\.75rem\)/,
  );
  assert.match(
    stylesResult.response.body,
    /--locate-button-min-width:\s*clamp\(7em,\s*5\.75vw,\s*8\.5em\)/,
  );
  assert.match(
    stylesResult.response.body,
    /--count-button-min-width:\s*clamp\(10\.5em,\s*9vw,\s*12\.5em\)/,
  );
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
  assert.match(
    stylesResult.response.body,
    /\.locate-button\s*\{[^}]*min-inline-size:\s*var\(--locate-button-min-width\)/s,
  );
  assert.match(
    stylesResult.response.body,
    /\.count-button\s*\{[^}]*min-inline-size:\s*var\(--count-button-min-width\)/s,
  );
  assert.match(stylesResult.response.body, /\.product-summary-layout\s*\{/);
  assert.match(stylesResult.response.body, /\.product-summary-facts\s*\{/);
  assert.match(stylesResult.response.body, /\.catalog-capacity-editor\s*\{/);
  assert.match(stylesResult.response.body, /\.put-capacity-recovery-grid\s*\{/);
  assert.match(stylesResult.response.body, /\.recommendation-space-badge-positive\s*\{/);

  const traversalResult = await serve("/client/../app.js");
  assert.equal(traversalResult.handled, false);
});
