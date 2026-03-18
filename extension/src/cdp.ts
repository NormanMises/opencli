/**
 * CDP execution via chrome.debugger API.
 *
 * chrome.debugger only needs the "debugger" permission — no host_permissions.
 * It can attach to any http/https tab. Avoid chrome:// and chrome-extension://
 * tabs (resolveTabId in background.ts filters them).
 */

const attached = new Set<number>();

async function ensureAttached(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('Another debugger is already attached')) {
      throw new Error(`attach failed: ${msg}`);
    }
  }
  attached.add(tabId);

  try {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
  } catch {
    // Some pages may not need explicit enable
  }
}

export async function evaluate(tabId: number, expression: string): Promise<unknown> {
  await ensureAttached(tabId);

  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }) as {
    result?: { type: string; value?: unknown; description?: string; subtype?: string };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  };

  if (result.exceptionDetails) {
    const errMsg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Eval error';
    throw new Error(errMsg);
  }

  return result.result?.value;
}

export const evaluateAsync = evaluate;

export function detach(tabId: number): void {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try { chrome.debugger.detach({ tabId }); } catch { /* ignore */ }
}

export function registerListeners(): void {
  chrome.tabs.onRemoved.addListener((tabId) => {
    attached.delete(tabId);
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId) attached.delete(source.tabId);
  });
}
