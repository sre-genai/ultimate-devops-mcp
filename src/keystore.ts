import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { logger } from "./logger.js";
import type { KeyIdentity } from "./audit.js";

// ---------------------------------------------------------------------------
// API key store
//
// Issues and verifies bearer secrets for the authenticate middleware. The
// plaintext secret is shown exactly once (at create time) and is NEVER
// persisted or logged — only its sha256 is stored, and that hash doubles as the
// lookup key on verify(). Three interchangeable backends (sqlite/postgres/redis)
// sit behind createKeyStore() so deployments can pick their durability story.
// ---------------------------------------------------------------------------

export interface ApiKeyRecord {
  id: string;
  name: string;
  owner: string; // SSO email/sub of the key's owner
  tools?: string[];
  allowWrites: boolean;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revoked: boolean;
}

export interface KeyStore {
  init(): Promise<void>;
  /** Returns the record PLUS the one-time plaintext secret (only chance to see it). */
  create(input: {
    name: string;
    owner: string;
    tools?: string[];
    allowWrites: boolean;
    expiresAt?: string;
  }): Promise<{ record: ApiKeyRecord; secret: string }>;
  /** Hash the presented secret, look it up; reject if missing/revoked/expired;
   * best-effort touch lastUsedAt; return a KeyIdentity or undefined. */
  verify(secret: string): Promise<KeyIdentity | undefined>;
  /** All of an owner's keys — NEVER includes the secret or its hash. */
  listByOwner(owner: string): Promise<ApiKeyRecord[]>;
  /** Only the owner may revoke their own key. */
  revoke(id: string, owner: string): Promise<boolean>;
  close(): Promise<void>;
}

const SECRET_PREFIX = "udm_live_";

/** sha256(secret) as hex — the only representation of a secret we ever store. */
function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** "udm_live_" + 24 random bytes, base64url-encoded. */
function generateSecret(): string {
  return SECRET_PREFIX + randomBytes(24).toString("base64url");
}

/** Build the persisted record for a create() request. */
function newRecord(input: {
  name: string;
  owner: string;
  tools?: string[];
  allowWrites: boolean;
  expiresAt?: string;
}): ApiKeyRecord {
  return {
    id: randomUUID(),
    name: input.name,
    owner: input.owner,
    tools: input.tools,
    allowWrites: input.allowWrites,
    createdAt: new Date().toISOString(),
    expiresAt: input.expiresAt,
    revoked: false,
  };
}

/** True when a record must be rejected on verify (revoked or past expiry). */
function isUnusable(record: ApiKeyRecord): boolean {
  if (record.revoked) return true;
  if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) return true;
  return false;
}

/** The identity handed to the dispatch layer — no secret material. */
function toIdentity(record: ApiKeyRecord): KeyIdentity {
  return { name: record.name, tools: record.tools, allowWrites: record.allowWrites };
}

// ---------------------------------------------------------------------------
// SQLite backend (default) — node:sqlite DatabaseSync (synchronous API wrapped
// in the async KeyStore contract).
// ---------------------------------------------------------------------------

