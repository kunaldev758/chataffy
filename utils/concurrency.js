/**
 * FIFO concurrency gate — active count never overshoots under contention.
 */
class ConcurrencyLimiter {
  constructor(limit) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.active = 0;
    this.waiters = [];
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise((resolve) => this.waiters.push(resolve));
  }

  release() {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

/** Serialize critical sections (storage reserve, canonical keys, metadata). */
function createAsyncLock() {
  let tail = Promise.resolve();
  return async function withLock(fn) {
    const prev = tail;
    let release;
    tail = new Promise((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

/**
 * Run mapper over items with a max concurrency.
 * Unlike Promise.all(items.map), only `concurrency` tasks run at once.
 */
async function mapWithConcurrency(items, concurrency, mapper) {
  const limiter = new ConcurrencyLimiter(concurrency);
  return Promise.all(
    items.map(async (item, index) => {
      await limiter.acquire();
      try {
        return await mapper(item, index);
      } finally {
        limiter.release();
      }
    }),
  );
}

module.exports = {
  ConcurrencyLimiter,
  createAsyncLock,
  mapWithConcurrency,
};
