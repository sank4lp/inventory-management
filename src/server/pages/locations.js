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
  statsGrid,
  statusBadge,
  table,
  trashIcon,
} from "./shared.js";

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
  const controller = cellIsMapped(cell)
    ? ` · mapped to ${cell.controller_code}${cell.hardware_channel ? ` module ${cell.hardware_channel}` : ""}`
    : " · recommended · unmapped";
  const state = Number(cell.active) === 1 ? "" : " · inactive";
  return `${cell.logical_code}${stock}${controller}${state}`;
}

function cellHasStock(cell) {
  return Number(cell.occupied_quantity || 0) !== 0 || Number(cell.reserved_quantity || 0) !== 0;
}

function cellIsMapped(cell) {
  return (
    Number(cell.active) === 1 &&
    cell.mapping_status === "mapped" &&
    Boolean(cell.controller_id) &&
    Boolean(cell.hardware_channel)
  );
}

function cellMappingDisplayName(cell) {
  return Number(cell.active) === 1 ? cell.logical_code : "Empty";
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

function renderLocationWorkflowActions(cell) {
  return `
    <a class="mini-link" href="/pick?cell_id=${cell.id}">Pick</a>
    <a class="mini-link" href="/put?cell_id=${cell.id}">Put</a>
  `;
}

function renderLocationLocateButton(cell) {
  const mapped = cellIsMapped(cell);
  return `
    <button
      type="button"
      class="ghost-button locate-button"
      data-cell-id="${cell.id}"
      data-cell-name="${escapeHtml(cell.logical_code)}"
      aria-pressed="false"
      ${mapped ? "data-locate-cell" : `disabled aria-disabled="true" title="Manual location has no LED mapped"`}
    >Locate</button>
  `;
}

export function createLocationPages({ db }) {
  function renderCellSearchResults(cells, search = "") {
    const searchLabel = String(search || "").trim();
    return `
      ${
        searchLabel
          ? `<p class="muted">${escapeHtml(formatQuantity(cells.length))} location(s) match "${escapeHtml(searchLabel)}".</p>`
          : ""
      }
      ${table(
        ["Location", "Stock", "Products", "Actions"],
        cells.map((cell) => [
          `<a href="/cells/${cell.id}">${escapeHtml(cell.logical_code)}</a>`,
          escapeHtml(formatQuantity(cell.occupied_quantity)),
          cell.inventory_summary ? escapeHtml(cell.inventory_summary) : `<span class="muted">Empty</span>`,
          `
            <div class="mini-actions">
              <a class="mini-link" href="/cells/${cell.id}">View</a>
              ${renderLocationWorkflowActions(cell)}
            </div>
          `,
        ]),
        "No locations match that search.",
      )}
    `;
  }

  function renderAllLocations(cells) {
    return table(
        ["Location", "Light Controller", "LED Module", "Stock", "Products", "Actions"],
      cells.map((cell) => [
        `<a href="/cells/${cell.id}">${escapeHtml(cell.logical_code)}</a>`,
        cell.controller_code ? escapeHtml(cell.controller_code) : `<span class="muted">Manual</span>`,
        cell.hardware_channel ? escapeHtml(cell.hardware_channel) : `<span class="muted">Manual</span>`,
        escapeHtml(formatQuantity(cell.occupied_quantity)),
        cell.inventory_summary ? escapeHtml(cell.inventory_summary) : `<span class="muted">Empty</span>`,
        `
          <div class="mini-actions">
            ${renderLocationWorkflowActions(cell)}
            ${renderLocationLocateButton(cell)}
          </div>
        `,
      ]),
    );
  }

  function renderCells(user, flash, search) {
    const cells = search ? searchCells(db, search) : [];
    const allCells = listCells(db);
    const occupiedCount = allCells.filter((cell) => Number(cell.occupied_quantity || 0) > 0).length;
    const emptyCount = allCells.length - occupiedCount;
    const mappedCount = allCells.filter((cell) => cell.controller_code && cell.hardware_channel).length;

    return page({
      title: "Locations",
      user,
      flash,
      content: `
        <div data-location-page>
          ${statsGrid([
            { label: "Locations", value: formatQuantity(allCells.length) },
            { label: "With Stock", value: formatQuantity(occupiedCount) },
            { label: "Empty", value: formatQuantity(emptyCount) },
            { label: "LED Mapped", value: formatQuantity(mappedCount) },
          ])}
          ${card(
            "Find A Location",
            `
              <form
                method="get"
                action="/cells"
                class="inline-form"
                data-live-search-form
                data-endpoint="/fragments/cell-search"
                data-target="#cell-search-results"
                data-empty-html="<p class=&quot;muted&quot;>Search a location to see what products are inside it.</p>"
              >
                <label class="inline-form-wrap">Search Locations
                  <input data-live-input name="q" value="${escapeHtml(search || "")}" placeholder="Type a location code, for example Z1-R1-C01" />
                </label>
                <button type="submit">Search</button>
              </form>
              <div id="cell-search-results">
                ${
                  search
                    ? renderCellSearchResults(cells, search)
                    : `<p class="muted">Search a location to see what products are inside it.</p>`
                }
              </div>
            `,
            "",
            `id="find-location"`,
          )}
          ${card(
            "All Locations",
            allCells.length
              ? renderAllLocations(allCells)
              : `<p class="muted">No active locations are configured. Ask an admin to add cells in Configuration.</p>`,
            "",
            `id="all-locations" data-row-collapser data-row-limit="6" data-row-label="locations"`,
          )}
        </div>
      `,
    });
  }

  function renderCellDetail(user, flash, cell) {
    if (!cell) {
      return page({
        title: "Cell Not Found",
        user,
        flash: flash || { message: "Cell not found.", tone: "error" },
        content: `<p><a href="/cells">Back To Cells</a></p>`,
      });
    }

    return page({
      title: cell.logical_code,
      user,
      flash,
      content: `
        ${card(
          "Location Summary",
          `
            <p><strong>${escapeHtml(cell.logical_code)}</strong></p>
            <p>${
              cell.controller_code && cell.hardware_channel
                ? `${escapeHtml(cell.controller_code)} · Channel ${escapeHtml(cell.hardware_channel)}`
                : "Manual pick/put · no light controller mapped"
            }</p>
            <div class="mini-actions">
              ${renderLocationWorkflowActions(cell)}
            </div>
          `,
        )}
        ${card(
          "Products In This Location",
          table(
            ["Product", "Available", "Action"],
            cell.products.map((product) => [
              `<a href="/products/${product.product_id}">${escapeHtml(product.name)}</a><br /><small>${escapeHtml(product.sku)}</small>`,
              escapeHtml(formatQuantity(product.available_quantity)),
              quickActionLinks(product.product_id, cell.id),
            ]),
            "This location is empty right now.",
          ),
          "",
          `data-row-collapser data-row-limit="4" data-row-label="products"`,
        )}
      `,
    });
  }

  function renderControllerSetupSection(controllers) {
    const runtime = getRuntimeContext();
    const firmwareOptions = runtime.firmwareService?.getFlashOptions();
    const lastFirmwareConfig = firmwareOptions?.lastConfiguration || null;
    const port = "";
    const fqbn = lastFirmwareConfig?.fqbn || firmwareOptions?.defaultFqbn || "esp32:esp32:esp32";
    const hasPorts = false;

    if (!firmwareOptions) {
      return `
        <section id="controller-setup" class="app-panel" data-config-section="controller-setup">
          <p class="muted">Firmware flashing is not available in this runtime.</p>
        </section>
      `;
    }

    return `
      <section id="controller-setup" class="app-panel" data-config-section="controller-setup">
        <div class="firmware-panel" data-firmware-panel>
          ${
            firmwareOptions.arduinoCli.available
              ? ""
              : `<div class="firmware-port-status firmware-port-status-missing">Arduino CLI is missing.</div>`
          }
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
              <div class="mini-actions">
                <button type="button" class="blue-button" data-firmware-scan-baseline data-firmware-next-on-success>Next</button>
              </div>
            </section>

            <section class="firmware-step" data-firmware-step="1" hidden>
              <div class="mini-actions">
                <button type="button" class="ghost-button" data-firmware-prev>Back</button>
                <button type="button" class="blue-button" data-firmware-refresh-ports data-firmware-next-on-success>Next</button>
              </div>
              <div class="firmware-port-status firmware-port-status-missing" data-firmware-detect-status hidden></div>
            </section>

            <section class="firmware-step" data-firmware-step="2" hidden>
              <div class="firmware-grid">
                <label>Controller Name
                  <input
                    name="controller_name"
                    list="firmware-controller-names"
                    placeholder="ESP32-Z1-A"
                    required
                  />
                </label>
                <label>LED Modules
                  <input
                    type="number"
                    name="module_count"
                    min="${firmwareOptions.moduleCount.min}"
                    max="${firmwareOptions.moduleCount.max}"
                    step="1"
                    placeholder="4"
                    required
                  />
                </label>
                <label>Serial Port
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
                <summary>Other Serial Devices / Manual Reflash</summary>
                <div class="firmware-other-device-list" data-firmware-other-device-list></div>
              </details>
              <div class="mini-actions">
                <button type="button" class="ghost-button" data-firmware-prev>Back</button>
                <button type="button" class="blue-button" data-firmware-next>Next</button>
              </div>
            </section>

            <section class="firmware-step" data-firmware-step="3" hidden>
              <div class="mini-actions">
                <button type="button" class="ghost-button" data-firmware-prev>Back</button>
                <button type="submit" class="blue-button" ${hasPorts ? "" : "disabled"}>Flash Controller</button>
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
    `;
  }

  function renderCellManagementSection(cells) {
    return `
      <section id="cell-management" class="configuration-table-section app-panel" data-config-section="cell-management" data-row-collapser data-row-limit="4" data-row-label="cells">
        <div class="panel-heading">
          <div>
            <h2>Manage Locations</h2>
            <p class="muted">Add logical locations, rename location names, or remove empty locations.</p>
          </div>
        </div>
        <form method="post" action="/devices/cells" class="inline-form">
          <label>Location Name
            <input
              name="logical_code"
              placeholder="Z1-R1-C01"
              pattern="[A-Za-z0-9._:-]+"
              required
            />
          </label>
          <button type="submit" class="ghost-button">Add Location</button>
        </form>
        ${
          cells.length
            ? table(
                ["Location Name", "Mapped Controller", "Mapped LED Module", "Stock", "Products", "Actions"],
                cells.map((cell) => {
                  const hasStock = cellHasStock(cell);
                  const deleteTitle = hasStock
                    ? `Move all stock out of ${cell.logical_code} before deleting it`
                    : `Delete ${cell.logical_code}`;
                  return [
                    `
                      <form method="post" action="/devices/cells/rename" class="inline-form">
                        <input type="hidden" name="cell_id" value="${cell.id}" />
                        <label class="sr-only" for="rename-cell-${cell.id}">Location Name</label>
                        <input
                          id="rename-cell-${cell.id}"
                          class="compact-input"
                          name="logical_code"
                          value="${escapeHtml(cell.logical_code)}"
                          pattern="[A-Za-z0-9._:-]+"
                          required
                        />
                        <button type="submit" class="ghost-button">Rename</button>
                      </form>
                    `,
                    cellIsMapped(cell) ? escapeHtml(cell.controller_code) : `<span class="muted">Unmapped</span>`,
                    cellIsMapped(cell) ? escapeHtml(cell.hardware_channel) : `<span class="muted">Unmapped</span>`,
                    escapeHtml(formatQuantity(cell.occupied_quantity)),
                    cell.inventory_summary ? escapeHtml(cell.inventory_summary) : `<span class="muted">Empty</span>`,
                    `
                      <form
                        method="post"
                        action="/devices/cells/delete"
                        class="inline-form"
                        data-delete-cell-form
                        data-cell-name="${escapeHtml(cell.logical_code)}"
                        data-cell-has-stock="${hasStock ? "true" : "false"}"
                      >
                        <input type="hidden" name="cell_id" value="${cell.id}" />
                        <button
                          type="submit"
                          class="icon-button danger-button"
                          aria-label="Delete ${escapeHtml(cell.logical_code)}"
                          title="${escapeHtml(deleteTitle)}"
                          ${hasStock ? "disabled" : ""}
                        >${trashIcon()}</button>
                      </form>
                    `,
                  ];
                }),
              )
            : `<p class="muted">No active cells are configured.</p>`
        }
      </section>
    `;
  }

  function renderCellMappingSection(cells) {
    const cellCatalog = listCellCatalog(db)
      .filter((cell) => Number(cell.active) === 1)
      .sort((left, right) => {
        const leftMapped = cellIsMapped(left) ? 1 : 0;
        const rightMapped = cellIsMapped(right) ? 1 : 0;
        if (leftMapped !== rightMapped) {
          return leftMapped - rightMapped;
        }
        return String(left.logical_code || "").localeCompare(String(right.logical_code || ""), undefined, {
          numeric: true,
        });
      });
    const firstRecommendedCell = cellCatalog.find((cell) => !cellIsMapped(cell));
    const mappedCells = cells
      .filter(
        (cell) => {
          const moduleCount = Number(cell.controller_module_count || 0);
          return (
            cell.controller_id &&
            cell.hardware_channel &&
            Number(cell.controller_active) === 1 &&
            String(cell.controller_health || "").toLowerCase() === "online" &&
            (moduleCount <= 0 || Number(cell.hardware_channel) <= moduleCount)
          );
        },
      )
      .sort((left, right) => {
        const controllerCompare = String(left.controller_code || "").localeCompare(
          String(right.controller_code || ""),
          undefined,
          { numeric: true },
        );
        if (controllerCompare !== 0) {
          return controllerCompare;
        }
        return Number(left.hardware_channel || 0) - Number(right.hardware_channel || 0);
      });

    return `
      <section id="cell-mapping" class="app-panel" data-config-section="cell-mapping" data-row-collapser data-row-limit="4" data-row-label="mappings">
        <div class="panel-heading">
          <div>
            <h2>Module Assignments</h2>
            <p class="muted">Ping a module, then assign it to the physical cell it controls.</p>
          </div>
          <div class="mini-actions mapping-toolbar">
            <span class="mapping-toolbar-status" data-mapping-dirty-count>All Mappings Saved</span>
            <button type="submit" form="cell-mapping-form" class="blue-button" data-mapping-save disabled>Save All</button>
          </div>
        </div>
        <form id="cell-mapping-form" method="post" action="/mapping/bulk" data-cell-mapping-form>
          <input type="hidden" name="return_to" value="/devices#cell-mapping" data-mapping-return-to />
          <datalist id="cell-mapping-options">
            ${cellCatalog
              .map(
                (catalogCell) => `
                  <option
                    value="${escapeHtml(catalogCell.logical_code)}"
                    label="${escapeHtml(cellMappingOptionLabel(catalogCell))}"
                    data-cell-id="${catalogCell.id}"
                    data-cell-label="${escapeHtml(catalogCell.logical_code)}"
                  ></option>
                `,
              )
              .join("")}
          </datalist>
          ${table(
            ["Controller", "LED Module", "Assigned Location", "Stock", "Actions"],
            mappedCells.map((cell) => {
              const assigned = Number(cell.active) === 1;
              const displayName = cellMappingDisplayName(cell);
              const originalValue = assigned ? String(cell.id) : "";
              const inputValue = assigned ? cell.logical_code : "";
              const stockLabel = assigned
                ? escapeHtml(formatQuantity(cell.occupied_quantity))
                : `<span class="muted">Empty</span>`;
              const inputPlaceholder = assigned
                ? ""
                : firstRecommendedCell
                  ? `Suggested: ${firstRecommendedCell.logical_code}`
                  : "Choose a location";
              return [
                escapeHtml(cell.controller_code || "No controller"),
                escapeHtml(cell.hardware_channel),
                `
                  <input type="hidden" name="hardware_channel_${cell.id}" value="${escapeHtml(cell.hardware_channel)}" />
                  <input type="hidden" name="original_target_cell_id_${cell.id}" value="${escapeHtml(originalValue)}" />
                <div class="mapping-cell-control">
                  <span
                    class="mapping-cell-name mapping-cell-name-saved"
                    data-mapping-cell-name
                    data-original-label="${escapeHtml(displayName)}"
                  >${escapeHtml(displayName)}</span>
                  <input
                    type="hidden"
                    name="target_cell_id_${cell.id}"
                    value="${escapeHtml(originalValue)}"
                    data-mapping-control
                    data-mapping-key="${cell.id}"
                    data-original-value="${escapeHtml(originalValue)}"
                    data-original-label="${escapeHtml(displayName)}"
                    data-current-label="${escapeHtml(displayName)}"
                    data-controller-name="${escapeHtml(cell.controller_code || "No controller")}"
                    data-module-name="${escapeHtml(cell.hardware_channel)}"
                  />
                  <input
                    class="compact-input cell-mapping-select"
                    list="cell-mapping-options"
                    value="${escapeHtml(inputValue)}"
                    ${assigned ? "required" : ""}
                    autocomplete="off"
                    data-mapping-input
                    data-mapping-input-for="${cell.id}"
                    placeholder="${escapeHtml(inputPlaceholder)}"
                  />
                </div>
              `,
                stockLabel,
                `
                <div class="mini-actions">
                  <button
                    type="button"
                    class="ghost-button locate-button"
                    data-locate-cell
                    data-cell-id="${cell.id}"
                    aria-pressed="false"
                    title="Locate ${escapeHtml(cell.controller_code || "controller")} LED module ${escapeHtml(cell.hardware_channel)}"
                  >Locate</button>
                  <button
                    type="submit"
                    form="cell-ping-${cell.id}"
                    class="green-button ping-button"
                    data-led-command-submit
                    data-led-loading-label="Pinging"
                    data-led-loading-title="Pinging ${escapeHtml(cell.controller_code || "controller")} LED module ${escapeHtml(cell.hardware_channel)}"
                    title="Ping ${escapeHtml(cell.controller_code || "controller")} LED module ${escapeHtml(cell.hardware_channel)}"
                  >Ping</button>
                </div>
              `,
              ];
            }),
          )}
        </form>
        ${mappedCells
          .map(
            (cell) => `
              <form
                id="cell-ping-${cell.id}"
                method="post"
                action="/devices/cell-test"
                data-led-command-form
                data-led-command-async
                data-led-loading-label="Pinging"
                data-led-return-hash="#cell-mapping"
                hidden
              >
                <input type="hidden" name="cell_id" value="${cell.id}" />
                <input type="hidden" name="color" value="green" />
                <input type="hidden" name="return_to" value="/devices#cell-mapping" data-led-command-return-to />
              </form>
            `,
          )
          .join("")}
        <div class="modal-backdrop app-alert-modal" data-mapping-unsaved-modal role="dialog" aria-modal="true" aria-labelledby="mapping-unsaved-title" hidden>
          <div class="modal-panel mapping-unsaved-panel">
            <div class="modal-header">
              <div>
                <h2 id="mapping-unsaved-title">Unsaved Cell Mapping Changes</h2>
                <p class="muted">Save or discard the pending mapping changes before leaving this section.</p>
              </div>
            </div>
            <ul class="mapping-unsaved-list" data-mapping-unsaved-list></ul>
            <div class="modal-actions">
              <button type="button" class="blue-button" data-mapping-modal-save>Save All</button>
              <button type="button" class="ghost-button danger-button" data-mapping-modal-discard>Discard</button>
              <button type="button" class="ghost-button" data-mapping-modal-review>Review</button>
            </div>
          </div>
        </div>
      </section>
    `;
  }

  function renderDeviceConfigSection(sectionKey) {
    const controllers = listControllers(db);
    const cells = listCells(db);

    switch (sectionKey) {
      case "controller-setup":
        return renderControllerSetupSection(controllers);
      case "cell-create":
        return renderCellManagementSection(cells);
      case "cell-management":
        return renderCellManagementSection(cells);
      case "cell-mapping":
        return renderCellMappingSection(listCellCatalog(db));
      default:
        return "";
    }
  }

  function renderDevices(user, flash) {
    const controllers = listControllers(db);
    const cells = listCells(db);
    const mappedCells = cells.filter(cellIsMapped);
    const manualCells = cells.filter((cell) => !cellIsMapped(cell));
    const onlineControllers = controllers.filter(
      (controller) => String(controller.heartbeat_status || "").toLowerCase() === "online",
    ).length;
    const moduleTotal = controllers.reduce(
      (sum, controller) => sum + Number(controller.module_count || controller.mapped_cells || 0),
      0,
    );

    const controllerRows = controllers.map((controller) => [
      escapeHtml(controller.controller_code),
      `<code>${escapeHtml(controller.address || "")}</code>`,
      statusBadge(controller.heartbeat_status),
      escapeHtml(formatDate(controller.last_seen_at)),
      escapeHtml(formatQuantity(controller.module_count || controller.mapped_cells)),
      escapeHtml(formatQuantity(controller.mapped_cells)),
      `
        <div class="mini-actions">
          <form method="post" action="/devices/controller-test" data-controller-health-form>
            <input type="hidden" name="controller_id" value="${controller.id}" />
            <input type="hidden" name="return_to" value="/devices#controller-health" data-controller-health-return-to />
            <button
              type="submit"
              class="icon-button refresh-button"
              data-controller-health-submit
              aria-label="Refresh health ${escapeHtml(controller.controller_code)}"
              title="Refresh health ${escapeHtml(controller.controller_code)}"
            >${refreshIcon()}</button>
          </form>
          <form
            method="post"
            action="/devices/controller-ping"
            data-led-command-form
            data-led-loading-label="Pinging"
            data-led-loading-title="Pinging ${escapeHtml(controller.controller_code)} modules"
          >
            <input type="hidden" name="controller_id" value="${controller.id}" />
            <input type="hidden" name="return_to" value="/devices#controller-health" data-led-command-return-to />
            <button
              type="submit"
              class="green-button ping-button"
              data-led-command-submit
              data-led-loading-label="Pinging"
              data-led-loading-title="Pinging ${escapeHtml(controller.controller_code)} modules"
              title="Ping all LED modules on ${escapeHtml(controller.controller_code)}"
            >Ping</button>
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

    return page({
      title: "Configuration Console",
      user,
      flash,
      content: `
        <div class="app-console" data-config-workspace>
          <section class="operation-grid" aria-label="Configuration actions" data-config-overview>
            <a class="operation-tile" href="#controller-setup" data-config-section-link="controller-setup" aria-controls="controller-setup">
              <span>
                <strong>Add Controller</strong>
                Flash a new ESP32 through a guided setup.
              </span>
              <span class="operation-kbd">01</span>
            </a>
            <a class="operation-tile" href="#cell-management" data-config-section-link="cell-management" aria-controls="cell-management">
              <span>
                <strong>Manage Locations</strong>
                Add, rename, or remove active storage locations.
              </span>
              <span class="operation-kbd">02</span>
            </a>
            <a class="operation-tile" href="#cell-mapping" data-config-section-link="cell-mapping" aria-controls="cell-mapping">
              <span>
                <strong>Cell Mapping</strong>
                Ping modules and assign them to storage locations.
              </span>
              <span class="operation-kbd">03</span>
            </a>
          </section>

          <section id="configuration-status" class="app-panel" aria-labelledby="configuration-status-heading" data-config-overview>
            <div class="panel-heading">
              <div>
                <h2 id="configuration-status-heading">System Status</h2>
                <p class="muted">Controller health shows the latest saved check. Use refresh on a controller when you need a live RS485 check.</p>
              </div>
            </div>
            <div class="status-strip">
              <div class="status-metric">
                <span class="muted">Controllers Online</span>
                <strong>${escapeHtml(`${onlineControllers}/${controllers.length}`)}</strong>
              </div>
              <div class="status-metric">
                <span class="muted">LED Modules</span>
                <strong>${escapeHtml(formatQuantity(moduleTotal))}</strong>
              </div>
              <div class="status-metric">
                <span class="muted">Mapped Cells</span>
                <strong>${escapeHtml(formatQuantity(mappedCells.length))}</strong>
              </div>
              <div class="status-metric">
                <span class="muted">Manual Cells</span>
                <strong>${escapeHtml(formatQuantity(manualCells.length))}</strong>
              </div>
            </div>
          </section>

          <section id="controller-health" class="app-panel" data-config-overview>
            <div class="panel-heading">
              <div>
                <h2>Controller Health</h2>
                <p class="muted">Delete removes only the controller. Its cells stay active for manual pick and put until remapped.</p>
              </div>
            </div>
            ${table(
              ["Controller", "RS485 ID", "Health", "Last Seen", "LED Modules", "Cells", "Actions"],
              controllerRows,
            )}
          </section>

          <div class="configuration-section-host" data-config-section-host hidden>
            <div class="configuration-flow-loading">Select a configuration flow to continue.</div>
          </div>
        </div>
      `,
    });
  }

  return {
    renderCellDetail,
    renderCells,
    renderCellSearchResults,
    renderDeviceConfigSection,
    renderDevices,
  };
}
