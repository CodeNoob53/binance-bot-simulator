#!/usr/bin/env node

import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Завантаження змінних середовища
dotenv.config();

const DB_PATH = process.env.DB_PATH || './data/simulation.db';

/**
 * Діагностичний скрипт для аналізу структури бази даних
 */
class DatabaseDiagnostics {
  constructor() {
    this.db = null;
  }

  /**
   * Підключення до бази даних
   */
  async connect() {
    try {
      this.db = await open({
        filename: DB_PATH,
        driver: sqlite3.Database
      });
      console.log('✅ З\'єднання з базою даних встановлено');
      return true;
    } catch (error) {
      console.error('❌ Помилка підключення до БД:', error.message);
      return false;
    }
  }

  /**
   * Перевірка існування файлу бази даних
   */
  checkDatabaseFile() {
    console.log('\n🔍 ПЕРЕВІРКА ФАЙЛУ БАЗИ ДАНИХ');
    console.log('═'.repeat(50));
    
    const dbDir = path.dirname(DB_PATH);
    const dbFile = path.basename(DB_PATH);
    
    console.log(`📁 Шлях до БД: ${DB_PATH}`);
    console.log(`📂 Директорія: ${dbDir}`);
    console.log(`📄 Файл: ${dbFile}`);
    
    // Перевірка директорії
    if (fs.existsSync(dbDir)) {
      console.log('✅ Директорія існує');
    } else {
      console.log('❌ Директорія не існує');
      return false;
    }
    
    // Перевірка файлу
    if (fs.existsSync(DB_PATH)) {
      const stats = fs.statSync(DB_PATH);
      console.log('✅ Файл БД існує');
      console.log(`📊 Розмір: ${(stats.size / 1024).toFixed(2)} KB`);
      console.log(`🕒 Створено: ${stats.birthtime.toLocaleString()}`);
      console.log(`🔄 Змінено: ${stats.mtime.toLocaleString()}`);
      return true;
    } else {
      console.log('❌ Файл БД не існує');
      return false;
    }
  }

  /**
   * Отримання списку всіх таблиць
   */
  async getTables() {
    const query = `
      SELECT name, type, sql 
      FROM sqlite_master 
      WHERE type IN ('table', 'view') 
      ORDER BY name
    `;
    
    try {
      const tables = await this.db.all(query);
      return tables;
    } catch (error) {
      console.error('❌ Помилка отримання таблиць:', error.message);
      return [];
    }
  }

  /**
   * Отримання структури таблиці
   */
  async getTableStructure(tableName) {
    try {
      const columns = await this.db.all(`PRAGMA table_info(${tableName})`);
      const indexes = await this.db.all(`PRAGMA index_list(${tableName})`);
      
      return {
        columns,
        indexes
      };
    } catch (error) {
      console.error(`❌ Помилка отримання структури таблиці ${tableName}:`, error.message);
      return { columns: [], indexes: [] };
    }
  }

  /**
   * Підрахунок записів у таблиці
   */
  async getTableCount(tableName) {
    try {
      const result = await this.db.get(`SELECT COUNT(*) as count FROM ${tableName}`);
      return result.count;
    } catch (error) {
      console.error(`❌ Помилка підрахунку записів у ${tableName}:`, error.message);
      return 0;
    }
  }

  /**
   * Показ структури бази даних
   */
  async showDatabaseStructure() {
    console.log('\n📋 СТРУКТУРА БАЗИ ДАНИХ');
    console.log('═'.repeat(50));
    
    const tables = await this.getTables();
    
    if (tables.length === 0) {
      console.log('❌ Таблиці не знайдені або БД порожня');
      return;
    }
    
    console.log(`📊 Знайдено таблиць: ${tables.length}\n`);
    
    for (const table of tables) {
      console.log(`🗂️  ТАБЛИЦЯ: ${table.name}`);
      console.log('-'.repeat(30));
      
      // Підрахунок записів
      const count = await this.getTableCount(table.name);
      console.log(`📈 Кількість записів: ${count}`);
      
      // Структура таблиці
      const structure = await this.getTableStructure(table.name);
      
      if (structure.columns.length > 0) {
        console.log('📝 Колонки:');
        structure.columns.forEach(col => {
          const nullable = col.notnull ? 'NOT NULL' : 'NULL';
          const primary = col.pk ? ' [PRIMARY KEY]' : '';
          const defaultValue = col.dflt_value ? ` DEFAULT ${col.dflt_value}` : '';
          console.log(`   • ${col.name}: ${col.type} ${nullable}${defaultValue}${primary}`);
        });
      }
      
      if (structure.indexes.length > 0) {
        console.log('🔍 Індекси:');
        structure.indexes.forEach(idx => {
          const unique = idx.unique ? 'UNIQUE' : 'INDEX';
          console.log(`   • ${idx.name} (${unique})`);
        });
      }
      
      console.log();
    }
  }

