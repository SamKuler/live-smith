import { fileURLToPath } from "node:url";

import { verifyTrackedPluginFixtures } from "./plugin-fixture-verification.js";

const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
const count = await verifyTrackedPluginFixtures(projectDirectory);
console.log(`Verified ${count} tracked Plugin compatibility fixtures.`);
