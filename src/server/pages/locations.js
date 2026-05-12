import {
  listCellCatalog,
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

function trashIcon() {
  return `
    <svg class="button-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path d="M3 6h18" />
      <path d="M8 6V4c0-1.1.9-2 2-2h4c1.1 0 2 .9 2 2v2" />
      <path d="M19 6l-1 14c-.1 1.1-1 2-2.1 2H8.1c-1.1 0-2-.9-2.1-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  `;
}

function refreshIcon() {
  return `
    <svg class="button-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 5v4h4" />
      <path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 19v-4h-4" />
    </svg>
  `;
}

function wizardCheckIcon() {
  return `
    <svg class="wizard-step-check" aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  `;
}

function renderModuleChips(modules = []) {
  return modules
    .map((moduleNumber) => `<span class="module-chip">Module ${escapeHtml(moduleNumber)}</span>`)
    .join("");
}

function renderFirmwareVerification(config) {
  if (!config) {
    return "";
  }

  const summary = config.mappingSummary
    ? ` Preserved ${formatQuantity(config.mappingSummary.preserved)} mapping(s), added ${formatQuantity(
        config.mappingSummary.created,
      )} new module slot(s), and left ${formatQuantity(config.mappingSummary.detached)} cell(s) in manual mode.`
    : "";
  return `
    <div class="firmware-verify">
      Flash saved for ${escapeHtml(config.controllerName || config.deviceName || "this controller")}.
      Use Ping on each LED module below, then update the cell dropdown if any physical module is assigned to the wrong cell.
      ${escapeHtml(summary)}
    </div>
  `;
}

function renderPortOptions(ports = []) {
  return ports
    .map((port) => `<option value="${escapeHtml(port.path)}">${escapeHtml(port.label)}</option>`)
    .join("");
}

function nextControllerName(controllers = []) {
  const used = new Set(controllers.map((controller) => String(controller.controller_code || "").toUpperCase()));
  let index = controllers.length + 1;
  while (used.has(`ESP32-${String(index).padStart(2, "0")}`)) {
    index += 1;
  }
  return `ESP32-${String(index).padStart(2, "0")}`;
}

function flashRecordSummary(port) {
  if (port.flashRecordAmbiguous || port.flashRecords?.length > 1) {
    const names = (port.flashRecords || [])
      .map((record) => record.controllerName || record.deviceName)
      .filter(Boolean)
      .join(", ");
    return `<span class="firmware-device-summary">Shared USB-UART identity${names ? ` for ${escapeHtml(names)}` : ""}. Choose the exact controller name before flashing.</span>`;
  }

  if (!port.flashRecord) {
    return `<span class="firmware-device-summary">New ESP32 detected. Flash this controller before mapping cells.</span>`;
  }

  const flashedBy = port.flashRecord.flashedBy?.name || port.flashRecord.flashedBy?.username || "unknown user";
  return `
    <span class="firmware-device-summary">
      Already flashed as ${escapeHtml(port.flashRecord.deviceName || port.deviceName || "ESP32 controller")}
      · id ${escapeHtml(port.flashRecord.controllerAddress || port.flashRecord.controllerId || "unknown")}
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
          ${statusBadge(port.flashRecordAmbiguous ? "shared" : port.flashStatus === "configured" ? "flashed" : "new")}
          ${flashRecordSummary(port)}
        </button>
      `,
    )
    .join("");
}

function cellMappingOptionLabel(cell) {
  const stock = Number(cell.occupied_quantity || 0) > 0 ? ` · stock ${formatQuantity(cell.occupied_quantity)}` : "";
  const controller = cell.controller_code
    ? ` · ${cell.controller_code}${cell.hardware_channel ? ` module ${cell.hardware_channel}` : ""}`
    : " · unmapped";
  const state = Number(cell.active) === 1 ? "" : " · inactive";
  return `${cell.logical_code}${stock}${controller}${state}`;
}

function cellHasDeletionData(cell) {
  return (
    Number(cell.occupied_quantity || 0) !== 0 ||
    Number(cell.reserved_quantity || 0) !== 0 ||
    Number(cell.balance_record_count || 0) > 0 ||
    Number(cell.task_line_count || 0) > 0 ||
    Number(cell.transaction_count || 0) > 0 ||
    Number(cell.device_event_count || 0) > 0
  );
}

