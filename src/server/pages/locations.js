import {
  listCells,
  listControllers,
  searchCells,
} from "../../services/inventory.js";
import { getRuntimeContext } from "../runtime-context.js";
import {
  card,
  escapeHtml,
  formatDate,
  formatQuantity,
  page,
  quickActionLinks,
  statusBadge,
  table,
} from "./shared.js";

function renderModuleChips(modules = []) {
  return modules
    .map((moduleNumber) => `<span class="module-chip">Module ${escapeHtml(moduleNumber)}</span>`)
    .join("");
}

function renderPortOptions(ports = []) {
  return ports
    .map((port) => `<option value="${escapeHtml(port.path)}">${escapeHtml(port.label)}</option>`)
    .join("");
}

function flashRecordSummary(port) {
  if (!port.flashRecord) {
    return `<span class="firmware-device-summary">New ESP32 detected. Flash this controller before mapping cells.</span>`;
  }

  const flashedBy = port.flashRecord.flashedBy?.name || port.flashRecord.flashedBy?.username || "unknown user";
  return `
    <span class="firmware-device-summary">
      Already flashed as ${escapeHtml(port.flashRecord.deviceName || port.deviceName || "ESP32 controller")}
      · ${escapeHtml(port.flashRecord.moduleCount)} LED module(s)
      · ${escapeHtml(formatDate(port.flashRecord.configuredAt))}
      · by ${escapeHtml(flashedBy)}
    </span>
  `;
}

function renderPortChoices(ports = [], selectedPort = "") {
  if (!ports.length) {
    return `<p class="muted">No detected ESP32 target yet. Unplug the ESP32, scan without it, then plug it in and detect the added port.</p>`;
  }

  return ports
    .map(
      (port) => `
        <button
          type="button"
          class="firmware-port-choice ${port.path === selectedPort ? "firmware-port-choice-active" : ""}"
          data-firmware-port-choice
          data-port-path="${escapeHtml(port.path)}"
          data-device-identity="${escapeHtml(port.deviceIdentity || port.path)}"
        >
          <strong>${escapeHtml(port.flashRecord?.deviceName || port.deviceName || "ESP32 controller")}</strong>
          <code>${escapeHtml(port.path)}</code>
          ${statusBadge(port.flashStatus === "configured" ? "flashed" : "new")}
          ${flashRecordSummary(port)}
        </button>
      `,
    )
    .join("");
}

