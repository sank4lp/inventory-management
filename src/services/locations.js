import {
  createCell,
  deleteCell,
  deleteController,
  getCellDetail,
  getCellDeletionImpact,
  listCellCatalog,
  listCells,
  listControllers,
  searchCells,
  updateControllerHealth,
  updateCellMapping,
} from "./inventory.js";

export function createLocationService({ db }) {
  return {
    listCells() {
      return listCells(db);
    },
    listCellCatalog() {
      return listCellCatalog(db);
    },
    searchCells(search = "") {
      return searchCells(db, search);
    },
    getCellDetail(cellId) {
      return getCellDetail(db, cellId);
    },
    getCellDeletionImpact(cellId) {
      return getCellDeletionImpact(db, cellId);
    },
    listControllers() {
      return listControllers(db);
    },
    updateControllerHealth(input) {
      return updateControllerHealth(db, input);
    },
    deleteController(input) {
      return deleteController(db, input);
    },
    deleteCell(input) {
      return deleteCell(db, input);
    },
    createCell(input) {
      return createCell(db, input);
    },
    updateCellMapping(input) {
      return updateCellMapping(db, input);
    },
  };
}
