import { card, page } from "./shared.js";

export function renderLogin(flash) {
  return page({
    title: "Login",
    flash,
    content: `
      <section class="auth-shell">
        ${card(
          "Warehouse entry station",
          `
            <form method="post" action="/login" class="stack-form">
              <label>Username<input name="username" required /></label>
              <label>Password<input type="password" name="password" required /></label>
              <button type="submit">Login</button>
            </form>
            <p class="muted">Seeded admin: <code>admin / admin123</code></p>
            <p class="muted">Need a new user? <a href="/register">Register with a key</a>.</p>
          `,
        )}
      </section>
    `,
  });
}

export function renderRegister(flash) {
  return page({
    title: "Register",
    flash,
    content: `
      <section class="auth-shell">
        ${card(
          "Controlled registration",
          `
            <form method="post" action="/register" class="stack-form">
              <label>Registration key<input name="registration_key" required /></label>
              <label>Full name<input name="name" required /></label>
              <label>Username<input name="username" required /></label>
              <label>Password<input type="password" name="password" required /></label>
              <button type="submit">Create account</button>
            </form>
            <p class="muted">Seeded operator key: <code>INVITE-OP-2026</code></p>
            <p class="muted"><a href="/login">Back to login</a></p>
          `,
        )}
      </section>
    `,
  });
}
