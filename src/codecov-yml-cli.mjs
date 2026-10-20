#!/usr/bin/env node
import { runCodecovYmlCli } from './check-codecov-yml.mjs'

process.exitCode = await runCodecovYmlCli()
