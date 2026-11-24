// SPDX-License-Identifier: MIT
// The example project configs in examples/ are documentation; keep them valid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateConfig } from '../src/config.ts';

const dir = join(import.meta.dirname, '..', 'examples');

test('every example project config passes validation', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0, 'no example configs found');
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8');
    assert.ok(!/\/Users\/|\/home\//.test(text), `${file} must use placeholder paths`);
    const cfg = validateConfig(JSON.parse(text));
    assert.equal(cfg.version, 1, file);
  }
});
