# Admin Flow

## Goal

Provide administrative control over users, products, devices, corrections, and system configuration.

## Admin capabilities

### User management
- generate one-time operator or admin registration keys
- revoke unused active registration keys
- review users
- change roles
- deactivate/reactivate users so inactive users cannot log in
- reset passwords

### Inventory oversight
- review transaction history
- perform controlled inventory adjustments
- locate the selected adjustment cell before recording a count
- preview the entered final quantity total on the selected cell's LED module
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

- Recommended actions for mixed-product and over-capacity cells live in the `/recommended-actions` page.
- Active registration keys can be copied or deleted from Admin by revoking them; used keys stay in the audit trail.
- The recommended onboarding model is one key per person, not one shared operator/admin key. This keeps registration auditable and prevents accidental reuse.
- User access can be suspended or restored from Admin, while the signed-in admin account cannot suspend itself.
- The Adjustment form can locate the selected cell and send the entered final quantity total to the cell LED before the adjustment batch is committed.
- Admins can review recent tasks from Overview and use **Correct** to enter task edit mode.
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
