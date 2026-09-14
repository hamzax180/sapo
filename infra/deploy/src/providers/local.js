/* =================================================================
   providers/local.js — the machine this process is already on
   -----------------------------------------------------------------
   Phase 1 has exactly one host and it is not provisioned by anyone.
   Implementing the same interface for it means the scheduler has no
   special case for "the local box": it asks a provider for a host
   either way, and local simply refuses to create or delete one.
   ================================================================= */
"use strict";

const os = require("os");
const { cfg } = require("../config");
const capacity = require("../monitor/capacity");

const provider = {
  name: "local",

  isConfigured() { return true; },

  async createServer() {
    throw new Error("the local provider cannot create servers — configure a cloud provider first");
  },

  async deleteServer() {
    throw new Error("the local provider cannot delete servers");
  },

  async getServer() {
    return {
      id: cfg.hostId,
      name: os.hostname(),
      publicIp: null,
      status: "running",
      cpuCores: os.cpus().length,
      memoryMb: Math.round(os.totalmem() / 1048576),
      diskGb: null
    };
  },

  /** Real measurements, unlike the cloud-side metrics a remote host reports. */
  async getServerResources() {
    const snap = await capacity.snapshot();
    return {
      cpuPct: snap.cpuPct,
      memoryPct: snap.memory.pct,
      diskPct: snap.disk ? snap.disk.pct : null,
      source: "local-agent"
    };
  }
};

module.exports = provider;
