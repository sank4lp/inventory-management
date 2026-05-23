import { card, page } from "./shared.js";

export function renderLogin(flash) {
  return page({
    title: "Sign In",
    flash,
    content: `
      <section class="auth-shell">
        ${card(
          "Warehouse Sign In",
          `
            <form method="post" action="/login" class="stack-form">
              <label>Username<input name="username" autocomplete="username" autofocus required /></label>
              <label>Password<input type="password" name="password" autocomplete="current-password" required /></label>
              <button type="submit">Sign In</button>
            </form>
            <p class="muted">New operator? <a href="/register">Create an account with a registration key</a>.</p>
            <details class="auth-demo-details">
              <summary>Demo Access</summary>
              <p class="muted">Seeded admin: <code>admin / admin123</code></p>
            </details>
          `,
        )}
      </section>
    `,
  });
}

export function renderRegister(flash) {
  return page({
    title: "Create Account",
    flash,
    content: `
      <section class="auth-shell">
        ${card(
          "Controlled Registration",
          `
            <form method="post" action="/register" class="stack-form">
              <label>Registration Key<input name="registration_key" autocomplete="one-time-code" autofocus required /></label>
              <label>Full Name<input name="name" autocomplete="name" required /></label>
              <label>Username<input name="username" autocomplete="username" required /></label>
              <label>Password<input type="password" name="password" autocomplete="new-password" required /></label>
              <button type="submit">Create Account</button>
            </form>
            <p class="muted">Paste the one-time key your admin generated for you. It decides whether your new account is an operator or admin account, and it cannot be reused after registration.</p>
            <p class="muted"><a href="/login">Back To Sign In</a></p>
          `,
        )}
      </section>
    `,
  });
}
