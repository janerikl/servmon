#!/usr/bin/env node
import path from "node:path";
import os from "node:os";
import { registryExists, generateRegistry } from "../lib/registry.js";
import { tmuxAvailable, ensureServerAlive } from "../lib/tmux.js";
import { runTui } from "../lib/tui.js";

const DEFAULT_SCAN_ROOT = path.join(os.homedir(), "Development");

function main() {
  if (!tmuxAvailable()) {
    console.error("tmux is required but not found on PATH. Install it with: sudo apt install tmux");
    process.exit(1);
  }

  ensureServerAlive();

  const scanRoot = process.argv[2] || DEFAULT_SCAN_ROOT;

  if (!registryExists()) {
    console.log(`No registry found. Scanning ${scanRoot} for Node/Rails projects...`);
    const found = generateRegistry(scanRoot);
    console.log(`Found ${found.length} project(s). Edit the registry anytime, or press R in the TUI to rescan.`);
  }

  runTui(scanRoot);
}

main();