class SqliteKeyStore implements KeyStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
  }

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        tools TEXT,
        allow_writes INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        last_used_at TEXT,
        revoked INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  async create(input: {
    name: string;
    owner: string;
    tools?: string[];
    allowWrites: boolean;
    expiresAt?: string;
  }): Promise<{ record: ApiKeyRecord; secret: string }> {
    const secret = generateSecret();
    const hash = hashSecret(secret);
    const record = newRecord(input);
    this.db
      .prepare(
        `INSERT INTO api_keys
          (id, name, owner, hash, tools, allow_writes, created_at, expires_at, last_used_at, revoked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.name,
        record.owner,
        hash,
        record.tools ? JSON.stringify(record.tools) : null,
        record.allowWrites ? 1 : 0,
        record.createdAt,
        record.expiresAt ?? null,
        null,
        0,
      );
    return { record, secret };
  }

  async verify(secret: string): Promise<KeyIdentity | undefined> {
    const hash = hashSecret(secret);
    const row = this.db
      .prepare(`SELECT * FROM api_keys WHERE hash = ?`)
      .get(hash) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const record = sqliteRowToRecord(row);
    if (isUnusable(record)) return undefined;
    // Best-effort touch — a failed timestamp update must not fail the request.
    try {
      this.db
        .prepare(`UPDATE api_keys SET last_used_at = ? WHERE hash = ?`)
        .run(new Date().toISOString(), hash);
    } catch (err) {
      logger.warn({ err: String(err) }, "keystore: failed to update lastUsedAt");
    }
    return toIdentity(record);
  }

  async listByOwner(owner: string): Promise<ApiKeyRecord[]> {
    const rows = this.db
      .prepare(`SELECT * FROM api_keys WHERE owner = ? ORDER BY created_at DESC`)
      .all(owner) as Record<string, unknown>[];
    return rows.map(sqliteRowToRecord);
  }

  async revoke(id: string, owner: string): Promise<boolean> {
    const res = this.db
      .prepare(`UPDATE api_keys SET revoked = 1 WHERE id = ? AND owner = ? AND revoked = 0`)
      .run(id, owner);
    return res.changes > 0;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/** Map a raw sqlite row (snake_case, integer flags) to an ApiKeyRecord. */
function sqliteRowToRecord(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    owner: row.owner as string,
    tools: row.tools ? (JSON.parse(row.tools as string) as string[]) : undefined,
    allowWrites: Number(row.allow_writes) === 1,
    createdAt: row.created_at as string,
    expiresAt: (row.expires_at as string | null) ?? undefined,
    lastUsedAt: (row.last_used_at as string | null) ?? undefined,
    revoked: Number(row.revoked) === 1,
  };
}

// ---------------------------------------------------------------------------
// Postgres backend — pg Pool, parameterized queries only.
// ---------------------------------------------------------------------------

class PostgresKeyStore implements KeyStore {
  // Typed loosely to avoid importing pg types at module scope (optional dep).
  private pool: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>; end: () => Promise<void> };

  constructor(pool: any) {
    this.pool = pool;
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        tools TEXT,
        allow_writes INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        last_used_at TEXT,
        revoked INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  async create(input: {
    name: string;
    owner: string;
    tools?: string[];
    allowWrites: boolean;
    expiresAt?: string;
  }): Promise<{ record: ApiKeyRecord; secret: string }> {
    const secret = generateSecret();
    const hash = hashSecret(secret);
    const record = newRecord(input);
    await this.pool.query(
      `INSERT INTO api_keys
        (id, name, owner, hash, tools, allow_writes, created_at, expires_at, last_used_at, revoked)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        record.id,
        record.name,
        record.owner,
        hash,
        record.tools ? JSON.stringify(record.tools) : null,
        record.allowWrites ? 1 : 0,
        record.createdAt,
        record.expiresAt ?? null,
        null,
        0,
      ],
    );
    return { record, secret };
  }

  async verify(secret: string): Promise<KeyIdentity | undefined> {
    const hash = hashSecret(secret);
    const res = await this.pool.query(`SELECT * FROM api_keys WHERE hash = $1`, [hash]);
    const row = res.rows[0];
    if (!row) return undefined;
    const record = pgRowToRecord(row);
    if (isUnusable(record)) return undefined;
    try {
      await this.pool.query(`UPDATE api_keys SET last_used_at = $1 WHERE hash = $2`, [
        new Date().toISOString(),
        hash,
      ]);
    } catch (err) {
      logger.warn({ err: String(err) }, "keystore: failed to update lastUsedAt");
    }
    return toIdentity(record);
  }

  async listByOwner(owner: string): Promise<ApiKeyRecord[]> {
    const res = await this.pool.query(
      `SELECT * FROM api_keys WHERE owner = $1 ORDER BY created_at DESC`,
      [owner],
    );
    return res.rows.map(pgRowToRecord);
  }

  async revoke(id: string, owner: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE api_keys SET revoked = 1 WHERE id = $1 AND owner = $2 AND revoked = 0`,
      [id, owner],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Map a pg row (snake_case) to an ApiKeyRecord. */
function pgRowToRecord(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    owner: row.owner as string,
    tools: row.tools ? (JSON.parse(row.tools as string) as string[]) : undefined,
    allowWrites: Number(row.allow_writes) === 1,
    createdAt: row.created_at as string,
    expiresAt: (row.expires_at as string | null) ?? undefined,
    lastUsedAt: (row.last_used_at as string | null) ?? undefined,
    revoked: Number(row.revoked) === 1,
  };
}

// ---------------------------------------------------------------------------
// Redis backend — one JSON blob per record keyed by hash, plus secondary
// indexes for owner-listing and id-based revoke.
//
//   udm:apikey:<hash>          -> JSON(ApiKeyRecord)
//   udm:apikeys:owner:<owner>  -> SET of hashes
//   udm:apikey:id:<id>         -> hash
// ---------------------------------------------------------------------------

class RedisKeyStore implements KeyStore {
  // Loosely typed to avoid importing ioredis types at module scope (optional dep).
  private redis: any;

  constructor(redis: any) {
    this.redis = redis;
  }

  private recordKey(hash: string): string {
    return `udm:apikey:${hash}`;
  }
  private ownerKey(owner: string): string {
    return `udm:apikeys:owner:${owner}`;
  }
  private idKey(id: string): string {
    return `udm:apikey:id:${id}`;
  }

  async init(): Promise<void> {
    // Redis is schemaless — nothing to create.
  }

  async create(input: {
    name: string;
    owner: string;
    tools?: string[];
    allowWrites: boolean;
    expiresAt?: string;
  }): Promise<{ record: ApiKeyRecord; secret: string }> {
    const secret = generateSecret();
    const hash = hashSecret(secret);
    const record = newRecord(input);
    await this.redis.set(this.recordKey(hash), JSON.stringify(record));
    await this.redis.sadd(this.ownerKey(record.owner), hash);
    await this.redis.set(this.idKey(record.id), hash);
    return { record, secret };
  }

  async verify(secret: string): Promise<KeyIdentity | undefined> {
    const hash = hashSecret(secret);
    const raw = await this.redis.get(this.recordKey(hash));
    if (!raw) return undefined;
    const record = JSON.parse(raw) as ApiKeyRecord;
    if (isUnusable(record)) return undefined;
    try {
      record.lastUsedAt = new Date().toISOString();
      await this.redis.set(this.recordKey(hash), JSON.stringify(record));
    } catch (err) {
      logger.warn({ err: String(err) }, "keystore: failed to update lastUsedAt");
    }
    return toIdentity(record);
  }

  async listByOwner(owner: string): Promise<ApiKeyRecord[]> {
    const hashes: string[] = await this.redis.smembers(this.ownerKey(owner));
    if (hashes.length === 0) return [];
    const raws: (string | null)[] = await this.redis.mget(
      ...hashes.map((h) => this.recordKey(h)),
    );
    const records = raws
      .filter((r): r is string => r !== null)
      .map((r) => JSON.parse(r) as ApiKeyRecord);
    records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return records;
  }

  async revoke(id: string, owner: string): Promise<boolean> {
    const hash: string | null = await this.redis.get(this.idKey(id));
    if (!hash) return false;
    const raw = await this.redis.get(this.recordKey(hash));
    if (!raw) return false;
    const record = JSON.parse(raw) as ApiKeyRecord;
    // Only the owner may revoke; do nothing if already revoked.
    if (record.owner !== owner || record.revoked) return false;
    record.revoked = true;
    await this.redis.set(this.recordKey(hash), JSON.stringify(record));
    return true;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createKeyStore(opts: {
  backend: "sqlite" | "postgres" | "redis";
  sqlitePath?: string;
  postgresUrl?: string;
  redisUrl?: string;
}): KeyStore {
  switch (opts.backend) {
    case "sqlite":
      return new SqliteKeyStore(opts.sqlitePath ?? "./udm-keys.db");
    case "postgres": {
      if (!opts.postgresUrl) throw new Error("keystore: postgres backend requires postgresUrl");
      // Dynamic-ish require to keep pg optional at load time for sqlite/redis users.
      const require = createRequire(import.meta.url);
      const { Pool } = require("pg");
      return new PostgresKeyStore(new Pool({ connectionString: opts.postgresUrl }));
    }
    case "redis": {
      if (!opts.redisUrl) throw new Error("keystore: redis backend requires redisUrl");
      const require = createRequire(import.meta.url);
      const Redis = require("ioredis");
      // ioredis default export is the client constructor.
      const RedisCtor = Redis.default ?? Redis;
      return new RedisKeyStore(new RedisCtor(opts.redisUrl));
    }
    default: {
      const _exhaustive: never = opts.backend;
      throw new Error(`keystore: unknown backend ${String(_exhaustive)}`);
    }
  }
}
