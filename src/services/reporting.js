import {currentActor} from "../modules/access/service.js";
import { buildReports } from "./reports.js";

export function createReportService({ db }) {
  return {
    buildReports(range,actor) {
      currentActor(db,actor,"reports.view");
      return buildReports(db, range);
    },
  };
}
