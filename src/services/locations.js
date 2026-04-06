import {
  getCellDetail,
  listCells,
  listControllers,
  searchCells,
  updateCellMapping,
} from "./inventory.js";

export function createLocationService({ db }) {
  return {
    listCells() {
      return listCells(db);
    },
    searchCells(search = "") {
      return searchCells(db, search);
    },
    getCellDetail(cellId) {
      return getCellDetail(db, cellId);
    },
    listControllers() {
      return listControllers(db);
    },
    updateCellMapping(input) {
      return updateCellMapping(db, input);
    },
  };
}
