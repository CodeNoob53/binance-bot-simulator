import { TradingSimulator } from './simulator.js';
import { SimulationConfigModel } from '../database/models.js';
import logger from '../utils/logger.js';
import fs from 'fs';

export class ParameterOptimizer {
  constructor() {
    this.configModel = new SimulationConfigModel();
    this.bestConfigs = [];
    this.optimizationHistory = [];
  }

  /**
   * Запуск оптимізації параметрів
   */
  async optimize(baseConfig, optimizationParams = {}) {
    logger.info('Starting parameter optimization...');
    
    const {
      takeProfitRange = [0.5, 3.0, 0.5],
      stopLossRange = [0.5, 2.0, 0.5],
      trailingStopRange = [0.2, 1.0, 0.2],
      buyAmountRange = [50, 200, 50],
      maxIterations = 100,
      targetMetric = 'roi_percent'
    } = optimizationParams;

    const combinations = this.generateParameterCombinations({
      takeProfitRange,
      stopLossRange,
      trailingStopRange,
      buyAmountRange,
      maxIterations
    });

    logger.info(`Testing ${combinations.length} parameter combinations`);

    for (let i = 0; i < combinations.length; i++) {
      const config = { ...baseConfig, ...combinations[i] };
      
      try {
        const result = await this.testConfiguration(config);
        
        this.optimizationHistory.push({
          config,
          result,
          iteration: i + 1
        });

        // Оновлюємо топ конфігурації
        this.updateBestConfigs(config, result, targetMetric);
        
        if (i % 10 === 0) {
          logger.info(`Optimization progress: ${i + 1}/${combinations.length}`);
        }
        
      } catch (error) {
        logger.error(`Error testing configuration ${i + 1}: ${error.message}`);
      }
    }

    return this.getBestConfigurations(10);
  }

  /**
   * Генерація комбінацій параметрів
   */
  generateParameterCombinations(ranges) {
    const combinations = [];
    
    const takeProfitValues = this.generateRange(...ranges.takeProfitRange);
    const stopLossValues = this.generateRange(...ranges.stopLossRange);
    const trailingStopValues = this.generateRange(...ranges.trailingStopRange);
    const buyAmountValues = this.generateRange(...ranges.buyAmountRange);

    for (const takeProfit of takeProfitValues) {
      for (const stopLoss of stopLossValues) {
        for (const trailingStop of trailingStopValues) {
          for (const buyAmount of buyAmountValues) {
            // Перевірка логічності параметрів
            if (takeProfit > stopLoss && trailingStop < takeProfit) {
              combinations.push({
                name: `Optimized_TP${takeProfit}_SL${stopLoss}_TS${trailingStop}_BA${buyAmount}`,
                takeProfitPercent: takeProfit,
                stopLossPercent: stopLoss,
                trailingStopPercent: trailingStop,
                trailingStopActivationPercent: takeProfit / 2,
                buyAmountUsdt: buyAmount,
                trailingStopEnabled: true
              });
            }
          }
        }
      }
    }

    // Якщо комбінацій забагато, використовуємо випадкову вибірку
    if (combinations.length > ranges.maxIterations) {
      return this.randomSample(combinations, ranges.maxIterations);
    }

    return combinations;
  }

  /**
   * Генерація діапазону значень
   */
  generateRange(min, max, step) {
    const values = [];
    for (let i = min; i <= max; i += step) {
      values.push(Math.round(i * 100) / 100);
    }
    return values;
  }

