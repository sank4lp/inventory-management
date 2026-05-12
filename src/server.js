import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { URL } from "node:url";

import { appConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { createLogger } from "./logger.js";
import { createPageRenderer } from "./server/pages/index.js";
import { setRuntimeContext } from "./server/runtime-context.js";
import {
  clearSessionCookie,
  createSessionCookie,
  getSessionUser,
  hashPassword,
  requireRole,
  verifyPassword,
} from "./services/auth.js";
import { createAdminService } from "./services/admin.js";
import { createAnomalyService } from "./services/anomalies.js";
import { createBackupService } from "./services/backups.js";
import { createCatalogService } from "./services/catalog.js";
import { createFirmwareService } from "./services/firmware.js";
import { createHardwareService } from "./services/hardware.js";
import { createLocationService } from "./services/locations.js";
import { createSystemService } from "./services/system.js";
import { createTaskService } from "./services/tasks.js";
import {
  authenticateUser,
  getCellDetail,
  getProductDetail,
  getTask,
  listCells,
  listControllers,
  listProducts,
  PUT_CAPACITY_ERROR_MESSAGE,
  registerUser,
  searchCells,
} from "./services/inventory.js";

const PORT = Number(process.env.PORT || 3000);
const logger = createLogger({
  level: appConfig.logLevel,
  siteId: appConfig.siteId,
});
const publicDir = join(process.cwd(), "public");
let appState = null;

function buildAppState() {
  const db = createDatabase({
    hashPassword,
    bootstrapAdmin: appConfig.bootstrapAdmin,
    allowDevAuthSeeds: appConfig.allowDevAuthSeeds,
  });
  const hardwareService = createHardwareService({
    db,
    config: appConfig,
    logger,
  });
  const firmwareService = createFirmwareService({
    db,
    config: appConfig,
    logger,
  });
  const systemService = createSystemService({
    db,
    config: appConfig,
    logger,
    hardwareService,
    getTask,
  });
  const startup = systemService.runStartupChecks();
  startup.recovery.recoveredTaskIds = systemService.recoverPendingGuidance();
  const catalogService = createCatalogService({ db });
  const locationService = createLocationService({ db });
  const anomalyService = createAnomalyService({ db });
  const adminService = createAdminService({ db });
  const taskService = createTaskService({
    db,
    hardwareService,
    logger,
    systemService,
  });
  const backupService = createBackupService({
    getDb: () => appState?.db || db,
    reloadAppState,
    logger,
  });
  const pages = createPageRenderer({ db, backupService });

  setRuntimeContext({
    config: appConfig,
    firmwareService,
    logger,
    systemService,
    startup,
  });

  return {
    adminService,
    anomalyService,
    backupService,
    catalogService,
    db,
    firmwareService,
    hardwareService,
    locationService,
    pages,
    startup,
    systemService,
    taskService,
  };
}

function reloadAppState({ closeCurrentDb = true } = {}) {
  if (closeCurrentDb && appState?.db) {
    appState.db.close();
  }

  appState = buildAppState();
  return appState;
}

function getAppState() {
  if (!appState) {
    appState = buildAppState();
  }

  return appState;
}

getAppState();

function sendHtml(response, html, statusCode = 200, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    ...headers,
  });
  response.end(html);
}

function sendText(response, text, statusCode = 200, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    ...headers,
  });
  response.end(text);
}

