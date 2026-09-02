/* =================================================================
   dbproviders/index.js — the database abstraction
   -----------------------------------------------------------------
   The same shape as providers/index.js, for the same reason: where a
   project's data lives is a choice, and the deployment path should not
   know which one was made. It asks for a provider by mode and gets back
   something with four methods.

   Two modes ship:

     builtin   a database on our shared cluster, created for them
     external  a connection string they gave us, used verbatim

   A third is designed for and NOT built: a provider holding a customer's
   API key and creating databases on their own Neon or Supabase account.
   The interface below is already the right shape for it — adding
   dbproviders/neon.js would be an implementation, not a redesign. It is
   left out on purpose. A stored provider API key can create and destroy
   billable resources on someone else's account, and how it is scoped,
   stored and revoked deserves its own decision rather than being folded
   into the change that introduced databases at all.

   The interface is small for the same reason the compute one is: the
   deployment path needs a URL to inject, a way to clean up, and a way to
   ask if it is alive. Anything richer would be modelling one provider's
   capabilities as if they were universal.
   ================================================================= */
"use strict";

/**
 * @typedef {Object} Provisioned
 * @property {boolean} ok
 * @property {string}  [url]       what gets injected into the container
 * @property {string}  [dbName]
 * @property {string}  [role]
 * @property {string}  [secret]    present only when newly generated; the
 *                                 caller is responsible for encrypting it
 * @property {boolean} [existed]
 * @property {string}  [error]
 *
 * @typedef {Object} DbProvider
 * @property {string} mode
 * @property {(projectId: string, existing?: {secret?: string}) => Promise<Provisioned>} provision
 * @property {(projectId: string, existing?: {secret?: string}) => Promise<{ok: boolean}>} destroy
 * @property {(projectId: string, existing?: {secret?: string}) => Promise<{ok: boolean, reachable: boolean, sizeBytes?: number}>} inspect
 * @property {() => Promise<boolean>} ready
 */

const REQUIRED = ["mode", "provision", "destroy", "inspect", "ready"];

/** Fails at load, not the first time a customer deploys. */
function assertProvider(p) {
  for (const k of REQUIRED) {
    if (!(k in p)) throw new Error("db provider " + (p.mode || "?") + " is missing " + k);
  }
  return p;
}

const registry = new Map();

function register(provider) {
  registry.set(provider.mode, assertProvider(provider));
  return provider;
}

const DEFAULT_MODE = "builtin";

/** Unknown modes fall back rather than throwing mid-deploy: a bad value in
    one row should not take a deployment down, and builtin is always safe. */
function get(mode) {
  return registry.get(mode || DEFAULT_MODE) || registry.get(DEFAULT_MODE);
}

const modes = () => [...registry.keys()];

register(require("./builtin"));
register(require("./external"));

module.exports = { register, get, modes, assertProvider, registry, DEFAULT_MODE };
