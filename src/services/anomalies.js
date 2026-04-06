import {
  applyRecommendedAction,
  detectAnomalies,
  getRecommendedActions,
} from "./inventory.js";

export function createAnomalyService({ db }) {
  return {
    detectAnomalies() {
      return detectAnomalies(db);
    },
    getRecommendedActions() {
      return getRecommendedActions(db);
    },
    applyRecommendedAction(input) {
      return applyRecommendedAction(db, input);
    },
  };
}
