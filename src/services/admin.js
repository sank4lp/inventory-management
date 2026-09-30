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
      auditAccess(db,actor,"invitation_revoked",input.keyId,{});
      return revokeRegistrationKey(db, input);
    },
    setUserStatus(input) {
      return setUserStatus(db, input);
    },
    createAdjustment(input) {
      throw new Error("Use a fresh Stocktaking observation and authorized review. Baseline-free adjustments are not an application command.");
    },
  };
}