export function createLocationPages({ db }) {
  function renderCellSearchResults(cells) {
    return table(
      ["Cell", "Stock", "Open"],
      cells.map((cell) => [
        escapeHtml(cell.logical_code),
        escapeHtml(formatQuantity(cell.occupied_quantity)),
        `<a class="mini-link" href="/cells/${cell.id}">View</a>`,
      ]),
    );
  }

  function renderAllLocations(cells) {
    return table(
      ["Cell", "Controller", "LED module", "Stock", "Products", "Locate"],
      cells.map((cell) => [
        `<a href="/cells/${cell.id}">${escapeHtml(cell.logical_code)}</a>`,
        escapeHtml(cell.controller_code || "No controller"),
        escapeHtml(cell.hardware_channel),
        escapeHtml(formatQuantity(cell.occupied_quantity)),
        cell.inventory_summary ? escapeHtml(cell.inventory_summary) : `<span class="muted">Empty</span>`,
        `
          <button
            type="button"
            class="ghost-button locate-button"
            data-locate-cell
            data-cell-id="${cell.id}"
            data-cell-name="${escapeHtml(cell.logical_code)}"
            aria-pressed="false"
          >Locate</button>
        `,
      ]),
    );
  }

  function renderCells(user, flash, search) {
    const cells = search ? searchCells(db, search) : [];
    const allCells = listCells(db);

    return page({
      title: "Cells",
      user,
      flash,
      content: `
        <div data-location-page>
          ${card(
            "Find a cell",
            `
              <form
                method="get"
                action="/cells"
                class="inline-form"
                data-live-search-form
                data-endpoint="/fragments/cell-search"
                data-target="#cell-search-results"
                data-empty-html="<p class=&quot;muted&quot;>Search a cell to see what products are inside it.</p>"
              >
                <input data-live-input name="q" value="${escapeHtml(search || "")}" placeholder="Search by logical code" />
                <button type="submit">Search</button>
              </form>
              <div id="cell-search-results">
                ${
                  search
                    ? renderCellSearchResults(cells)
                    : `<p class="muted">Search a cell to see what products are inside it.</p>`
                }
              </div>
            `,
          )}
          ${card(
            "All locations",
            allCells.length
              ? renderAllLocations(allCells)
              : `<p class="muted">No active locations are configured.</p>`,
          )}
        </div>
      `,
    });
  }

  function renderCellDetail(user, flash, cell) {
    if (!cell) {
      return page({
        title: "Cell not found",
        user,
        flash: flash || { message: "Cell not found.", tone: "error" },
        content: `<p><a href="/cells">Back to cells</a></p>`,
      });
    }

    return page({
      title: cell.logical_code,
      user,
      flash,
      content: `
        ${card(
          "Cell summary",
          `
            <p><strong>${escapeHtml(cell.logical_code)}</strong></p>
            <p>${escapeHtml(cell.controller_code || "No controller")} · Channel ${escapeHtml(cell.hardware_channel)}</p>
          `,
        )}
        ${card(
          "Products in this cell",
          table(
            ["Product", "Available", "Action"],
            cell.products.map((product) => [
              `<a href="/products/${product.product_id}">${escapeHtml(product.name)}</a><br /><small>${escapeHtml(product.sku)}</small>`,
              escapeHtml(formatQuantity(product.available_quantity)),
              quickActionLinks(product.product_id, cell.id),
            ]),
          ),
        )}
      `,
    });
  }

  function renderDevices(user, flash) {
    const controllers = listControllers(db);
    const cells = listCells(db);
    const runtime = getRuntimeContext();
    const firmwareOptions = runtime.firmwareService?.getFlashOptions();
    const lastFirmwareConfig = firmwareOptions?.lastConfiguration || null;
    const moduleCount = lastFirmwareConfig?.moduleCount || firmwareOptions?.moduleCount?.value || 4;
    const port = "";
    const controllerName = lastFirmwareConfig?.controllerName || lastFirmwareConfig?.deviceName || "ESP32-01";
    const fqbn = lastFirmwareConfig?.fqbn || firmwareOptions?.defaultFqbn || "esp32:esp32:esp32";
    const hasPorts = false;

    return page({
      title: "Devices and Mapping",
      user,
      flash,
      content: `
        ${
          firmwareOptions
            ? card(
                "ESP32 firmware",
                `
                  <div class="firmware-panel" data-firmware-panel>
                    <div class="meta-grid compact-meta-grid">
                      <div><strong>Arduino CLI</strong><br />${statusBadge(
                        firmwareOptions.arduinoCli.available ? "available" : "missing",
                      )}</div>
                      <div><strong>Sketch</strong><br /><code>${escapeHtml(
                        firmwareOptions.sketchPath,
                      )}</code></div>
                    </div>
                    <form class="stack-form" data-firmware-flash-form>
                      <div class="firmware-grid">
                        <label>Controller name
                          <input
                            name="controller_name"
                            value="${escapeHtml(controllerName)}"
                            placeholder="ESP32-Z1-A"
                            required
                          />
                        </label>
                        <label>LED modules
                          <input
                            type="number"
                            name="module_count"
                            min="${firmwareOptions.moduleCount.min}"
                            max="${firmwareOptions.moduleCount.max}"
                            step="1"
                            value="${escapeHtml(moduleCount)}"
                            required
                          />
                        </label>
                        <label>Serial port
                          <div class="firmware-port-input-row">
                            <input
                              name="port"
                              list="firmware-ports"
                              value="${escapeHtml(port)}"
                              placeholder="/dev/ttyUSB0"
                              data-firmware-port-input
                              required
                            />
                            <input type="hidden" name="device_identity" value="" data-firmware-device-identity />
                          </div>
                          <div class="firmware-detect-actions">
                            <button type="button" class="ghost-button" data-firmware-scan-baseline>1. Scan without ESP32</button>
                            <button type="button" class="ghost-button" data-firmware-refresh-ports>2. Detect added ESP32</button>
                          </div>
                        </label>
                        <label>Board FQBN
                          <input name="fqbn" value="${escapeHtml(fqbn)}" required />
                        </label>
                      </div>
                      <datalist id="firmware-ports">
                        ${renderPortOptions([])}
                      </datalist>
                      <p class="muted">Setup flow: keep RS485, mouse, and keyboard connected; unplug the ESP32; scan without ESP32; plug in the ESP32; then detect the added serial device.</p>
                      <p class="muted">If upload cannot connect, hold BOOT, start flashing, tap EN/RESET once while Connecting is shown, then release BOOT after upload starts.</p>
                      <div
                        class="firmware-port-status ${hasPorts ? "firmware-port-status-ok" : "firmware-port-status-missing"}"
                        data-firmware-port-status
                      >${escapeHtml(firmwareOptions.portStatus)}</div>
                      <div class="firmware-port-list" data-firmware-port-list>
                        ${renderPortChoices([], port)}
                      </div>
                      <details class="firmware-other-devices" data-firmware-other-devices>
                        <summary>Other serial devices / manual reflash</summary>
                        <div class="firmware-other-device-list" data-firmware-other-device-list></div>
                      </details>
                      <div class="mini-actions">
                        <button type="submit" class="blue-button" ${hasPorts ? "" : "disabled"}>Compile and flash</button>
                      </div>
                    </form>
                    <div
                      class="module-assignment-strip"
                      data-firmware-modules
                      ${lastFirmwareConfig?.assignedModules?.length ? "" : "hidden"}
                    >${renderModuleChips(lastFirmwareConfig?.assignedModules || [])}</div>
                    <div class="firmware-progress" data-firmware-progress hidden>
                      <div class="firmware-progress-head">
                        <strong data-firmware-stage>Queued</strong>
                        <span data-firmware-percent>0%</span>
                      </div>
                      <progress data-firmware-progress-bar value="0" max="100"></progress>
                      <div class="firmware-hint" data-firmware-hint hidden></div>
                      <pre class="firmware-log" data-firmware-log></pre>
                    </div>
                  </div>
                `,
              )
            : ""
        }
        ${card(
          "Controllers",
          table(
            ["Controller", "Health", "LED modules", "Cells", "Test"],
            controllers.map((controller) => [
              escapeHtml(controller.controller_code),
              statusBadge(controller.heartbeat_status),
              escapeHtml(formatQuantity(controller.module_count || controller.mapped_cells)),
              escapeHtml(formatQuantity(controller.mapped_cells)),
              `
                <form method="post" action="/devices/controller-test">
                  <input type="hidden" name="controller_id" value="${controller.id}" />
                  <button type="submit" class="ghost-button">Send test</button>
                </form>
              `,
            ]),
          ),
        )}
        ${card(
          "Cell mapping",
          table(
            ["Controller", "LED module", "Cell name", "Stock", "Blink"],
            cells.map((cell) => [
              escapeHtml(cell.controller_code || "No controller"),
              escapeHtml(cell.hardware_channel),
              `
                <form method="post" action="/mapping" class="inline-form">
                  <input type="hidden" name="cell_id" value="${cell.id}" />
                  <input type="hidden" name="hardware_channel" value="${escapeHtml(cell.hardware_channel)}" />
                  <input class="compact-input" name="logical_code" value="${escapeHtml(cell.logical_code)}" />
                  <button type="submit" class="ghost-button">Save</button>
                </form>
              `,
              escapeHtml(formatQuantity(cell.occupied_quantity)),
              `
                <form method="post" action="/devices/cell-test">
                  <input type="hidden" name="cell_id" value="${cell.id}" />
                  <input type="hidden" name="color" value="green" />
                  <button type="submit" class="ghost-button">Blink green</button>
                </form>
              `,
            ]),
          ),
        )}
      `,
    });
  }

  return {
    renderCellDetail,
    renderCells,
    renderCellSearchResults,
    renderDevices,
  };
}
