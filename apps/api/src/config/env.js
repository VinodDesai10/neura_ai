/**
 * config/env.js
 *
 * Thin wrapper around the env loader. Import and call loadEnv() once at the
 * application entry point (server.js) before anything else reads process.env.
 */
export { loadEnv } from "../utils/load-env.js";

/**
 * Returns a numeric env variable, falling back to `fallback` when the value is
 * absent or not a positive finite number.
 *
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
export function readPositiveNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
