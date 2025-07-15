import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import logger from '../utils/logger.js';
import { runMigrations } from './migrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function initializeDatabase() {
  try {
    // Створюємо директорію для БД
    const dbDir = join(__dirname, '../../data');
    mkdirSync(dbDir, { recursive: true });
    
    const dbPath = process.env.DB_PATH || join(dbDir, 'simulation.db');
    
    logger.info(`Initializing database at: ${dbPath}`);
    
    const db = new Database(dbPath);
    
    // Оптимізація SQLite
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = 10000');
    db.pragma('temp_store = memory');
    
    // Запускаємо міграції
    runMigrations(db);
    
    logger.info('Database initialized successfully');
    
    return db;
  } catch (error) {
    logger.error('Failed to initialize database:', error);
    throw error;
  }
}

// Singleton instance
let dbInstance = null;

export function getDatabase() {
  if (!dbInstance) {
    dbInstance = initializeDatabase();
  }
  return dbInstance;
}

export function closeDatabase() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    logger.info('Database connection closed');
  }
}