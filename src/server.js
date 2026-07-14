import { createServer } from "node:http";
import { join } from "node:path";
import { URL } from "node:url";

import { withTransaction } from "./db.js";
import { getAppState, logger } from "./server/app-state.js";
import {
  ensureAdmin,
  ensureApiAdmin,
  ensureApiAuth,
  ensureAuth,
} from "./server/http/auth-guards.js";
import { parseForm } from "./server/http/request-body.js";
import {
  appendFlash,
  getFlash,
  safeLocalPath,
  sendHtml,
  sendJson,
  sendRedirect,
  sendText,
} from "./server/http/responses.js";
import {
  parseAdjustmentLines,
  parseCellMappingForm,
  parsePutPlanForm,
  parseRecommendedActionMoves,
  parseTaskReviewForm,
} from "./server/forms/inventory-forms.js";
import {
  adjustmentPreviewTask,
  adjustmentQuantityGuidance,
} from "./server/guidance/adjustments.js";
import {
  productFindGuidanceLines,
  productFindGuidanceTask,
} from "./server/guidance/product-find.js";
import {
  recommendationGuidanceLines,
  recommendationGuidanceTask,
  uniqueGuidanceLines,
} from "./server/guidance/recommended-actions.js";
import { serveStatic } from "./server/static-assets.js";
import {
  clearSessionCookie,
  createSessionCookie,
  getSessionUser,
  hashPassword,
  verifyPassword,
} from "./services/auth.js";
import {
  authenticateUser,
  getCellDetail,
  getProductDetail,
  getProductMovementStockSummary,
  listCells,
  listProducts,
  PUT_CAPACITY_ERROR_MESSAGE,
  registerUser,
  searchCells,
  updateUserLastActive,
} from "./services/inventory.js";
import {
  reportFormatFromForm,
  resetReportFormatSettings,
  updateReportFormatSettings,
} from "./services/report-format.js";
import { renderAdjustmentLine } from "./server/pages/shared.js";

const PORT = Number(process.env.PORT || 3000);
const publicDir = join(process.cwd(), "public");
const CAPACITY_RECOMMENDATION_KEY_PARAM = "capacity_recommendation_key";
const ACTIVE_PRODUCT_FIND_GUIDANCE_PREFIX = "active_product_find_guidance";
const ACTIVE_RECOMMENDATION_GUIDANCE_PREFIX = "active_recommendation_guidance";

getAppState();

function requestWantsJson(request) {
  const accept = String(request.headers.accept || "").toLowerCase();
  const requestedWith = String(request.headers["x-requested-with"] || "").toLowerCase();
  return requestedWith === "fetch" || accept.includes("application/json");
}

function putCapacityRetryPath(form) {
  const retryPath = movementRetryPath("/put", form);
  return `${retryPath}${retryPath.includes("?") ? "&" : "?"}capacity_help=1`;
}

function movementRetryPath(path, form) {
  const params = new URLSearchParams();
  if (form.product_id) {
    params.set("product_id", form.product_id);
  }
  if (form.quantity) {
    params.set("quantity", form.quantity);
  }
  if (form.context_cell_id || form.preferred_cell_id) {
    params.set("cell_id", form.context_cell_id || form.preferred_cell_id);
  }
  return `${path}${params.toString() ? `?${params.toString()}` : ""}`;
}

