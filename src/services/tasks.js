import {
  allocatePick,
  cancelTask,
  completeTask,
  correctCompletedTask,
  getTask,
  listRecentTasks,
  listRecentTasksForProfileUser,
  listRecentTasksForUser,
  markPhysicalConfirmation,
  planPut,
  updatePendingPutPlan,
} from "./inventory.js";

export function createTaskService({ db, hardwareService, logger, systemService }) {
  return {
    getTask(taskId) {
      return getTask(db, taskId);
    },
    listRecentTasks(limit = 10) {
      return listRecentTasks(db, limit);
    },
    listRecentTasksForUser(user, limit = 10) {
      return listRecentTasksForUser(db, user, limit);
    },
    listRecentTasksForProfileUser(userId, limit = 10) {
      return listRecentTasksForProfileUser(db, userId, limit);
    },
    issueActionToken(scope, taskId, userId) {
      return systemService.issueSubmissionToken({ scope, taskId, userId });
    },
    createPickTask({ userId, productId, quantity, preferredCellId = null, preferredCellIds = [] }) {
      const task = allocatePick(db, { userId, productId, quantity, preferredCellId, preferredCellIds });
      const guidance = hardwareService.activateGuidance(task, task.lines, {
        source: "task_create",
        taskType: task.type,
      });
      logger.info("task.pick.created", {
        taskId: task.id,
        userId,
        productId: Number(productId),
        quantity: Number(quantity),
        adapter: hardwareService.adapterName,
        degradedGuidance: guidance.degraded,
      });
      return { task, guidance };
    },
    createPutTask({ userId, productId, quantity, preferredCellId = null, preferredCellIds = [] }) {
      const task = planPut(db, { userId, productId, quantity, preferredCellId, preferredCellIds });
      const guidance = hardwareService.activateGuidance(task, task.lines, {
        source: "task_create",
        taskType: task.type,
      });
      logger.info("task.put.created", {
        taskId: task.id,
        userId,
        productId: Number(productId),
        quantity: Number(quantity),
        adapter: hardwareService.adapterName,
        degradedGuidance: guidance.degraded,
      });
      return { task, guidance };
    },
    confirmTask({ taskId, actualQuantities, actualCellIds, userId, note, submissionToken }) {
      systemService.consumeSubmissionToken({
        token: submissionToken,
        scope: "task-confirm",
        taskId: Number(taskId),
        userId,
      });
      const taskBeforeCompletion = getTask(db, Number(taskId));
      const completion = completeTask(db, {
        taskId,
        actualQuantities,
        actualCellIds,
        userId,
        note,
      });
      if (taskBeforeCompletion) {
        hardwareService.clearGuidance(taskBeforeCompletion, taskBeforeCompletion.lines, {
          source: "task_complete",
        });
      }
      logger.info("task.confirmed", {
        taskId: completion.task.id,
        userId,
        anomalies: completion.anomalies.length,
      });
      return completion;
    },
    updatePutPlan({ taskId, allocations, userId, note, submissionToken }) {
      systemService.consumeSubmissionToken({
        token: submissionToken,
        scope: "task-put-plan",
        taskId: Number(taskId),
        userId,
      });
      const previousTask = getTask(db, Number(taskId));
      const task = updatePendingPutPlan(db, {
        taskId,
        allocations,
        note,
      });
      if (previousTask) {
        hardwareService.clearGuidance(previousTask, previousTask.lines, {
          source: "task_put_plan_adjust",
        });
      }
      const guidance = hardwareService.activateGuidance(task, task.lines, {
        source: "task_put_plan_adjust",
        taskType: task.type,
      });
      logger.info("task.put.plan_updated", {
        taskId: task.id,
        userId,
        lineCount: task.lines.length,
        adapter: hardwareService.adapterName,
        degradedGuidance: guidance.degraded,
      });
      return { task, guidance };
    },
    correctTask({ taskId, actualQuantities, actualCellIds, userId, note, submissionToken }) {
      systemService.consumeSubmissionToken({
        token: submissionToken,
        scope: "task-correct",
        taskId: Number(taskId),
        userId,
      });
      const correction = correctCompletedTask(db, {
        taskId,
        actualQuantities,
        actualCellIds,
        userId,
        note,
      });
      logger.info("task.corrected", {
        taskId: correction.task.id,
        userId,
        anomalies: correction.anomalies.length,
      });
      return correction;
    },
    cancelTask({ taskId, userId, submissionToken }) {
      systemService.consumeSubmissionToken({
        token: submissionToken,
        scope: "task-cancel",
        taskId: Number(taskId),
        userId,
      });
      const task = cancelTask(db, { taskId });
      hardwareService.clearGuidance(task, task.lines, {
        source: "task_cancel",
      });
      logger.info("task.cancelled", {
        taskId: task.id,
        userId,
      });
      return task;
    },
    recordPhysicalConfirmation({ lineId, taskId, userId }) {
      const task = getTask(db, Number(taskId));
      if (!task) {
        throw new Error("Task not found.");
      }
      if (task.status === "completed") {
        throw new Error("Completed tasks can only be changed through correction mode.");
      }
      if (task.status === "cancelled") {
        throw new Error("Cancelled tasks cannot be continued.");
      }
      if (!task.lines.some((line) => Number(line.id) === Number(lineId))) {
        throw new Error("Task line does not belong to this task.");
      }
      const line = markPhysicalConfirmation(db, Number(lineId));
      hardwareService.recordPhysicalConfirmation({ ...line, task_id: Number(taskId) }, userId);
      logger.info("task.physical_confirmation", {
        taskId: Number(taskId),
        lineId: Number(lineId),
        userId,
      });
      return line;
    },
  };
}
