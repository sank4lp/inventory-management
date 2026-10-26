import {templatePage,uiConfirmation,uiFacts,uiTable,uiPanel,uiDisclosure} from "../ui.js";
import {can} from "../../modules/access/catalog.js";
import { randomUUID } from "node:crypto";
import { describeLocation } from "../../modules/operations/location-contract.js";
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

function renderLocationPingButton(cell) {
  const mapped = cellIsMapped(cell);
  return `
    <button
      type="button"
      class="green-button ping-button"
      data-ping-cell
      data-cell-id="${cell.id}"
      data-led-loading-label="Pinging"
      data-led-loading-title="Pinging ${escapeHtml(cell.logical_code)}"
      ${mapped ? `title="Ping ${escapeHtml(cell.logical_code)} LED module"` : `disabled aria-disabled="true" title="Manual location has no LED mapped"`}
    >Ping</button>
  `;
}

function renderLocationCountButton(cell) {
  const mapped = cellIsMapped(cell);
  return `
    <button
      type="button"
      class="ghost-button count-button"
      data-show-location-count
      data-cell-id="${cell.id}"
      data-activate-endpoint="/api/cells/${cell.id}/count"
      data-clear-endpoint="/api/cells/${cell.id}/count/clear"
      data-show-label="Show Count"
      data-active-label="Showing Count"
      data-led-loading-label="Showing"
      data-led-loading-title="Showing stock count for ${escapeHtml(cell.logical_code)} in yellow"
      aria-pressed="false"
      ${mapped ? `title="Show stock count for ${escapeHtml(cell.logical_code)} on its LED module"` : `disabled aria-disabled="true" title="Manual location has no LED mapped"`}
    >Show Count</button>
  `;
}

