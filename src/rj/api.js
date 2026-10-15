import { RJ_DEFAULTS } from "../config.js";

function getRjCredentials(env) {
  return {
    apiKey: env.RJ_API_KEY || RJ_DEFAULTS.API_KEY,
    userAgent: env.RJ_USER_AGENT || RJ_DEFAULTS.USER_AGENT,
  };
}

function getRadioJavanApiHeaders(env, refererPath) {
  const { apiKey, userAgent } = getRjCredentials(env);
  return {
    "User-Agent": RJ_DEFAULTS.BROWSER_UA,
    Referer: `${RJ_DEFAULTS.ORIGIN}${refererPath}`,
    Origin: RJ_DEFAULTS.ORIGIN,
    Accept: "application/json, text/plain, */*",
    "x-api-key": apiKey,
    "x-rj-user-agent": userAgent,
  };
}

async function fetchRadioJavanApi(env, endpoint, refererPath) {
  const response = await fetch(`${RJ_DEFAULTS.ORIGIN}${endpoint}`, {
    method: "GET",
    headers: getRadioJavanApiHeaders(env, refererPath),
  });

  if (!response.ok) {
    throw new Error(`Non-OK HTTP status: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

export { getRjCredentials, getRadioJavanApiHeaders, fetchRadioJavanApi };