  /**
   * Показ останніх записів з ключових таблиць
   */
  async showRecentData() {
    console.log('\n📊 ОСТАННІ ДАНІ');
    console.log('═'.repeat(50));
    
    const tables = await this.getTables();
    const dataTables = tables.filter(t => 
      ['symbols', 'klines', 'simulation_configs', 'simulation_results', 'simulation_summary'].includes(t.name)
    );
    
    for (const table of dataTables) {
      console.log(`\n📋 Останні записи з ${table.name}:`);
      console.log('-'.repeat(40));
      
      try {
        const recentData = await this.db.all(
          `SELECT * FROM ${table.name} ORDER BY rowid DESC LIMIT 3`
        );
        
        if (recentData.length === 0) {
          console.log('   📭 Немає даних');
        } else {
          recentData.forEach((row, index) => {
            console.log(`   ${index + 1}. ${JSON.stringify(row, null, 2)}`);
          });
        }
      } catch (error) {
        console.log(`   ❌ Помилка: ${error.message}`);
      }
    }
  }

  /**
   * Перевірка цілісності даних
   */
  async checkDataIntegrity() {
    console.log('\n🔍 ПЕРЕВІРКА ЦІЛІСНОСТІ ДАНИХ');
    console.log('═'.repeat(50));
    
    const checks = [
      {
        name: 'Символи без K-line даних',
        query: `
          SELECT s.symbol 
          FROM symbols s 
          LEFT JOIN klines k ON s.symbol = k.symbol 
          WHERE k.symbol IS NULL
          LIMIT 5
        `
      },
      {
        name: 'K-lines без символів',
        query: `
          SELECT DISTINCT k.symbol 
          FROM klines k 
          LEFT JOIN symbols s ON k.symbol = s.symbol 
          WHERE s.symbol IS NULL
          LIMIT 5
        `
      },
      {
        name: 'Конфігурації без результатів',
        query: `
          SELECT sc.name 
          FROM simulation_configs sc 
          LEFT JOIN simulation_results sr ON sc.id = sr.config_id 
          WHERE sr.config_id IS NULL
          LIMIT 5
        `
      },
      {
        name: 'Діапазон дат K-lines',
        query: `
          SELECT 
            MIN(datetime(open_time/1000, 'unixepoch')) as earliest,
            MAX(datetime(open_time/1000, 'unixepoch')) as latest,
            COUNT(*) as total_klines
          FROM klines
        `
      }
    ];
    
    for (const check of checks) {
      console.log(`\n🔍 ${check.name}:`);
      try {
        const result = await this.db.all(check.query);
        if (result.length === 0) {
          console.log('   ✅ Проблем не знайдено');
        } else {
          result.forEach(row => {
            console.log(`   📄 ${JSON.stringify(row)}`);
          });
        }
      } catch (error) {
        console.log(`   ❌ Помилка перевірки: ${error.message}`);
      }
    }
  }

  /**
   * Показ конфігурацій симуляції
   */
  async showSimulationConfigs() {
    console.log('\n⚙️  КОНФІГУРАЦІЇ СИМУЛЯЦІЇ');
    console.log('═'.repeat(50));
    
    try {
      const configs = await this.db.all(`
        SELECT 
          id, name, take_profit_percent, stop_loss_percent,
          buy_amount_usdt, max_open_trades, created_at
        FROM simulation_configs 
        ORDER BY created_at DESC
        LIMIT 10
      `);
      
      if (configs.length === 0) {
        console.log('❌ Конфігурації не знайдені');
        return;
      }
      
      configs.forEach((config, index) => {
        console.log(`\n${index + 1}. ${config.name} (ID: ${config.id})`);
        console.log(`   📈 Take Profit: ${config.take_profit_percent}%`);
        console.log(`   📉 Stop Loss: ${config.stop_loss_percent}%`);
        console.log(`   💰 Розмір позиції: $${config.buy_amount_usdt}`);
        console.log(`   🔢 Макс. угод: ${config.max_open_trades}`);
        console.log(`   🕒 Створено: ${config.created_at}`);
      });
    } catch (error) {
      console.log(`❌ Помилка отримання конфігурацій: ${error.message}`);
    }
  }

  /**
   * Головний метод діагностики
   */
  async runDiagnostics() {
    console.log('🔧 ДІАГНОСТИКА БАЗИ ДАНИХ BINANCE SIMULATOR');
    console.log('═'.repeat(60));
    
    // Перевірка файлу
    if (!this.checkDatabaseFile()) {
      console.log('\n❌ База даних недоступна. Запустіть: npm run db:init');
      return;
    }
    
    // Підключення
    if (!(await this.connect())) {
      return;
    }
    
    try {
      // Структура БД
      await this.showDatabaseStructure();
      
      // Останні дані
      await this.showRecentData();
      
      // Конфігурації
      await this.showSimulationConfigs();
      
      // Перевірка цілісності
      await this.checkDataIntegrity();
      
      console.log('\n✅ ДІАГНОСТИКА ЗАВЕРШЕНА');
      console.log('═'.repeat(60));
      
    } catch (error) {
      console.error('❌ Помилка під час діагностики:', error);
    } finally {
      if (this.db) {
        await this.db.close();
      }
    }
  }
}

// Запуск діагностики
const diagnostics = new DatabaseDiagnostics();
diagnostics.runDiagnostics().catch(console.error);

export default DatabaseDiagnostics;