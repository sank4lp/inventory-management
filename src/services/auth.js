import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SESSION_SECRET =
  process.env.SESSION_SECRET || "inventory-local-dev-secret";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function sign(value) {
  return createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(password, salt, 64).toString("base64url");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, passwordHash) {
  const [salt, stored] = passwordHash.split(":");
  const hash = scryptSync(password, salt, 64);
  const storedBuffer = Buffer.from(stored, "base64url");

  if (hash.length !== storedBuffer.length) {
    return false;
  }

  return timingSafeEqual(hash, storedBuffer);
}

export function parseCookies(header = "") {
  const entries = header.split(";").map((value) => value.trim()).filter(Boolean);
  return Object.fromEntries(
    entries.map((entry) => {
      const [key, ...rest] = entry.split("=");
      return [key, rest.join("=")];
    }),
  );
}

export function createSessionCookie(user) {
  const payload = JSON.stringify({
    userId: user.id,
    role: user.role,
    exp: Date.now() + SESSION_TTL_MS,
  });
  const encoded = Buffer.from(payload, "utf8").toString("base64url");
  const signature = sign(encoded);
  return `session=${encoded}.${signature}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function clearSessionCookie() {
  return "session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}

export function getSessionUser(request, db) {
  const cookies = parseCookies(request.headers.cookie);
  const session = cookies.session;

  if (!session || !session.includes(".")) {
    return null;
  }

  const [encoded, signature] = session.split(".");
  const expectedSignature = sign(encoded);

  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }

  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (payload.exp < Date.now()) {
    return null;
  }

  return (
    db
      .prepare(
        "SELECT id, name, username, role, status FROM users WHERE id = ? AND status = 'active'",
      )
      .get(payload.userId) || null
  );
}

export function requireRole(user, role) {
  return user && user.role === role;
}
