import { requireRole } from "../../services/auth.js";
import { appendFlash, sendJson, sendRedirect } from "./responses.js";

export function ensureAuth(response, user) {
  if (!user) {
    sendRedirect(response, "/login");
    return false;
  }
  return true;
}

export function ensureAdmin(response, user) {
  if (!user) {
    sendRedirect(response, "/login");
    return false;
  }

  if (!requireRole(user, "admin")) {
    sendRedirect(response, appendFlash("/", "Admin access is required.", "error"));
    return false;
  }

  return true;
}

export function ensureApiAdmin(response, user) {
  if (!user) {
    sendJson(response, { error: "Authentication is required." }, 401);
    return false;
  }

  if (!requireRole(user, "admin")) {
    sendJson(response, { error: "Admin access is required." }, 403);
    return false;
  }

  return true;
}

export function ensureApiAuth(response, user) {
  if (!user) {
    sendJson(response, { error: "Authentication is required." }, 401);
    return false;
  }
  return true;
}