function renderLocationUtilityActions(cell) {
  return `
    ${renderLocationPingButton(cell)}
    ${renderLocationLocateButton(cell)}
    ${renderLocationCountButton(cell)}
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
              ${renderLocationUtilityActions(cell)}
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
            ${renderLocationUtilityActions(cell)}
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
            <p>${escapeHtml(describeLocation(db,cell.id).directions)}</p>
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
        ${can(user,'locations.manage')?card('Location directions',`<form method="post" action="/cells/${cell.id}/directions" class="stack-form">
          <input type="hidden" name="requestId" value="${randomUUID()}"><input type="hidden" name="descriptionRevision" value="${describeLocation(db,cell.id).descriptionRevision}">
          <label>Location name<input name="displayName" maxlength="160" value="${escapeHtml(cell.display_name||'')}"></label>
          <label>Shed / shelf details<input name="travelInstructions" maxlength="1000" value="${escapeHtml(cell.travel_instructions||'')}" placeholder="For example: Enter the packing area, second shelf on the left"></label>
          <p>The cell code, QR and stock history stay unchanged. </p><button>Save directions</button></form>`):''}
      `,
    });
  }

  function renderControllerSetupSection(controllers, controllerId = null) {
    const runtime = getRuntimeContext();
    const firmwareOptions = runtime.firmwareService?.getFlashOptions();
    const editing = controllerId != null;
    const selected = editing ? controllers.find(c => c.id === Number(controllerId)) : null;
    if (editing && !selected) throw new Error('Controller is no longer available. Return to Hardware and refresh.');
    if (!firmwareOptions) return `<section id="controller-setup" class="app-panel" data-config-section="controller-setup"><p class="muted">Firmware flashing is not available in this runtime.</p></section>`;
    const saved = firmwareOptions.controllerFlashRecords?.find(c => c.controllerId === selected?.id);
    const fqbn = firmwareOptions.defaultFqbn || 'esp32:esp32:esp32';
    const name = selected?.controller_code || '';
    const count = saved?.physicalModuleCount ?? selected?.module_count ?? '';
    const ready = saved?.replacementReady === true;
    const steps = [['Disconnect','Unplug the ESP32'],['Attach','Connect by USB'],['Configure','Check the details'],['Flash','Upload and verify']];
    return `<section id="controller-setup" class="app-panel controller-wizard" data-config-section="controller-setup">
      <div class="firmware-panel" data-firmware-panel data-firmware-mode="${editing?'edit':'add'}">
        <form class="firmware-wizard" data-firmware-flash-form data-firmware-wizard data-current-step="0">
          <div class="firmware-navigation-slot"><nav class="firmware-navigation" aria-label="Controller setup navigation">
            <button type="button" class="ghost-button firmware-nav-button" data-firmware-back>← Back</button>
            <div class="firmware-navigation-forward">
              <button type="button" class="green-button firmware-nav-button" data-firmware-forward>Next →</button>
              <button type="submit" class="green-button firmware-nav-button" data-firmware-submit hidden disabled>${editing?'Update firmware':'Flash controller'}</button>
            </div>
          </nav></div>
          <header class="firmware-wizard-head"><h2>${editing?`Edit ${escapeHtml(name)}`:'Add a new controller'}</h2><p class="muted">${editing?'Update this ESP32 or connect a replacement. Your cells and LED mappings stay with this controller.':'Connect an ESP32 and choose how many LED modules it controls.'}</p></header>
          ${firmwareOptions.arduinoCli.available?'':'<p class="firmware-port-status firmware-port-status-missing" role="alert">The firmware tools are not installed on this host.</p>'}
          <ol class="wizard-steps" aria-label="Controller setup progress">${steps.map(([title,subtitle],i)=>`<li class="wizard-step-indicator ${i===0?'wizard-step-indicator-active':'wizard-step-indicator-upcoming'}" data-firmware-step-indicator="${i}" ${i===0?'aria-current="step"':''}><span class="wizard-step-node" aria-hidden="true"><span class="wizard-step-number">${i+1}</span>${wizardCheckIcon()}</span><span class="wizard-step-copy"><strong>${title}</strong><span>${subtitle}</span></span></li>`).join('')}</ol>
          <input type="hidden" name="replacement_controller_id" value="${selected?.id||''}" data-firmware-replacement data-name="${escapeHtml(name)}" data-count="${count}" data-ready="${ready?'1':'0'}">
          <input type="hidden" name="fqbn" value="${escapeHtml(fqbn)}">
          <section class="firmware-step" data-firmware-step="0">
            <h3>Disconnect the ESP32</h3><p>Unplug its USB cable from the Raspberry Pi, then choose Next.</p>
            <p class="muted">Switch off external power before changing wires. Keep the ESP32 isolated from external power and LED/RS485 connections during flashing.</p>
          </section>
          <section class="firmware-step" data-firmware-step="1" hidden>
            <h3>Connect the ESP32 via USB</h3><p>Connect ${editing?'this controller or its replacement':'the new controller'} to the Raspberry Pi using a USB data cable, then choose Next.</p>
            <p class="firmware-port-status" role="status" data-firmware-detect-status hidden></p>
          </section>
          <section class="firmware-step" data-firmware-step="2" hidden>
            <div class="firmware-grid">
              <label>Controller name<input name="controller_name" placeholder="e.g. Shelf A" ${editing?`value="${escapeHtml(name)}" readonly`:''} required maxlength="80"></label>
              <label>LED modules<input type="number" name="module_count" min="${editing?0:firmwareOptions.moduleCount.min}" max="${firmwareOptions.moduleCount.max}" step="1" placeholder="4" ${editing?`value="${count}" readonly`:''} required></label>
              <label>Serial port<input name="port" list="firmware-ports" placeholder="Select the connected ESP32" data-firmware-port-input required><input type="hidden" name="device_identity" value="" data-firmware-device-identity></label>
            </div>
            <datalist id="firmware-ports"></datalist>
            <section class="firmware-added-device" aria-label="Added serial device"><h3>Added serial device</h3><p class="firmware-port-status" role="status" data-firmware-port-status>Select the ESP32 detected in the previous step.</p><div class="firmware-port-list" data-firmware-port-list></div></section>
            <details class="firmware-other-devices" data-firmware-other-devices><summary>Other serial devices / Manual refresh</summary><button type="button" class="ghost-button" data-firmware-refresh-ports>Refresh devices</button><div class="firmware-other-device-list" data-firmware-other-device-list></div></details>
          </section>
          <section class="firmware-step" data-firmware-step="3" hidden>
            <h3>${editing?'Ready to update':'Ready to add your controller'}</h3>
            <dl class="firmware-review"><div><dt>Controller</dt><dd data-firmware-review-name></dd></div><div><dt>LED modules</dt><dd data-firmware-review-count></dd></div><div><dt>Serial port</dt><dd data-firmware-review-port></dd></div></dl>
            <p>${editing?'The saved LED setup will be restored and checked. Existing locations and inventory stay unchanged.':'The application will upload the firmware and save the controller setup.'}</p>
            ${editing?`<div data-firmware-replacement-help><details class="firmware-backup-help" ${ready?'':'open'}><summary>${ready?'Save a setup backup':'Setup backup needed'}</summary><p>With the original ESP32 connected, save its LED setup before updating or replacing it.</p><button type="button" class="ghost-button" data-firmware-controller-backup>Save connected controller’s setup</button><p role="status" data-firmware-backup-status></p></details><label class="firmware-confirmation"><input type="checkbox" name="replacement_confirmed" value="1" required>The ESP32 is isolated for USB maintenance and the LED chain is unchanged.</label></div>`:''}
            <p class="muted">Keep USB connected until verification finishes.</p>
            <div class="firmware-progress" data-firmware-progress hidden><div class="firmware-progress-head"><strong data-firmware-stage>Queued</strong><span data-firmware-percent>0%</span></div><progress data-firmware-progress-bar value="0" max="100"></progress><p class="firmware-hint" role="status" data-firmware-hint hidden></p><details class="firmware-diagnostics"><summary>Upload details</summary><pre class="firmware-log" data-firmware-log></pre></details></div>
          </section>
          <p class="firmware-flow-status" role="status" data-firmware-flow-status hidden></p>
        </form>
      </div>
    </section>`;
  }

  function renderCellManagementSection(cells) {
    return `<section id="cell-management" class="app-panel" data-config-section="cell-management"><h2>Manage Locations</h2><a class="green-button" href="/locations/manage">Manage names, QR codes and LED modules</a></section>`;
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
                    type="button"
                    data-ping-cell
                    data-cell-id="${cell.id}"
                    class="green-button ping-button"
                    data-led-command-submit
                    data-led-loading-label="Pinging"
                    data-led-loading-title="Pinging ${escapeHtml(cell.controller_code || "controller")} LED module ${escapeHtml(cell.hardware_channel)}"
                    title="Ping ${escapeHtml(cell.controller_code || "controller")} LED module ${escapeHtml(cell.hardware_channel)}"
                  >Ping</button>
                  ${renderLocationCountButton(cell)}
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

  function renderDeviceConfigSection(sectionKey, {controllerId=null} = {}) {
    const controllers = listControllers(db);
    const cells = listCells(db);

    switch (sectionKey) {
      case "controller-setup":
        return renderControllerSetupSection(controllers,controllerId);
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
    if(!can(user,'hardware.flash')&&!can(user,'hardware.map')&&!can(user,'locations.manage')&&!can(user,'hardware.test')&&!can(user,'hardware.controllers'))return templatePage({title:'Hardware configuration and health',user,flash,content:`<div class="ui-settings-page"><nav class="ui-toolbar"><a href="/settings">← Settings</a></nav>${uiPanel('Controller Health',uiTable([{key:'controller',label:'Controller'},{key:'address',label:'RS485 address'},{key:'health',label:'Health'},{key:'date',label:'Last seen'},{key:'outputs',label:'Outputs'}],listControllers(db).map(c=>[escapeHtml(c.controller_code),escapeHtml(c.address),statusBadge(c.heartbeat_status),escapeHtml(formatDate(c.last_seen_at)),c.module_count]),{label:'Controller Health'}))}${uiDisclosure('Location mappings',uiTable([{key:'location',label:'Location'},{key:'controller',label:'Controller'},{key:'output',label:'Output'},{key:'mapping',label:'Mapping'}],listCells(db).map(c=>[escapeHtml(c.display_name||c.logical_code),escapeHtml(c.controller_code||c.controller_id||'Manual'),escapeHtml(c.hardware_channel||'—'),escapeHtml(c.mapping_status)]),{label:'Location mappings'}))}<details class="ui-help"><summary>About controller status</summary><p>Health reflects the last received status. Viewing configuration does not test lights, change mappings or flash firmware.</p></details></div>`});
    const controllers = listControllers(db);
    const cells = listCells(db);
    const mappedCells = cells.filter(cellIsMapped);
    const manualCells = cells.filter((cell) => !cellIsMapped(cell));
    const onlineControllers = controllers.filter(
      (controller) => String(controller.heartbeat_status || "").toLowerCase() === "online",
    ).length;
    const moduleTotal = controllers.reduce(
      (sum, controller) => sum + Number(controller.module_count || 0),
      0,
    );

    const controllerRows = controllers.map((controller) => [
      escapeHtml(controller.controller_code),
      `<code>${escapeHtml(controller.address || "")}</code>`,
      statusBadge(controller.heartbeat_status),
      escapeHtml(formatDate(controller.last_seen_at)),
      controller.module_count ? escapeHtml(formatQuantity(controller.module_count)) : '<span class="muted">Light count not configured</span>',
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
              data-ping-controller
              data-controller-id="${controller.id}"
              data-led-loading-label="Pinging"
              data-led-loading-title="Pinging ${escapeHtml(controller.controller_code)} modules"
              title="Ping all LED modules on ${escapeHtml(controller.controller_code)}"
            >Ping</button>
          </form>
          ${can(user,'hardware.map')&&can(user,'locations.manage')?`<a class="ghost-button" href="/locations/manage?view=leds&controller=${controller.id}">Map locations</a>`:''}
          ${can(user,'hardware.flash')?`<a class="ghost-button controller-edit-button" href="#controller-edit-${controller.id}" data-controller-edit="${controller.id}" aria-label="Edit ${escapeHtml(controller.controller_code)}">Edit</a>`:''}
          <form
            method="post"
            action="/devices/controller-delete"
            ${uiConfirmation({title:'Delete controller',label:'Delete controller',danger:true,message:'Its cells stay available for manual Pick/Put until remapped.',facts:[['Controller',controller.controller_code],['RS485 address',String(controller.address||'—')],['LED modules',String(controller.module_count||0)]]})}
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

    return templatePage({
      title: "Hardware",
      user,
      flash,
      content: `
        <div class="app-console ui-settings-page ui-hardware" data-config-workspace><nav class="ui-toolbar"><a href="/settings">← Settings</a><a href="/location-setup">Location setup</a></nav>
          <section class="ui-settings-links" aria-label="Configuration actions" data-config-overview>
            <a class="ui-button ui-button-secondary" href="#controller-setup" data-config-section-link="controller-setup" aria-controls="controller-setup">
              <span>
                <strong>Add Controller</strong>

              </span>

            </a>
            <a class="ui-button ui-button-secondary" href="/locations/manage">
              <span>
                <strong>Manage Locations</strong>

              </span>

            </a>

          </section>

          <section id="configuration-status" class="app-panel" aria-labelledby="configuration-status-heading" data-config-overview>
            <div class="panel-heading">
              <div>
                <h2 id="configuration-status-heading">Hardware status</h2>
                <details class="ui-help"><summary>About controller status</summary><p>Health shows the latest saved check. Use Refresh for a live RS485 check. Configured output counts come from controller setup; mapped locations do not establish the physical light count.</p></details>
              </div>
            </div>
            ${uiFacts([['Controllers Online',escapeHtml(`${onlineControllers}/${controllers.length}`)],['Configured LED outputs',escapeHtml(formatQuantity(moduleTotal))],['Mapped Cells',escapeHtml(formatQuantity(mappedCells.length))],['Manual Cells',escapeHtml(formatQuantity(manualCells.length))]])}
          </section>

          <section id="controller-health" class="app-panel" data-config-overview>
            <div class="panel-heading">
              <div>
                <h2>Controller Health</h2>
                <details class="ui-help"><summary>About removing a controller</summary><p>Delete removes only the controller. Its cells stay active for manual pick and put until remapped.</p></details>
              </div>
            </div>
            ${uiTable([{key:'controller',label:'Controller'},{key:'address',label:'RS485 ID'},{key:'health',label:'Health'},{key:'date',label:'Last Seen'},{key:'outputs',label:'Configured outputs'},{key:'mapped',label:'Mapped locations'},{key:'action',label:'Actions'}],controllerRows,{label:'Controller Health'})}
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
