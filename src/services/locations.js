import {currentActor} from "../modules/access/service.js";
import {
  createCell,
  deleteCell,
  deleteController,
  getCellDetail,
  getCellDeletionImpact,
  listCellCatalog,
  listCells,
  listControllers,
  renameCell,
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
      currentActor(db,input.actor,"hardware.test");
      return updateControllerHealth(db, input);
    },
    deleteController(input) {
      currentActor(db,input.actor,"hardware.controllers");
      return deleteController(db, input);
    },
    deleteCell(input) {
      currentActor(db,input.actor,"locations.manage");
      return deleteCell(db, input);
    },
    createCell(input) {
      currentActor(db,input.actor,"locations.manage");
      return createCell(db, input);
    },
    renameCell(input) {
      currentActor(db,input.actor,"locations.manage");
      return renameCell(db, input);
    },
    updateCellMapping(input) {
      currentActor(db,input.actor,"hardware.map");
      return updateCellMapping(db, input);
    },
  };
}
