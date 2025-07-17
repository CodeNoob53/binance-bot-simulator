import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import logger from '../utils/logger.js';
import { runMigrations } from './migrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function initializeDatabase() {
  try {
    const dbDir = join(__dirname, '../../data');
    mkdirSync(dbDir, { recursive: true });
    const dbPath = process.env.DB_PATH || join(dbDir, 'simulation.db');
    logger.info(`Initializing database at: ${dbPath}`);

    const db = await open({ filename: dbPath, driver: sqlite3.Database });

    await db.exec('PRAGMA journal_mode = WAL;');
    await db.exec('PRAGMA synchronous = NORMAL;');
    await db.exec('PRAGMA cache_size = 10000;');
    await db.exec('PRAGMA temp_store = MEMORY;');

    await runMigrations(db);

    logger.info('Database initialized successfully');
    return db;
  } catch (error) {
    logger.error('Failed to initialize database:', error);
    throw error;
  }
}

let dbInstancePromise = null;

export async function getDatabase() {
  if (!dbInstancePromise) {
    dbInstancePromise = initializeDatabase();
  }
  return dbInstancePromise;
}

export async function closeDatabase() {
  if (dbInstancePromise) {
    const db = await dbInstancePromise;
    await db.close();
    dbInstancePromise = null;
    logger.info('Database connection closed');
  }
}
