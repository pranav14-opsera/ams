#!/usr/bin/env node
/**
 * Minimal migration runner for migrations/*.sql.
 *
 * Chosen over node-pg-migrate's JS-migration API because these migrations
 * are plain, forward-only SQL (matching the Flyway convention this repo's
 * numbering already follows) — wrapping each in a `module.exports = pgm =>
 * {...}` JS shim would add a layer this project doesn't need, and every
 * migration here has already been verified by running it directly with
 * psql against a real PostgreSQL instance (see this WO's PR description).
 * This runner does exactly that verification, automated: apply each
 * not-yet-applied migrations/*.sql file, in filename order, inside its own
 * transaction, tracked in a schema_migrations table.
 */

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

function defaultConnectionString() {
  return (
    process.env.DATABASE_URL ||
    `postgres://${process.env.PGUSER || "postgres"}@${process.env.PGHOST || "localhost"}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE || "postgres"}`
  );
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedMigrations(client) {
  const result = await client.query("SELECT filename FROM schema_migrations");
  return new Set(result.rows.map((r) => r.filename));
}

async function runMigrations(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await ensureMigrationsTable(client);
    const applied = await appliedMigrations(client);

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    let appliedCount = 0;
    for (const file of files) {
      if (applied.has(file)) continue;

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      console.log(`Applying ${file}...`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
        appliedCount++;
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }

    console.log(
      appliedCount > 0
        ? `Applied ${appliedCount} migration(s).`
        : "No pending migrations — schema is up to date."
    );
  } finally {
    await client.end();
  }
}

async function runSqlFile(connectionString, relativePath) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const sql = fs.readFileSync(path.join(__dirname, relativePath), "utf8");
    await client.query(sql);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  runMigrations(defaultConnectionString()).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { runMigrations, runSqlFile, defaultConnectionString };
