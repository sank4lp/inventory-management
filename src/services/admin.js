import {
  createAdjustment,
  issueRegistrationKey,
  listRegistrationKeys,
  listUsers,
  revokeRegistrationKey,
  setUserStatus,
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
    revokeRegistrationKey(input) {
      return revokeRegistrationKey(db, input);
    },
    setUserStatus(input) {
      return setUserStatus(db, input);
    },
    createAdjustment(input) {
      return createAdjustment(db, input);
    },
  };
}
