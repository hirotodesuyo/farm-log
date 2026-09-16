import crypto from "node:crypto";

const COOKIE_NAME = "farm_session";
const SESSION_MESSAGE = "farm-log-session-v1";

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function syncConfigured() {
  return Boolean(process.env.FARM_SYNC_KEY && process.env.BLOB_READ_WRITE_TOKEN);
}

export function verifySyncCode(code) {
  return safeEqual(code, process.env.FARM_SYNC_KEY);
}

export function sessionToken() {
  return crypto
    .createHmac("sha256", process.env.FARM_SYNC_KEY || "")
    .update(SESSION_MESSAGE)
    .digest("hex");
}

export function hasValidSession(req) {
  if (!syncConfigured()) return false;
  const cookies = Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map(part => part.trim().split("="))
      .filter(parts => parts.length === 2)
      .map(([key, value]) => [key, decodeURIComponent(value)])
  );
  return safeEqual(cookies[COOKIE_NAME], sessionToken());
}

export function sessionCookie() {
  return `${COOKIE_NAME}=${encodeURIComponent(sessionToken())}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`;
}