function sendJson(response, payload, statusCode = 200, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

function sendRedirect(response, location, headers = {}) {
  response.writeHead(302, {
    Location: location,
    ...headers,
  });
  response.end();
}

function appendFlash(path, message, tone = "info") {
  const url = new URL(path, "http://localhost");
  url.searchParams.set("flash", message);
  url.searchParams.set("tone", tone);
  return `${url.pathname}${url.search}${url.hash}`;
}

function safeLocalPath(value, fallback = "/") {
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

function putCapacityRetryPath(form) {
  const params = new URLSearchParams();
  if (form.product_id) {
    params.set("product_id", form.product_id);
  }
  if (form.quantity) {
    params.set("quantity", form.quantity);
  }
  if (form.preferred_cell_id) {
    params.set("cell_id", form.preferred_cell_id);
  }
  params.set("capacity_help", "1");
  return `/put?${params.toString()}`;
}

async function parseForm(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const params = new URLSearchParams(raw);
  return Object.fromEntries(params.entries());
}

function getFlash(url) {
  const message = url.searchParams.get("flash");
  if (!message) {
    return null;
  }

  return {
    message,
    tone: url.searchParams.get("tone") || "info",
  };
}

function ensureAuth(response, user) {
  if (!user) {
    sendRedirect(response, "/login");
    return false;
  }
  return true;
}

function ensureAdmin(response, user) {
  if (!user) {
    sendRedirect(response, "/login");
    return false;
  }

  if (!requireRole(user, "admin")) {
    sendRedirect(response, appendFlash("/", "Admin access is required.", "error"));
    return false;
  }

  return true;
}

function ensureApiAdmin(response, user) {
  if (!user) {
    sendJson(response, { error: "Authentication is required." }, 401);
    return false;
  }

  if (!requireRole(user, "admin")) {
    sendJson(response, { error: "Admin access is required." }, 403);
    return false;
  }

  return true;
}

function ensureApiAuth(response, user) {
  if (!user) {
    sendJson(response, { error: "Authentication is required." }, 401);
    return false;
  }
  return true;
}

function parseTaskReviewForm(form) {
  return {
    actualQuantities: Object.fromEntries(
      Object.entries(form)
        .filter(([key]) => key.startsWith("actual_") && !key.startsWith("actual_cell_"))
        .map(([key, value]) => [Number(key.slice(7)), value]),
    ),
    actualCellIds: Object.fromEntries(
      Object.entries(form)
        .filter(([key]) => key.startsWith("actual_cell_"))
        .map(([key, value]) => [Number(key.slice(12)), value]),
    ),
  };
}

function parsePutPlanForm(form) {
  const byKey = new Map();

  for (const [key, value] of Object.entries(form)) {
    if (key.startsWith("plan_qty_")) {
      const suffix = key.slice("plan_qty_".length);
      byKey.set(suffix, {
        ...(byKey.get(suffix) || {}),
        quantity: value,
      });
    }
    if (key.startsWith("plan_cell_")) {
      const suffix = key.slice("plan_cell_".length);
      byKey.set(suffix, {
        ...(byKey.get(suffix) || {}),
        cellId: value,
      });
    }
  }

  return Array.from(byKey.values()).filter(
    (allocation) => String(allocation.quantity || "").trim() || String(allocation.cellId || "").trim(),
  );
}

function parseCellMappingForm(form) {
  return Object.entries(form)
    .filter(([key]) => key.startsWith("target_cell_id_"))
    .map(([key, targetCellId]) => {
      const sourceCellId = key.slice("target_cell_id_".length);
      return {
        sourceCellId,
        targetCellId,
        originalTargetCellId: form[`original_target_cell_id_${sourceCellId}`],
        hardwareChannel: form[`hardware_channel_${sourceCellId}`],
      };
    })
    .filter(
      (mapping) =>
        String(mapping.targetCellId || "").trim() &&
        String(mapping.hardwareChannel || "").trim() &&
        String(mapping.targetCellId) !== String(mapping.originalTargetCellId),
    );
}

function parseRecommendedActionMoves(form) {
  return Object.entries(form)
    .filter(([key, value]) => key.startsWith("move_qty_") && String(value).trim())
    .map(([key, value]) => {
      const suffix = key.slice("move_qty_".length);
      return {
        index: suffix,
        quantity: value,
        targetCellId: form[`move_cell_${suffix}`],
      };
    });
}

function recommendationGuidanceTask(form = {}) {
  return {
    id: null,
    type: "recommended_move",
    summary: form.reason || "Recommended action move",
  };
}

function recommendationGuidanceLines(cells, { sourceCellId, targetCellId, quantity }) {
  const moveQuantity = Number(quantity);
  if (!Number.isFinite(moveQuantity) || moveQuantity <= 0) {
    throw new Error("Move quantity must be greater than zero before lighting cells.");
  }

  const sourceCell = cells.find((entry) => entry.id === Number(sourceCellId));
  const targetCell = cells.find((entry) => entry.id === Number(targetCellId));
  if (!sourceCell) {
    throw new Error("Source cell was not found.");
  }
  if (!targetCell) {
    throw new Error("Choose a target cell before sending the light signal.");
  }

  return [
    {
      ...sourceCell,
      cell_id: sourceCell.id,
      planned_quantity: moveQuantity,
      guidance_color: "green",
      guidance_role: "pick_source",
    },
    {
      ...targetCell,
      cell_id: targetCell.id,
      planned_quantity: moveQuantity,
      guidance_color: "red",
      guidance_role: "put_target",
    },
  ];
}

function uniqueGuidanceLines(lines) {
  const byTarget = new Map();
  for (const line of lines) {
    byTarget.set(`${line.controller_id || "manual"}:${line.hardware_channel || line.cell_id}`, line);
  }
  return Array.from(byTarget.values());
}

function createAutomaticBackup(source) {
  const { backupService } = getAppState();

  try {
    return {
      ok: true,
      backup: backupService.createBackup({
        kind: "auto",
        source,
      }),
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

function backupAwareFlash(message, tone, backupResult) {
  if (backupResult?.ok) {
    return {
      message,
      tone,
    };
  }

  return {
    message: `${message} Automatic backup failed: ${backupResult?.error || "Unknown error"}`,
    tone: tone === "error" ? "error" : "warning",
  };
}

function serveStatic(request, response, pathname) {
  const filename =
    pathname === "/styles.css"
      ? "styles.css"
      : pathname === "/theme.css"
        ? "theme.css"
      : pathname === "/app.js"
        ? "app.js"
        : null;
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
  response.writeHead(200, { "Content-Type": contentType });
  createReadStream(filePath).pipe(response);
  return true;
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
    systemService,
    taskService,
  } = getAppState();
  const user = getSessionUser(request, db);
  const flash = getFlash(url);

  if (serveStatic(request, response, url.pathname)) {
    return;
  }

  try {
    if (request.method === "GET" && url.pathname === "/fragments/home-products") {
      if (!ensureAuth(response, user)) {
        return;
      }
      const q = url.searchParams.get("q") || "";
      const products = q ? listProducts(db, q).slice(0, 8) : [];
      sendText(
        response,
        q
          ? pages.renderHomeProductResults(products)
          : `<p class="muted">Search here and jump straight into Pick or Put.</p>`,
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/fragments/home-cells") {
      if (!ensureAuth(response, user)) {
        return;
      }
      const q = url.searchParams.get("q") || "";
      const cells = q ? searchCells(db, q).slice(0, 8) : [];
      sendText(
        response,
        q
          ? pages.renderHomeCellResults(cells)
          : `<p class="muted">Search a cell to see which products are stored there.</p>`,
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/fragments/catalog-products") {
      if (!ensureAuth(response, user)) {
        return;
      }
      const q = url.searchParams.get("q") || "";
      sendText(response, pages.renderCatalogProductResults(listProducts(db, q)));
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
          ? pages.renderCellSearchResults(searchCells(db, q))
          : `<p class="muted">Search a cell to see what products are inside it.</p>`,
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
      sendHtml(response, pages.renderProductDetail(user, flash, product));
      return;
    }

    const productCapacityMatch = url.pathname.match(/^\/products\/(\d+)\/items-per-cell$/);
    if (request.method === "POST" && productCapacityMatch) {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      catalogService.updateProductItemsPerCell({
        productId: Number(productCapacityMatch[1]),
        itemsPerCell: form.items_per_cell,
      });
      const backupResult = createAutomaticBackup("product-capacity-update");
      const nextFlash = backupAwareFlash("Items per cell updated.", "success", backupResult);
      const returnTo = safeLocalPath(form.return_to, `/products/${productCapacityMatch[1]}`);
      sendRedirect(
        response,
        appendFlash(returnTo, nextFlash.message, nextFlash.tone),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/products") {
      if (!ensureAuth(response, user)) {
        return;
      }
      const form = await parseForm(request);
      catalogService.createProduct(form);
      const backupResult = createAutomaticBackup("product-create");
      const nextFlash = backupAwareFlash("Product saved.", "success", backupResult);
      sendRedirect(response, appendFlash("/products", nextFlash.message, nextFlash.tone));
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
      const { task, guidance } = taskService.createPickTask({
        userId: user.id,
        productId: form.product_id,
        quantity: form.quantity,
        preferredCellId: form.preferred_cell_id || null,
      });
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
        ? locationService.listCells().filter((cell) => cellIds.includes(cell.id))
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
        .listCells()
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
        }));
      } catch (error) {
        if (error.message === PUT_CAPACITY_ERROR_MESSAGE) {
          sendRedirect(
            response,
            appendFlash(putCapacityRetryPath(form), error.message, "error"),
          );
          return;
        }
        throw error;
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
        appendFlash(`/tasks/${completion.task.id}`, nextFlash.message, nextFlash.tone),
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
      if (!task || task.status === "cancelled") {
        sendRedirect(response, appendFlash(`/tasks/${buttonMatch[1]}`, "Cancelled tasks cannot be continued.", "error"));
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
        `Simulated button press for ${line.logical_code}.`,
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
        pages.renderRecommendedActions(user, flash, url.searchParams.get("key") || ""),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/recommended-actions/apply") {
      if (!ensureAuth(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const moves = parseRecommendedActionMoves(form);
      const guidanceCells = listCells(db);
      const guidanceLines = uniqueGuidanceLines(
        moves.flatMap((move) =>
          recommendationGuidanceLines(guidanceCells, {
            sourceCellId: form.source_cell_id,
            targetCellId: move.targetCellId,
            quantity: move.quantity,
          }),
        ),
      );
      anomalyService.applyRecommendedAction({
        sourceCellId: form.source_cell_id,
        productId: form.product_id,
        moves,
        userId: user.id,
        reason: form.reason,
      });
      hardwareService.clearGuidance(recommendationGuidanceTask(form), guidanceLines, {
        source: "recommended_action_apply",
      });
      const backupResult = createAutomaticBackup("recommended-action-apply");
      const nextFlash = backupAwareFlash("Recommended action applied.", "success", backupResult);
      sendRedirect(
        response,
        appendFlash("/recommended-actions", nextFlash.message, nextFlash.tone),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/recommended-actions/light-cell") {
      if (!ensureAuth(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const moveIndex = String(form.light_move_index || "").trim();
      const moveQuantity = Number(form[`move_qty_${moveIndex}`]);
      const targetCellId = Number(form[`move_cell_${moveIndex}`]);
      const cells = listCells(db);
      let guidanceLines;
      try {
        guidanceLines = recommendationGuidanceLines(cells, {
          sourceCellId: form.source_cell_id,
          targetCellId,
          quantity: moveQuantity,
        });
      } catch (error) {
        sendRedirect(
          response,
          appendFlash(
            `/recommended-actions?key=${encodeURIComponent(form.recommendation_key || "")}`,
            error.message,
            "error",
          ),
        );
        return;
      }
      const guidance = hardwareService.activateGuidance(recommendationGuidanceTask(form), guidanceLines, {
        source: "recommended_action_light",
        recommendationKey: form.recommendation_key || "",
      });
      const sourceCell = guidanceLines[0];
      const targetCell = guidanceLines[1];
      const guidanceMessage = guidance.degraded
        ? `GREEN LED: pick ${moveQuantity} from cell ${sourceCell.logical_code}. RED LED: put ${moveQuantity} into cell ${targetCell.logical_code}. ${guidance.message || "Some cells need manual guidance."}`
        : `GREEN LED: pick ${moveQuantity} from cell ${sourceCell.logical_code}. RED LED: put ${moveQuantity} into cell ${targetCell.logical_code}.`;
      sendRedirect(
        response,
        appendFlash(
          `/recommended-actions?key=${encodeURIComponent(form.recommendation_key || "")}`,
          guidanceMessage,
          guidance.degraded ? "warning" : "success",
        ),
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/devices") {
      if (!ensureAuth(response, user)) {
        return;
      }
      systemService.refreshControllerHealths();
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
      const result = hardwareService.checkControllerHealth(controller);
      const healthStatus = result.status || (result.ok && !result.degraded ? "online" : "unknown");
      locationService.updateControllerHealth({
        controllerId: controller.id,
        status: healthStatus,
      });
      sendRedirect(
        response,
        appendFlash(
          "/devices",
          healthStatus === "online"
            ? `${controller.controller_code} responded on RS485.`
            : `No healthy response from ${controller.controller_code}. Check power, A/B wiring, RS485 id, and that the controller is flashed.`,
          healthStatus === "online" ? "success" : "warning",
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
      const deleted = locationService.deleteController({ controllerId: controller.id });
      sendRedirect(
        response,
        appendFlash(
          "/devices",
          `${controller.controller_code} was deleted. ${deleted.detachedCellCount} cell(s) remain active for manual pick/put until remapped.`,
          "success",
        ),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/devices/cell-test") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const cell = locationService.listCells().find((entry) => entry.id === Number(form.cell_id));
      if (!cell) {
        throw new Error("Cell not found.");
      }
      const result = hardwareService.sendCellTest(cell, form.color || "green");
      const returnTo = safeLocalPath(form.return_to, "/devices#cell-mapping");
      sendRedirect(
        response,
        appendFlash(
          returnTo,
          result.degraded
            ? `Light test skipped for ${cell.logical_code}. Manual mode is active.`
            : `Light test sent for ${cell.logical_code}.`,
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
      const backupResult = createAutomaticBackup("cell-mapping-update");
      const nextFlash = backupAwareFlash("Cell mapping updated.", "success", backupResult);
      sendRedirect(response, appendFlash("/devices", nextFlash.message, nextFlash.tone));
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
      const backupResult = createAutomaticBackup("cell-mapping-bulk-update");
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
        capacity: form.capacity || 12,
        createdBy: user.id,
      });
      const backupResult = createAutomaticBackup("cell-created");
      const nextFlash = backupAwareFlash(`Cell ${cell.logical_code} added.`, "success", backupResult);
      sendRedirect(response, appendFlash("/devices", nextFlash.message, nextFlash.tone));
      return;
    }

    if (request.method === "POST" && url.pathname === "/devices/cells/delete") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const deleteDataConfirmed = ["1", "true", "yes"].includes(
        String(form.delete_data_confirmed || "").toLowerCase(),
      );
      const impact = locationService.getCellDeletionImpact(form.cell_id);
      if (impact.hasData && !deleteDataConfirmed) {
        throw new Error("This cell has stock, task history, or hardware events. Confirm deleting associated data first.");
      }
      if (impact.cell.controller_id && impact.cell.hardware_channel) {
        hardwareService.setCellLocate(impact.cell, false);
      }
      const backupResult = createAutomaticBackup(
        impact.hasData ? "cell-delete-with-data-before" : "cell-delete-before",
      );
      const deleted = locationService.deleteCell({
        cellId: form.cell_id,
        deleteDataConfirmed,
      });
      const dataSummary = deleted.hasData
        ? ` Deleted ${deleted.balanceRows} balance row(s), ${deleted.taskLines} task line(s), ${deleted.transactions} transaction(s), and ${deleted.deviceEvents} hardware event(s).`
        : "";
      const nextFlash = backupAwareFlash(
        `Cell ${deleted.cell.logical_code} deleted.${dataSummary}`,
        "success",
        backupResult,
      );
      sendRedirect(response, appendFlash("/devices", nextFlash.message, nextFlash.tone));
      return;
    }

    if (request.method === "GET" && url.pathname === "/admin") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      sendHtml(response, pages.renderAdmin(user, flash));
      return;
    }

    if (request.method === "POST" && url.pathname === "/admin/registration-keys") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      adminService.issueRegistrationKey({
        keyValue: form.key_value,
        role: form.role,
        userId: user.id,
      });
      const backupResult = createAutomaticBackup("registration-key-issue");
      const nextFlash = backupAwareFlash("Registration key issued.", "success", backupResult);
      sendRedirect(response, appendFlash("/admin", nextFlash.message, nextFlash.tone));
      return;
    }

    if (request.method === "POST" && url.pathname === "/admin/adjustments") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const lineIndexes = Array.from(
        new Set(
          Object.keys(form)
            .map(
              (key) =>
                key.match(/^product_id_(.+)$/)?.[1] ||
                key.match(/^absolute_quantity_(.+)$/)?.[1] ||
                null,
            )
            .filter(Boolean),
        ),
      ).sort((left, right) => String(left).localeCompare(String(right), undefined, { numeric: true }));
      const lines = lineIndexes
        .map((index) => ({
          productId: form[`product_id_${index}`],
          absoluteQuantity: form[`absolute_quantity_${index}`],
        }))
        .filter(
          (line) =>
            String(line.productId || "").trim() || String(line.absoluteQuantity || "").trim(),
        );
      adminService.createAdjustment({
        cellId: form.cell_id,
        userId: user.id,
        reason: form.reason,
        lines,
      });
      const backupResult = createAutomaticBackup("adjustment-create");
      const nextFlash = backupAwareFlash("Adjustment batch recorded.", "success", backupResult);
      sendRedirect(response, appendFlash("/admin", nextFlash.message, nextFlash.tone));
      return;
    }

    sendHtml(response, pages.renderNotFound(user), 404);
  } catch (error) {
    if (url.pathname.startsWith("/api/")) {
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
    sendRedirect(response, appendFlash(target, error.message, "error"));
  }
};

export const server = createServer(requestHandler);

if (process.env.NO_SERVER_LISTEN !== "1") {
  server.listen(PORT, "127.0.0.1", () => {
    process.stdout.write(`Inventory app running on http://localhost:${PORT}\n`);
  });
}