function renderCellMappingOptions(cellCatalog, selectedCellId) {
  return cellCatalog
    .map(
      (cell) => `
        <option value="${cell.id}" ${Number(cell.id) === Number(selectedCellId) ? "selected" : ""}>
          ${escapeHtml(cellMappingOptionLabel(cell))}
        </option>
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
      ["Cell", "Controller", "LED module", "Stock", "Products", "Actions"],
      cells.map((cell) => [
        `<a href="/cells/${cell.id}">${escapeHtml(cell.logical_code)}</a>`,
        cell.controller_code ? escapeHtml(cell.controller_code) : `<span class="muted">Manual</span>`,
        cell.hardware_channel ? escapeHtml(cell.hardware_channel) : `<span class="muted">Manual</span>`,
        escapeHtml(formatQuantity(cell.occupied_quantity)),
        cell.inventory_summary ? escapeHtml(cell.inventory_summary) : `<span class="muted">Empty</span>`,
        `
          <div class="mini-actions">
            <a class="mini-link" href="/put?cell_id=${cell.id}">Put item here</a>
            <button
              type="button"
              class="ghost-button locate-button"
              data-locate-cell
              data-cell-id="${cell.id}"
              data-cell-name="${escapeHtml(cell.logical_code)}"
              aria-pressed="false"
            >Locate</button>
          </div>
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
            "",
            `data-row-collapser data-row-limit="6" data-row-label="locations"`,
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
            <p>${
              cell.controller_code && cell.hardware_channel
                ? `${escapeHtml(cell.controller_code)} · Channel ${escapeHtml(cell.hardware_channel)}`
                : "Manual pick/put · no controller mapped"
            }</p>
            <div class="mini-actions">
              <a class="mini-link" href="/put?cell_id=${cell.id}">Put any item here</a>
            </div>
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
          "",
          `data-row-collapser data-row-limit="4" data-row-label="products"`,
        )}
      `,
    });
  }

  function renderDevices(user, flash) {
    const controllers = listControllers(db);
    const cells = listCells(db);
    const cellCatalog = listCellCatalog(db);
    const mappedCells = cells.filter((cell) => cell.controller_id && cell.hardware_channel);
    const onlineControllers = controllers.filter(
      (controller) => String(controller.heartbeat_status || "").toLowerCase() === "online",
    ).length;
    const manualCells = cells.length - mappedCells.length;
    const moduleTotal = controllers.reduce(
      (sum, controller) => sum + Number(controller.module_count || controller.mapped_cells || 0),
      0,
    );
    const runtime = getRuntimeContext();
    const firmwareOptions = runtime.firmwareService?.getFlashOptions();
    const lastFirmwareConfig = firmwareOptions?.lastConfiguration || null;
    const moduleCount = lastFirmwareConfig?.moduleCount || firmwareOptions?.moduleCount?.value || 4;
    const port = "";
    const controllerName = nextControllerName(controllers);
    const fqbn = lastFirmwareConfig?.fqbn || firmwareOptions?.defaultFqbn || "esp32:esp32:esp32";
    const hasPorts = false;

    const controllerRows = controllers.map((controller) => [
      escapeHtml(controller.controller_code),
      `<code>${escapeHtml(controller.address || "")}</code>`,
      statusBadge(controller.heartbeat_status),
      escapeHtml(formatDate(controller.last_seen_at)),
      escapeHtml(formatQuantity(controller.module_count || controller.mapped_cells)),
      escapeHtml(formatQuantity(controller.mapped_cells)),
      `
        <div class="mini-actions">
          <form method="post" action="/devices/controller-test">
            <input type="hidden" name="controller_id" value="${controller.id}" />
            <button
              type="submit"
              class="icon-button refresh-button"
              aria-label="Refresh health ${escapeHtml(controller.controller_code)}"
              title="Refresh health ${escapeHtml(controller.controller_code)}"
            >${refreshIcon()}</button>
          </form>
          <form
            method="post"
            action="/devices/controller-delete"
            onsubmit="return confirm('Delete this controller? Its cells will stay active for manual pick/put until remapped.');"
          >
            <input type="hidden" name="controller_id" value="${controller.id}" />
            <button
              type="submit"
              class="icon-button danger-button"
              aria-label="Delete ${escapeHtml(controller.controller_code)}"
              title="Delete ${escapeHtml(controller.controller_code)}"
            >${trashIcon()}</button>
          </form>
        </div>
      `,
    ]);

    const controllerWizard = firmwareOptions
      ? `
        <section id="controller-setup" class="app-panel" data-config-section="controller-setup" hidden>
          <div class="panel-heading">
            <div>
              <h2>Add Controller</h2>
              <p class="muted">Follow the same connection order every time so the app can identify the newly attached ESP32.</p>
            </div>
            ${statusBadge(firmwareOptions.arduinoCli.available ? "available" : "missing")}
          </div>
          <div class="firmware-panel" data-firmware-panel>
            <div class="meta-grid compact-meta-grid">
              <div><strong>Arduino CLI</strong><br />${statusBadge(
                firmwareOptions.arduinoCli.available ? "available" : "missing",
              )}</div>
              <div><strong>Sketch</strong><br /><code>${escapeHtml(firmwareOptions.sketchPath)}</code></div>
            </div>
            <form class="stack-form firmware-wizard" data-firmware-flash-form data-firmware-wizard data-current-step="0">
              <ol class="wizard-steps" aria-label="Controller setup progress">
                <li class="wizard-step-indicator wizard-step-indicator-active" data-firmware-step-indicator="0" aria-current="step">
                  <span class="wizard-step-node" aria-hidden="true">
                    <span class="wizard-step-number">1</span>
                    ${wizardCheckIcon()}
                  </span>
                  <span class="wizard-step-copy">
                    <strong>Disconnect</strong>
                    <span>Save current ports</span>
                  </span>
                </li>
                <li class="wizard-step-indicator wizard-step-indicator-upcoming" data-firmware-step-indicator="1">
                  <span class="wizard-step-node" aria-hidden="true">
                    <span class="wizard-step-number">2</span>
                    ${wizardCheckIcon()}
                  </span>
                  <span class="wizard-step-copy">
                    <strong>Attach</strong>
                    <span>Find new ESP32</span>
                  </span>
                </li>
                <li class="wizard-step-indicator wizard-step-indicator-upcoming" data-firmware-step-indicator="2">
                  <span class="wizard-step-node" aria-hidden="true">
                    <span class="wizard-step-number">3</span>
                    ${wizardCheckIcon()}
                  </span>
                  <span class="wizard-step-copy">
                    <strong>Configure</strong>
                    <span>Name and modules</span>
                  </span>
                </li>
                <li class="wizard-step-indicator wizard-step-indicator-upcoming" data-firmware-step-indicator="3">
                  <span class="wizard-step-node" aria-hidden="true">
                    <span class="wizard-step-number">4</span>
                    ${wizardCheckIcon()}
                  </span>
                  <span class="wizard-step-copy">
                    <strong>Flash</strong>
                    <span>Upload firmware</span>
                  </span>
                </li>
              </ol>

              <section class="firmware-step" data-firmware-step="0">
                <h3>Disconnect ESP32 controllers</h3>
                <p class="muted">Keep RS485, keyboard, and mouse connected. Unplug only the ESP32 controller that you want to add or replace.</p>
                <div class="mini-actions">
                  <button type="button" class="blue-button" data-firmware-scan-baseline data-firmware-next-on-success>Next</button>
                </div>
              </section>

              <section class="firmware-step" data-firmware-step="1" hidden>
                <h3>Attach one ESP32 controller</h3>
                <p class="muted">Connect the ESP32 over USB. If the app does not find a newly added serial device, go back and repeat the disconnect step.</p>
                <div class="mini-actions">
                  <button type="button" class="ghost-button" data-firmware-prev>Back</button>
                  <button type="button" class="blue-button" data-firmware-refresh-ports data-firmware-next-on-success>Next</button>
                </div>
                <div class="firmware-port-status firmware-port-status-missing" data-firmware-detect-status hidden></div>
              </section>

              <section class="firmware-step" data-firmware-step="2" hidden>
                <h3>Select and configure the controller</h3>
                <div class="firmware-grid">
                  <label>Controller name
                    <input
                      name="controller_name"
                      list="firmware-controller-names"
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
                  </label>
                  <label>Board FQBN
                    <input name="fqbn" value="${escapeHtml(fqbn)}" required />
                  </label>
                </div>
                <datalist id="firmware-ports">
                  ${renderPortOptions([])}
                </datalist>
                <datalist id="firmware-controller-names">
                  ${controllers
                    .map(
                      (controller) =>
                        `<option value="${escapeHtml(controller.controller_code)}">${escapeHtml(
                          `${controller.controller_code} · replace/migrate existing mapping`,
                        )}</option>`,
                    )
                    .join("")}
                </datalist>
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
                  <button type="button" class="ghost-button" data-firmware-prev>Back</button>
                  <button type="button" class="blue-button" data-firmware-next>Next</button>
                </div>
              </section>

              <section class="firmware-step" data-firmware-step="3" hidden>
                <h3>Flash firmware</h3>
                <p class="muted">If upload cannot connect, hold BOOT, start flashing, tap EN/RESET once while Connecting is shown, then release BOOT after upload starts.</p>
                <div class="mini-actions">
                  <button type="button" class="ghost-button" data-firmware-prev>Back</button>
                  <button type="submit" class="blue-button" ${hasPorts ? "" : "disabled"}>Flash controller</button>
                </div>
                <div class="firmware-progress" data-firmware-progress hidden>
                  <div class="firmware-progress-head">
                    <strong data-firmware-stage>Queued</strong>
                    <span data-firmware-percent>0%</span>
                  </div>
                  <progress data-firmware-progress-bar value="0" max="100"></progress>
                  <div class="firmware-hint" data-firmware-hint hidden></div>
                  <pre class="firmware-log" data-firmware-log></pre>
                </div>
              </section>
            </form>
            <div
              class="module-assignment-strip"
              data-firmware-modules
              ${lastFirmwareConfig?.assignedModules?.length ? "" : "hidden"}
            >${renderModuleChips(lastFirmwareConfig?.assignedModules || [])}</div>
            ${renderFirmwareVerification(lastFirmwareConfig)}
          </div>
        </section>
      `
      : `
        <section id="controller-setup" class="app-panel" data-config-section="controller-setup" hidden>
          <div class="panel-heading">
            <div>
              <h2>Add Controller</h2>
              <p class="muted">Firmware flashing is not available in this runtime.</p>
            </div>
          </div>
        </section>
      `;

    return page({
      title: "Configuration Console",
      user,
      flash,
      content: `
        <div class="app-console" data-config-workspace>
          <section class="operation-grid" aria-label="Configuration actions">
            <a class="operation-tile" href="#controller-setup" data-config-section-link="controller-setup" aria-controls="controller-setup">
              <span>
                <strong>Add controller</strong>
                Flash a new ESP32 through a guided setup.
              </span>
              <span class="operation-kbd">01</span>
            </a>
            <a class="operation-tile" href="#cell-create" data-config-section-link="cell-create" aria-controls="cell-create">
              <span>
                <strong>Add cells</strong>
                Create a storage location with capacity.
              </span>
              <span class="operation-kbd">02</span>
            </a>
            <a class="operation-tile" href="#cell-management" data-config-section-link="cell-management" aria-controls="cell-management">
              <span>
                <strong>Manage cells</strong>
                Delete and review active storage cells.
              </span>
              <span class="operation-kbd">03</span>
            </a>
            <a class="operation-tile" href="#cell-mapping" data-config-section-link="cell-mapping" aria-controls="cell-mapping">
              <span>
                <strong>Cell mapping</strong>
                Ping modules and assign them to storage cells.
              </span>
              <span class="operation-kbd">04</span>
            </a>
          </section>

          <section class="app-panel" aria-labelledby="configuration-status-heading">
            <div class="panel-heading">
              <div>
                <h2 id="configuration-status-heading">System Status</h2>
                <p class="muted">Controller health is refreshed when this console opens.</p>
              </div>
            </div>
            <div class="status-strip">
              <div class="status-metric">
                <span class="muted">Controllers online</span>
                <strong>${escapeHtml(`${onlineControllers}/${controllers.length}`)}</strong>
              </div>
              <div class="status-metric">
                <span class="muted">LED modules</span>
                <strong>${escapeHtml(formatQuantity(moduleTotal))}</strong>
              </div>
              <div class="status-metric">
                <span class="muted">Mapped cells</span>
                <strong>${escapeHtml(formatQuantity(mappedCells.length))}</strong>
              </div>
              <div class="status-metric">
                <span class="muted">Manual cells</span>
                <strong>${escapeHtml(formatQuantity(manualCells))}</strong>
              </div>
            </div>
          </section>

          <section id="controller-health" class="app-panel">
            <div class="panel-heading">
              <div>
                <h2>Controller Health</h2>
                <p class="muted">Delete removes only the controller. Its cells stay active for manual pick and put until remapped.</p>
              </div>
            </div>
            ${table(
              ["Controller", "RS485 id", "Health", "Last seen", "LED modules", "Cells", "Actions"],
              controllerRows,
            )}
          </section>

          <div
            class="modal-backdrop app-alert-modal configuration-flow-modal"
            data-config-modal
            role="dialog"
            aria-modal="true"
            aria-labelledby="configuration-flow-title"
            hidden
          >
            <div class="modal-panel configuration-flow-panel">
              <div class="modal-header">
                <div>
                  <h2 id="configuration-flow-title" data-config-modal-title>Configuration</h2>
                  <p class="muted" data-config-modal-description>Select a configuration flow to continue.</p>
                </div>
                <button type="button" class="icon-button ghost-button" data-config-modal-close aria-label="Close configuration flow" title="Close">x</button>
              </div>
              <div class="configuration-flow-content">
                ${controllerWizard}

                <section id="cell-create" class="app-panel" data-config-section="cell-create" hidden>
                  <div class="panel-heading">
                    <div>
                      <h2>Add Cells</h2>
                      <p class="muted">Create the logical storage cells that operators will pick from and put into.</p>
                    </div>
                  </div>
                  <form method="post" action="/devices/cells" class="inline-form">
                    <label>Cell name
                      <input
                        name="logical_code"
                        placeholder="Z1-R1-C01"
                        pattern="[A-Za-z0-9._:-]+"
                        required
                      />
                    </label>
                    <label>Capacity
                      <input name="capacity" type="number" min="1" step="1" value="12" required />
                    </label>
                    <button type="submit" class="ghost-button">Add cell</button>
                  </form>
                </section>

                <section id="cell-management" class="configuration-table-section" data-config-section="cell-management" data-row-collapser data-row-limit="4" data-row-label="cells" hidden>
                  ${
                    cells.length
                      ? table(
                          ["Cell", "Controller", "LED module", "Stock", "Products", "Actions"],
                          cells.map((cell) => {
                            const hasData = cellHasDeletionData(cell);
                            return [
                              escapeHtml(cell.logical_code),
                              cell.controller_code ? escapeHtml(cell.controller_code) : `<span class="muted">Manual</span>`,
                              cell.hardware_channel ? escapeHtml(cell.hardware_channel) : `<span class="muted">Manual</span>`,
                              escapeHtml(formatQuantity(cell.occupied_quantity)),
                              cell.inventory_summary ? escapeHtml(cell.inventory_summary) : `<span class="muted">Empty</span>`,
                              `
                                <form
                                  method="post"
                                  action="/devices/cells/delete"
                                  class="inline-form"
                                  data-delete-cell-form
                                  data-cell-name="${escapeHtml(cell.logical_code)}"
                                  data-cell-has-data="${hasData ? "true" : "false"}"
                                >
                                  <input type="hidden" name="cell_id" value="${cell.id}" />
                                  <input type="hidden" name="delete_data_confirmed" value="0" data-delete-data-confirmed />
                                  <button
                                    type="submit"
                                    class="icon-button danger-button"
                                    aria-label="Delete ${escapeHtml(cell.logical_code)}"
                                    title="Delete ${escapeHtml(cell.logical_code)}"
                                  >${trashIcon()}</button>
                                </form>
                              `,
                            ];
                          }),
                        )
                      : `<p class="muted">No active cells are configured.</p>`
                  }
                </section>

                <section id="cell-mapping" class="app-panel" data-config-section="cell-mapping" data-row-collapser data-row-limit="4" data-row-label="mappings" hidden>
                  <div class="panel-heading">
                    <div>
                      <h2>Module Assignments</h2>
                      <p class="muted">Ping a module, then assign it to the physical cell it controls.</p>
                    </div>
                    <div class="mini-actions mapping-toolbar">
                      <span class="mapping-toolbar-status" data-mapping-dirty-count>All mappings saved</span>
                      <button type="submit" form="cell-mapping-form" class="blue-button" data-mapping-save disabled>Save all</button>
                    </div>
                  </div>
                  <form id="cell-mapping-form" method="post" action="/mapping/bulk" data-cell-mapping-form>
                    <input type="hidden" name="return_to" value="/devices#cell-mapping" data-mapping-return-to />
                    ${table(
                      ["Controller", "LED module", "Cell name", "Stock", "Ping"],
                      mappedCells.map((cell) => [
                        escapeHtml(cell.controller_code || "No controller"),
                        escapeHtml(cell.hardware_channel),
                        `
                          <input type="hidden" name="hardware_channel_${cell.id}" value="${escapeHtml(cell.hardware_channel)}" />
                          <input type="hidden" name="original_target_cell_id_${cell.id}" value="${cell.id}" />
                          <div class="mapping-cell-control">
                            <span
                              class="mapping-cell-name mapping-cell-name-saved"
                              data-mapping-cell-name
                              data-original-label="${escapeHtml(cell.logical_code)}"
                            >${escapeHtml(cell.logical_code)}</span>
                            <select
                              class="compact-input cell-mapping-select"
                              name="target_cell_id_${cell.id}"
                              required
                              data-mapping-select
                              data-original-value="${cell.id}"
                              data-original-label="${escapeHtml(cell.logical_code)}"
                              data-controller-name="${escapeHtml(cell.controller_code || "No controller")}"
                              data-module-name="${escapeHtml(cell.hardware_channel)}"
                            >
                              ${renderCellMappingOptions(cellCatalog, cell.id)}
                            </select>
                          </div>
                        `,
                        escapeHtml(formatQuantity(cell.occupied_quantity)),
                        `
                          <button
                            type="submit"
                            form="cell-ping-${cell.id}"
                            class="green-button ping-button"
                            title="Ping ${escapeHtml(cell.logical_code)}"
                          >Ping</button>
                        `,
                      ]),
                    )}
                  </form>
                  ${mappedCells
                    .map(
                      (cell) => `
                        <form id="cell-ping-${cell.id}" method="post" action="/devices/cell-test" hidden>
                          <input type="hidden" name="cell_id" value="${cell.id}" />
                          <input type="hidden" name="color" value="green" />
                          <input type="hidden" name="return_to" value="/devices#cell-mapping" />
                        </form>
                      `,
                    )
                    .join("")}
                  <div class="modal-backdrop app-alert-modal" data-mapping-unsaved-modal role="dialog" aria-modal="true" aria-labelledby="mapping-unsaved-title" hidden>
                    <div class="modal-panel mapping-unsaved-panel">
                      <div class="modal-header">
                        <div>
                          <h2 id="mapping-unsaved-title">Unsaved cell mapping changes</h2>
                          <p class="muted">Save or discard the pending mapping changes before leaving this section.</p>
                        </div>
                      </div>
                      <ul class="mapping-unsaved-list" data-mapping-unsaved-list></ul>
                      <div class="modal-actions">
                        <button type="button" class="blue-button" data-mapping-modal-save>Save all</button>
                        <button type="button" class="ghost-button danger-button" data-mapping-modal-discard>Discard</button>
                        <button type="button" class="ghost-button" data-mapping-modal-review>Review</button>
                      </div>
                    </div>
                  </div>
                </section>
              </div>
            </div>
          </div>
        </div>
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
