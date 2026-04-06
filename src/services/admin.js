import {
  createAdjustment,
  issueRegistrationKey,
  listRegistrationKeys,
  listUsers,
} from "./inventory.js";

export function createAdminService({ db }) {
  return {
    listUsers() {
      return listUsers(db);
    },
    listRegistrationKeys() {
      return listRegistrationKeys(db);
    },
    issueRegistrationKey(input) {
      return issueRegistrationKey(db, input);
    },
    createAdjustment(input) {
      return createAdjustment(db, input);
    },
  };
}
