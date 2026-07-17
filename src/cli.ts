#!/usr/bin/env node

import { runCli } from "./core/cli-runner.js";

process.exitCode = await runCli({ args: process.argv.slice(2) });
