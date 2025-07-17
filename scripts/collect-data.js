#!/usr/bin/env node

import 'dotenv/config';
import { initializeDatabase } from '../src/database/init.js';
import { SymbolCollector } from '../src/collectors/symbolCollector.js';
import { ListingAnalyzer } from '../src/collectors/listingAnalyzer.js';
import { KlineCollector } from '../src/collectors/klineCollector.js';
import logger from '../src/utils/logger.js';
import chalk from 'chalk';

async function main() {
  console.log(chalk.cyan('\n🚀 Starting historical data collection...\n'));
  
  try {
    // Ініціалізація БД
    console.log(chalk.yellow('📊 Initializing database...'));
    await initializeDatabase();
    
    // Етап 1: Збір символів
    console.log(chalk.yellow('\n📋 Stage 1: Collecting USDT symbols...'));
    const symbolCollector = new SymbolCollector();
    const symbolCount = await symbolCollector.collectAllUSDTSymbols();
    console.log(chalk.green(`✅ Collected ${symbolCount} USDT symbols\n`));
    
    // Етап 2: Аналіз дат лістингу
    console.log(chalk.yellow('🔍 Stage 2: Analyzing listing dates...'));
    const listingAnalyzer = new ListingAnalyzer();
    const analysisResults = await listingAnalyzer.analyzeListingDates();
    console.log(chalk.green(`✅ Analyzed ${analysisResults.analyzed} symbols`));
    console.log(chalk.red(`❌ Failed: ${analysisResults.failed} symbols\n`));
    
    // Етап 3: Збір хвилинних даних для нових лістингів
    console.log(chalk.yellow('📈 Stage 3: Collecting minute klines for new listings...'));
    const klineCollector = new KlineCollector();
    const klineResults = await klineCollector.collectRecentListingsData(180); // 180 днів
    console.log(chalk.green(`✅ Collected data for ${klineResults.successful} symbols`));
    console.log(chalk.red(`❌ Failed: ${klineResults.failed} symbols\n`));
    
    // Фінальна статистика
    console.log(chalk.cyan('📊 Final Statistics:'));
    const stats = await getCollectionStats();
    console.log(chalk.white(`   Total symbols: ${stats.totalSymbols}`));
    console.log(chalk.white(`   Analyzed listings: ${stats.analyzedListings}`));
    console.log(chalk.white(`   New listings (180d): ${stats.newListings}`));
    console.log(chalk.white(`   Total klines collected: ${stats.totalKlines}`));
    
    console.log(chalk.green('\n✨ Data collection completed successfully!\n'));
    
  } catch (error) {
    console.error(chalk.red('\n❌ Error during data collection:'), error);
    process.exit(1);
  }
}

async function getCollectionStats() {
  const { getDatabase } = await import('../src/database/init.js');
  const db = await getDatabase();
  
  const stats = {
    totalSymbols: (await db.get('SELECT COUNT(*) as count FROM symbols')).count,
    analyzedListings: (await db.get('SELECT COUNT(*) as count FROM listing_analysis WHERE data_status = "analyzed"')).count,
    newListings: (await db.get(`
      SELECT COUNT(*) as count
      FROM listing_analysis
      WHERE data_status = "analyzed"
      AND listing_date >= ?
    `, Date.now() - (180 * 24 * 60 * 60 * 1000))).count,
    totalKlines: (await db.get('SELECT COUNT(*) as count FROM historical_klines')).count
  };
  
  return stats;
}

// Запуск
main().catch(console.error);

