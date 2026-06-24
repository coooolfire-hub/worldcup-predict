// ============================================================
// D1 兼容适配层
// 模拟 Cloudflare D1 的 API，让所有业务代码无需改动即可在 Node 运行。
//
// 自动选择 SQLite 实现：
//   - 优先 better-sqlite3（性能好，腾讯云生产环境用，需 npm install）
//   - 回退 node:sqlite（Node 22+ 内置，无需安装，方便快速跑）
// D1 是异步API，这里把同步调用包装成 Promise，保持业务代码的 await 不变。
// ============================================================

let SQLiteImpl = null;
let implName = '';

try {
  const mod = await import('better-sqlite3');
  SQLiteImpl = mod.default;
  implName = 'better-sqlite3';
} catch (e) {
  // better-sqlite3 没装，用 Node 内置的
  const { DatabaseSync } = await import('node:sqlite');
  SQLiteImpl = DatabaseSync;
  implName = 'node:sqlite';
}

console.log(`[数据库] 使用 ${implName}`);

const USING_NODE_SQLITE = implName === 'node:sqlite';

class D1PreparedStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }
  bind(...params) {
    this.params = params;
    return this;
  }
  async first() {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...this.params);
    return row === undefined ? null : row;
  }
  async all() {
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(...this.params);
    return { results: rows, success: true };
  }
  async run() {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...this.params);
    // 两个库的返回字段名一致：lastInsertRowid / changes
    return {
      success: true,
      meta: {
        last_row_id: info.lastInsertRowid,
        changes: info.changes,
      },
    };
  }
}

class D1Database {
  constructor(filename) {
    if (USING_NODE_SQLITE) {
      this.db = new SQLiteImpl(filename);
    } else {
      this.db = new SQLiteImpl(filename);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
    }
  }
  prepare(sql) {
    return new D1PreparedStatement(this.db, sql);
  }
  async batch(statements) {
    const results = [];
    // 简单串行执行（node:sqlite 的事务API和better-sqlite3不同，这里求稳不用事务包装）
    for (const stmt of statements) {
      const prepared = this.db.prepare(stmt.sql);
      const info = prepared.run(...stmt.params);
      results.push({
        success: true,
        meta: { last_row_id: info.lastInsertRowid, changes: info.changes },
      });
    }
    return results;
  }
  exec(sql) {
    this.db.exec(sql);
  }
}

export function createDB(filename) {
  return new D1Database(filename);
}
