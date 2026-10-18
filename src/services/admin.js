import {withTransaction} from "../db.js";
import {currentActor,auditAccess} from "../modules/access/service.js";
import {
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
      const actor=currentActor(db,input.actor,"access.manage");
      return withTransaction(db, () => {
        const key = revokeRegistrationKey(db, input);
        auditAccess(db,actor,"invitation_revoked",key.id,{});
        return key;
      });
    },
    setUserStatus(input) {
      return setUserStatus(db, input);
    },
    createAdjustment(input) {
      throw new Error("Use a fresh Stocktaking observation and authorized review. Baseline-free adjustments are not an application command.");
    },
  };
}
