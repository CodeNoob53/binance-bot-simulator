import logger from '../utils/logger.js';
import { sleep } from '../utils/helpers.js';
import PQueue from 'p-queue';
import cliProgress from 'cli-progress';

export class WorkerManager {
  constructor(workersCount = 10) {
    this.workersCount = workersCount;
    this.queue = new PQueue({ concurrency: workersCount });
  }
  
  async processWithWorkers(items, processingFunction) {
    logger.info(`Starting ${this.workersCount} workers to process ${items.length} items`);
    
    // Створюємо progress bar
    const progressBar = new cliProgress.SingleBar({
      format: 'Progress |{bar}| {percentage}% | {value}/{total} | ETA: {eta_formatted}',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true
    });
    
    progressBar.start(items.length, 0);
    
    const results = [];
    let processed = 0;
    
    // Додаємо всі завдання в чергу
    const promises = items.map((item, index) => 
      this.queue.add(async () => {
        try {
          const result = await processingFunction(item);
          processed++;
          progressBar.update(processed);
          return result;
        } catch (error) {
          logger.error(`Worker error processing item ${index}:`, error);
          processed++;
          progressBar.update(processed);
          return { success: false, error: error.message };
        }
      })
    );
    
    // Чекаємо завершення всіх завдань
    const allResults = await Promise.allSettled(promises);
    
    progressBar.stop();
    
    // Обробляємо результати
    for (const result of allResults) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        results.push({ success: false, error: result.reason });
      }
    }
    
    // Підсумкова статистика
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    
    logger.info(`Workers completed: ${successful} successful, ${failed} failed`);
    
    return results;
  }
  
  async processInBatches(items, batchSize, processingFunction) {
    const results = [];
    
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      logger.info(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(items.length / batchSize)}`);
      
      const batchResults = await this.processWithWorkers(batch, processingFunction);
      results.push(...batchResults);
      
      // Пауза між батчами
      if (i + batchSize < items.length) {
        await sleep(2000);
      }
    }
    
    return results;
  }
}