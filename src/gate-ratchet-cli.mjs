#!/usr/bin/env node
import { runGateRatchetCli } from './check-gate-ratchet.mjs'

process.exitCode = runGateRatchetCli(process.argv.slice(2))
