import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import migrations from '../apps/api/dist/database/run-migrations.js';
const source = process.env.AUDIT_DATABASE_URL;
assert.ok(source && new URL(source).pathname.includes('audit'));
const control = new pg.Client({ connectionString: source }); await control.connect();
const name = `gma_pos_audit_upgrade_${Date.now()}`;
const target = new URL(source); target.pathname = `/${name}`;
await control.query(`CREATE DATABASE ${name}`);
const db = new pg.Client({ connectionString: target.toString() }); await db.connect();
try {
  await db.query('CREATE TABLE schema_migrations(filename text PRIMARY KEY, checksum_sha256 char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const file of (await readdir('apps/api/migrations')).filter(f => f.endsWith('.sql') && f < '009').sort()) {
    const sql = await readFile(`apps/api/migrations/${file}`, 'utf8');
    await db.query(sql);
    await db.query('INSERT INTO schema_migrations(filename,checksum_sha256) VALUES($1,$2)', [file, createHash('sha256').update(sql).digest('hex')]);
  }
  const storeId = randomUUID();
  await db.query('INSERT INTO stores(id,name) VALUES($1,$2)', [storeId,'Pre-009 QA store']);
  const result = await migrations.runMigrations(target.toString());
  assert.equal(result.appliedCount,2); assert.equal(result.skippedCount,8);
  assert.equal((await db.query('SELECT name FROM stores WHERE id=$1',[storeId])).rows[0].name,'Pre-009 QA store');
  assert.equal((await db.query('SELECT min_available_cursor FROM store_sync_state WHERE store_id=$1',[storeId])).rows[0].min_available_cursor,'0');
  const rerun = await migrations.runMigrations(target.toString()); assert.equal(rerun.appliedCount,0);assert.equal(rerun.skippedCount,10);
  console.log(JSON.stringify({ok:true,upgrade:result,rerun,preservedStore:true}));
} finally {
 await db.end(); await control.query(`DROP DATABASE ${name}`); await control.end();
}
