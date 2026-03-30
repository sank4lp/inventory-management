import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { URL } from "node:url";

import { createDatabase } from "./db.js";
import { createPageRenderer } from "./server/pages/index.js";
import {
  clearSessionCookie,
  createSessionCookie,
  getSessionUser,
  hashPassword,
  requireRole,
  verifyPassword,
} from "./services/auth.js";
import {
  activateGuidance,
  clearGuidance,
  sendCellTest,
  sendControllerTest,
  simulateButtonPress,
} from "./services/hardware.js";
import {
  applyRecommendedAction,
  allocatePick,
  authenticateUser,
  cancelTask,
  completeTask,
  correctCompletedTask,
  createAdjustment,
  createProduct,
  getCellDetail,
  getProductDetail,
  getTask,
  issueRegistrationKey,
  listCells,
  listControllers,
  listProducts,
  markPhysicalConfirmation,
  planPut,
  registerUser,
  searchCells,
  updateCellMapping,
  updateProductItemsPerCell,
} from "./services/inventory.js";

const PORT = Number(process.env.PORT || 3000);
const db = createDatabase({ hashPassword });
const pages = createPageRenderer({ db });
const publicDir = join(process.cwd(), "public");

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
  return `${url.pathname}${url.search}`;
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

function serveStatic(request, response, pathname) {
  const filename =
    pathname === "/styles.css"
      ? "styles.css"
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
      sendRedirect(response, appendFlash("/", "Registration completed.", "success"), {
        "Set-Cookie": createSessionCookie(newUser),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/logout") {
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
      updateProductItemsPerCell(db, {
        productId: Number(productCapacityMatch[1]),
        itemsPerCell: form.items_per_cell,
      });
      sendRedirect(
        response,
        appendFlash(`/products/${productCapacityMatch[1]}`, "Items per cell updated.", "success"),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/products") {
      if (!ensureAuth(response, user)) {
        return;
      }
      const form = await parseForm(request);
      createProduct(db, form);
      sendRedirect(response, appendFlash("/products", "Product saved.", "success"));
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
      const task = allocatePick(db, {
        userId: user.id,
        productId: form.product_id,
        quantity: form.quantity,
        preferredCellId: form.preferred_cell_id || null,
      });
      activateGuidance(db, task, task.lines);
      sendRedirect(
        response,
        appendFlash(`/tasks/${task.id}`, "Pick task created and guidance activated.", "success"),
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

    if (request.method === "POST" && url.pathname === "/put") {
      if (!ensureAuth(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const task = planPut(db, {
        userId: user.id,
        productId: form.product_id,
        quantity: form.quantity,
        preferredCellId: form.preferred_cell_id || null,
      });
      activateGuidance(db, task, task.lines);
      sendRedirect(
        response,
        appendFlash(`/tasks/${task.id}`, "Put task created and guidance activated.", "success"),
      );
      return;
    }

    const taskMatch = url.pathname.match(/^\/tasks\/(\d+)$/);
    if (request.method === "GET" && taskMatch) {
      if (!ensureAuth(response, user)) {
        return;
      }
      const task = getTask(db, Number(taskMatch[1]));
      const mode = url.searchParams.get("mode") === "edit" ? "edit" : "view";
      if (mode === "edit" && task && (!pages.canEditTask(user, task) || task.status !== "completed")) {
        sendRedirect(response, appendFlash(`/tasks/${task.id}`, "You can edit only your own tasks unless you are an admin.", "error"));
        return;
      }
      sendHtml(response, pages.renderTask(user, flash, task, mode));
      return;
    }

    const confirmMatch = url.pathname.match(/^\/tasks\/(\d+)\/confirm$/);
    if (request.method === "POST" && confirmMatch) {
      if (!ensureAuth(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const { actualQuantities, actualCellIds } = parseTaskReviewForm(form);
      const completion = completeTask(db, {
        taskId: Number(confirmMatch[1]),
        actualQuantities,
        actualCellIds,
        userId: user.id,
        note: form.note,
      });
      clearGuidance(db, completion.task, completion.task.lines);
      sendRedirect(
        response,
        appendFlash(
          `/tasks/${completion.task.id}`,
          completion.anomalies.length
            ? `Action completed. ${completion.anomalies.length} recommended action warning(s) were created.`
            : "Action completed successfully.",
          completion.anomalies.length ? "error" : "success",
        ),
      );
      return;
    }

    const correctMatch = url.pathname.match(/^\/tasks\/(\d+)\/correct$/);
    if (request.method === "POST" && correctMatch) {
      if (!ensureAuth(response, user)) {
        return;
      }
      const task = getTask(db, Number(correctMatch[1]));
      if (!task || !pages.canEditTask(user, task)) {
        sendRedirect(response, appendFlash(`/tasks/${correctMatch[1]}`, "You can edit only your own tasks unless you are an admin.", "error"));
        return;
      }
      const form = await parseForm(request);
      const { actualQuantities, actualCellIds } = parseTaskReviewForm(form);
      const correction = correctCompletedTask(db, {
        taskId: Number(correctMatch[1]),
        actualQuantities,
        actualCellIds,
        userId: user.id,
        note: form.note,
      });
      sendRedirect(
        response,
        appendFlash(
          `/tasks/${correction.task.id}`,
          correction.anomalies.length
            ? `Correction saved. ${correction.anomalies.length} recommended action warning(s) remain.`
            : "Correction saved successfully.",
          correction.anomalies.length ? "error" : "success",
        ),
      );
      return;
    }

    const buttonMatch = url.pathname.match(/^\/tasks\/(\d+)\/simulate-button$/);
    if (request.method === "POST" && buttonMatch) {
      if (!ensureAuth(response, user)) {
        return;
      }
      const task = getTask(db, Number(buttonMatch[1]));
      if (!task || task.status === "cancelled") {
        sendRedirect(response, appendFlash(`/tasks/${buttonMatch[1]}`, "Cancelled tasks cannot be continued.", "error"));
        return;
      }
      const form = await parseForm(request);
      const line = markPhysicalConfirmation(db, Number(form.line_id));
      simulateButtonPress(db, { ...line, task_id: Number(buttonMatch[1]) });
      sendRedirect(
        response,
        appendFlash(`/tasks/${buttonMatch[1]}`, `Simulated button press for ${line.logical_code}.`, "success"),
      );
      return;
    }

    const cancelMatch = url.pathname.match(/^\/tasks\/(\d+)\/cancel$/);
    if (request.method === "POST" && cancelMatch) {
      if (!ensureAuth(response, user)) {
        return;
      }
      const task = getTask(db, Number(cancelMatch[1]));
      if (!task || !pages.canEditTask(user, task)) {
        sendRedirect(response, appendFlash(`/tasks/${cancelMatch[1]}`, "You can cancel only your own tasks unless you are an admin.", "error"));
        return;
      }
      const cancelledTask = cancelTask(db, { taskId: Number(cancelMatch[1]) });
      clearGuidance(db, cancelledTask, cancelledTask.lines);
      sendRedirect(response, appendFlash(`/tasks/${cancelledTask.id}`, "Task cancelled.", "success"));
      return;
    }

    if (request.method === "GET" && url.pathname === "/reports") {
      if (!ensureAuth(response, user)) {
        return;
      }
      sendHtml(response, pages.renderReports(user, flash, url));
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
      const moves = Object.entries(form)
        .filter(([key, value]) => key.startsWith("move_qty_") && String(value).trim())
        .map(([key, value]) => {
          const suffix = key.slice("move_qty_".length);
          return {
            quantity: value,
            targetCellId: form[`move_cell_${suffix}`],
          };
        });
      applyRecommendedAction(db, {
        sourceCellId: form.source_cell_id,
        productId: form.product_id,
        moves,
        userId: user.id,
        reason: form.reason,
      });
      sendRedirect(
        response,
        appendFlash("/recommended-actions", "Recommended action applied.", "success"),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/recommended-actions/light-cell") {
      if (!ensureAuth(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const moveIndex = String(form.light_move_index || "").trim();
      const targetCellId = Number(form[`move_cell_${moveIndex}`]);
      const cell = listCells(db).find((entry) => entry.id === targetCellId);
      if (!cell) {
        sendRedirect(
          response,
          appendFlash(
            `/recommended-actions?key=${encodeURIComponent(form.recommendation_key || "")}`,
            "Choose a target cell before sending the light signal.",
            "error",
          ),
        );
        return;
      }
      sendCellTest(db, cell, "blue");
      sendRedirect(
        response,
        appendFlash(
          `/recommended-actions?key=${encodeURIComponent(form.recommendation_key || "")}`,
          `Find/Light Cell sent for ${cell.logical_code}.`,
          "success",
        ),
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/devices") {
      if (!ensureAuth(response, user)) {
        return;
      }
      sendHtml(response, pages.renderDevices(user, flash));
      return;
    }

    if (request.method === "POST" && url.pathname === "/devices/controller-test") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const controller = listControllers(db).find((entry) => entry.id === Number(form.controller_id));
      if (!controller) {
        throw new Error("Controller not found.");
      }
      sendControllerTest(db, controller);
      sendRedirect(response, appendFlash("/devices", `Sent test to ${controller.controller_code}.`, "success"));
      return;
    }

    if (request.method === "POST" && url.pathname === "/devices/cell-test") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      const cell = listCells(db).find((entry) => entry.id === Number(form.cell_id));
      if (!cell) {
        throw new Error("Cell not found.");
      }
      sendCellTest(db, cell);
      sendRedirect(response, appendFlash("/devices", `Light test sent for ${cell.logical_code}.`, "success"));
      return;
    }

    if (request.method === "POST" && url.pathname === "/mapping") {
      if (!ensureAdmin(response, user)) {
        return;
      }
      const form = await parseForm(request);
      updateCellMapping(db, {
        cellId: form.cell_id,
        hardwareChannel: form.hardware_channel,
        mappedBy: user.id,
      });
      sendRedirect(response, appendFlash("/devices", "Cell mapping updated.", "success"));
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
      issueRegistrationKey(db, {
        keyValue: form.key_value,
        role: form.role,
        userId: user.id,
      });
      sendRedirect(response, appendFlash("/admin", "Registration key issued.", "success"));
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
      createAdjustment(db, {
        cellId: form.cell_id,
        userId: user.id,
        reason: form.reason,
        lines,
      });
      sendRedirect(response, appendFlash("/admin", "Adjustment batch recorded.", "success"));
      return;
    }

    sendHtml(response, pages.renderNotFound(user), 404);
  } catch (error) {
    let target = user ? url.pathname : "/login";
    const confirmMatch = url.pathname.match(/^\/tasks\/(\d+)\/confirm$/);
    const buttonMatch = url.pathname.match(/^\/tasks\/(\d+)\/simulate-button$/);
    if (confirmMatch || buttonMatch) {
      const taskId = confirmMatch?.[1] || buttonMatch?.[1];
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