  /**
   * Випадкова вибірка з масиву
   */
  randomSample(array, size) {
    const shuffled = [...array].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, size);
  }

  /**
   * Тестування конфігурації
   */
  async testConfiguration(config) {
    const simulator = new TradingSimulator(config);
    return await simulator.runSimulation();
  }

  /**
   * Оновлення топ конфігурацій
   */
  updateBestConfigs(config, result, targetMetric) {
    const entry = {
      config,
      result,
      score: result.summary[targetMetric] || 0
    };

    this.bestConfigs.push(entry);
    
    // Сортуємо за цільовою метрикою
    this.bestConfigs.sort((a, b) => b.score - a.score);
    
    // Залишаємо тільки топ 20
    if (this.bestConfigs.length > 20) {
      this.bestConfigs = this.bestConfigs.slice(0, 20);
    }
  }

  /**
   * Отримання найкращих конфігурацій
   */
  getBestConfigurations(limit = 10) {
    return this.bestConfigs.slice(0, limit).map(entry => ({
      config: entry.config,
      performance: entry.result.summary,
      score: entry.score
    }));
  }

  /**
   * Genetic Algorithm оптимізація
   */
  async geneticOptimization(baseConfig, options = {}) {
    const {
      populationSize = 50,
      generations = 20,
      mutationRate = 0.1,
      crossoverRate = 0.8,
      elitismRate = 0.1
    } = options;

    logger.info(`Starting genetic optimization: ${populationSize} population, ${generations} generations`);

    // Створюємо початкову популяцію
    let population = this.createInitialPopulation(baseConfig, populationSize);
    
    for (let generation = 0; generation < generations; generation++) {
      logger.info(`Generation ${generation + 1}/${generations}`);
      
      // Оцінюємо кожну особину
      const evaluatedPopulation = [];
      for (const individual of population) {
        const result = await this.testConfiguration(individual);
        evaluatedPopulation.push({
          config: individual,
          fitness: result.summary.roi_percent || 0,
          result
        });
      }
      
      // Сортуємо за фітнесом
      evaluatedPopulation.sort((a, b) => b.fitness - a.fitness);
      
      // Елітизм - зберігаємо найкращих
      const eliteCount = Math.floor(populationSize * elitismRate);
      const newPopulation = evaluatedPopulation.slice(0, eliteCount)
        .map(ind => ind.config);
      
      // Створюємо нове покоління
      while (newPopulation.length < populationSize) {
        const parent1 = this.tournamentSelection(evaluatedPopulation);
        const parent2 = this.tournamentSelection(evaluatedPopulation);
        
        let child = this.crossover(parent1.config, parent2.config, crossoverRate);
        child = this.mutate(child, mutationRate);
        
        newPopulation.push(child);
      }
      
      population = newPopulation;
      
      // Логуємо прогрес
      const bestFitness = evaluatedPopulation[0].fitness;
      logger.info(`Best fitness in generation ${generation + 1}: ${bestFitness.toFixed(2)}%`);
    }
    
    // Повертаємо найкращий результат
    const finalResults = [];
    for (const individual of population.slice(0, 5)) {
      const result = await this.testConfiguration(individual);
      finalResults.push({
        config: individual,
        performance: result.summary
      });
    }
    
    return finalResults.sort((a, b) => 
      (b.performance.roi_percent || 0) - (a.performance.roi_percent || 0)
    );
  }

  /**
   * Створення початкової популяції
   */
  createInitialPopulation(baseConfig, size) {
    const population = [];
    
    for (let i = 0; i < size; i++) {
      const individual = {
        ...baseConfig,
        name: `GA_Individual_${i}`,
        takeProfitPercent: this.randomInRange(0.5, 3.0),
        stopLossPercent: this.randomInRange(0.5, 2.0),
        trailingStopPercent: this.randomInRange(0.2, 1.0),
        buyAmountUsdt: this.randomInRange(50, 200),
        trailingStopEnabled: Math.random() > 0.5
      };
      
      // Забезпечуємо логічність параметрів
      individual.trailingStopActivationPercent = individual.takeProfitPercent / 2;
      
      if (individual.takeProfitPercent > individual.stopLossPercent) {
        population.push(individual);
      } else {
        i--; // Повторюємо генерацію
      }
    }
    
    return population;
  }

  /**
   * Турнірний відбір
   */
  tournamentSelection(population, tournamentSize = 3) {
    const tournament = [];
    for (let i = 0; i < tournamentSize; i++) {
      const randomIndex = Math.floor(Math.random() * population.length);
      tournament.push(population[randomIndex]);
    }
    
    return tournament.sort((a, b) => b.fitness - a.fitness)[0];
  }

  /**
   * Схрещування
   */
  crossover(parent1, parent2, crossoverRate) {
    if (Math.random() > crossoverRate) {
      return parent1;
    }
    
    const child = { ...parent1 };
    
    // Змішуємо параметри
    if (Math.random() > 0.5) child.takeProfitPercent = parent2.takeProfitPercent;
    if (Math.random() > 0.5) child.stopLossPercent = parent2.stopLossPercent;
    if (Math.random() > 0.5) child.trailingStopPercent = parent2.trailingStopPercent;
    if (Math.random() > 0.5) child.buyAmountUsdt = parent2.buyAmountUsdt;
    if (Math.random() > 0.5) child.trailingStopEnabled = parent2.trailingStopEnabled;
    
    return child;
  }

  /**
   * Мутація
   */
  mutate(individual, mutationRate) {
    const mutated = { ...individual };
    
    if (Math.random() < mutationRate) {
      mutated.takeProfitPercent = this.randomInRange(0.5, 3.0);
    }
    if (Math.random() < mutationRate) {
      mutated.stopLossPercent = this.randomInRange(0.5, 2.0);
    }
    if (Math.random() < mutationRate) {
      mutated.trailingStopPercent = this.randomInRange(0.2, 1.0);
    }
    if (Math.random() < mutationRate) {
      mutated.buyAmountUsdt = this.randomInRange(50, 200);
    }
    if (Math.random() < mutationRate) {
      mutated.trailingStopEnabled = !mutated.trailingStopEnabled;
    }
    
    return mutated;
  }

  /**
   * Генерація випадкового числа в діапазоні
   */
  randomInRange(min, max) {
    return Math.round((Math.random() * (max - min) + min) * 100) / 100;
  }

  /**
   * Експорт результатів оптимізації
   */
  exportResults(filename = 'optimization_results.json') {
    const data = {
      bestConfigs: this.bestConfigs,
      optimizationHistory: this.optimizationHistory,
      exportDate: new Date().toISOString()
    };
    
    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
    logger.info(`Optimization results exported to ${filename}`);
  }
}

export default ParameterOptimizer;