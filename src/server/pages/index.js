import { renderLogin, renderRegister } from "./auth.js";
import { createAdminPages } from "./admin.js";
import { createBackupPages } from "./backups.js";
import { createHomePages } from "./home.js";
import { createLocationPages } from "./locations.js";
import { createProductPages } from "./products.js";
import { createProfilePages } from "./profile.js";
import { createReportsPages } from "./reports.js";
import { page } from "./shared.js";
import { createTaskPages } from "./tasks.js";

export function createPageRenderer({ db, backupService }) {
  const homePages = createHomePages({ db });
  const productPages = createProductPages({ db });
  const taskPages = createTaskPages({ db });
  const reportPages = createReportsPages({ db });
  const locationPages = createLocationPages({ db });
  const profilePages = createProfilePages({ db });
  const adminPages = createAdminPages({ db });
  const backupPages = createBackupPages({ backupService });

  function renderNotFound(user) {
    return page({
      title: "Not Found",
      user,
      content: `<p>The requested page does not exist.</p><p><a href="/">Back To Dashboard</a></p>`,
    });
  }

  return {
    ...adminPages,
    ...backupPages,
    ...homePages,
    ...locationPages,
    ...productPages,
    ...profilePages,
    ...reportPages,
    ...taskPages,
    renderLogin,
    renderNotFound,
    renderRegister,
  };
}
