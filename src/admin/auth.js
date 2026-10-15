import {
  ADMIN_COOKIE_NAME,
  ADMIN_SESSION_TTL_S,
  getAdminToken,
} from "../config.js";

function getBearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function bytesToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSign(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToHex(sig);
}

async function createAdminSessionValue(env) {
  const secret = getAdminToken(env);
  if (!secret) {
    return null;
  }
  const exp = Math.floor(Date.now() / 1000) + ADMIN_SESSION_TTL_S;
  const payload = `admin.${exp}`;
  const sig = await hmacSign(secret, payload);
  return `${payload}.${sig}`;
}

async function verifyAdminSessionValue(env, value) {
  const secret = getAdminToken(env);
  if (!secret || !value) {
    return false;
  }
  const parts = String(value).split(".");
  if (parts.length !== 3 || parts[0] !== "admin") {
    return false;
  }
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) {
    return false;
  }
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = await hmacSign(secret, payload);
  return expected === parts[2];
}

function parseCookies(header) {
  const out = {};
  if (!header) {
    return out;
  }
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(value);
  }
  return out;
}

function buildAdminCookie(value, { clear = false } = {}) {
  if (clear) {
    return `${ADMIN_COOKIE_NAME}=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
  }
  return `${ADMIN_COOKIE_NAME}=${encodeURIComponent(value)}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${ADMIN_SESSION_TTL_S}`;
}

async function isAdminAuthorized(request, env) {
  const secret = getAdminToken(env);
  if (!secret) {
    return false;
  }

  const bearer = getBearerToken(request);
  if (bearer && bearer === secret) {
    return true;
  }

  const cookies = parseCookies(request.headers.get("Cookie") || "");
  return verifyAdminSessionValue(env, cookies[ADMIN_COOKIE_NAME]);
}

function passwordFromRequestBody(body, contentType) {
  if (!body) {
    return "";
  }
  if (typeof body === "object" && body.password != null) {
    return String(body.password);
  }
  if (typeof body === "string" && /application\/x-www-form-urlencoded/i.test(contentType || "")) {
    return new URLSearchParams(body).get("password") || "";
  }
  return "";
}

export {
  ADMIN_COOKIE_NAME,
  createAdminSessionValue,
  verifyAdminSessionValue,
  buildAdminCookie,
  isAdminAuthorized,
  passwordFromRequestBody,
  parseCookies,
};
