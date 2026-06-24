// ============================================================
// 数据库初始化脚本
// 运行: node server/init-db.js
// 把所有 schema 文件按顺序建表到 SQLite 文件里。
// 相当于之前的 wrangler d1 execute --file=xxx.sql
// ============================================================

import { createDB } from './d1-adapter.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = process.env.DB_FILE || './worldcup.db';
const SCHEMA_DIR = path.join(__dirname, '../schema');

const SCHEMA_FILES = [
  'schema.sql',
  'seed.sql',
  'auth-schema.sql',
  'event-markets-schema.sql',
];

const db = createDB(DB_FILE);

for (const file of SCHEMA_FILES) {
  const filePath = path.join(SCHEMA_DIR, file);
  if (!fs.existsSync(filePath)) {
    console.log(`⚠ 跳过不存在的文件: ${file}`);
    continue;
  }
  const sql = fs.readFileSync(filePath, 'utf8');
  try {
    db.exec(sql);
    console.log(`✓ 已执行 ${file}`);
  } catch (e) {
    // seed/auth 里可能有重复执行报错（如 ALTER TABLE 重复加列），容错继续
    console.log(`⚠ ${file} 执行时有警告（可能是重复执行）: ${e.message.slice(0, 80)}`);
  }
}

console.log(`\n数据库初始化完成: ${DB_FILE}`);
