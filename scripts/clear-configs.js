import { getDatabase } from '../src/database/init.js';

async function clearConfigs() {
  try {
    const db = await getDatabase();
    
    console.log('🧹 Очищення конфігурацій...');
    
    await db.run('DELETE FROM simulation_summary');
    await db.run('DELETE FROM simulation_results'); 
    await db.run('DELETE FROM simulation_configs');
    
    // Скидаємо AUTO_INCREMENT
    await db.run('DELETE FROM sqlite_sequence WHERE name IN ("simulation_configs", "simulation_results", "simulation_summary")');
    
    console.log('✅ Конфігурації очищені');
    
  } catch (error) {
    console.error('❌ Помилка:', error.message);
  }
}

clearConfigs();