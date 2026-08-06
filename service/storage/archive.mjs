/**
 * SPDX-License-Identifier: Apache-2.0
 * [INPUT]: 一个已完成组的全部 terminal item
 * [OUTPUT]: SQLite 里的归档行（只有文字与元数据，没有 WAV 二进制），以及最小查询接口
 * [POS]: docs/061 §七.4/§七.5。归档是**删除 WAV 的前置条件**，不是它的副产品——
 *        顺序永远是「先 commit，再删文件」，反过来就是把音频扔进一个没写成的事务里。
 * [PROTOCOL]: 只用 `node:sqlite`（Termux 的 Node 自带）；⛔ 不引入 npm/native 依赖。
 *             用前先跑一次最小兼容测试：拿不准的运行时不如明确报出来，
 *             而不是在第一次归档、也就是第一次要删文件的时候才发现。
 *             变更时更新此头部，然后检查 CLAUDE.md
 */
import fs from 'node:fs';
import path from 'node:path';

export const ARCHIVE_SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS archived_groups (
  group_id     TEXT PRIMARY KEY,
  group_seq    INTEGER NOT NULL,
  item_count   INTEGER NOT NULL,
  created_at   TEXT,
  completed_at TEXT,
  archived_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS archived_items (
  segment_id       TEXT PRIMARY KEY,
  group_id         TEXT NOT NULL,
  item_seq         INTEGER NOT NULL,
  status           TEXT NOT NULL,
  text             TEXT,
  model_id         TEXT,
  model_runtime    TEXT,
  inference_ms     INTEGER,
  segment_start_ms INTEGER,
  segment_end_ms   INTEGER,
  duration_ms      INTEGER,
  created_at       TEXT,
  completed_at     TEXT,
  error            TEXT,
  -- 归档即意味着 WAV 已经（或即将）被删除。这一列是**事实**不是意图：
  -- 「文字还在但音频没了」必须能被查询方直接读出来，而不是靠猜。
  wav_available    INTEGER NOT NULL DEFAULT 0,
  archived_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS archived_items_group ON archived_items(group_id, item_seq);
`;

export class RecordArchive {
  constructor({ file, sqlite = null }) {
    this.file = file;
    this.sqlite = sqlite;
    this.db = null;
    this.available = false;
    this.lastError = null;
    this.compat = null;
    /**
     * ⭐ 计数缓存（docs/061 §九）。
     *
     * `stats()` 曾经每次都 `prepare` 两条 `SELECT COUNT(*)` 并全表扫描，而它挂在
     * `/live` 上、每秒被调用四次——两张随归档单调增长的表，一天扫几十万次，
     * 回答的却是一个只在轮转那一刻才会变的数。现在只在写入后失效。
     */
    this.counts = null;
    this.statements = null;
  }

  /** 预备语句复用。⚠ 每次 `prepare` 都要重新编译 SQL，那是纯粹的重复劳动。 */
  sql(key, text) {
    if (!this.statements) this.statements = new Map();
    let statement = this.statements.get(key);
    if (!statement) {
      statement = this.db.prepare(text);
      this.statements.set(key, statement);
    }
    return statement;
  }

  /**
   * 打开并自检。返回是否可用——**不可用不抛**：本子项停下来如实上报，
   * 上层因此绝不会把「归档失败」误当成「归档成功」而去删 WAV。
   */
  async open() {
    if (this.available) return true;
    try {
      const module = this.sqlite ?? await import('node:sqlite');
      const { DatabaseSync } = module;
      if (typeof DatabaseSync !== 'function') throw new Error('node:sqlite has no DatabaseSync');
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const db = new DatabaseSync(this.file);
      // WAL：崩溃时未提交的事务不会污染已提交的行。
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA synchronous = FULL;');
      db.exec(DDL);
      this.compat = this.selfTest(db);
      if (!this.compat.ok) throw new Error(`node:sqlite self-test failed: ${this.compat.reason}`);
      const stored = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('schema_version');
      if (!stored) {
        db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)')
          .run('schema_version', String(ARCHIVE_SCHEMA_VERSION));
      } else if (Number(stored.value) !== ARCHIVE_SCHEMA_VERSION) {
        // ⚠ 认不出的 schema 明确报错，绝不当成空库继续写——那会让两个版本的行混在一起。
        throw new Error(`archive schema ${stored.value} != ${ARCHIVE_SCHEMA_VERSION}`);
      }
      this.db = db;
      this.statements = null;
      this.counts = null;
      this.available = true;
      this.lastError = null;
      return true;
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      this.available = false;
      return false;
    }
  }

  /** 最小兼容测试：建表→写→读→删。跑不通就说明这个运行时的 sqlite 不能用来放证据。 */
  selfTest(db) {
    try {
      db.exec('CREATE TABLE IF NOT EXISTS __probe (id INTEGER PRIMARY KEY, v TEXT);');
      db.exec('BEGIN');
      db.prepare('INSERT OR REPLACE INTO __probe (id, v) VALUES (?, ?)').run(1, 'ok');
      db.exec('COMMIT');
      const row = db.prepare('SELECT v FROM __probe WHERE id = ?').get(1);
      db.exec('DROP TABLE __probe');
      if (row?.v !== 'ok') return { ok: false, reason: `probe read back ${JSON.stringify(row)}` };
      return { ok: true, at_ms: Date.now() };
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) };
    }
  }

  isArchived(groupId) {
    if (!this.available) return false;
    try {
      return Boolean(this.sql('is_archived', 'SELECT 1 FROM archived_groups WHERE group_id = ?').get(groupId));
    } catch { return false; }
  }

  /**
   * 归档一个组。**整组一个事务**：要么全部落库，要么一行都没有——
   * 半个组落库之后去删 WAV，丢掉的那部分谁也找不回来。
   * 幂等：重复归档不产生重复行，且会把上次没写全的字段补上（§七.5）。
   */
  archiveGroup(group, items) {
    if (!this.available) return { ok: false, reason: 'archive_unavailable', error: this.lastError };
    const archivedAt = new Date().toISOString();
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const upsertItem = this.db.prepare(`
        INSERT INTO archived_items (
          segment_id, group_id, item_seq, status, text, model_id, model_runtime, inference_ms,
          segment_start_ms, segment_end_ms, duration_ms, created_at, completed_at, error,
          wav_available, archived_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(segment_id) DO UPDATE SET
          status = excluded.status, text = excluded.text, model_id = excluded.model_id,
          model_runtime = excluded.model_runtime, inference_ms = excluded.inference_ms,
          completed_at = excluded.completed_at, error = excluded.error,
          wav_available = excluded.wav_available, archived_at = excluded.archived_at
      `);
      for (const item of items) {
        upsertItem.run(
          String(item.segment_id),
          String(group.group_id),
          Number(item.item_seq) || 0,
          String(item.status ?? 'pending'),
          item.text ?? null,
          item.model?.id ?? null,
          item.model?.runtime ?? null,
          Number.isFinite(Number(item.inference_ms)) ? Math.round(Number(item.inference_ms)) : null,
          Number.isFinite(Number(item.segment_start_ms)) ? Math.round(Number(item.segment_start_ms)) : null,
          Number.isFinite(Number(item.segment_end_ms)) ? Math.round(Number(item.segment_end_ms)) : null,
          Number.isFinite(Number(item.duration_ms)) ? Math.round(Number(item.duration_ms)) : null,
          item.created_at ?? null,
          item.completed_at ?? null,
          item.error ?? null,
          0,
          archivedAt,
        );
      }
      this.db.prepare(`
        INSERT INTO archived_groups (group_id, group_seq, item_count, created_at, completed_at, archived_at)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(group_id) DO UPDATE SET
          item_count = excluded.item_count, completed_at = excluded.completed_at,
          archived_at = excluded.archived_at
      `).run(
        String(group.group_id),
        Number(group.group_seq) || 0,
        items.length,
        group.created_at ?? null,
        group.completed_at ?? null,
        archivedAt,
      );
      this.db.exec('COMMIT');
      // 写成功了才让计数过期。失败时旧计数仍然是对的。
      this.counts = null;
      return { ok: true, group_id: group.group_id, rows: items.length, archived_at: archivedAt };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* 事务可能已经不在了。 */ }
      this.lastError = String(error?.message ?? error);
      return { ok: false, reason: 'commit_failed', error: this.lastError };
    }
  }

  /** 最小内部查询：用来验证归档内容确实落了库（§七.6）。 */
  query({ limit = 20, groupId = null } = {}) {
    if (!this.available) return { available: false, error: this.lastError, items: [] };
    const bounded = Math.max(1, Math.min(200, Number(limit) || 20));
    try {
      const rows = groupId
        ? this.db.prepare(
          'SELECT * FROM archived_items WHERE group_id = ? ORDER BY item_seq DESC LIMIT ?',
        ).all(String(groupId), bounded)
        : this.db.prepare(
          'SELECT * FROM archived_items ORDER BY archived_at DESC, item_seq DESC LIMIT ?',
        ).all(bounded);
      return {
        available: true,
        items: rows.map((row) => ({ ...row, wav_available: row.wav_available === 1 })),
      };
    } catch (error) {
      return { available: true, error: String(error?.message ?? error), items: [] };
    }
  }

  stats() {
    const base = {
      schema: 'termux-os.speech-archive.v1',
      schema_version: ARCHIVE_SCHEMA_VERSION,
      file: this.file,
      available: this.available,
      compat: this.compat,
      last_error: this.lastError,
    };
    if (!this.available) return { ...base, groups: 0, items: 0 };
    if (this.counts) return { ...base, ...this.counts };
    try {
      this.counts = {
        groups: this.sql('count_groups', 'SELECT COUNT(*) AS n FROM archived_groups').get().n,
        items: this.sql('count_items', 'SELECT COUNT(*) AS n FROM archived_items').get().n,
      };
      return { ...base, ...this.counts };
    } catch (error) {
      return { ...base, groups: null, items: null, last_error: String(error?.message ?? error) };
    }
  }

  close() {
    this.statements = null;
    this.counts = null;
    try { this.db?.close(); } catch { /* Already closed. */ }
    this.db = null;
    this.available = false;
  }
}
