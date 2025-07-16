#!/usr/bin/env node

import 'dotenv/config';
import { getDatabase } from '../src/database/init.js';
import { ResultAnalyzer } from '../src/analysis/resultAnalyzer.js';
import { ReportGenerator } from '../src/analysis/reportGenerator.js';
import chalk from 'chalk';
import fs from 'fs/promises';

async function main() {
  console.log(chalk.cyan('\n📊 Analyzing simulation results...\n'));
  
  try {
    const db = getDatabase();
    
    // Перевірка наявності результатів
    const resultCount = db.prepare('SELECT COUNT(*) as count FROM simulation_results').get().count;
    if (resultCount === 0) {
      console.log(chalk.red('\n❌ No simulation results found! Please run simulation first:'));
      console.log(chalk.white('   npm run simulate\n'));
      process.exit(1);
    }
    
    console.log(chalk.green(`✅ Found ${resultCount} simulation results\n`));
    
    // Аналіз результатів
    const analyzer = new ResultAnalyzer();
    
    console.log(chalk.yellow('🔍 Analyzing configurations...'));
    const configAnalysis = await analyzer.analyzeConfigurations();
    
    console.log(chalk.yellow('📈 Analyzing time patterns...'));
    const timePatterns = await analyzer.analyzeTimePatterns();
    
    console.log(chalk.yellow('💰 Analyzing profit distribution...'));
    const profitDistribution = await analyzer.analyzeProfitDistribution();
    
    console.log(chalk.yellow('🔄 Analyzing trailing stop effectiveness...'));
    const trailingStopAnalysis = await analyzer.analyzeTrailingStopEffectiveness();
    
    // Генерація звіту
    console.log(chalk.yellow('\n📄 Generating report...'));
    const reportGenerator = new ReportGenerator();
    const report = await reportGenerator.generateFullReport({
      configAnalysis,
      timePatterns,
      profitDistribution,
      trailingStopAnalysis
    });
    
    // Збереження звіту
    const reportPath = `reports/simulation_report_${Date.now()}.json`;
    await fs.mkdir('reports', { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(chalk.green(`\n✅ Report saved to: ${reportPath}\n`));
    
    // Виведення ключових висновків
    displayKeyFindings(report);
    
    console.log(chalk.green('\n✨ Analysis completed successfully!\n'));
    
  } catch (error) {
    console.error(chalk.red('\n❌ Error during analysis:'), error);
    process.exit(1);
  }
}

function displayKeyFindings(report) {
  console.log(chalk.cyan('🎯 Key Findings:\n'));
  
  const { recommendations } = report;
  
  console.log(chalk.white('📊 Best Configuration:'));
  console.log(chalk.green(`   ${recommendations.bestConfig.name}`));
  console.log(chalk.white(`   • Take Profit: ${(recommendations.bestConfig.takeProfitPercent * 100).toFixed(0)}%`));
  console.log(chalk.white(`   • Stop Loss: ${(recommendations.bestConfig.stopLossPercent * 100).toFixed(0)}%`));
  console.log(chalk.white(`   • Position Size: $${recommendations.bestConfig.buyAmountUsdt}`));
  if (recommendations.bestConfig.trailingStopEnabled) {
    console.log(chalk.white(`   • Trailing Stop: ${(recommendations.bestConfig.trailingStopPercent * 100).toFixed(0)}% (activates at +${(recommendations.bestConfig.trailingStopActivationPercent * 100).toFixed(0)}%)`));
  }
  console.log(chalk.yellow(`   • Expected ROI: ${recommendations.bestConfig.expectedROI.toFixed(2)}%`));
  console.log(chalk.yellow(`   • Win Rate: ${recommendations.bestConfig.expectedWinRate.toFixed(2)}%\n`));
  
  console.log(chalk.white('⏰ Best Trading Times:'));
  recommendations.tradingTimes.forEach(time => {
    console.log(chalk.white(`   • ${time.window}: ${time.winRate.toFixed(1)}% win rate`));
  });
  
  console.log(chalk.white('\n⚠️  Risk Warnings:'));
  recommendations.warnings.forEach(warning => {
    console.log(chalk.yellow(`   • ${warning}`));
  });
  
  console.log(chalk.white('\n💡 Implementation Tips:'));
  recommendations.tips.forEach(tip => {
    console.log(chalk.blue(`   • ${tip}`));
  });
}

// Запуск
main().catch(console.error);