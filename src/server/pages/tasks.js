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
      task.type === "pick"
        ? "Pick from the green cells below."
        : "Place into the blue cells below.";
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
                <form method="post" action="/tasks/${task.id}/cancel">
                  ${hiddenSubmissionToken(actionTokens.cancel)}
                  <button class="ghost-button" type="submit">Cancel Task</button>
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
                ? ["Suggested cell", "Final cell", "Planned", "Actual", "Reached cell", "Signal"]
                : ["Cell", "Planned", "Actual", "Reached cell", "Signal"],
              task.lines.map((line) => [
                ...(task.type === "put"
                  ? [
                      escapeHtml(line.logical_code),
                      editable || taskIsActive
                        ? cellPickerField(cells, line.cell_id, `line-${line.id}`, `actual_cell_${line.id}`, "confirm-form")
                        : escapeHtml(line.logical_code),
                    ]
                  : [escapeHtml(line.logical_code)]),
                `${escapeHtml(formatQuantity(line.planned_quantity))} ${escapeHtml(line.unit_of_measure)}`,
                editable || taskIsActive
                  ? `<input form="confirm-form" class="compact-input" type="number" step="0.01" min="0" ${task.type === "pick" ? `max="${escapeHtml(line.planned_quantity)}"` : ""} name="actual_${line.id}" value="${escapeHtml(line.actual_quantity || line.planned_quantity)}" />`
                  : escapeHtml(formatQuantity(line.actual_quantity || line.planned_quantity)),
                line.physical_confirmed_at
                  ? `<span class="badge badge-active">Yes</span>`
                  : `<span class="badge badge-pending-review">No</span>`,
                taskIsActive && !editMode
                  ? `
                      <form method="post" action="/tasks/${task.id}/simulate-button">
                        <input type="hidden" name="line_id" value="${line.id}" />
                        <button type="submit" class="ghost-button">Press button</button>
                      </form>
                    `
                  : `<span class="muted">${editMode ? "Editing" : "Done"}</span>`,
              ]),
            )}
            ${
              editable || taskIsActive
                ? `
                    <form id="confirm-form" method="post" action="/tasks/${task.id}/${editSubmitPath}" class="stack-form">
                      ${hiddenSubmissionToken(editMode ? actionTokens.correct : actionTokens.confirm)}
                      <label>Note<textarea name="note" rows="3" placeholder="Optional note"></textarea></label>
                      <button type="submit">${editMode ? "Save Correction" : "Finish task"}</button>
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
                    <form method="post" action="/recommended-actions/apply" class="stack-form">
                      <input type="hidden" name="source_cell_id" value="${action.cellId}" />
                      <input type="hidden" name="product_id" value="${action.productId}" />
                      <input type="hidden" name="reason" value="${escapeHtml(action.title)}" />
                      <input type="hidden" name="recommendation_key" value="${escapeHtml(action.key)}" />
                      ${action.recommendedMoves
                        .map(
                          (move, index) => `
                            <div class="recommendation-row">
                              <div class="recommendation-summary">
                                <strong>${escapeHtml(action.productSku)}</strong>
                                <p class="muted">Move ${escapeHtml(formatQuantity(move.quantity))} item(s) from ${escapeHtml(action.logicalCode)} to the target cell below.</p>
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
                                  class="ghost-button"
                                  formaction="/recommended-actions/light-cell"
                                  name="light_move_index"
                                  value="${index}"
                                >
                                  Find/Light Cell
                                </button>
                              </div>
                            </div>
                          `,
                        )
                        .join("")}
                      <button type="submit">Apply recommendation</button>
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
