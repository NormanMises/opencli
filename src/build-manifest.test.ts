import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseTsArgsBlock, scanTs, shouldReplaceManifestEntry } from './build-manifest.js';

describe('parseTsArgsBlock', () => {
  it('keeps args with nested choices arrays', () => {
    const args = parseTsArgsBlock(`
      {
        name: 'period',
        type: 'string',
        default: 'seven',
        help: 'Stats period: seven or thirty',
        choices: ['seven', 'thirty'],
      },
    `);

    expect(args).toEqual([
      {
        name: 'period',
        type: 'string',
        default: 'seven',
        required: false,
        positional: undefined,
        help: 'Stats period: seven or thirty',
        choices: ['seven', 'thirty'],
      },
    ]);
  });

  it('keeps hyphenated arg names from TS adapters', () => {
    const args = parseTsArgsBlock(`
      {
        name: 'tweet-url',
        help: 'Single tweet URL to download',
      },
      {
        name: 'download-images',
        type: 'boolean',
        default: false,
        help: 'Download images locally',
      },
    `);

    expect(args).toEqual([
      {
        name: 'tweet-url',
        type: 'str',
        default: undefined,
        required: false,
        positional: undefined,
        help: 'Single tweet URL to download',
        choices: undefined,
      },
      {
        name: 'download-images',
        type: 'boolean',
        default: false,
        required: false,
        positional: undefined,
        help: 'Download images locally',
        choices: undefined,
      },
    ]);
  });
});

describe('manifest helper rules', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers TS adapters over duplicate YAML adapters', () => {
    expect(shouldReplaceManifestEntry(
      {
        site: 'demo',
        name: 'search',
        description: 'yaml',
        strategy: 'public',
        browser: false,
        args: [],
        type: 'yaml',
      },
      {
        site: 'demo',
        name: 'search',
        description: 'ts',
        strategy: 'public',
        browser: false,
        args: [],
        type: 'ts',
        modulePath: 'demo/search.js',
      },
    )).toBe(true);

    expect(shouldReplaceManifestEntry(
      {
        site: 'demo',
        name: 'search',
        description: 'ts',
        strategy: 'public',
        browser: false,
        args: [],
        type: 'ts',
        modulePath: 'demo/search.js',
      },
      {
        site: 'demo',
        name: 'search',
        description: 'yaml',
        strategy: 'public',
        browser: false,
        args: [],
        type: 'yaml',
      },
    )).toBe(false);
  });

  it('skips TS files that do not register a cli', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-manifest-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'utils.ts');
    fs.writeFileSync(file, `export function helper() { return 'noop'; }`);

    expect(scanTs(file, 'demo')).toBeNull();
  });

  it('extracts timeoutSeconds from TS adapters into manifest timeout', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-manifest-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'slow.ts');
    const registryImport = pathToFileURL(path.join(process.cwd(), 'src', 'registry.ts')).href;
    fs.writeFileSync(file, `
import { cli, Strategy } from '${registryImport}';

cli({
  site: 'demo',
  name: 'slow',
  description: 'slow command',
  strategy: Strategy.COOKIE,
  browser: true,
  timeoutSeconds: 180,
  navigateBefore: false,
  args: [
    { name: 'query', required: true, help: 'query text' },
  ],
  func: async () => [{ ok: true }],
});
`);

    expect(scanTs(file, 'demo')).toEqual(expect.objectContaining({
      site: 'demo',
      name: 'slow',
      description: 'slow command',
      strategy: 'cookie',
      browser: true,
      timeout: 180,
      navigateBefore: false,
      type: 'ts',
      modulePath: 'demo/slow.js',
      args: [
        {
          name: 'query',
          type: 'str',
          default: undefined,
          required: true,
          positional: undefined,
          help: 'query text',
          choices: undefined,
        },
      ],
    }));
  });
});
