// Minimal migration runner for Phase 1: just executes every .sql file in
// db/migrations in filename order. Swap for a real tool (node-pg-migrate,
// Prisma Migrate, etc.) once the schema starts changing often.
import fs from "fs";
import path from "path";
import { pool } from "./pool";

async function migrate() {
  const dir = path.join(__dirname, "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), "utf-8");
    console.log(`Running migration: ${file}`);
    await pool.query(sql);
  }

  console.log("Migrations complete.");
  await pool.end();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
