# Authentication and Registration Flow

## Goal

Allow multiple users to securely access the system while preventing unauthorized self-registration.

## Roles

- **Operator**: can perform operational inventory tasks
- **Admin**: can manage users, settings, products, devices, and corrections

## Registration model

Registration is controlled through a **registration key** issued outside the system.

Current software behavior:
- only users with a valid registration key can register,
- admins can generate operator or admin keys from the admin console,
- admins can revoke unused active keys so they can no longer create accounts,
- admins can suspend or restore user access from the admin console,
- each key is intended for one person and is marked used after registration,
- the seeded demo key is `INVITE-OP-2026`.

## Registration flow

1. User opens the registration screen
2. User enters:
   - registration key
   - name
   - username
   - password
   - optional contact details
3. System validates the key
4. System creates the user with the appropriate role/policy
5. System marks the key as used
6. User is redirected to login or automatically signed in

## Login flow

1. User opens login screen
2. User enters username and password
3. System validates credentials
4. System creates a session
5. User lands on home screen

## Logout / session lock flow

Recommended for kiosk safety:

- explicit logout button,
- optional inactivity timeout,
- optional quick lock when operator leaves station.

## Admin user management flow

Admin can:
- create registration keys,
- generate separate one-time operator/admin registration keys,
- revoke unused active registration keys,
- view users,
- deactivate/reactivate users,
- reset passwords,
- change roles,
- view user activity logs.

## Permission notes

- Operators can create and complete pick and put actions.
- Operators can only reopen and correct their own completed tasks.
- Admins can reopen and correct any completed task.
- Corrections should create new audit entries rather than silently overwriting history.

## Recommended security rules

- Store passwords only as hashes
- Do not allow plain-text secret storage
- Registration keys should expire or be revocable
- High-privilege actions should be admin-only

## Edge cases

- invalid registration key
- expired key
- reused key
- duplicate username
- disabled user attempting login
- forgotten password recovery process
