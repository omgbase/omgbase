#!/usr/bin/env node

import { VERSION } from "@omgbase/core";
import { parseArgs } from "node:util";

const { positionals } = parseArgs({ allowPositionals: true, strict: false });
const command = positionals[0];

if (!command || command === "version") {
  console.log(`omgbase ${VERSION}`);
  process.exit(0);
}

console.error(`omgbase: unknown command '${command}'`);
process.exit(1);
