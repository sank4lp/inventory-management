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
  function ledColorLabel(color) {
    return String(color || "").trim().toUpperCase() || "LED";
  }

  function taskActionLabel(taskType) {
    return taskType === "put" ? "Put into" : "Pick from";
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
    const detailText =
      detail ||
      (mapped
        ? `Follow the ${safeColor} light for this instruction.`
        : "No LED is mapped for this cell; follow the on-screen instruction.");

    return `
      <div class="led-instruction led-instruction-${escapeHtml(visualTone)}">
        <span class="led-chip led-chip-${escapeHtml(visualTone)}">${escapeHtml(colorLabel)}</span>
        <strong>${escapeHtml(action)} cell ${escapeHtml(cellCode)}</strong>
        ${quantityText ? `<span>${escapeHtml(quantityText)}</span>` : ""}
        <small>${escapeHtml(detailText)}</small>
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

  function renderPutPlanAdjuster(task, cells, actionToken) {
    const total = task.lines.reduce((sum, line) => sum + Number(line.planned_quantity), 0);
    const row = ({ key, cellId = null, quantity = "", removable = false }) => `
      <div class="put-plan-row" data-put-plan-row>
        <label>Cell
          ${cellPickerField(cells, cellId, `put-plan-${key}`, `plan_cell_${key}`, "put-plan-form")}
        </label>
        <label>Items
          <input
            form="put-plan-form"
            class="compact-input"
            type="number"
            step="0.01"
            min="0"
            name="plan_qty_${key}"
            value="${escapeHtml(quantity)}"
            data-put-plan-qty
          />
        </label>
        ${
          removable
            ? `<button type="button" class="ghost-button" data-put-plan-remove>Remove</button>`
            : `<span class="muted">Suggested</span>`
        }
      </div>
    `;

    return card(
      "Adjust Put Cells",
      `
        <p class="muted">Change the split before placing items. The task will show each adjusted cell as a RED LED put instruction after the total matches the original requested quantity.</p>
        <div
          data-put-plan-form
          data-expected-total="${escapeHtml(total)}"
        >
          <div class="put-plan-lines" data-put-plan-lines>
            ${task.lines
              .map((line) =>
                row({
                  key: line.id,
                  cellId: line.cell_id,
                  quantity: line.planned_quantity,
                }),
              )
              .join("")}
          </div>
          <template data-put-plan-template>
            ${row({ key: "new___INDEX__", quantity: 0, removable: true })}
          </template>
          <div class="mini-actions">
            <button type="button" class="ghost-button" data-put-plan-add>Adjust in more cells</button>
          </div>
          <form id="put-plan-form" method="post" action="/tasks/${task.id}/put-plan" class="stack-form" data-led-command-form data-led-loading-label="Updating">
            ${hiddenSubmissionToken(actionToken)}
            <label>Adjustment note<textarea name="note" rows="2" placeholder="Optional note"></textarea></label>
            <p class="muted" data-put-plan-total>Adjusted total: ${escapeHtml(formatQuantity(total))} / ${escapeHtml(formatQuantity(total))}</p>
            <button type="submit" class="blue-button" data-put-plan-submit data-led-command-submit data-led-loading-label="Updating">Update LED quantities</button>
          </form>
        </div>
      `,
    );
  }

  function renderTask(user, flash, task, mode = "view", actionTokens = {}) {
    if (!task) {
      return page({
        title: "Task not found",
        user,
        flash: flash || { message: "Task not found.", tone: "error" },
        content: `<p><a href="/">Back to dashboard</a></p>`,
      });
    }

    const guidanceSummary =
      "Follow each row as a direct instruction. The row tells you the action, the cell, the quantity, and the LED color to look for.";
    const firstLine = task.lines[0];
    const cells = task.type === "put" ? listCells(db) : [];
    const editMode = mode === "edit";
    const taskIsActive = task.status !== "completed" && task.status !== "cancelled";
    const editable = editMode && canEditTask(user, task) && task.status === "completed";
    const taskLabel = task.type === "pick" ? "Pick Task" : "Put Task";
    const actionLabel = task.type === "pick" ? "Finish Pick Action" : "Finish Put Action";
    const editSubmitPath = editMode && task.status === "completed" ? "correct" : "confirm";

    return page({
      title: `${editMode ? "Edit" : task.type === "pick" ? "Pick Action Initiated" : "Put Action Initiated"} - Task #${task.id}`,
      user,
      flash,
      content: `
        <section class="page-actions">
          ${
            canEditTask(user, task) && task.status === "completed"
              ? editMode
                ? `<a class="action-cta-button secondary-cta" href="/tasks/${task.id}">Back to task</a>`
                : `<a class="action-cta-button secondary-cta" href="/tasks/${task.id}?mode=edit">Edit</a>`
              : ""
          }
          ${
            taskIsActive && canEditTask(user, task)
              ? `
                <form method="post" action="/tasks/${task.id}/cancel" data-led-command-form data-led-loading-label="Cancelling">
                  ${hiddenSubmissionToken(actionTokens.cancel)}
                  <button class="ghost-button" type="submit" data-led-command-submit data-led-loading-label="Cancelling">Cancel Task</button>
                </form>
              `
              : ""
          }
        </section>
        <section class="guide-strip">
          <span class="guide-pill">${escapeHtml(taskLabel)}</span>
          <span class="guide-pill active-guide">Review cells</span>
        </section>
        ${card(
          editMode ? `Edit ${actionLabel}` : "Task",
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
            <p><strong>${escapeHtml(task.summary)}</strong></p>
            <p class="muted">${escapeHtml(guidanceSummary)}</p>
            `,
        )}
        ${
          task.type === "put" && taskIsActive && canEditTask(user, task)
            ? renderPutPlanAdjuster(task, cells, actionTokens.putPlan)
            : ""
        }
        ${card(
          editMode ? `Make Changes to ${actionLabel}` : actionLabel,
          `
            ${
              task.type === "put"
                ? `<p class="muted">You may change cell or quantity. If the final placement overfills a cell or mixes products, Home will flag it under Recommended actions.</p>`
                : ""
            }
            ${
              task.status === "cancelled"
                ? `<p class="flash flash-info">This task has been cancelled. Start a new ${escapeHtml(task.type)} task if you still need to move these items.</p>`
                : ""
            }
            ${table(
              task.type === "put"
                ? ["Instruction", "Final cell", "Planned", "Actual"]
                : ["Instruction", "Planned", "Actual"],
              task.lines.map((line) => [
                ...(task.type === "put"
                  ? [
                      renderTaskLineInstruction(task, line),
                      editable || taskIsActive
                        ? cellPickerField(cells, line.cell_id, `line-${line.id}`, `actual_cell_${line.id}`, "confirm-form")
                        : escapeHtml(line.logical_code),
                    ]
                  : [renderTaskLineInstruction(task, line)]),
                `${escapeHtml(formatQuantity(line.planned_quantity))} ${escapeHtml(line.unit_of_measure)}`,
                editable || taskIsActive
                  ? `<input form="confirm-form" class="compact-input" type="number" step="0.01" min="0" ${task.type === "pick" ? `max="${escapeHtml(line.planned_quantity)}"` : ""} name="actual_${line.id}" value="${escapeHtml(line.actual_quantity || line.planned_quantity)}" />`
                  : escapeHtml(formatQuantity(line.actual_quantity || line.planned_quantity)),
              ]),
            )}
            ${
              editable || taskIsActive
                ? `
                    <form id="confirm-form" method="post" action="/tasks/${task.id}/${editSubmitPath}" class="stack-form"${editMode ? "" : ` data-led-command-form data-led-loading-label="Finishing"`}>
                      ${hiddenSubmissionToken(editMode ? actionTokens.correct : actionTokens.confirm)}
                      <label>Note<textarea name="note" rows="3" placeholder="Optional note"></textarea></label>
                      <button type="submit"${editMode ? "" : ` data-led-command-submit data-led-loading-label="Finishing"`}>${editMode ? "Save Correction" : "Finish task"}</button>
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
      `,
    });
  }

  function renderRecommendedActions(user, flash, selectedKey = "") {
    const allActions = getRecommendedActions(db);
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
              </section>
            `
            : ""
        }
        ${actions.length
          ? actions
              .map((action) =>
                card(
                  action.title,
                  `
                    <p><strong>Products currently in ${escapeHtml(action.logicalCode)}:</strong> ${escapeHtml(action.description)}</p>
                    <p><strong>Recommended action:</strong> ${escapeHtml(action.actionSummary || `Move ${action.productSku} from ${action.logicalCode}.`)}</p>
                    ${
                      action.unresolvedQuantity > 0
                        ? `<p class="flash flash-error">The system could not find room for ${escapeHtml(formatQuantity(action.unresolvedQuantity))} item(s). Please review manually.</p>`
                        : ""
                    }
                    <form method="post" action="/recommended-actions/apply" class="stack-form" data-led-command-form data-led-loading-label="Working">
                      <input type="hidden" name="source_cell_id" value="${action.cellId}" />
                      <input type="hidden" name="product_id" value="${action.productId}" />
                      <input type="hidden" name="reason" value="${escapeHtml(action.title)}" />
                      <input type="hidden" name="recommendation_key" value="${escapeHtml(action.key)}" />
                      ${action.recommendedMoves
                        .map((move, index) => {
                          const sourceMapped = cellHasMappedLed(action.cellId);
                          const targetMapped = cellHasMappedLed(move.targetCellId);
                          return `
                            <div class="recommendation-row">
                              <div class="recommendation-summary">
                                <strong>${escapeHtml(action.productSku)}</strong>
                                <p class="muted">Move ${escapeHtml(formatQuantity(move.quantity))} item(s) from ${escapeHtml(action.logicalCode)} to the target cell below.</p>
                                <div class="recommended-led-plan">
                                  ${renderLedInstruction({
                                    action: "Pick from",
                                    cellCode: action.logicalCode,
                                    color: "green",
                                    quantity: move.quantity,
                                    mapped: sourceMapped,
                                    detail: sourceMapped ? "The source cell will show this GREEN LED instruction." : "",
                                  })}
                                  ${renderLedInstruction({
                                    action: "Put into",
                                    cellCode: move.targetLogicalCode || "selected target",
                                    color: "red",
                                    quantity: move.quantity,
                                    mapped: targetMapped,
                                    detail: targetMapped ? "The selected target cell will show this RED LED instruction." : "",
                                  })}
                                </div>
                              </div>
                              <div class="recommendation-fields">
                                <label>Move quantity
                                  <input type="number" min="0" step="0.01" name="move_qty_${index}" value="${escapeHtml(move.quantity)}" />
                                </label>
                                <label>Target cell
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
                                  Show PICK/PUT LEDs
                                </button>
                              </div>
                            </div>
                          `;
                        })
                        .join("")}
                      <button type="submit" data-led-command-submit data-led-loading-label="Applying">Apply recommendation</button>
                    </form>
                  `,
                ),
              )
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
