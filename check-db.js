#!/usr/bin/env node

import 'dotenv/config';
import { getDatabase } from './src/database/init.js';
import chalk from 'chalk';

async function checkDatabase() {
  console.log(chalk.cyan('\n🔍 Перевірка бази даних...\n'));
  
  try {
    const db = await getDatabase();
    
    // Перевірка існування таблиць
    console.log(chalk.yellow('📋 Існуючі таблиці:'));
    const tables = await db.all(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `);
    
    for (const table of tables) {
      console.log(`   • ${table.name}`);
    }
    console.log();
    
    // Перевірка кількості записів у кожній таблиці
    console.log(chalk.yellow('📊 Кількість записів:'));
    
    for (const table of tables) {
      try {
        const countResult = await db.get(`SELECT COUNT(*) as count FROM ${table.name}`);
        console.log(`   • ${table.name}: ${countResult.count} записів`);
      } catch (error) {
        console.log(`   • ${table.name}: помилка - ${error.message}`);
      }
    }
    console.log();
    
    // Детальна перевірка основних таблиць
    const keyTables = ['simulation_configs', 'simulation_results', 'simulation_summary'];
    
    for (const tableName of keyTables) {
      if (tables.find(t => t.name === tableName)) {
        console.log(chalk.yellow(`🔍 Детальна інформація про ${tableName}:`));
        
        // Структура таблиці
        const schema = await db.all(`PRAGMA table_info(${tableName})`);
        console.log('   Колонки:');
        schema.forEach(col => {
          console.log(`     - ${col.name} (${col.type})`);
        });
        
        // Останні записи
        try {
          const sampleData = await db.all(`SELECT * FROM ${tableName} LIMIT 3`);
          if (sampleData.length > 0) {
            console.log('   Приклад даних:');
            console.table(sampleData);
          } else {
            console.log('   📭 Таблиця порожня');
          }
        } catch (error) {
          console.log(`   ❌ Помилка читання: ${error.message}`);
        }
        console.log();
      }
    }
    
    // Перевірка наявності результатів симуляції
    console.log(chalk.yellow('🎲 Перевірка результатів симуляції:'));
    
    try {
      const configCount = await db.get('SELECT COUNT(*) as count FROM simulation_configs');
      const resultCount = await db.get('SELECT COUNT(*) as count FROM simulation_results');
      const summaryCount = await db.get('SELECT COUNT(*) as count FROM simulation_summary');
      
      console.log(`   • Конфігурації: ${configCount.count}`);
      console.log(`   • Результати угод: ${resultCount.count}`);
      console.log(`   • Зведена статистика: ${summaryCount.count}`);
      
      if (resultCount.count === 0) {
        console.log(chalk.red('\n❌ Немає результатів симуляції!'));
        console.log(chalk.white('   Можливі причини:'));
        console.log(chalk.white('   1. Симуляція не завершилась успішно'));
        console.log(chalk.white('   2. Помилка збереження в БД'));
        console.log(chalk.white('   3. Неправильні таблиці чи структура'));
      } else {
        console.log(chalk.green('\n✅ Результати симуляції знайдені!'));
      }
      
    } catch (error) {
      console.log(chalk.red(`❌ Помилка перевірки: ${error.message}`));
    }
    
    console.log(chalk.green('\n🎉 Перевірка завершена!\n'));
    
  } catch (error) {
    console.error(chalk.red('\n❌ Помилка з\'єднання з БД:'), error);
    process.exit(1);
  }
}

checkDatabase().catch(console.error);