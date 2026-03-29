# Admin Flow

## Goal

Provide administrative control over users, products, devices, corrections, and system configuration.

## Admin capabilities

### User management
- create registration keys
- review users
- change roles
- deactivate/reactivate users
- reset passwords

### Inventory oversight
- review transaction history
- perform controlled inventory adjustments
- review recommended actions and unresolved anomalies
- reopen and correct any completed task

### Product management
- create/edit/archive products
- manage preferred cell rules
- change a product's **items per cell** value from the console
- manage metadata standards

### System configuration
- manage zones and controllers
- trigger maintenance/test mode
- map or remap cells
- review device health

### Reporting
- generate and export analytics reports
- inspect operator activity

## Current software behavior

- The home screen shows recommended actions for mixed-product and over-capacity cells.
- Admins can open a single recommendation from Home, or open the full `/recommended-actions` page.
- Admins can review recent tasks from Home and use **Make Correction** to enter task edit mode.
- Task correction uses compensating adjustment transactions so the audit trail stays intact.

## Important audit rule

Admins should **not** silently edit historical rows as if the original event changed.

Recommended model:
- operational events remain immutable,
- corrections create new **adjustment transactions**,
- the UI shows full change history.

## Example admin flows

### Inventory correction
1. Admin opens a completed task from **Make Correction**
2. Admin reviews the original cell plan and actual result
3. Admin edits the corrected cell and quantity values
4. System records the correction as adjustment transactions
5. Audit trail links the correction to the admin user and original task

### User revocation
1. Admin opens user management
2. Admin selects a user
3. Admin changes status to inactive
4. System blocks future login

### Device troubleshooting
1. Admin opens zone/device screen
2. Admin sees offline controller or failing cell
3. Admin runs test or remapping flow
4. System records maintenance action
