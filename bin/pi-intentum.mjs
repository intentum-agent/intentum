#!/usr/bin/env node

// Historical companion name. Same executable as `intentum`.
export { intentumRegisteredInPi, inspectRepository, locatePi, renderBrand, runCli } from "./intentum.mjs";
import { main } from "./intentum.mjs";

await main(import.meta.url, "pi-intentum");
