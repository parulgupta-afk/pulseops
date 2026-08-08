import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on("error", (err) => {
  // Idle client errors shouldn't crash the process, just log them.
  console.error("Unexpected error on idle Postgres client", err);
});
