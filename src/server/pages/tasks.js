import {
  getRecommendedActions,
  listCells,
} from "../../services/inventory.js";
import {
  canEditTask,
  card,
  cellPickerField,
  escapeHtml,
  formatDate,
  formatQuantity,
  hiddenSubmissionToken,
  page,
  statusBadge,
  table,
} from "./shared.js";

export function createTaskPages({ db }) {
  function safeRecommendedReturnPath(value) {
    const text = String(value || "").trim();
    if (!text) {
      return "";
    }

    try {
      const url = new URL(text, "http://localhost");
      if (url.origin !== "http://localhost") {
        return "";
      }
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return "";
    }
  }

  function ledColorLabel(color) {
    return String(color || "").trim().toUpperCase() || "LED";
  }

  function taskActionLabel(taskType) {
    return taskType === "put" ? "Put Into" : "Pick From";
  }

  function operatorTaskSummary(task) {
    const firstLine = task.lines[0];
    if (!firstLine) {
      return task.summary;
    }

    const totalQuantity = task.lines.reduce((sum, line) => sum + Number(line.planned_quantity || 0), 0);
    const action = task.type === "put" ? "Put" : "Pick";
    return `${action} ${formatQuantity(totalQuantity)} ${firstLine.unit_of_measure} of ${firstLine.sku}`;
  }

  function completedLineQuantity(line) {
    return Number(line.actual_quantity ?? line.planned_quantity);
  }

  function renderCompletionDialog(task) {
    if (!["pick", "put"].includes(task.type) || task.status !== "completed") {
      return "";
    }

    const firstLine = task.lines[0];
    const totalQuantity = task.lines.reduce((sum, line) => sum + completedLineQuantity(line), 0);
    const movementLabel = task.type === "put" ? "Put" : "Pick";
    const completedAction = task.type === "put" ? "Placed" : "Picked";
    const cellAction = task.type === "put" ? "Placed in" : "Picked from";
    const completedSummary = firstLine
      ? `${completedAction} ${formatQuantity(totalQuantity)} ${firstLine.unit_of_measure} of ${firstLine.sku}`
      : task.summary;

    return `
      <section
        class="modal-backdrop app-alert-modal completion-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="completion-title"
        data-completion-redirect
        data-redirect-target="/"
        data-redirect-seconds="10"
      >
        <div class="modal-panel completion-panel">
          <header class="completion-header">
            <div>
              <span class="completion-kicker">${escapeHtml(movementLabel)} Task #${escapeHtml(task.id)}</span>
              <h2 id="completion-title">Complete</h2>
            </div>
            ${statusBadge(task.status)}
          </header>
          <div class="completion-redirect-status" aria-live="polite">
            <p data-completion-countdown>Redirecting to Overview in 10 seconds</p>
            <div class="completion-progress" aria-hidden="true">
              <span data-completion-progress></span>
            </div>
          </div>
          <section class="completion-summary" aria-label="Task Summary">
            <h3>Task Summary</h3>
            <div class="meta-grid compact-meta-grid">
              <div><strong>Task</strong><br />${escapeHtml(movementLabel)} #${escapeHtml(task.id)}</div>
              <div><strong>Product</strong><br />${escapeHtml(firstLine?.sku || "Item")}</div>
              <div><strong>Quantity</strong><br />${escapeHtml(formatQuantity(totalQuantity))} ${escapeHtml(firstLine?.unit_of_measure || "item(s)")}</div>
              <div><strong>Completed</strong><br />${escapeHtml(formatDate(task.completed_at))}</div>
            </div>
            <p><strong>${escapeHtml(completedSummary)}</strong></p>
            <ul class="completion-line-list">
              ${task.lines
                .map(
                  (line) => `
                    <li>
                      <span>${escapeHtml(cellAction)} ${escapeHtml(line.logical_code)}</span>
                      <strong>${escapeHtml(formatQuantity(completedLineQuantity(line)))} ${escapeHtml(line.unit_of_measure)}</strong>
                    </li>
                  `,
                )
                .join("")}
            </ul>
          </section>
          <a class="action-cta-button completion-overview-button" href="/" data-completion-overview>Go To Overview</a>
        </div>
      </section>
    `;
  }

  function renderLedInstruction({
    action,
    cellCode,
    color,
    quantity = "",
    unit = "",
    mapped = true,
    detail = "",
  }) {
    const safeColor = String(color || "manual").toLowerCase();
    const visualTone = mapped ? safeColor : "manual";
    const colorLabel = mapped ? `${ledColorLabel(safeColor)} LED` : "Manual";
    const quantityText = quantity ? `Quantity: ${formatQuantity(quantity)}${unit ? ` ${unit}` : ""}` : "";
    const detailText = detail || (mapped ? "" : "No LED is mapped for this cell.");

    return `
      <div class="led-instruction led-instruction-${escapeHtml(visualTone)}">
        <span class="led-chip led-chip-${escapeHtml(visualTone)}">${escapeHtml(colorLabel)}</span>
        <strong>${escapeHtml(action)} cell ${escapeHtml(cellCode)}</strong>
        ${quantityText ? `<span>${escapeHtml(quantityText)}</span>` : ""}
        ${detailText ? `<small>${escapeHtml(detailText)}</small>` : ""}
      </div>
    `;
  }

  function renderTaskLineInstruction(task, line) {
    const color = line.guidance_color || (task.type === "put" ? "red" : "green");
    return renderLedInstruction({
      action: taskActionLabel(task.type),
      cellCode: line.logical_code,
      color,
      quantity: line.planned_quantity,
      unit: line.unit_of_measure,
      mapped: Boolean(line.controller_id && line.hardware_channel),
    });
  }

  function groupRecommendedMoves(moves, { idField, codeField }) {
    const grouped = new Map();
    for (const move of moves) {
      const cellId = Number(move[idField]);
      const entry = grouped.get(cellId) || {
        cellId,
        logicalCode: move[codeField],
        quantity: 0,
      };
      entry.quantity += Number(move.quantity || 0);
      grouped.set(cellId, entry);
    }

    return Array.from(grouped.values()).filter((entry) => entry.quantity > 0);
  }

  function renderRecommendedActionIntro(action, cellHasMappedLed) {
    if (!action.optimizationPlan) {
      return `
        <p><strong>Products currently in ${escapeHtml(action.logicalCode)}:</strong> ${escapeHtml(action.description)}</p>
        <p><strong>Recommended Action:</strong> ${escapeHtml(action.actionSummary || `Move ${action.productSku} from ${action.logicalCode}.`)}</p>
      `;
    }

    const pickCells = groupRecommendedMoves(action.recommendedMoves, {
      idField: "sourceCellId",
      codeField: "sourceLogicalCode",
    });
    const putCells = groupRecommendedMoves(action.recommendedMoves, {
      idField: "targetCellId",
      codeField: "targetLogicalCode",
    });

    return `
      <p><strong>Current Layout:</strong> ${escapeHtml(action.description)}</p>
      <p><strong>Recommended Action:</strong> ${escapeHtml(action.actionSummary)}</p>
      <p class="muted">Target layout: ${escapeHtml(
        action.optimizationPlan.targets
          .map(
            (target) =>
              `${target.logicalCode}: ${formatQuantity(target.finalQuantity)} item(s)`,
          )
          .join(", "),
      )}</p>
      <div class="recommended-led-plan">
        ${putCells
          .map((cell) =>
            renderLedInstruction({
              action: "Put Into",
              cellCode: cell.logicalCode,
              color: "red",
              quantity: cell.quantity,
              mapped: cellHasMappedLed(cell.cellId),
              detail: cellHasMappedLed(cell.cellId)
                ? "This target cell will show the total RED put instruction."
                : "",
            }),
          )
          .join("")}
        ${pickCells
          .map((cell) =>
            renderLedInstruction({
              action: "Pick From",
              cellCode: cell.logicalCode,
              color: "green",
              quantity: cell.quantity,
              mapped: cellHasMappedLed(cell.cellId),
              detail: cellHasMappedLed(cell.cellId)
                ? "This source cell will show the total GREEN pick instruction."
                : "",
            }),
          )
          .join("")}
      </div>
    `;
  }

  function renderPutPlanRow(cells, { key, cellId = null, quantity = "", removable = false }) {
    return `
      <div class="put-plan-row" data-put-plan-row>
        <label>Cell
          ${cellPickerField(cells, cellId, `put-plan-${key}`, `plan_cell_${key}`, "put-plan-form")}
        </label>
        <label>Items
          <input
            form="put-plan-form"
            class="compact-input"
            type="number"
            step="1"
            min="0"
            inputmode="numeric"
            name="plan_qty_${key}"
            value="${escapeHtml(quantity)}"
            data-put-plan-qty
            data-quantity-change-input
          />
        </label>
        ${
          removable
            ? `<button type="button" class="ghost-button" data-put-plan-remove>Remove</button>`
            : `<button type="submit" form="put-plan-form" class="ghost-button" data-led-command-submit data-led-loading-label="Updating">Update Cell</button>`
        }
      </div>
    `;
  }

  function renderPutCellControl(line, cells) {
    return `
      <div
        class="put-task-cell-control"
        data-put-task-cell-control
        data-line-id="${escapeHtml(line.id)}"
        data-original-cell-id="${escapeHtml(line.cell_id)}"
        data-original-label="${escapeHtml(line.logical_code)}"
      >
        <span
          class="mapping-cell-name mapping-cell-name-saved"
          data-put-task-cell-name
          data-original-label="${escapeHtml(line.logical_code)}"
        >${escapeHtml(line.logical_code)}</span>
        ${cellPickerField(cells, line.cell_id, `put-line-${line.id}`, `plan_cell_${line.id}`, "put-plan-form")}
        <input
          type="hidden"
          form="confirm-form"
          name="actual_cell_${line.id}"
          value="${escapeHtml(line.cell_id)}"
          data-put-confirm-cell-for="${escapeHtml(line.id)}"
        />
      </div>
    `;
  }

  function renderTask(user, flash, task, mode = "view", actionTokens = {}, options = {}) {
    if (!task) {
      return page({
        title: "Task Not Found",
        user,
        flash: flash || { message: "Task not found.", tone: "error" },
        content: `<p><a href="/">Back To Dashboard</a></p>`,
      });
    }

    const firstLine = task.lines[0];
    const cells = ["pick", "put"].includes(task.type) ? listCells(db) : [];
    const editMode = mode === "edit";
    const taskIsActive = task.status !== "completed" && task.status !== "cancelled";
    const editable = editMode && canEditTask(user, task) && task.status === "completed";
    const plannedTotal = task.lines.reduce((sum, line) => sum + Number(line.planned_quantity), 0);
    const taskLabel = task.type === "pick" ? "Pick Task" : "Put Task";
    const movementLabel = task.type === "pick" ? "Pick" : "Put";
    const actionLabel = task.type === "pick" ? "Complete Pick" : "Complete Put";
    const taskTitle = `${editMode ? "Correct" : task.type === "pick" ? "Pick" : "Put"} Task #${task.id}`;
    const editSubmitPath = editMode && task.status === "completed" ? "correct" : "confirm";
    const canAdjustPutPlan = task.type === "put" && taskIsActive && canEditTask(user, task);
    const reviewHeaders = task.type === "put"
      ? [
          "Instruction",
          "Final Cell",
          "Suggested",
          "Actual",
          ...(canAdjustPutPlan ? ["Update"] : []),
        ]
      : [
          "Instruction",
          ...(editable || taskIsActive ? ["Final Cell"] : []),
          "Suggested",
          "Actual",
        ];
    const reviewRows = task.lines.map((line) => [
      ...(task.type === "put"
        ? [
            renderTaskLineInstruction(task, line),
            editable
              ? cellPickerField(cells, line.cell_id, `line-${line.id}`, `actual_cell_${line.id}`, "confirm-form")
              : taskIsActive
              ? renderPutCellControl(line, cells)
              : escapeHtml(line.logical_code),
          ]
        : [
            renderTaskLineInstruction(task, line),
            ...(editable || taskIsActive
              ? [cellPickerField(cells, line.cell_id, `line-${line.id}`, `actual_cell_${line.id}`, "confirm-form")]
              : []),
          ]),
      `${escapeHtml(formatQuantity(line.planned_quantity))} ${escapeHtml(line.unit_of_measure)}
        ${
          canAdjustPutPlan
            ? `<input
                type="hidden"
                form="put-plan-form"
                name="plan_qty_${line.id}"
                value="${escapeHtml(line.planned_quantity)}"
                data-put-plan-qty
                data-put-plan-qty-for="${escapeHtml(line.id)}"
                data-quantity-change-input
              />`
            : ""
        }`,
      editable || taskIsActive
        ? `<input
            form="confirm-form"
            class="compact-input"
            type="number"
            step="1"
            min="0"
            inputmode="numeric"
            name="actual_${line.id}"
            value="${escapeHtml(line.actual_quantity || line.planned_quantity)}"
            data-quantity-change-input
            ${canAdjustPutPlan ? `data-put-actual-qty-for="${escapeHtml(line.id)}"` : ""}
          />`
        : escapeHtml(formatQuantity(line.actual_quantity || line.planned_quantity)),
      ...(canAdjustPutPlan
        ? [
            `<button
              type="submit"
              form="put-plan-form"
              class="ghost-button"
              data-led-command-submit
              data-led-loading-label="Updating"
            >Update Cell</button>`,
          ]
        : []),
    ]);
    const reviewTable = table(reviewHeaders, reviewRows);
    const showCompletionDialog = Boolean(
      options.showCompletionDialog &&
        mode !== "edit" &&
        task.status === "completed" &&
        ["pick", "put"].includes(task.type),
    );

    return page({
      title: taskTitle,
      user,
      flash,
      content: `
        <section class="page-actions">
          ${
            canEditTask(user, task) && task.status === "completed"
              ? editMode
                ? `<a class="action-cta-button secondary-cta" href="/tasks/${task.id}">Back To Task</a>`
                : `<a class="action-cta-button secondary-cta" href="/tasks/${task.id}?mode=edit">Correct Task</a>`
              : ""
          }
          ${
            taskIsActive && canEditTask(user, task)
              ? `
                <form
                  method="post"
                  action="/tasks/${task.id}/cancel"
                  data-led-command-form
                  data-led-loading-label="Cancelling"
                  onsubmit="return confirm('Cancel this task? Inventory has not been changed yet, but the LED guidance will stop.');"
                >
                  ${hiddenSubmissionToken(actionTokens.cancel)}
                  <button class="ghost-button danger-button" type="submit" data-led-command-submit data-led-loading-label="Cancelling">Cancel Task</button>
                </form>
              `
              : ""
          }
        </section>
        <section class="guide-strip">
          <span class="guide-pill">${escapeHtml(taskLabel)}</span>
          <span class="guide-pill active-guide">Review Cells</span>
        </section>
        ${card(
          editMode ? `Correct ${movementLabel} Result` : "Task Summary",
          `
            <div class="meta-grid compact-meta-grid">
              <div><strong>Status</strong><br />${statusBadge(task.status)}</div>
              <div><strong>Started</strong><br />${escapeHtml(formatDate(task.started_at))}</div>
            </div>
            ${
              firstLine
                ? `<p><strong>${escapeHtml(firstLine.product_name)}</strong> · ${escapeHtml(firstLine.sku)}</p>`
                : ""
            }
            <p><strong>${escapeHtml(operatorTaskSummary(task))}</strong></p>
            `,
        )}
        ${card(
          editMode ? "Save Corrected Result" : actionLabel,
          `
            ${
              task.status === "cancelled"
                ? `<p class="flash flash-info">This task has been cancelled. Start a new ${escapeHtml(task.type)} task if you still need to move these items.</p>`
                : ""
            }
            ${
              canAdjustPutPlan
                ? `
                  <div data-put-plan-form data-expected-total="${escapeHtml(plannedTotal)}">
                    ${reviewTable}
                    <div class="put-plan-lines" data-put-plan-lines></div>
                    <template data-put-plan-template>
                      ${renderPutPlanRow(cells, { key: "new___INDEX__", quantity: 0, removable: true })}
                    </template>
                    <div class="mini-actions put-plan-actions">
                      <button type="button" class="ghost-button" data-put-plan-add>Add Another Cell</button>
                      <span class="muted" data-put-plan-total>Adjusted Total: ${escapeHtml(formatQuantity(plannedTotal))}</span>
                    </div>
                    <form
                      id="put-plan-form"
                      method="post"
                      action="/tasks/${task.id}/put-plan"
                      class="stack-form hidden-form-shell"
                      data-led-command-form
                      data-led-loading-label="Updating"
                      data-quantity-change-form
                      data-original-total="${escapeHtml(plannedTotal)}"
                    >
                      ${hiddenSubmissionToken(actionTokens.putPlan)}
                    </form>
                  </div>
                `
                : reviewTable
            }
            ${
              editable || taskIsActive
                ? `
                    <form
                      id="confirm-form"
                      method="post"
                      action="/tasks/${task.id}/${editSubmitPath}"
                      class="stack-form"${editMode ? "" : ` data-led-command-form data-led-loading-label="Finishing"`}
                      ${taskIsActive ? `data-quantity-change-form data-original-total="${escapeHtml(plannedTotal)}"` : ""}
                    >
                      ${hiddenSubmissionToken(editMode ? actionTokens.correct : actionTokens.confirm)}
                      <label>Note<textarea name="note" rows="3" placeholder="Optional note"></textarea></label>
                      <button type="submit"${editMode ? "" : ` data-led-command-submit data-led-loading-label="Finishing"`}>${editMode ? "Save Correction" : actionLabel}</button>
                    </form>
                  `
                : `<p class="muted">${
                    task.status === "cancelled"
                      ? "Cancelled tasks cannot be completed or edited. Start a new task instead."
                      : "Only the task owner or an admin can edit this task."
                  }</p>`
            }
          `,
        )}
        ${showCompletionDialog ? renderCompletionDialog(task) : ""}
      `,
    });
  }

  function renderRecommendedActions(user, flash, selectedKey = "", options = {}) {
    const allActions = getRecommendedActions(db);
    const returnTo = safeRecommendedReturnPath(options.returnTo);
    const openedFromCapacityUpdate = options.source === "capacity" && Boolean(selectedKey);
    const fullOptimizationLedReady = options.ledReady === true;
    const activeLedMoveIndex = String(options.ledMoveIndex || "").trim();
    const returnToInput = returnTo
      ? `<input type="hidden" name="return_to" value="${escapeHtml(returnTo)}" />`
      : "";
    const recommendationSourceInput = openedFromCapacityUpdate
      ? `<input type="hidden" name="recommendation_source" value="capacity" />`
      : "";
    if (!selectedKey) {
      return page({
        title: "Recommended Actions",
        user,
        flash,
        content: `
          ${card(
            "Recommended Cleanup",
            allActions.length
              ? table(
                  ["Issue", "Location", "Product", "Suggested Next Step", "Action"],
                  allActions.map((action) => [
                    `<strong>${escapeHtml(action.title)}</strong>`,
                    escapeHtml(action.logicalCode),
                    escapeHtml(action.productSku),
                    escapeHtml(action.actionSummary || `Move ${action.productSku} from ${action.logicalCode}.`),
                    `<a class="mini-link" href="/recommended-actions?key=${encodeURIComponent(action.key)}">Review</a>`,
                  ]),
                )
              : `<p class="muted">No recommended actions right now.</p>`,
            "",
            `data-row-collapser data-row-limit="8" data-row-label="recommendations"`,
          )}
        `,
      });
    }

    const actions = selectedKey
      ? allActions.filter((action) => action.key === selectedKey)
      : allActions;
    const cells = listCells(db);
    const cellById = new Map(cells.map((cell) => [Number(cell.id), cell]));
    const cellHasMappedLed = (cellId) => {
      const cell = cellById.get(Number(cellId));
      return Boolean(cell?.controller_id && cell?.hardware_channel);
    };

    return page({
      title: selectedKey ? "Recommended Action" : "Recommended Actions",
      user,
      flash,
      content: `
        ${
          selectedKey
            ? `
              <section class="page-actions page-actions-left">
                <a class="action-cta-button secondary-cta" href="/recommended-actions">All Recommendations</a>
                ${returnTo ? `<a class="action-cta-button secondary-cta" href="${escapeHtml(returnTo)}">Skip For Now</a>` : ""}
              </section>
            `
            : ""
        }
        ${
          openedFromCapacityUpdate
            ? `<p class="flash flash-warning">The capacity update created this recommended action. Apply it now to update inventory, or skip it for later.</p>`
            : ""
        }
        ${actions.length
          ? actions
              .map((action) => {
                const activeMoveIndex =
                  action.optimizationPlan && fullOptimizationLedReady ? "all" : activeLedMoveIndex;
                const ledClearAttrs = activeMoveIndex
                  ? ` data-recommendation-led-clear-form data-recommendation-led-clear-endpoint="/recommended-actions/clear-leds"`
                  : "";
                const activeMoveInput = activeMoveIndex
                  ? `<input type="hidden" name="active_light_move_index" value="${escapeHtml(activeMoveIndex)}" />`
                  : "";
                return card(
                  action.title,
                  `
                    ${action.optimizationPlan && fullOptimizationLedReady ? `<p class="flash flash-success">Full optimization LEDs are active. Review the move plan, then apply the recommendation.</p>` : ""}
                    ${renderRecommendedActionIntro(action, cellHasMappedLed)}
                    ${
                      action.unresolvedQuantity > 0
                        ? `<p class="flash flash-error">The system could not find room for ${escapeHtml(formatQuantity(action.unresolvedQuantity))} item(s). Please review manually.</p>`
                        : ""
                    }
                    <form method="post" action="/recommended-actions/apply" class="stack-form" data-led-command-form data-led-loading-label="Working"${ledClearAttrs}>
                      <input type="hidden" name="source_cell_id" value="${action.cellId}" />
                      <input type="hidden" name="product_id" value="${action.productId}" />
                      <input type="hidden" name="reason" value="${escapeHtml(action.title)}" />
                      <input type="hidden" name="recommendation_key" value="${escapeHtml(action.key)}" />
                      ${action.optimizationPlan && fullOptimizationLedReady ? `<input type="hidden" name="led_ready" value="1" />` : ""}
                      ${activeMoveInput}
                      ${returnToInput}
                      ${recommendationSourceInput}
                      ${action.recommendedMoves
                        .map((move, index) => {
                          const sourceCellId = Number(move.sourceCellId || action.cellId);
                          const sourceLogicalCode = move.sourceLogicalCode || action.logicalCode;
                          const sourceMapped = cellHasMappedLed(sourceCellId);
                          const targetMapped = cellHasMappedLed(move.targetCellId);
                          return `
                            <div class="recommendation-row ${action.optimizationPlan ? "recommendation-row-compact" : ""}">
                              <div class="recommendation-summary">
                                <strong>${escapeHtml(action.productSku)}</strong>
                                <p class="muted">Move ${escapeHtml(formatQuantity(move.quantity))} item(s) from ${escapeHtml(sourceLogicalCode)} to the target cell below.</p>
                                ${
                                  action.optimizationPlan
                                    ? ""
                                    : `
                                      <div class="recommended-led-plan">
                                        ${renderLedInstruction({
                                          action: "Pick From",
                                          cellCode: sourceLogicalCode,
                                          color: "green",
                                          quantity: move.quantity,
                                          mapped: sourceMapped,
                                          detail: sourceMapped ? "The source cell will show this GREEN LED instruction." : "",
                                        })}
                                        ${renderLedInstruction({
                                          action: "Put Into",
                                          cellCode: move.targetLogicalCode || "selected target",
                                          color: "red",
                                          quantity: move.quantity,
                                          mapped: targetMapped,
                                          detail: targetMapped ? "The selected target cell will show this RED LED instruction." : "",
                                        })}
                                      </div>
                                    `
                                }
                              </div>
                              <div class="recommendation-fields">
                                <input type="hidden" name="move_source_${index}" value="${escapeHtml(sourceCellId)}" />
                                <label>Move Quantity
                                  <input type="number" min="0" step="0.01" name="move_qty_${index}" value="${escapeHtml(move.quantity)}" />
                                </label>
                                <label>Target Cell
                                  ${cellPickerField(
                                    cells,
                                    move.targetCellId,
                                    `recommendation-${action.key}-${index}`,
                                    `move_cell_${index}`,
                                  )}
                                </label>
                                <button
                                  type="submit"
                                  class="ghost-button led-action-button"
                                  formaction="/recommended-actions/light-cell"
                                  name="light_move_index"
                                  value="${index}"
                                  data-led-command-submit
                                  data-led-loading-label="Sending LEDs"
                                >
                                  Show Pick/Put LEDs
                                </button>
                              </div>
                            </div>
                          `;
                        })
                        .join("")}
                      ${
                        action.optimizationPlan
                          ? `
                            <button
                              type="submit"
                              class="ghost-button led-action-button"
                              formaction="/recommended-actions/light-cell"
                              name="light_move_index"
                              value="all"
                              data-led-command-submit
                              data-led-loading-label="Sending LEDs"
                            >Show Full Optimization LEDs</button>
                          `
                          : ""
                      }
                      <button
                        type="submit"
                        data-led-command-submit
                        data-led-loading-label="Applying"
                        ${action.optimizationPlan && !fullOptimizationLedReady ? `disabled title="Show full optimization LEDs before applying this recommendation."` : ""}
                      >Apply Recommendation</button>
                    </form>
                  `,
                );
              })
              .join("")
          : card(
              selectedKey ? "Recommended Action" : "Recommended Actions",
              `<p class="muted">${
                selectedKey
                  ? "That recommendation no longer needs action."
                  : "No recommended actions right now."
              }</p>`,
            )}
      `,
    });
  }

  return {
    canEditTask,
    renderRecommendedActions,
    renderTask,
  };
}
