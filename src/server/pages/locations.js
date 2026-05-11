import {
  listCells,
  listControllers,
  searchCells,
} from "../../services/inventory.js";
import { getRuntimeContext } from "../runtime-context.js";
import {
  card,
  escapeHtml,
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

function renderPortChoices(ports = [], selectedPort = "") {
  if (!ports.length) {
    return `<p class="muted">No ESP32 serial port detected. Plug in the ESP32 USB cable, then click Refresh ports.</p>`;
  }

  return ports
    .map(
      (port) => `
        <button
          type="button"
          class="firmware-port-choice ${port.path === selectedPort ? "firmware-port-choice-active" : ""}"
          data-firmware-port-choice
          data-port-path="${escapeHtml(port.path)}"
        >
          <strong>${escapeHtml(port.label)}</strong>
          <code>${escapeHtml(port.path)}</code>
          ${port.recommended ? statusBadge("detected") : statusBadge("serial")}
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

  function renderCells(user, flash, search) {
    const cells = search ? searchCells(db, search) : [];

    return page({
      title: "Cells",
      user,
      flash,
      content: `
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
    const port = firmwareOptions?.defaultPort || "";
    const fqbn = lastFirmwareConfig?.fqbn || firmwareOptions?.defaultFqbn || "esp32:esp32:esp32";
    const hasPorts = Boolean(firmwareOptions?.ports?.length);

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
                            <button type="button" class="ghost-button" data-firmware-refresh-ports>Refresh ports</button>
                          </div>
                        </label>
                        <label>Board FQBN
                          <input name="fqbn" value="${escapeHtml(fqbn)}" required />
                        </label>
                      </div>
                      <datalist id="firmware-ports">
                        ${renderPortOptions(firmwareOptions.ports)}
                      </datalist>
                      <div
                        class="firmware-port-status ${hasPorts ? "firmware-port-status-ok" : "firmware-port-status-missing"}"
                        data-firmware-port-status
                      >${escapeHtml(firmwareOptions.portStatus)}</div>
                      <div class="firmware-port-list" data-firmware-port-list>
                        ${renderPortChoices(firmwareOptions.ports, port)}
                      </div>
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
            ["Controller", "Health", "Cells", "Test"],
            controllers.map((controller) => [
              escapeHtml(controller.controller_code),
              statusBadge(controller.heartbeat_status),
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
            ["Cell", "Channel", "Stock", "Save", "Light"],
            cells.map((cell) => [
              escapeHtml(cell.logical_code),
              escapeHtml(cell.hardware_channel),
              escapeHtml(formatQuantity(cell.occupied_quantity)),
              `
                <form method="post" action="/mapping" class="inline-form">
                  <input type="hidden" name="cell_id" value="${cell.id}" />
                  <input class="compact-input" type="number" min="1" name="hardware_channel" value="${escapeHtml(cell.hardware_channel)}" />
                  <button type="submit" class="ghost-button">Save</button>
                </form>
              `,
              `
                <form method="post" action="/devices/cell-test">
                  <input type="hidden" name="cell_id" value="${cell.id}" />
                  <button type="submit" class="ghost-button">Blink</button>
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
