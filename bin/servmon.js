#!/usr/bin/env node
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { registryExists, generateRegistry } from "../lib/registry.js";
import { tmuxAvailable, ensureServerAlive } from "../lib/tmux.js";
import { runTui } from "../lib/tui.js";

const DEFAULT_SCAN_ROOT = path.join(os.homedir(), "Development");

const USAGE = `Usage: servmon [scan-root]

Discover, monitor and control local Node/Rails dev servers in tmux.

  scan-root   directory to scan for projects (default: ~/Development)

Press F1 inside servmon for keyboard commands.`;

function main() {
  const arg = process.argv[2];
  if (arg === "-h" || arg === "--help") {
    console.log(USAGE);
    return;
  }
  if (arg && arg.startsWith("-")) {
    console.error(`Unknown option: ${arg}\n\n${USAGE}`);
    process.exit(1);
  }

  const scanRoot = path.resolve(arg || DEFAULT_SCAN_ROOT);
  if (!fs.statSync(scanRoot, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`Scan root is not a directory: ${scanRoot}`);
    process.exit(1);
  }

  if (!tmuxAvailable()) {
    console.error("tmux is required but not found on PATH. Install it with: sudo apt install tmux");
    process.exit(1);
  }

  ensureServerAlive();

  if (!registryExists()) {
    console.log(`No registry found. Scanning ${scanRoot} for Node/Rails projects...`);
    const { projects } = generateRegistry(scanRoot);
    console.log(
      `Found ${projects.length} project(s). Edit the registry anytime, then press R in the TUI to reload it (f rescans).`
    );
  }

  runTui(scanRoot);
}

main();
