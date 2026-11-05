import { renderLogin, renderRegister } from "./auth.js";
import { createAdminPages } from "./admin.js";
import { createBackupPages } from "./backups.js";
import { createHomePages } from "./home.js";
import { createLocationPages } from "./locations.js";
import { createProductPages } from "./products.js";
import { createProductFieldPages } from "./product-fields.js";
import { createProfilePages } from "./profile.js";
import { createReportsPages } from "./reports.js";
import { card, page, escapeHtml } from "./shared.js";
import { createTaskPages } from "./tasks.js";

export function createPageRenderer({
  db,
  backupService,
  productFieldService,
  unitConversionService,
}) {
  const homePages = createHomePages({ db });
  const productPages = createProductPages({ db, productFieldService });
  const productFieldPages = createProductFieldPages({
    db,
    productFieldService,
    unitConversionService,
  });
  const taskPages = createTaskPages({ db });
  const reportPages = createReportsPages({ db });
  const locationPages = createLocationPages({ db });
  const profilePages = createProfilePages({ db });
  const adminPages = createAdminPages({ db, backupService, productFieldService });
  const backupPages = createBackupPages({ backupService });

  function renderRecommendedActionsError(user) {
    return page({
      title: "Recommended Actions",
      currentPath: "/recommended-actions",
      user,
      content: card(
        "Actions could not load",
        `<p>Try again. If this continues, contact your administrator.</p>
         <div class="page-actions page-actions-left"><a class="action-cta-button" href="/recommended-actions">Try again</a></div>`,
      ),
    });
  }

  function renderNotFound(user) {
    return page({
      title: "Not Found",
      user,
      content: `<p>The requested page does not exist.</p><p><a href="/">Back To Dashboard</a></p>`,
    });
  }

  function renderRequestError(user, error, pathname) {
    const destinations = [
      ['/backups', '/backups', 'Backups'], ['/cells', '/cells', 'Locations'],
      ['/products', '/products', 'Products'], ['/devices', '/devices', 'Hardware'],
      ['/stocktaking', '/stocktaking', 'Stocktaking'], ['/settings', '/settings', 'Settings'],
    ];
    const [, href, label] = destinations.find(([prefix])=>pathname===prefix||pathname.startsWith(prefix+'/')) || ['',user?'/work':'/login',user?'My Work':'Sign in'];
    return page({title:'Unable to open this page',currentPath:href,user,content:card('Unable to open this page',
      `<p role="alert">${escapeHtml(error.message||'Please try again.')}</p><div class="page-actions page-actions-left"><a class="action-cta-button" href="${href}">Back to ${label}</a></div>`)});
  }

  return {
    ...adminPages,
    ...backupPages,
    ...homePages,
    ...locationPages,
    ...productPages,
    ...productFieldPages,
    ...profilePages,
    ...reportPages,
    ...taskPages,
    renderLogin,
    renderNotFound,
    renderRecommendedActionsError,
    renderRequestError,
    renderRegister,
  };
}
