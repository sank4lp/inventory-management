import { createServer } from "node:http";
import { join } from "node:path";
import { URL } from "node:url";

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

getAppState();

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
  if (form.preferred_cell_id) {
    params.set("cell_id", form.preferred_cell_id);
  }
  return `${path}${params.toString() ? `?${params.toString()}` : ""}`;
}

function capacityRecommendationPromptPath(returnTo, recommendationKey) {
  const url = new URL(returnTo, "http://localhost");
  url.searchParams.set(CAPACITY_RECOMMENDATION_KEY_PARAM, recommendationKey);
  return `${url.pathname}${url.search}${url.hash}`;
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
    systemService,
    taskService,
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

    if (request.method === "POST" && url.pathname === "/products") {
      if (!ensureAuth(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const product = catalogService.createProduct(form);
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
        }),
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
      const returnTo = safeLocalPath(form.return_to, "/recommended-actions");
      sendRedirect(
        response,
        appendFlash(returnTo, nextFlash.message, nextFlash.tone),
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
      const returnTo = safeLocalPath(form.return_to, "");
      const sourceParam = form.recommendation_source === "capacity" ? "&source=capacity" : "";
      const recommendationPath = `/recommended-actions?key=${encodeURIComponent(form.recommendation_key || "")}${sourceParam}${returnTo ? `&return_to=${encodeURIComponent(returnTo)}` : ""}`;
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
            recommendationPath,
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
          recommendationPath,
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
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const cell = locationService.listCellCatalog().find((entry) => entry.id === Number(form.cell_id));
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
      const backupResult = createCriticalBackup("cell-mapping-update");
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
      sendRedirect(response, appendFlash("/devices", nextFlash.message, nextFlash.tone));
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
      const key = adminService.issueRegistrationKey({
        keyValue: form.key_value,
        role: form.role,
        userId: user.id,
      });
      const backupResult = createAutomaticBackup("registration-key-issue");
      const roleLabel = key.role === "admin" ? "Admin" : "Operator";
      const nextFlash = backupAwareFlash(`${roleLabel} registration key issued.`, "success", backupResult);
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
      const nextFlash = backupAwareFlash("Registration key deleted.", "success", backupResult);
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
    if (url.pathname === "/mapping" || url.pathname === "/mapping/bulk") {
      target = "/devices#cell-mapping";
    }
    if (url.pathname === "/admin/adjustments") {
      target = "/admin";
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
