import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openDatabase } from "./db/schema.js";
import { createServer } from "./http/server.js";
import { CardService } from "./ledger/service.js";

const databasePath = process.env.DATABASE_PATH ?? "data/cardlane.db";
const port = Number(process.env.PORT ?? 3000);
const webhookSecret = process.env.WEBHOOK_SECRET ?? "dev-only-change-me";

if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });

const service = new CardService(openDatabase(databasePath));
const server = createServer(service, webhookSecret);

server.listen(port, () => {
  console.log(`cardlane listening on http://localhost:${port}`);
});