function preferredCellIdsFromForm(form) {
  return Object.entries(form)
    .filter(([key, value]) => /^preferred_cell_\d+$/.test(key) && String(value || "").trim())
    .map(([key, value]) => Number(value || key.replace("preferred_cell_", "")))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function saveCustomProductFields(productFieldService, { productId, form, actor }) {
  const fields = productFieldService
    .list()
    .filter((field) => field.field_kind === "custom" && field.visible);
  for (const field of fields) {
    const key = `custom_field_${field.id}`;
    if (!Object.prototype.hasOwnProperty.call(form, key)) {
      if (field.required) {
        throw new Error(`${field.label} is required.`);
      }
      continue;
    }
    productFieldService.setProductValue({
      actor,
      productId,
      fieldId: field.id,
      value: form[key],
    });
  }
}

function capacityRecommendationPromptPath(returnTo, recommendationKey) {
  const url = new URL(returnTo, "http://localhost");
  url.searchParams.set(CAPACITY_RECOMMENDATION_KEY_PARAM, recommendationKey);
  return `${url.pathname}${url.search}${url.hash}`;
}

function productFindActivePath(returnTo) {
  const url = new URL(returnTo, "http://localhost");
  url.searchParams.set("find_led", "1");
  return `${url.pathname}${url.search}${url.hash}`;
}

function productFindMovementReturnPath(returnTo, form, productId) {
  const url = new URL(returnTo, "http://localhost");
  if (!["/pick", "/put"].includes(url.pathname)) {
    return returnTo;
  }

  const formHas = (key) => Object.prototype.hasOwnProperty.call(form, key);
  const productValue = String(form.product_id || productId || "").trim();
  if (productValue) {
    url.searchParams.set("product_id", productValue);
  }

  if (formHas("quantity")) {
    const quantity = String(form.quantity || "").trim();
    if (quantity) {
      url.searchParams.set("quantity", quantity);
    } else {
      url.searchParams.delete("quantity");
    }
  }

  if (form.context_cell_id || form.preferred_cell_id) {
    url.searchParams.set("cell_id", form.context_cell_id || form.preferred_cell_id);
  }

  const preferredCellIds = preferredCellIdsFromForm(form);
  if (preferredCellIds.length) {
    url.searchParams.set("preferred_cell_ids", preferredCellIds.join(","));
  } else {
    url.searchParams.delete("preferred_cell_ids");
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

function sanitizedGuidanceLines(guidanceLines) {
  return guidanceLines.map((line) => ({
    id: line.id ?? line.cell_id ?? null,
    cell_id: line.cell_id ?? line.id ?? null,
    logical_code: line.logical_code || "",
    controller_id: line.controller_id ?? null,
    controller_address: line.controller_address || line.address || "",
    hardware_channel: line.hardware_channel ?? null,
    planned_quantity: line.planned_quantity ?? null,
    guidance_color: line.guidance_color || "",
    guidance_role: line.guidance_role || "",
  }));
}

function activeProductFindGuidanceKey(userId, productId) {
  const id = Number(productId);
  if (!userId || !Number.isFinite(id) || id <= 0) {
    return "";
  }
  return `${ACTIVE_PRODUCT_FIND_GUIDANCE_PREFIX}:${userId}:${id}`;
}

function readActiveProductFindGuidance(db, userId, productId) {
  const metadataKey = activeProductFindGuidanceKey(userId, productId);
  if (!metadataKey) {
    return null;
  }
  const row = db.prepare("SELECT value FROM app_metadata WHERE key = ?").get(metadataKey);
  if (!row?.value) {
    return null;
  }

  try {
    const parsed = JSON.parse(row.value);
    return {
      metadataKey,
      lines: Array.isArray(parsed.lines) ? parsed.lines : [],
      productId: parsed.productId || productId,
      sku: parsed.sku || "",
    };
  } catch {
    return {
      metadataKey,
      lines: [],
      productId,
      sku: "",
    };
  }
}

function saveActiveProductFindGuidance(db, userId, product, guidanceLines) {
  const metadataKey = activeProductFindGuidanceKey(userId, product?.id);
  if (!metadataKey || !guidanceLines.length) {
    return;
  }
  const now = new Date().toISOString();
  db.prepare(
    `
      INSERT INTO app_metadata (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `,
  ).run(
    metadataKey,
    JSON.stringify({
      productId: product.id,
      sku: product.sku || "",
      lines: sanitizedGuidanceLines(guidanceLines),
      updatedAt: now,
    }),
    now,
  );
}

function deleteActiveProductFindGuidance(db, userId, productId) {
  const metadataKey = activeProductFindGuidanceKey(userId, productId);
  if (!metadataKey) {
    return;
  }
  db.prepare("DELETE FROM app_metadata WHERE key = ?").run(metadataKey);
}

function activeRecommendationGuidanceKey(userId, recommendationKey) {
  const key = String(recommendationKey || "").trim();
  if (!userId || !key) {
    return "";
  }
  return `${ACTIVE_RECOMMENDATION_GUIDANCE_PREFIX}:${userId}:${key}`;
}

function readActiveRecommendationGuidance(db, userId, recommendationKey) {
  const metadataKey = activeRecommendationGuidanceKey(userId, recommendationKey);
  if (!metadataKey) {
    return null;
  }
  const row = db.prepare("SELECT value FROM app_metadata WHERE key = ?").get(metadataKey);
  if (!row?.value) {
    return null;
  }

  try {
    const parsed = JSON.parse(row.value);
    return {
      metadataKey,
      lines: Array.isArray(parsed.lines) ? parsed.lines : [],
      recommendationKey: parsed.recommendationKey || recommendationKey,
      reason: parsed.reason || "",
    };
  } catch {
    return {
      metadataKey,
      lines: [],
      recommendationKey,
      reason: "",
    };
  }
}

function saveActiveRecommendationGuidance(db, userId, form, guidanceLines) {
  const metadataKey = activeRecommendationGuidanceKey(userId, form.recommendation_key);
  if (!metadataKey || !guidanceLines.length) {
    return;
  }
  const now = new Date().toISOString();
  db.prepare(
    `
      INSERT INTO app_metadata (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `,
  ).run(
    metadataKey,
    JSON.stringify({
      recommendationKey: form.recommendation_key || "",
      reason: form.reason || "",
      lines: sanitizedGuidanceLines(guidanceLines),
      updatedAt: now,
    }),
    now,
  );
}

function deleteActiveRecommendationGuidance(db, userId, recommendationKey) {
  const metadataKey = activeRecommendationGuidanceKey(userId, recommendationKey);
  if (!metadataKey) {
    return;
  }
  db.prepare("DELETE FROM app_metadata WHERE key = ?").run(metadataKey);
}

function buildRecommendationGuidanceLines(cells, form, { moveIndex = "all" } = {}) {
  const index = String(moveIndex || "all").trim();
  const moves = parseRecommendedActionMoves(form);
  const selectedMoves =
    index && index !== "all" ? moves.filter((move) => String(move.index) === index) : moves;

  return uniqueGuidanceLines(
    selectedMoves.flatMap((move) =>
      recommendationGuidanceLines(cells, {
        sourceCellId: move.sourceCellId || form.source_cell_id,
        targetCellId: move.targetCellId,
        quantity: move.quantity,
      }),
    ),
  );
}

function createAutomaticBackup(source) {
  const { backupService } = getAppState();

  try {
    const result = backupService.createAutomaticBackupIfDue({
      source,
    });
    return {
      ok: true,
      ...result,
    };
  } catch (error) {
    logger.error("backup.auto.failed", {
      source,
      error: error.message,
    });
    return {
      ok: false,
      error: error.message,
    };
  }
}

function createRequiredSafetyBackup(source) {
  const { backupService } = getAppState();
  return backupService.createBackup({
    kind: "manual",
    source,
  });
}

function createRequiredCriticalBackup(source) {
  const { backupService } = getAppState();
  return backupService.createCriticalBackup({
    source,
  }).backup;
}

function createCriticalBackup(source) {
  const { backupService } = getAppState();

  try {
    return {
      ok: true,
      ...backupService.createCriticalBackup({
        source,
      }),
    };
  } catch (error) {
    logger.error("backup.critical.failed", {
      source,
      error: error.message,
    });
    return {
      ok: false,
      error: error.message,
    };
  }
}

function backupAwareFlash(message, tone, backupResult) {
  if (backupResult?.ok) {
    return {
      message,
      tone,
    };
  }

  return {
    message: `${message} Backup failed: ${backupResult?.error || "Unknown error"}`,
    tone: tone === "error" ? "error" : "warning",
  };
}

export const requestHandler = async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const {
    adminService,
    anomalyService,
    backupService,
    catalogService,
    db,
    firmwareService,
    hardwareService,
    locationService,
    pages,
    productFieldService,
    systemService,
    taskService,
    unitConversionService,
  } = getAppState();
  const user = getSessionUser(request, db);
  const flash = getFlash(url);

  if (serveStatic(response, publicDir, url.pathname)) {
    return;
  }

  try {
    if (user) {
      updateUserLastActive(db, user.id);
    }

    systemService.cancelStalePendingReviewTasks();

    if (request.method === "GET" && url.pathname === "/api/system/health") {
      if (!ensureApiAuth(response, user)) {
        return;
      }
      const health = systemService.healthSummary(getAppState().startup);
      sendJson(response, {
        degraded: health.degraded,
        message: health.message,
        warnings: health.warnings,
        overallStatus: health.overallStatus,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/fragments/catalog-products") {
      if (!ensureAuth(response, user)) {
        return;
      }
      const q = url.searchParams.get("q") || "";
      sendText(
        response,
        pages.renderCatalogProductResults(
          listProducts(db, q),
          q ? "No products match that search." : "No products have been added yet.",
          q,
        ),
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/fragments/movement-stock-locations") {
      if (!ensureAuth(response, user)) {
        return;
      }
      const productId = Number(url.searchParams.get("product_id") || 0);
      const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
      const limit = Math.min(25, Math.max(1, Number(url.searchParams.get("limit") || 5)));
      const product = getProductMovementStockSummary(db, productId, { limit, offset });
      sendText(response, product ? pages.renderMovementStockRows(product) : "");
      return;
    }

    if (request.method === "GET" && url.pathname === "/fragments/cell-search") {
      if (!ensureAuth(response, user)) {
        return;
      }
      const q = url.searchParams.get("q") || "";
      sendText(
        response,
        q
          ? pages.renderCellSearchResults(searchCells(db, q), q)
          : `<p class="muted">Search a location to see what products are inside it.</p>`,
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/login") {
      sendHtml(response, pages.renderLogin(flash));
      return;
    }

    if (request.method === "POST" && url.pathname === "/login") {
      const form = await parseForm(request);
      const signedInUser = authenticateUser(db, {
        username: form.username || "",
        password: form.password || "",
        verifyPassword,
      });
      logger.info("auth.login", {
        userId: signedInUser.id,
        username: signedInUser.username,
      });
      sendRedirect(response, appendFlash("/", "Signed in successfully.", "success"), {
        "Set-Cookie": createSessionCookie(signedInUser),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/register") {
      sendHtml(response, pages.renderRegister(flash));
      return;
    }

    if (request.method === "POST" && url.pathname === "/register") {
      const form = await parseForm(request);
      const newUser = registerUser(db, {
        registrationKey: form.registration_key,
        name: form.name,
        username: form.username,
        password: form.password,
        hashPassword,
      });
      logger.info("auth.register", {
        userId: newUser.id,
        username: newUser.username,
        role: newUser.role,
      });
      const backupResult = createAutomaticBackup("user-registration");
      const nextFlash = backupAwareFlash("Registration completed.", "success", backupResult);
      sendRedirect(response, appendFlash("/", nextFlash.message, nextFlash.tone), {
        "Set-Cookie": createSessionCookie(newUser),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/logout") {
      if (user) {
        logger.info("auth.logout", {
          userId: user.id,
          username: user.username,
        });
      }
      sendRedirect(response, "/login", {
        "Set-Cookie": clearSessionCookie(),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/profile") {
      if (!ensureAuth(response, user)) {
        return;
      }
      sendHtml(response, pages.renderProfile(user, flash));
      return;
    }

    if (request.method === "GET" && url.pathname === "/") {
      if (!ensureAuth(response, user)) {
        return;
      }
      sendHtml(response, pages.renderHome(user, flash, url));
      return;
    }

    if (request.method === "GET" && url.pathname === "/products") {
      if (!ensureAuth(response, user)) {
        return;
      }
      sendHtml(
        response,
        pages.renderProducts(
          user,
          flash,
          url.searchParams.get("q") || "",
          url.searchParams.get("show_add") === "1",
        ),
      );
      return;
    }

    const productMatch = url.pathname.match(/^\/products\/(\d+)$/);
    if (request.method === "GET" && productMatch) {
      if (!ensureAuth(response, user)) {
        return;
      }
      const product = getProductDetail(db, Number(productMatch[1]));
      sendHtml(response, pages.renderProductDetail(user, flash, product, url));
      return;
    }

    const productFindClearMatch = url.pathname.match(/^\/products\/(\d+)\/find\/clear$/);
    if (request.method === "POST" && productFindClearMatch) {
      if (!ensureAuth(response, user)) {
        return;
      }
      const productId = Number(productFindClearMatch[1]);
      const product = getProductDetail(db, productId);
      const activeGuidance = readActiveProductFindGuidance(db, user.id, productId);
      const guidanceLines = activeGuidance?.lines?.length
        ? activeGuidance.lines
        : productFindGuidanceLines(product || {});
      if (guidanceLines.length) {
        hardwareService.clearGuidance(productFindGuidanceTask(product || { id: productId }), guidanceLines, {
          source: "product_find_leave",
          productId,
        });
      }
      deleteActiveProductFindGuidance(db, user.id, productId);
      sendText(response, "", 204, { "Cache-Control": "no-store" });
      return;
    }

    const productFindMatch = url.pathname.match(/^\/products\/(\d+)\/find$/);
    if (request.method === "POST" && productFindMatch) {
      if (!ensureAuth(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const productId = Number(productFindMatch[1]);
      const returnTo = productFindMovementReturnPath(
        safeLocalPath(form.return_to, `/products/${productId}`),
        form,
        productId,
      );
      const product = getProductDetail(db, productId);
      if (!product) {
        sendRedirect(response, appendFlash(returnTo, "Product not found.", "error"));
        return;
      }
      const guidanceLines = productFindGuidanceLines(product);
      if (!guidanceLines.length) {
        sendRedirect(
          response,
          appendFlash(
            returnTo,
            "This product is not stored in any location yet.",
            "error",
          ),
        );
        return;
      }
      const activeGuidance = readActiveProductFindGuidance(db, user.id, productId);
      if (activeGuidance?.lines?.length) {
        hardwareService.clearGuidance(productFindGuidanceTask(product), activeGuidance.lines, {
          source: "product_find_relight",
          productId,
        });
        deleteActiveProductFindGuidance(db, user.id, productId);
      }
      const guidance = hardwareService.activateGuidance(productFindGuidanceTask(product), guidanceLines, {
        source: "product_find",
        productId,
      });
      if (guidance.ok !== false) {
        saveActiveProductFindGuidance(db, user.id, product, guidanceLines);
      }
      const mappedCount = guidanceLines.filter(
        (line) => line.hardware_channel && (line.controller_address || line.controller_id),
      ).length;
      const baseMessage = mappedCount > 0
        ? `Showing ${product.sku} quantities on ${mappedCount} mapped LED module(s) in yellow.`
        : `${product.sku} is stored in ${guidanceLines.length} location(s), but none have mapped LED modules.`;
      const message = guidance.degraded && guidance.message
        ? `${baseMessage} ${guidance.message}`
        : baseMessage;
      sendRedirect(
        response,
        appendFlash(
          productFindActivePath(returnTo),
          message,
          guidance.degraded ? "warning" : "success",
        ),
      );
      return;
    }

    const productCapacityMatch = url.pathname.match(/^\/products\/(\d+)\/items-per-cell$/);
    if (request.method === "POST" && productCapacityMatch) {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const productId = Number(productCapacityMatch[1]);
      const previousRecommendationKeys = new Set(
        anomalyService
          .getRecommendedActions()
          .filter((action) => Number(action.productId) === productId)
          .map((action) => action.key),
      );
      catalogService.updateProductItemsPerCell({
        productId,
        itemsPerCell: form.items_per_cell,
      });
      const backupResult = createAutomaticBackup("product-capacity-update");
      const returnTo = safeLocalPath(form.return_to, `/products/${productId}`);
      const newRecommendation = anomalyService
        .getRecommendedActions()
        .find(
          (action) =>
            Number(action.productId) === productId &&
            !previousRecommendationKeys.has(action.key),
        );
      if (newRecommendation) {
        const nextFlash = backupAwareFlash(
          "Capacity updated. A recommended inventory action was created; review it now or skip for later.",
          "warning",
          backupResult,
        );
        sendRedirect(
          response,
          appendFlash(
            capacityRecommendationPromptPath(returnTo, newRecommendation.key),
            nextFlash.message,
            nextFlash.tone,
          ),
        );
        return;
      }
      const nextFlash = backupAwareFlash("Items per cell updated.", "success", backupResult);
      sendRedirect(
        response,
        appendFlash(returnTo, nextFlash.message, nextFlash.tone),
      );
      return;
    }

    const productDetailsMatch = url.pathname.match(/^\/products\/(\d+)\/details$/);
    if (request.method === "POST" && productDetailsMatch) {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const productId = Number(productDetailsMatch[1]);
      const form = await parseForm(request);
      try {
        withTransaction(db, () => {
          catalogService.updateProductDetails({
            productId,
            name: form.name,
            brand: form.brand,
            category: form.category,
            variant: form.variant,
            unit_of_measure: form.unit_of_measure,
            description: form.description,
          });
          saveCustomProductFields(productFieldService, {
            productId,
            form,
            actor: user,
          });
        });
      } catch (error) {
        sendRedirect(response, appendFlash(`/products/${productId}`, error.message, "error"));
        return;
      }
      const backupResult = createAutomaticBackup("product-details-update");
      const nextFlash = backupAwareFlash("Product details updated.", "success", backupResult);
      sendRedirect(response, appendFlash(`/products/${productId}`, nextFlash.message, nextFlash.tone));
      return;
    }

    const productDeleteMatch = url.pathname.match(/^\/products\/(\d+)\/delete$/);
    if (request.method === "POST" && productDeleteMatch) {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const productId = Number(productDeleteMatch[1]);
      try {
        catalogService.removeProduct(productId);
      } catch (error) {
        sendRedirect(response, appendFlash(`/products/${productId}`, error.message, "error"));
        return;
      }
      const backupResult = createAutomaticBackup("product-remove");
      const nextFlash = backupAwareFlash("Product removed from the active catalog.", "success", backupResult);
      sendRedirect(response, appendFlash("/products", nextFlash.message, nextFlash.tone));
      return;
    }

    if (request.method === "POST" && url.pathname === "/products") {
      if (!ensureAuth(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const product = withTransaction(db, () => {
        const created = catalogService.createProduct(form);
        saveCustomProductFields(productFieldService, {
          productId: created.id,
          form,
          actor: user,
        });
        return created;
      });
      const backupResult = createAutomaticBackup("product-create");
      const nextFlash = backupAwareFlash("Product saved.", "success", backupResult);
      const nextPath =
        form.next_action === "put"
          ? `/put?product_id=${product.id}`
          : `/products/${product.id}`;
      sendRedirect(response, appendFlash(nextPath, nextFlash.message, nextFlash.tone));
      return;
    }

    if (request.method === "GET" && url.pathname === "/pick") {
      if (!ensureAuth(response, user)) {
        return;
      }
      sendHtml(response, pages.renderPick(user, flash, url));
      return;
    }

    if (request.method === "POST" && url.pathname === "/pick") {
      if (!ensureAuth(response, user)) {
        return;
      }
      const form = await parseForm(request);
      let task;
      let guidance;
      try {
        ({ task, guidance } = taskService.createPickTask({
          userId: user.id,
          productId: form.product_id,
          quantity: form.quantity,
          preferredCellId: form.preferred_cell_id || null,
          preferredCellIds: preferredCellIdsFromForm(form),
        }));
      } catch (error) {
        sendRedirect(
          response,
          appendFlash(movementRetryPath("/pick", form), error.message, "error"),
        );
        return;
      }
      const backupResult = createAutomaticBackup("task-pick-create");
      const nextFlash = backupAwareFlash(
        guidance.degraded
          ? "Pick task created. Hardware guidance is unavailable, so continue with manual on-screen guidance."
          : "Pick task created and guidance activated.",
        guidance.degraded ? "warning" : "success",
        backupResult,
      );
      sendRedirect(
        response,
        appendFlash(`/tasks/${task.id}`, nextFlash.message, nextFlash.tone),
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/put") {
      if (!ensureAuth(response, user)) {
        return;
      }
      sendHtml(response, pages.renderPut(user, flash, url));
      return;
    }

    if (request.method === "GET" && url.pathname === "/cells") {
      if (!ensureAuth(response, user)) {
        return;
      }
      sendHtml(response, pages.renderCells(user, flash, url.searchParams.get("q") || ""));
      return;
    }

    const cellMatch = url.pathname.match(/^\/cells\/(\d+)$/);
    if (request.method === "GET" && cellMatch) {
      if (!ensureAuth(response, user)) {
        return;
      }
      const cell = getCellDetail(db, Number(cellMatch[1]));
      sendHtml(response, pages.renderCellDetail(user, flash, cell));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/cells/locate/clear-all") {
      if (!ensureApiAuth(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const cellIds = String(form.cell_ids || "")
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value > 0);
      const selectedCells = cellIds.length
        ? locationService.listCellCatalog().filter((cell) => cellIds.includes(cell.id))
        : [];
      const result = hardwareService.clearAllCellLocates(selectedCells);
      sendJson(response, {
        ok: result.ok,
        degraded: result.degraded,
        message: result.message,
        clearedCellIds: selectedCells.map((cell) => cell.id),
      });
      return;
    }

    const apiCellLocateMatch = url.pathname.match(/^\/api\/cells\/(\d+)\/locate$/);
    if (request.method === "POST" && apiCellLocateMatch) {
      if (!ensureApiAuth(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const cell = locationService
        .listCellCatalog()
        .find((entry) => entry.id === Number(apiCellLocateMatch[1]));
      if (!cell) {
        sendJson(response, { error: "Cell not found." }, 404);
        return;
      }
      const active = !["0", "false", "off", "clear"].includes(
        String(form.active || form.action || "1").toLowerCase(),
      );
      const result = hardwareService.setCellLocate(cell, active);
      sendJson(response, {
        ok: result.ok,
        degraded: result.degraded,
        message: result.message,
        active,
        cell: {
          id: cell.id,
          logicalCode: cell.logical_code,
          hardwareChannel: cell.hardware_channel,
        },
      });
      return;
    }

    const apiCellPingMatch = url.pathname.match(/^\/api\/cells\/(\d+)\/ping$/);
    if (request.method === "POST" && apiCellPingMatch) {
      if (!ensureApiAuth(response, user)) {
        return;
      }
      const cell = locationService
        .listCellCatalog()
        .find((entry) => entry.id === Number(apiCellPingMatch[1]));
      if (!cell) {
        sendJson(response, { error: "Cell not found." }, 404);
        return;
      }
      const result = hardwareService.sendCellTest(cell, "green");
      sendJson(response, {
        ok: result.ok,
        degraded: result.degraded,
        message: result.degraded
          ? `Ping skipped for ${cell.logical_code}. This location has no LED mapped.`
          : `Ping sent for ${cell.logical_code}.`,
        cell: {
          id: cell.id,
          logicalCode: cell.logical_code,
          hardwareChannel: cell.hardware_channel,
        },
      });
      return;
    }

    const apiCellCountMatch = url.pathname.match(/^\/api\/cells\/(\d+)\/count$/);
    if (request.method === "POST" && apiCellCountMatch) {
      if (!ensureApiAuth(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const cell = locationService
        .listCells()
        .find((entry) => entry.id === Number(apiCellCountMatch[1]));
      if (!cell) {
        sendJson(response, { error: "Cell not found." }, 404);
        return;
      }

      const productId = Number(form.product_id || 0);
      let quantity = Number(cell.occupied_quantity || 0);
      let product = null;
      if (productId > 0) {
        product = getProductDetail(db, productId);
        if (!product) {
          sendJson(response, { error: "Product not found." }, 404);
          return;
        }
        const productLocation = product.locations.find(
          (location) => Number(location.cell_id) === Number(cell.id),
        );
        quantity = Number(productLocation?.available_quantity || 0);
      }
      if (!Number.isFinite(quantity) || quantity < 0) {
        sendJson(response, { error: "A valid stock quantity could not be determined." }, 422);
        return;
      }

      const displayQuantity = Number.isInteger(quantity)
        ? String(quantity)
        : quantity.toFixed(2).replace(/\.?0+$/, "");
      const guidance = hardwareService.showCellQuantity(cell, displayQuantity, "yellow", {
        source: product ? "product_location_quantity" : "location_stock_count",
        productId: product?.id || null,
      });

      sendJson(response, {
        ok: guidance.ok,
        degraded: guidance.degraded,
        message:
          guidance.message ||
          `Showing ${quantity} on ${cell.logical_code} in yellow.`,
        displayQuantity: quantity,
        color: "yellow",
        cell: {
          id: cell.id,
          logicalCode: cell.logical_code,
          hardwareChannel: cell.hardware_channel,
        },
        product: product ? { id: product.id, sku: product.sku } : null,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/put") {
      if (!ensureAuth(response, user)) {
        return;
      }
      const form = await parseForm(request);
      let task;
      let guidance;
      try {
        ({ task, guidance } = taskService.createPutTask({
          userId: user.id,
          productId: form.product_id,
          quantity: form.quantity,
          preferredCellId: form.preferred_cell_id || null,
          preferredCellIds: preferredCellIdsFromForm(form),
        }));
      } catch (error) {
        if (error.message === PUT_CAPACITY_ERROR_MESSAGE) {
          sendRedirect(
            response,
            appendFlash(putCapacityRetryPath(form), error.message, "error"),
          );
          return;
        }
        sendRedirect(
          response,
          appendFlash(movementRetryPath("/put", form), error.message, "error"),
        );
        return;
      }
      const backupResult = createAutomaticBackup("task-put-create");
      const nextFlash = backupAwareFlash(
        guidance.degraded
          ? "Put task created. Hardware guidance is unavailable, so continue with manual on-screen guidance."
          : "Put task created and guidance activated.",
        guidance.degraded ? "warning" : "success",
        backupResult,
      );
      sendRedirect(
        response,
        appendFlash(`/tasks/${task.id}`, nextFlash.message, nextFlash.tone),
      );
      return;
    }

    const taskMatch = url.pathname.match(/^\/tasks\/(\d+)$/);
    if (request.method === "GET" && taskMatch) {
      if (!ensureAuth(response, user)) {
        return;
      }
      const task = taskService.getTask(Number(taskMatch[1]));
      const mode = url.searchParams.get("mode") === "edit" ? "edit" : "view";
      if (mode === "edit" && task && (!pages.canEditTask(user, task) || task.status !== "completed")) {
        sendRedirect(response, appendFlash(`/tasks/${task.id}`, "You can edit only your own tasks unless you are an admin.", "error"));
        return;
      }
      sendHtml(
        response,
        pages.renderTask(user, flash, task, mode, {
          cancel:
            task && task.status !== "completed" && task.status !== "cancelled"
              ? taskService.issueActionToken("task-cancel", task.id, user.id)
              : null,
          confirm:
            task && task.status !== "completed" && task.status !== "cancelled"
              ? taskService.issueActionToken("task-confirm", task.id, user.id)
              : null,
          putPlan:
            task && task.type === "put" && task.status !== "completed" && task.status !== "cancelled"
              ? taskService.issueActionToken("task-put-plan", task.id, user.id)
              : null,
          correct:
            task && task.status === "completed"
              ? taskService.issueActionToken("task-correct", task.id, user.id)
              : null,
        }, {
          showCompletionDialog: url.searchParams.get("completed") === "1",
        }),
      );
      return;
    }

    const putPlanMatch = url.pathname.match(/^\/tasks\/(\d+)\/put-plan$/);
    if (request.method === "POST" && putPlanMatch) {
      if (!ensureAuth(response, user)) {
        return;
      }
      const task = taskService.getTask(Number(putPlanMatch[1]));
      if (!task || !pages.canEditTask(user, task)) {
        sendRedirect(response, appendFlash(`/tasks/${putPlanMatch[1]}`, "You can adjust only your own tasks unless you are an admin.", "error"));
        return;
      }
      const form = await parseForm(request);
      const updated = taskService.updatePutPlan({
        taskId: Number(putPlanMatch[1]),
        allocations: parsePutPlanForm(form),
        userId: user.id,
        note: form.note,
        submissionToken: form.submission_token,
      });
      const backupResult = createAutomaticBackup("task-put-plan-adjust");
      const nextFlash = backupAwareFlash(
        updated.guidance.degraded
          ? "Put cells updated. Hardware guidance is unavailable, so continue with manual on-screen guidance."
          : "Put cells updated and LED quantities refreshed.",
        updated.guidance.degraded ? "warning" : "success",
        backupResult,
      );
      sendRedirect(
        response,
        appendFlash(`/tasks/${updated.task.id}`, nextFlash.message, nextFlash.tone),
      );
      return;
    }

    const confirmMatch = url.pathname.match(/^\/tasks\/(\d+)\/confirm$/);
    if (request.method === "POST" && confirmMatch) {
      if (!ensureAuth(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const { actualQuantities, actualCellIds } = parseTaskReviewForm(form);
      const completion = taskService.confirmTask({
        taskId: Number(confirmMatch[1]),
        actualQuantities,
        actualCellIds,
        userId: user.id,
        note: form.note,
        submissionToken: form.submission_token,
      });
      const backupResult = createAutomaticBackup("task-confirm");
      const nextFlash = backupAwareFlash(
        completion.anomalies.length
          ? `Action completed. ${completion.anomalies.length} recommended action warning(s) were created.`
          : "Action completed successfully.",
        completion.anomalies.length ? "error" : "success",
        backupResult,
      );
      sendRedirect(
        response,
        appendFlash(`/tasks/${completion.task.id}?completed=1`, nextFlash.message, nextFlash.tone),
      );
      return;
    }

    const correctMatch = url.pathname.match(/^\/tasks\/(\d+)\/correct$/);
    if (request.method === "POST" && correctMatch) {
      if (!ensureAuth(response, user)) {
        return;
      }
      const task = taskService.getTask(Number(correctMatch[1]));
      if (!task || !pages.canEditTask(user, task)) {
        sendRedirect(response, appendFlash(`/tasks/${correctMatch[1]}`, "You can edit only your own tasks unless you are an admin.", "error"));
        return;
      }
      const form = await parseForm(request);
      const { actualQuantities, actualCellIds } = parseTaskReviewForm(form);
      const correction = taskService.correctTask({
        taskId: Number(correctMatch[1]),
        actualQuantities,
        actualCellIds,
        userId: user.id,
        note: form.note,
        submissionToken: form.submission_token,
      });
      const backupResult = createAutomaticBackup("task-correct");
      const nextFlash = backupAwareFlash(
        correction.anomalies.length
          ? `Correction saved. ${correction.anomalies.length} recommended action warning(s) remain.`
          : "Correction saved successfully.",
        correction.anomalies.length ? "error" : "success",
        backupResult,
      );
      sendRedirect(
        response,
        appendFlash(`/tasks/${correction.task.id}`, nextFlash.message, nextFlash.tone),
      );
      return;
    }

    const buttonMatch = url.pathname.match(/^\/tasks\/(\d+)\/simulate-button$/);
    if (request.method === "POST" && buttonMatch) {
      if (!ensureAuth(response, user)) {
        return;
      }
      const task = taskService.getTask(Number(buttonMatch[1]));
      if (!task || !pages.canEditTask(user, task)) {
        sendRedirect(response, appendFlash(`/tasks/${buttonMatch[1]}`, "You can confirm only your own tasks unless you are an admin.", "error"));
        return;
      }
      if (task.status === "cancelled") {
        sendRedirect(response, appendFlash(`/tasks/${buttonMatch[1]}`, "Cancelled tasks cannot be continued.", "error"));
        return;
      }
      if (task.status === "completed") {
        sendRedirect(response, appendFlash(`/tasks/${buttonMatch[1]}`, "Completed tasks can only be changed through correction mode.", "error"));
        return;
      }
      const form = await parseForm(request);
      const line = taskService.recordPhysicalConfirmation({
        lineId: Number(form.line_id),
        taskId: Number(buttonMatch[1]),
        userId: user.id,
      });
      const backupResult = createAutomaticBackup("task-physical-confirm");
      const nextFlash = backupAwareFlash(
        `Marked ${line.logical_code} as reached.`,
        "success",
        backupResult,
      );
      sendRedirect(
        response,
        appendFlash(`/tasks/${buttonMatch[1]}`, nextFlash.message, nextFlash.tone),
      );
      return;
    }

    const cancelMatch = url.pathname.match(/^\/tasks\/(\d+)\/cancel$/);
    if (request.method === "POST" && cancelMatch) {
      if (!ensureAuth(response, user)) {
        return;
      }
      const task = taskService.getTask(Number(cancelMatch[1]));
      if (!task || !pages.canEditTask(user, task)) {
        sendRedirect(response, appendFlash(`/tasks/${cancelMatch[1]}`, "You can cancel only your own tasks unless you are an admin.", "error"));
        return;
      }
      const form = await parseForm(request);
      const cancelledTask = taskService.cancelTask({
        taskId: Number(cancelMatch[1]),
        userId: user.id,
        submissionToken: form.submission_token,
      });
      const backupResult = createAutomaticBackup("task-cancel");
      const nextFlash = backupAwareFlash("Task cancelled.", "success", backupResult);
      sendRedirect(response, appendFlash(`/tasks/${cancelledTask.id}`, nextFlash.message, nextFlash.tone));
      return;
    }

    if (request.method === "GET" && url.pathname === "/reports") {
      if (!ensureAuth(response, user)) {
        return;
      }
      sendHtml(response, pages.renderReports(user, flash, url));
      return;
    }

    if (request.method === "POST" && url.pathname === "/reports/format") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      updateReportFormatSettings(db, reportFormatFromForm(form));
      const backupResult = createAutomaticBackup("report-format-update");
      const nextFlash = backupAwareFlash("Report format saved.", "success", backupResult);
      const returnTo = safeLocalPath(form.return_to, "/reports?format=1");
      sendRedirect(response, appendFlash(returnTo, nextFlash.message, nextFlash.tone));
      return;
    }

    if (request.method === "POST" && url.pathname === "/reports/format/reset") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      resetReportFormatSettings(db);
      const backupResult = createAutomaticBackup("report-format-reset");
      const nextFlash = backupAwareFlash("Report format reset.", "success", backupResult);
      const returnTo = safeLocalPath(form.return_to, "/reports?format=1");
      sendRedirect(response, appendFlash(returnTo, nextFlash.message, nextFlash.tone));
      return;
    }

    if (request.method === "GET" && url.pathname === "/backups") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      sendHtml(response, pages.renderBackups(user, flash));
      return;
    }

    if (request.method === "POST" && url.pathname === "/backups/create") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const backup = backupService.createBackup({
        kind: "manual",
        source: `manual-${user.username || user.id}`,
      });
      sendRedirect(
        response,
        appendFlash(
          "/backups",
          `Manual backup created: ${backup.filename}.`,
          "success",
        ),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/backups/schedule") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const schedule = backupService.updateAutomaticBackupSchedule({
        cadence: form.cadence,
        startTime: form.start_time,
      });
      const returnTo = safeLocalPath(form.return_to, "/backups");
      sendRedirect(
        response,
        appendFlash(
          returnTo,
          `Automatic backup schedule saved: ${schedule.label} at ${schedule.startTime}.`,
          "success",
        ),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/backups/retention") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const result = backupService.updateBackupRetention({
        retentionDays: form.retention_days,
      });
      const returnTo = safeLocalPath(form.return_to, "/backups");
      sendRedirect(
        response,
        appendFlash(
          returnTo,
          `Backup retention saved: ${result.retentionDays} day(s).`,
          "success",
        ),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/backups/restore") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      if (String(form.confirm_restore || "").trim() !== "RESTORE") {
        sendRedirect(
          response,
          appendFlash("/backups", "Type RESTORE to confirm the database restore.", "error"),
        );
        return;
      }
      const restore = backupService.restoreBackup(form.filename);
      sendRedirect(
        response,
        appendFlash(
          "/backups",
          `Restored ${restore.restoredBackup.filename}. A safety restore point was saved as ${restore.restorePoint.filename}.`,
          "warning",
        ),
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/recommended-actions") {
      if (!ensureAuth(response, user)) {
        return;
      }
      sendHtml(
        response,
        pages.renderRecommendedActions(user, flash, url.searchParams.get("key") || "", {
          returnTo: url.searchParams.get("return_to") || "",
          source: url.searchParams.get("source") || "",
          ledReady: url.searchParams.get("led_ready") === "1",
          ledMoveIndex: url.searchParams.get("led_move_index") || "",
        }),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/recommended-actions/apply") {
      if (!ensureAuth(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const action = anomalyService
        .getRecommendedActions()
        .find((entry) => entry.key === form.recommendation_key);
      if (action?.optimizationPlan && form.led_ready !== "1") {
        const returnTo = safeLocalPath(form.return_to, "");
        const sourceParam = form.recommendation_source === "capacity" ? "&source=capacity" : "";
        const recommendationPath = `/recommended-actions?key=${encodeURIComponent(form.recommendation_key || "")}${sourceParam}${returnTo ? `&return_to=${encodeURIComponent(returnTo)}` : ""}`;
        sendRedirect(
          response,
          appendFlash(
            recommendationPath,
            "Show full optimization LEDs before applying this recommendation.",
            "error",
          ),
        );
        return;
      }
      const moves = parseRecommendedActionMoves(form);
      const guidanceCells = listCells(db);
      const guidanceLines = buildRecommendationGuidanceLines(guidanceCells, form);
      anomalyService.applyRecommendedAction({
        sourceCellId: form.source_cell_id,
        productId: form.product_id,
        moves,
        userId: user.id,
        reason: form.reason,
      });
      const activeGuidance = readActiveRecommendationGuidance(
        db,
        user.id,
        form.recommendation_key,
      );
      const clearGuidanceLines = activeGuidance?.lines?.length ? activeGuidance.lines : guidanceLines;
      hardwareService.clearGuidance(recommendationGuidanceTask(form), clearGuidanceLines, {
        source: "recommended_action_apply",
      });
      deleteActiveRecommendationGuidance(db, user.id, form.recommendation_key);
      const backupResult = createAutomaticBackup("recommended-action-apply");
      const nextFlash = backupAwareFlash("Recommended action applied.", "success", backupResult);
      const returnTo = safeLocalPath(form.return_to, "/recommended-actions");
      sendRedirect(
        response,
        appendFlash(returnTo, nextFlash.message, nextFlash.tone),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/recommended-actions/clear-leds") {
      if (!ensureAuth(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const activeGuidance = readActiveRecommendationGuidance(
        db,
        user.id,
        form.recommendation_key,
      );
      let guidanceLines = activeGuidance?.lines || [];
      if (!guidanceLines.length) {
        try {
          guidanceLines = buildRecommendationGuidanceLines(listCells(db), form, {
            moveIndex: form.active_light_move_index || "all",
          });
        } catch {
          guidanceLines = [];
        }
      }
      if (guidanceLines.length) {
        hardwareService.clearGuidance(recommendationGuidanceTask(form), guidanceLines, {
          source: "recommended_action_leave",
          recommendationKey: form.recommendation_key || "",
        });
      }
      deleteActiveRecommendationGuidance(db, user.id, form.recommendation_key);
      sendText(response, "", 204, { "Cache-Control": "no-store" });
      return;
    }

    if (request.method === "POST" && url.pathname === "/recommended-actions/light-cell") {
      if (!ensureAuth(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const moveIndex = String(form.light_move_index || "").trim();
      const cells = listCells(db);
      const returnTo = safeLocalPath(form.return_to, "");
      const sourceParam = form.recommendation_source === "capacity" ? "&source=capacity" : "";
      const ledReadyParam = moveIndex === "all" ? "&led_ready=1" : "";
      const ledMoveParam = moveIndex ? `&led_move_index=${encodeURIComponent(moveIndex)}` : "";
      const recommendationPath = `/recommended-actions?key=${encodeURIComponent(form.recommendation_key || "")}${sourceParam}${returnTo ? `&return_to=${encodeURIComponent(returnTo)}` : ""}`;
      const activeRecommendationPath = `/recommended-actions?key=${encodeURIComponent(form.recommendation_key || "")}${sourceParam}${ledReadyParam}${ledMoveParam}${returnTo ? `&return_to=${encodeURIComponent(returnTo)}` : ""}`;
      let guidanceLines;
      try {
        guidanceLines =
          moveIndex === "all"
            ? buildRecommendationGuidanceLines(cells, form)
            : buildRecommendationGuidanceLines(cells, form, { moveIndex });
      } catch (error) {
        sendRedirect(
          response,
          appendFlash(
            recommendationPath,
            error.message,
            "error",
          ),
        );
        return;
      }
      if (!guidanceLines.length) {
        sendRedirect(
          response,
          appendFlash(
            recommendationPath,
            "At least one move is required before sending LEDs.",
            "error",
          ),
        );
        return;
      }
      const activeGuidance = readActiveRecommendationGuidance(
        db,
        user.id,
        form.recommendation_key,
      );
      if (activeGuidance?.lines?.length) {
        hardwareService.clearGuidance(recommendationGuidanceTask(form), activeGuidance.lines, {
          source: "recommended_action_relight",
          recommendationKey: form.recommendation_key || "",
        });
        deleteActiveRecommendationGuidance(db, user.id, form.recommendation_key);
      }
      const guidance = hardwareService.activateGuidance(recommendationGuidanceTask(form), guidanceLines, {
        source: "recommended_action_light",
        recommendationKey: form.recommendation_key || "",
      });
      if (guidance.ok !== false) {
        saveActiveRecommendationGuidance(db, user.id, form, guidanceLines);
      }
      const pickLines = guidanceLines.filter((line) => line.guidance_color === "green");
      const putLines = guidanceLines.filter((line) => line.guidance_color === "red");
      const ledSummary = `GREEN LED pick cells: ${pickLines
        .map((line) => `${line.logical_code} (${line.planned_quantity})`)
        .join(", ")}. RED LED put cells: ${putLines
        .map((line) => `${line.logical_code} (${line.planned_quantity})`)
        .join(", ")}.`;
      const guidanceMessage = guidance.degraded
        ? `${ledSummary} ${guidance.message || "Some cells need manual guidance."}`
        : ledSummary;
      sendRedirect(
        response,
        appendFlash(
          activeRecommendationPath,
          guidanceMessage,
          guidance.degraded ? "warning" : "success",
        ),
      );
      return;
    }

    const deviceSectionMatch = url.pathname.match(/^\/devices\/sections\/([a-z-]+)$/);
    if (request.method === "GET" && deviceSectionMatch) {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const sectionHtml = pages.renderDeviceConfigSection(deviceSectionMatch[1]);
      if (!sectionHtml) {
        sendText(response, "Unknown configuration section.", 404);
        return;
      }
      sendHtml(response, sectionHtml, 200, { "Cache-Control": "no-store" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/devices") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      sendHtml(response, pages.renderDevices(user, flash));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/firmware/options") {
      if (!ensureApiAdmin(response, user)) {
        return;
      }
      sendJson(response, firmwareService.getFlashOptions());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/firmware/flash") {
      if (!ensureApiAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const job = firmwareService.startFlashJob(form, user);
      sendJson(response, { job }, 202);
      return;
    }

    const firmwareJobMatch = url.pathname.match(/^\/api\/firmware\/jobs\/([A-Za-z0-9-]+)$/);
    if (request.method === "GET" && firmwareJobMatch) {
      if (!ensureApiAdmin(response, user)) {
        return;
      }
      const job = firmwareService.getJob(firmwareJobMatch[1]);
      if (!job) {
        sendJson(response, { error: "Firmware job not found." }, 404);
        return;
      }
      sendJson(response, { job });
      return;
    }

    if (request.method === "POST" && url.pathname === "/devices/controller-test") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const controller = locationService
        .listControllers()
        .find((entry) => entry.id === Number(form.controller_id));
      if (!controller) {
        throw new Error("Controller not found.");
      }
      const result = systemService.refreshControllerHealth(controller);
      const healthStatus = result.status;
      const returnTo = safeLocalPath(form.return_to, "/devices#controller-health");
      sendRedirect(
        response,
        appendFlash(
          returnTo,
          healthStatus === "online"
            ? `${controller.controller_code} responded on RS485.`
            : `No healthy response from ${controller.controller_code}. Check power, A/B wiring, RS485 id, and that the controller is flashed.`,
          healthStatus === "online" ? "success" : "warning",
        ),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/devices/controller-ping") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const controller = locationService
        .listControllers()
        .find((entry) => entry.id === Number(form.controller_id));
      if (!controller) {
        throw new Error("Controller not found.");
      }

      const mappedCells = locationService
        .listCells()
        .filter((cell) => cell.controller_id === controller.id && cell.hardware_channel);
      const moduleTargets = new Map();
      const moduleCount = Number(controller.module_count || 0);
      for (let channel = 1; channel <= moduleCount; channel += 1) {
        moduleTargets.set(String(channel), {
          id: null,
          logical_code: `${controller.controller_code} module ${channel}`,
          controller_id: controller.id,
          controller_code: controller.controller_code,
          controller_address: controller.address,
          address: controller.address,
          hardware_channel: channel,
        });
      }
      for (const cell of mappedCells) {
        moduleTargets.set(String(cell.hardware_channel), {
          ...cell,
          controller_address: cell.controller_address || controller.address,
          address: cell.address || controller.address,
        });
      }

      const targets = Array.from(moduleTargets.values()).sort((left, right) => {
        const leftChannel = Number(left.hardware_channel);
        const rightChannel = Number(right.hardware_channel);
        if (Number.isFinite(leftChannel) && Number.isFinite(rightChannel)) {
          return leftChannel - rightChannel;
        }
        return String(left.hardware_channel).localeCompare(String(right.hardware_channel));
      });
      const returnTo = safeLocalPath(form.return_to, "/devices#controller-health");
      if (!targets.length) {
        sendRedirect(
          response,
          appendFlash(
            returnTo,
            `No LED modules are mapped or configured for ${controller.controller_code}.`,
            "warning",
          ),
        );
        return;
      }

      const results = targets.map((target) => hardwareService.sendCellTest(target, form.color || "green"));
      const degradedCount = results.filter((result) => result.degraded).length;
      const sentCount = targets.length - degradedCount;
      sendRedirect(
        response,
        appendFlash(
          returnTo,
          degradedCount
            ? `Ping sent to ${sentCount} of ${targets.length} LED module(s) on ${controller.controller_code}. ${degradedCount} module(s) need manual checking.`
            : `Ping sent to ${targets.length} LED module(s) on ${controller.controller_code}.`,
          degradedCount ? "warning" : "success",
        ),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/devices/controller-delete") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const controller = locationService
        .listControllers()
        .find((entry) => entry.id === Number(form.controller_id));
      if (!controller) {
        throw new Error("Controller not found.");
      }
      const controllerCells = locationService
        .listCells()
        .filter((cell) => cell.controller_id === controller.id);
      if (controllerCells.length) {
        hardwareService.clearAllCellLocates(controllerCells);
      }
      createRequiredCriticalBackup("pre-controller-delete");
      const deleted = locationService.deleteController({ controllerId: controller.id });
      const backupResult = createCriticalBackup("controller-deleted");
      const nextFlash = backupAwareFlash(
        `${controller.controller_code} was deleted. ${deleted.detachedCellCount} cell(s) remain active for manual pick/put until remapped.`,
        "success",
        backupResult,
      );
      sendRedirect(
        response,
        appendFlash(
          "/devices",
          nextFlash.message,
          nextFlash.tone,
        ),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/devices/cell-test") {
      const wantsJson = requestWantsJson(request);
      if (wantsJson ? !ensureApiAdmin(response, user) : !ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const cell = locationService.listCellCatalog().find((entry) => entry.id === Number(form.cell_id));
      if (!cell) {
        if (wantsJson) {
          sendJson(response, { error: "Cell not found." }, 404);
          return;
        }
        throw new Error("Cell not found.");
      }
      const result = hardwareService.sendCellTest(cell, form.color || "green");
      const message = result.degraded
        ? `Light test skipped for ${cell.logical_code}. Manual mode is active.`
        : `Light test sent for ${cell.logical_code}.`;
      if (wantsJson) {
        sendJson(response, {
          ok: result.ok,
          degraded: result.degraded,
          message,
          cell: {
            id: cell.id,
            logicalCode: cell.logical_code,
            hardwareChannel: cell.hardware_channel,
          },
        });
        return;
      }
      const returnTo = safeLocalPath(form.return_to, "/devices#cell-mapping");
      sendRedirect(
        response,
        appendFlash(
          returnTo,
          message,
          result.degraded ? "warning" : "success",
        ),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/mapping") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      locationService.updateCellMapping({
        cellId: form.cell_id,
        hardwareChannel: form.hardware_channel,
        targetCellId: form.target_cell_id,
        mappedBy: user.id,
      });
      const backupResult = createCriticalBackup("cell-mapping-update");
      const nextFlash = backupAwareFlash("Cell mapping updated.", "success", backupResult);
      sendRedirect(response, appendFlash("/devices#cell-mapping", nextFlash.message, nextFlash.tone));
      return;
    }

    if (request.method === "POST" && url.pathname === "/mapping/bulk") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const mappings = parseCellMappingForm(form);
      const returnTo = safeLocalPath(form.return_to, "/devices#cell-mapping");

      if (!mappings.length) {
        sendRedirect(response, appendFlash(returnTo, "No cell mapping changes to save.", "info"));
        return;
      }

      for (const mapping of mappings) {
        locationService.updateCellMapping({
          cellId: mapping.sourceCellId,
          hardwareChannel: mapping.hardwareChannel,
          targetCellId: mapping.targetCellId,
          mappedBy: user.id,
        });
      }
      const backupResult = createCriticalBackup("cell-mapping-bulk-update");
      const nextFlash = backupAwareFlash(
        `${mappings.length} cell mapping${mappings.length === 1 ? "" : "s"} updated.`,
        "success",
        backupResult,
      );
      sendRedirect(response, appendFlash(returnTo, nextFlash.message, nextFlash.tone));
      return;
    }

    if (request.method === "POST" && url.pathname === "/devices/cells") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const cell = locationService.createCell({
        logicalCode: form.logical_code,
        createdBy: user.id,
      });
      const backupResult = createCriticalBackup("cell-created");
      const nextFlash = backupAwareFlash(`Cell ${cell.logical_code} added.`, "success", backupResult);
      sendRedirect(response, appendFlash("/devices#cell-management", nextFlash.message, nextFlash.tone));
      return;
    }

    if (request.method === "POST" && url.pathname === "/devices/cells/rename") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const cell = locationService.renameCell({
        cellId: form.cell_id,
        logicalCode: form.logical_code,
        renamedBy: user.id,
      });
      const backupResult = createCriticalBackup("cell-renamed");
      const nextFlash = backupAwareFlash(`Cell renamed to ${cell.logical_code}.`, "success", backupResult);
      sendRedirect(response, appendFlash("/devices#cell-management", nextFlash.message, nextFlash.tone));
      return;
    }

    if (request.method === "POST" && url.pathname === "/devices/cells/delete") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const impact = locationService.getCellDeletionImpact(form.cell_id);
      if (impact.hasStock) {
        throw new Error("Move all stock out of this cell before deleting it.");
      }
      if (impact.cell.controller_id && impact.cell.hardware_channel) {
        hardwareService.setCellLocate(impact.cell, false);
      }
      const safetyBackup = createRequiredCriticalBackup(
        impact.hasData ? "cell-delete-with-history-before" : "cell-delete-before",
      );
      const deleted = locationService.deleteCell({
        cellId: form.cell_id,
        deletedBy: user.id,
      });
      const moduleSummary = deleted.modulePlaceholder
        ? ` LED module ${deleted.modulePlaceholder.hardware_channel} remains available in Cell Mapping.`
        : "";
      const dataSummary = deleted.preservedHistory
        ? " Historical task and hardware records were preserved."
        : "";
      const nextFlash = backupAwareFlash(
        `Cell ${deleted.cell.logical_code} deleted.${moduleSummary}${dataSummary} Safety backup: ${safetyBackup.filename}.`,
        "success",
        createCriticalBackup(deleted.hasData ? "cell-delete-with-history" : "cell-delete"),
      );
      sendRedirect(response, appendFlash("/devices#cell-management", nextFlash.message, nextFlash.tone));
      return;
    }

    if (request.method === "GET" && url.pathname === "/admin/product-fields") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      sendHtml(response, pages.renderProductFields(user, flash));
      return;
    }

    if (request.method === "POST" && url.pathname === "/admin/product-unit-conversions/preview") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const preview = unitConversionService.preview({
        actor: user,
        productId: form.product_id,
        targetUnit: form.target_unit,
        factor: form.factor,
        precision: form.precision,
      });
      sendHtml(response, pages.renderProductFields(user, null, preview));
      return;
    }

    if (request.method === "POST" && url.pathname === "/admin/product-unit-conversions/apply") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      if (form.confirmed !== "1") {
        throw new Error("Review and confirm the unit migration before applying it.");
      }
      const safetyBackup = createRequiredCriticalBackup("product-unit-conversion-before");
      const result = unitConversionService.apply({
        actor: user,
        productId: form.product_id,
        targetUnit: form.target_unit,
        factor: form.factor,
        precision: form.precision,
        previewToken: form.preview_token,
      });
      sendRedirect(
        response,
        appendFlash(
          "/admin/product-fields",
          `${result.product.sku} migrated from ${result.sourceUnit} to ${result.targetUnit}. Safety backup: ${safetyBackup.filename}.`,
          "success",
        ),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/admin/product-fields") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      productFieldService.create({
        actor: user,
        label: form.label,
        dataType: form.data_type,
        sortOrder: form.sort_order,
        options: String(form.options || "")
          .split(/\r?\n|,/)
          .map((option) => option.trim())
          .filter(Boolean),
        searchable: form.searchable ? 1 : 0,
        filterable: form.filterable ? 1 : 0,
        reportable: form.reportable ? 1 : 0,
        visible: form.visible ? 1 : 0,
        active: 1,
      });
      const backupResult = createAutomaticBackup("product-field-create");
      const nextFlash = backupAwareFlash("Product field added.", "success", backupResult);
      sendRedirect(response, appendFlash("/admin/product-fields", nextFlash.message, nextFlash.tone));
      return;
    }

    const productFieldMatch = url.pathname.match(/^\/admin\/product-fields\/(\d+)$/);
    if (request.method === "POST" && productFieldMatch) {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      productFieldService.update({
        actor: user,
        fieldId: Number(productFieldMatch[1]),
        label: form.label,
        sortOrder: form.sort_order,
        options: form.options === undefined
          ? undefined
          : String(form.options)
              .split(/\r?\n|,/)
              .map((option) => option.trim())
              .filter(Boolean),
        required: form.required ? 1 : 0,
        searchable: form.searchable ? 1 : 0,
        filterable: form.filterable ? 1 : 0,
        reportable: form.reportable ? 1 : 0,
        visible: form.visible ? 1 : 0,
        active: form.active ? 1 : 0,
      });
      const backupResult = createAutomaticBackup("product-field-update");
      const nextFlash = backupAwareFlash("Product field updated.", "success", backupResult);
      sendRedirect(response, appendFlash("/admin/product-fields", nextFlash.message, nextFlash.tone));
      return;
    }

    if (request.method === "GET" && url.pathname === "/admin") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      sendHtml(response, pages.renderAdmin(user, flash));
      return;
    }

    const adminUserMatch = url.pathname.match(/^\/admin\/users\/(\d+)$/);
    if (request.method === "GET" && adminUserMatch) {
      if (!ensureAdmin(response, user)) {
        return;
      }
      sendHtml(response, pages.renderAdminUserProfile(user, flash, Number(adminUserMatch[1])));
      return;
    }

    if (request.method === "POST" && url.pathname === "/admin/registration-keys") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const key = adminService.issueRegistrationKey({
        keyValue: form.key_value,
        role: form.role,
        usagePolicy: form.usage_policy,
        userId: user.id,
      });
      const backupResult = createAutomaticBackup("registration-key-issue");
      const roleLabel = key.role === "admin" ? "Admin" : "Operator";
      const keyLabel = key.usage_policy === "global" ? "global registration key" : "registration key";
      const nextFlash = backupAwareFlash(`${roleLabel} ${keyLabel} issued.`, "success", backupResult);
      sendRedirect(response, appendFlash("/admin", nextFlash.message, nextFlash.tone));
      return;
    }

    if (request.method === "POST" && url.pathname === "/admin/registration-keys/revoke") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      adminService.revokeRegistrationKey({
        keyId: form.key_id,
      });
      const backupResult = createAutomaticBackup("registration-key-revoke");
      const nextFlash = backupAwareFlash("Registration key suspended.", "success", backupResult);
      sendRedirect(response, appendFlash("/admin", nextFlash.message, nextFlash.tone));
      return;
    }

    if (request.method === "POST" && url.pathname === "/admin/users/status") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const updatedUser = adminService.setUserStatus({
        userId: form.user_id,
        status: form.status,
        actingUserId: user.id,
      });
      const backupResult = createAutomaticBackup("user-status-update");
      const action = updatedUser.status === "active" ? "restored" : "suspended";
      const nextFlash = backupAwareFlash(
        `${updatedUser.username} access ${action}.`,
        "success",
        backupResult,
      );
      sendRedirect(response, appendFlash("/admin", nextFlash.message, nextFlash.tone));
      return;
    }

    if (request.method === "POST" && url.pathname === "/admin/task-timeout") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const settings = systemService.updatePendingReviewTimeout({
        timeoutMinutes: form.timeout_minutes,
        updatedBy: user.id,
      });
      systemService.cancelStalePendingReviewTasks();
      const backupResult = createAutomaticBackup("task-timeout-update");
      const nextFlash = backupAwareFlash(
        `Task completion timeout saved: ${settings.timeoutMinutes} minute(s).`,
        "success",
        backupResult,
      );
      sendRedirect(response, appendFlash("/admin", nextFlash.message, nextFlash.tone));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/adjustments/cell-products") {
      if (!ensureApiAdmin(response, user)) {
        return;
      }

      const cellId = Number(url.searchParams.get("cell_id"));
      const cell = getCellDetail(db, cellId);
      if (!cell) {
        sendJson(response, { error: "Cell not found." }, 404);
        return;
      }

      const products = listProducts(db);
      const linesHtml = cell.products
        .map((product, index) =>
          renderAdjustmentLine(products, index, {
            productId: product.product_id,
            absoluteQuantity: product.available_quantity,
            savedProductId: product.product_id,
            savedQuantity: product.available_quantity,
          }),
        )
        .join("");

      sendJson(response, {
        cell: {
          id: cell.id,
          logicalCode: cell.logical_code,
        },
        products: cell.products.map((product) => ({
          productId: product.product_id,
          sku: product.sku,
          name: product.name,
          brand: product.brand,
          unitOfMeasure: product.unit_of_measure,
          availableQuantity: product.available_quantity,
        })),
        linesHtml,
        nextIndex: cell.products.length,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/adjustments/light") {
      if (!ensureApiAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const preview = adjustmentQuantityGuidance(locationService.listCells(), {
        cellId: form.cell_id,
        lines: parseAdjustmentLines(form),
      });
      const guidance = hardwareService.activateGuidance(
        adjustmentPreviewTask({ userId: user.id }),
        preview.lines,
        {
          source: "adjustment_quantity_preview",
          displayQuantity: preview.displayQuantity,
        },
      );
      sendJson(response, {
        ok: guidance.ok,
        degraded: guidance.degraded,
        message:
          guidance.message ||
          `Showing ${preview.displayQuantity} on ${preview.cell.logical_code}.`,
        cell: {
          id: preview.cell.id,
          logicalCode: preview.cell.logical_code,
        },
        displayQuantity: preview.displayQuantity,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/admin/adjustments") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      try {
        adminService.createAdjustment({
          cellId: form.cell_id,
          userId: user.id,
          reason: form.reason,
          lines: parseAdjustmentLines(form),
        });
      } catch (error) {
        if (error.message.startsWith("No adjustment was needed")) {
          sendRedirect(response, appendFlash("/admin", error.message, "info"));
          return;
        }
        throw error;
      }
      const backupResult = createAutomaticBackup("adjustment-create");
      const nextFlash = backupAwareFlash("Adjustment batch recorded.", "success", backupResult);
      sendRedirect(response, appendFlash("/admin", nextFlash.message, nextFlash.tone));
      return;
    }

    sendHtml(response, pages.renderNotFound(user), 404);
  } catch (error) {
    if (url.pathname.startsWith("/api/") || requestWantsJson(request)) {
      sendJson(response, { error: error.message }, 400);
      return;
    }
    let target = user ? url.pathname : "/login";
    const confirmMatch = url.pathname.match(/^\/tasks\/(\d+)\/confirm$/);
    const putPlanMatch = url.pathname.match(/^\/tasks\/(\d+)\/put-plan$/);
    const correctMatch = url.pathname.match(/^\/tasks\/(\d+)\/correct$/);
    const cancelMatch = url.pathname.match(/^\/tasks\/(\d+)\/cancel$/);
    const buttonMatch = url.pathname.match(/^\/tasks\/(\d+)\/simulate-button$/);
    if (confirmMatch || putPlanMatch || correctMatch || cancelMatch || buttonMatch) {
      const taskId =
        confirmMatch?.[1] ||
        putPlanMatch?.[1] ||
        correctMatch?.[1] ||
        cancelMatch?.[1] ||
        buttonMatch?.[1];
      target = `/tasks/${taskId}`;
    }
    if (url.pathname === "/mapping" || url.pathname === "/mapping/bulk") {
      target = "/devices#cell-mapping";
    }
    if (url.pathname.startsWith("/devices/cells")) {
      target = "/devices#cell-management";
    }
    if (url.pathname === "/admin/adjustments") {
      target = "/admin";
    }
    if (url.pathname.startsWith("/admin/product-fields")) {
      target = "/admin/product-fields";
    }
    if (url.pathname.startsWith("/admin/product-unit-conversions")) {
      target = "/admin/product-fields";
    }
    sendRedirect(response, appendFlash(target, error.message, "error"));
  }
};

export const server = createServer(requestHandler);

if (process.env.NO_SERVER_LISTEN !== "1") {
  server.listen(PORT, "127.0.0.1", () => {
    process.stdout.write(`Inventory app running on http://localhost:${PORT}\n`);
  });
}
