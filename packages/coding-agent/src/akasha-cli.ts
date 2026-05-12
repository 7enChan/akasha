#!/usr/bin/env node

process.env.PI_AKASHA_ENTRYPOINT = "1";

await import("./cli.js");
