import {
  allocatePick,
  cancelTask,
  completeTask,
  correctCompletedTask,
  getTask,
  listRecentTasks,
  listRecentTasksForUser,
  markPhysicalConfirmation,
  planPut,
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
    issueActionToken(scope, taskId, userId) {
      return systemService.issueSubmissionToken({ scope, taskId, userId });
    },
    createPickTask({ userId, productId, quantity, preferredCellId = null }) {
      const task = allocatePick(db, { userId, productId, quantity, preferredCellId });
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
    createPutTask({ userId, productId, quantity, preferredCellId = null }) {
      const task = planPut(db, { userId, productId, quantity, preferredCellId });
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
      const completion = completeTask(db, {
        taskId,
        actualQuantities,
        actualCellIds,
        userId,
        note,
      });
      hardwareService.clearGuidance(completion.task, completion.task.lines, {
        source: "task_complete",
      });
      logger.info("task.confirmed", {
        taskId: completion.task.id,
        userId,
        anomalies: completion.anomalies.length,
      });
      return completion;
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
