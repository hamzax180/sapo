/* =================================================================
   providers/index.js — the compute abstraction
   -----------------------------------------------------------------
   Nothing outside this folder mentions Hetzner. That is the whole
   point: the scheduler in Phase 5 asks a ComputeProvider for a host,
   and swapping in AWS, Vultr or DigitalOcean later is adding a file
   here, not tracing Hetzner calls through the deployment path.

   The interface is deliberately small. Everything a scheduler needs
   to place work is create / delete / get / resources; anything
   richer would be modelling one provider capabilities as if they
   were universal.
   ================================================================= */
"use strict";

/**
 * @typedef {Object} Server
 * @property {string} id
 * @property {string} name
 * @property {string} publicIp
 * @property {string} status        provisioning | running | off | unknown
 * @property {number} cpuCores
 * @property {number} memoryMb
 * @property {number} diskGb
 *
 * @typedef {Object} Resources
 * @property {number} cpuPct
 * @property {number} memoryPct
 * @property {number} diskPct
 *
 * @typedef {Object} ComputeProvider
 * @property {string} name
 * @property {() => boolean} isConfigured
 * @property {(opts?: object) => Promise<Server>} createServer
 * @property {(id: string) => Promise<void>} deleteServer
 * @property {(id: string) => Promise<Server>} getServer
 * @property {(id: string) => Promise<Resources>} getServerResources
 */

const REQUIRED = ["name", "isConfigured", "createServer", "deleteServer", "getServer", "getServerResources"];

/** Fails at load rather than at 3am when the scheduler first calls it. */
function assertProvider(p) {
  for (const k of REQUIRED) {
    if (!(k in p)) throw new Error("provider " + (p.name || "?") + " is missing " + k);
  }
  return p;
}

const registry = new Map();

function register(provider) {
  registry.set(provider.name, assertProvider(provider));
  return provider;
}

function get(name) {
  const p = registry.get(name);
  if (!p) throw new Error("unknown compute provider: " + name);
  return p;
}

/** Providers that could actually be used right now. */
function available() {
  return [...registry.values()].filter((p) => p.isConfigured());
}

// Registered at load so `get("hetzner")` works without the caller knowing
// which file it came from.
register(require("./local"));
register(require("./hetzner"));

module.exports = { register, get, available, assertProvider, registry };
