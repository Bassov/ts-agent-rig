#!/usr/bin/env node
import { main } from '../src/check.mjs'

const code = await main(process.argv.slice(2), process)
process.exitCode = typeof code === 'number' ? code : 1
