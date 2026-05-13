import { nowIso } from "../shared/time.js";

function taskLinesWithCells(db, taskId) {
  return db
    .prepare(
      `
        SELECT
          tl.*,
          p.sku,
          p.name AS product_name,
          p.brand,
          p.unit_of_measure,
          c.logical_code,
          c.hardware_channel,
          c.controller_id,
          ctrl.controller_code,
          ctrl.address AS controller_address
        FROM task_lines tl
        JOIN products p ON p.id = tl.product_id
        JOIN cells c ON c.id = tl.cell_id
        LEFT JOIN controllers ctrl ON ctrl.id = c.controller_id
        WHERE tl.task_id = ?
        ORDER BY p.name, c.row_number, c.column_number
      `,
    )
    .all(Number(taskId));
}

export function createTaskRepository(db) {
  return {
    get(taskId) {
      const task = db
        .prepare(
          `
            SELECT
              t.*,
              u.name AS created_by_name,
              u.username AS created_by_username
            FROM tasks t
            JOIN users u ON u.id = t.created_by
            WHERE t.id = ?
          `,
        )
        .get(Number(taskId));

      if (!task) {
        return null;
      }

      return {
        ...task,
        lines: taskLinesWithCells(db, taskId),
      };
    },

    listRecent(limit = 10) {
      return db
        .prepare(
          `
            SELECT
              t.id,
              t.type,
              t.status,
              t.summary,
              t.started_at,
              t.completed_at,
              t.created_by,
              u.username AS created_by_username,
              (
                SELECT p.sku
                FROM task_lines tl
                JOIN products p ON p.id = tl.product_id
                WHERE tl.task_id = t.id
                ORDER BY tl.id
                LIMIT 1
              ) AS first_sku,
              (
                SELECT p.name
                FROM task_lines tl
                JOIN products p ON p.id = tl.product_id
                WHERE tl.task_id = t.id
                ORDER BY tl.id
                LIMIT 1
              ) AS first_product_name
            FROM tasks t
            JOIN users u ON u.id = t.created_by
            ORDER BY t.id DESC
            LIMIT ?
          `,
        )
        .all(Number(limit));
    },

    listRecentForUser(user, limit = 10) {
      if (user.role === "admin") {
        return this.listRecent(limit);
      }

      return db
        .prepare(
          `
            SELECT
              t.id,
              t.type,
              t.status,
              t.summary,
              t.started_at,
              t.completed_at,
              t.created_by,
              u.username AS created_by_username,
              (
                SELECT p.sku
                FROM task_lines tl
                JOIN products p ON p.id = tl.product_id
                WHERE tl.task_id = t.id
                ORDER BY tl.id
                LIMIT 1
              ) AS first_sku,
              (
                SELECT p.name
                FROM task_lines tl
                JOIN products p ON p.id = tl.product_id
                WHERE tl.task_id = t.id
                ORDER BY tl.id
                LIMIT 1
              ) AS first_product_name
            FROM tasks t
            JOIN users u ON u.id = t.created_by
            WHERE t.created_by = ?
            ORDER BY t.id DESC
            LIMIT ?
          `,
        )
        .all(Number(user.id), Number(limit));
    },

    createPendingReviewTask({ type, summary, createdBy, lines }) {
      const taskResult = db
        .prepare(
          `
            INSERT INTO tasks (type, status, summary, created_by, started_at)
            VALUES (?, 'pending_review', ?, ?, ?)
          `,
        )
        .run(type, summary, Number(createdBy), nowIso());

      const taskId = Number(taskResult.lastInsertRowid);
      for (const line of lines) {
        this.addLine(taskId, line);
      }
      return this.get(taskId);
    },

    updateSummary(taskId, summary) {
      db.prepare("UPDATE tasks SET summary = ? WHERE id = ?").run(summary, Number(taskId));
    },

    addLine(taskId, line) {
      db.prepare(
        `
          INSERT INTO task_lines (task_id, product_id, cell_id, planned_quantity, guidance_color)
          VALUES (?, ?, ?, ?, ?)
        `,
      ).run(
        Number(taskId),
        Number(line.product_id),
        Number(line.cell_id),
        Number(line.planned_quantity),
        line.guidance_color,
      );
    },

    updateStatus(taskId, status, completedAt = nowIso()) {
      db.prepare(
        `
          UPDATE tasks
          SET status = ?, completed_at = ?
          WHERE id = ?
        `,
      ).run(status, completedAt, Number(taskId));
    },

    deleteLines(taskId) {
      db.prepare("DELETE FROM task_lines WHERE task_id = ?").run(Number(taskId));
    },

    addPutPlanLine(taskId, { productId, cellId, quantity, note = null }) {
      db.prepare(
        `
          INSERT INTO task_lines (
            task_id, product_id, cell_id, planned_quantity, guidance_color, note
          )
          VALUES (?, ?, ?, ?, 'red', ?)
        `,
      ).run(Number(taskId), Number(productId), Number(cellId), Number(quantity), note);
    },

    updateLineActual({ lineId, actualQuantity, exceptionQuantity, note = null, cellId }) {
      db.prepare(
        `
          UPDATE task_lines
          SET actual_quantity = ?, exception_quantity = ?, note = ?, cell_id = ?
          WHERE id = ?
        `,
      ).run(
        Number(actualQuantity),
        Number(exceptionQuantity),
        note,
        Number(cellId),
        Number(lineId),
      );
    },

    findLineWithCell(lineId) {
      return db
        .prepare(
          `
            SELECT
              tl.*,
              c.logical_code,
              c.hardware_channel,
              c.controller_id,
              ctrl.controller_code,
              ctrl.address AS controller_address
            FROM task_lines tl
            JOIN cells c ON c.id = tl.cell_id
            LEFT JOIN controllers ctrl ON ctrl.id = c.controller_id
            WHERE tl.id = ?
          `,
        )
        .get(Number(lineId));
    },

    markLinePhysicalConfirmed(lineId) {
      db.prepare(
        `
          UPDATE task_lines
          SET physical_confirmed_at = ?, actual_quantity = CASE WHEN actual_quantity = 0 THEN planned_quantity ELSE actual_quantity END
          WHERE id = ?
        `,
      ).run(nowIso(), Number(lineId));
    },
  };
}
