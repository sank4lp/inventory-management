import {currentActor} from '../access/service.js';
// User-triggered maintenance crosses this boundary. Scheduled safety backups use the internal service.
export function createMaintenanceCommands({db,backupService}) {
  return {
    create(actor,input){currentActor(db,actor,'backups.create');return backupService.createBackup(input);},
    schedule(actor,input){currentActor(db,actor,'backups.configure');return backupService.updateAutomaticBackupSchedule(input);},
    retention(actor,input){currentActor(db,actor,'backups.configure');return backupService.updateBackupRetention(input);},
    restore(actor,filename){currentActor(db,actor,'backups.restore');return backupService.restoreBackup(filename);},
  };
}
