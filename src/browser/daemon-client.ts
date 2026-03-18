/**
 * HTTP client for communicating with the opencli daemon.
 *
 * Provides a typed send() function that posts a Command and returns a Result.
 */

const DAEMON_PORT = parseInt(process.env.OPENCLI_DAEMON_PORT ?? '19825', 10);
const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;

let _idCounter = 0;

function generateId(): string {
  return `cmd_${Date.now()}_${++_idCounter}`;
}

export interface DaemonCommand {
  id: string;
  action: 'exec' | 'navigate' | 'tabs' | 'cookies';
  tabId?: number;
  code?: string;
  url?: string;
  op?: string;
  index?: number;
  domain?: string;
}

export interface DaemonResult {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Check if daemon is running.
 */
export async function isDaemonRunning(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${DAEMON_URL}/status`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Check if daemon is running AND the extension is connected.
 */
export async function isExtensionConnected(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${DAEMON_URL}/status`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const data = await res.json() as { extensionConnected?: boolean };
    return !!data.extensionConnected;
  } catch {
    return false;
  }
}

/**
 * Send a command to the daemon and wait for a result.
 */
export async function sendCommand(
  action: DaemonCommand['action'],
  params: Omit<DaemonCommand, 'id' | 'action'> = {},
): Promise<unknown> {
  const id = generateId();
  const command: DaemonCommand = { id, action, ...params };

  const res = await fetch(`${DAEMON_URL}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });

  const result = (await res.json()) as DaemonResult;

  if (!result.ok) {
    throw new Error(result.error ?? 'Daemon command failed');
  }

  return result.data;
}
