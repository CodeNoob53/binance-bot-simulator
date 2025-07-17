#!/usr/bin/env node
import 'dotenv/config';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

async function migrate() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const dbDir = join(__dirname, '../data');
  mkdirSync(dbDir, { recursive: true });
  const dbPath = process.env.DB_PATH || join(dbDir, 'simulation.db');

  const db = await open({ filename: dbPath, driver: sqlite3.Database });

  await db.exec('PRAGMA journal_mode = WAL;');

  const duplicates = await db.all(`
    SELECT symbol_id
    FROM listing_analysis
    GROUP BY symbol_id
    HAVING COUNT(*) > 1
  `);

  for (const row of duplicates) {
    const keep = await db.get(
      `SELECT id FROM listing_analysis
       WHERE symbol_id = ?
       ORDER BY analysis_date DESC, id DESC
       LIMIT 1`,
      row.symbol_id
    );
    await db.run(
      `DELETE FROM listing_analysis
       WHERE symbol_id = ? AND id != ?`,
      row.symbol_id,
      keep.id
    );
  }

  await db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_analysis_symbol_unique ON listing_analysis(symbol_id)'
  );

  await db.close();
  console.log('Migration completed.');
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
