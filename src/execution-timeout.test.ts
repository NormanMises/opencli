import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerCommand, getRegistry, Strategy, type InternalCliCommand } from './registry.js';

const { runWithTimeoutMock, browserSessionMock, getBrowserFactoryMock } = vi.hoisted(() => ({
  runWithTimeoutMock: vi.fn(async (promise: Promise<unknown>) => promise),
  browserSessionMock: vi.fn(async (_BrowserFactory: unknown, fn: (page: any) => Promise<unknown>) => fn({
    goto: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
  })),
  getBrowserFactoryMock: vi.fn(() => class {
    async connect() { return { goto: async () => {}, wait: async () => {} }; }
    async close() {}
  }),
}));

vi.mock('./runtime.js', () => ({
  getBrowserFactory: getBrowserFactoryMock,
  browserSession: browserSessionMock,
  runWithTimeout: runWithTimeoutMock,
  DEFAULT_BROWSER_COMMAND_TIMEOUT: 60,
}));

import { executeCommand } from './execution.js';

describe('executeCommand lazy timeout', () => {
  const tempDirs: string[] = [];
  const cleanupKeys: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    runWithTimeoutMock.mockImplementation(async (promise: Promise<unknown>) => promise);
    browserSessionMock.mockImplementation(async (_BrowserFactory: unknown, fn: (page: any) => Promise<unknown>) => fn({
      goto: vi.fn(async () => {}),
      wait: vi.fn(async () => {}),
    }));
  });

  afterEach(() => {
    for (const key of cleanupKeys.splice(0)) {
      getRegistry().delete(key);
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses resolved command timeoutSeconds for lazy browser commands', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-exec-timeout-'));
    tempDirs.push(dir);
    const modulePath = path.join(dir, 'lazy-browser.ts');
    const registryImport = pathToFileURL(path.join(process.cwd(), 'src', 'registry.ts')).href;
    fs.writeFileSync(modulePath, `
import { cli, Strategy } from '${registryImport}';

cli({
  site: 'lazy-timeout-test',
  name: 'browser-command',
  description: 'lazy browser command',
  strategy: Strategy.COOKIE,
  browser: true,
  timeoutSeconds: 180,
  navigateBefore: false,
  func: async () => [{ ok: true }],
});
`);

    const stub: InternalCliCommand = {
      site: 'lazy-timeout-test',
      name: 'browser-command',
      description: 'lazy browser command',
      strategy: Strategy.COOKIE,
      browser: true,
      args: [],
      source: modulePath,
      navigateBefore: false,
      _lazy: true,
      _modulePath: modulePath,
    };
    const key = 'lazy-timeout-test/browser-command';
    cleanupKeys.push(key);
    registerCommand(stub);

    const result = await executeCommand(stub, {});

    expect(result).toEqual([{ ok: true }]);
    expect(runWithTimeoutMock).toHaveBeenCalledTimes(1);
    expect(runWithTimeoutMock).toHaveBeenCalledWith(
      expect.any(Promise),
      expect.objectContaining({ timeout: 180, label: key }),
    );
  });
});
