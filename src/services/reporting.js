import { buildReports } from "./reports.js";

export function createReportService({ db }) {
  return {
    buildReports(range) {
      return buildReports(db, range);
    },
  };
}
