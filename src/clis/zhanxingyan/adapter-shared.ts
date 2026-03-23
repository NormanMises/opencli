import { CliError } from '../../errors.js';
import type { IPage } from '../../types.js';

export const ZHANXINGYAN_ROOT = 'https://www.zhanxingyan.cn';
export const SCHOOL_LIST_URL = `${ZHANXINGYAN_ROOT}/school/list/yx`;
export const ADJUST_LIST_URL = `${ZHANXINGYAN_ROOT}/adjust/list`;

export function requireBrowserPage(page: IPage | null): asserts page is IPage {
  if (!page) {
    throw new CliError(
      'BROWSER_CONNECT',
      '需要可用的 Browser Bridge 会话。',
      '请先确认 Chrome 已安装 Browser Bridge 扩展，并执行 opencli doctor。',
    );
  }
}

export async function openPage(page: IPage, url: string, settleMs = 2500): Promise<void> {
  await page.goto(url, { settleMs });
  await page.wait(1);
}

export async function assertPageReady(
  page: IPage,
  url: string,
  description: string,
  detector: string,
): Promise<void> {
  await openPage(page, url);
  const ready = await page.evaluate(`
    (() => {
      ${browserPrelude()}
      return !!(${detector});
    })()
  `);
  if (!ready) {
    throw new CliError(
      'COMMAND_EXEC',
      `未能进入${description}。`,
      `请先在 Chrome 中手动打开 ${url}，确认页面结构没有变化后再重试。`,
    );
  }
}

export function normalizeReportType(input: unknown): '复试名单' | '录取名单' {
  const value = String(input ?? '').trim();
  if (value === '复试名单' || value === '录取名单') return value;
  throw new CliError(
    'INVALID_ARG',
    `不支持的数据类型: ${value}`,
    '请使用“复试名单”或“录取名单”。',
  );
}

export function normalizeScore(value: unknown): number {
  const score = Number(value);
  if (!Number.isFinite(score)) {
    throw new CliError('INVALID_ARG', `分数无效: ${value}`, '请传入数字，例如 --score 360');
  }
  return Math.round(score);
}

export function normalizeMajorCode(value: unknown): string {
  const code = String(value ?? '').trim().toUpperCase();
  if (!/^[0-9A-Z]{6}$/.test(code)) {
    throw new CliError(
      'INVALID_ARG',
      `专业代码无效: ${code}`,
      '请传入 6 位专业代码，例如 --major-code 025100 或 --major-code 0812J6',
    );
  }
  return code;
}

export function normalizeMajorSelector(value: unknown): string {
  const code = String(value ?? '').trim().toUpperCase();
  if (!/^\d{4}([0-9A-Z]{2})?$/.test(code)) {
    throw new CliError(
      'INVALID_ARG',
      `专业代码无效: ${code}`,
      '请传入 4 位专业前缀或 6 位专业代码，例如 --major-code 0812、--major-code 085400 或 --major-code 0812J6',
    );
  }
  return code;
}

export function normalizeMajorPrefix(value: unknown): string {
  const code = String(value ?? '').trim();
  if (!/^\d{4}$/.test(code)) {
    throw new CliError(
      'INVALID_ARG',
      `专业前缀无效: ${code}`,
      '请传入 4 位专业前缀，例如 --major-prefix 0454',
    );
  }
  return code;
}

export function inferDegreeLabelsByCode(code: string): string[] {
  return String(code).startsWith('0')
    ? ['专业学位', '学术学位']
    : ['学术学位', '专业学位'];
}

export function browserPrelude(): string {
  return `
    const normalize = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const isVisible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const textOf = (el) => normalize(el && (el.innerText || el.textContent));
    const exactMatch = (text, target) => normalize(text) === normalize(target);
    const containsMatch = (text, target) => normalize(text).includes(normalize(target));
    const byText = (selectors, target, exact = true) => {
      const nodes = Array.from(document.querySelectorAll(selectors));
      return nodes.find((node) => {
        if (!isVisible(node)) return false;
        const text = textOf(node);
        return exact ? exactMatch(text, target) : containsMatch(text, target);
      }) || null;
    };
    const dispatchInput = (el, value) => {
      if (!el) return false;
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const findInputByPlaceholder = (keyword) => {
      return Array.from(document.querySelectorAll('input')).find((node) => {
        const placeholder = normalize(node.getAttribute('placeholder'));
        return placeholder.includes(normalize(keyword));
      }) || null;
    };
    const dismissLoginDialog = () => {
      const dialog = Array.from(document.querySelectorAll('.el-message-box, [role="dialog"]')).find((node) => {
        const text = textOf(node);
        return text.includes('您还未登录') || text.includes('前往登录');
      });
      if (!dialog) return false;
      const cancel = Array.from(dialog.querySelectorAll('button, .el-button')).find((node) => {
        const text = textOf(node);
        return text === '取消' || text === '关闭';
      });
      if (cancel) cancel.click();
      return true;
    };
    const findSchoolCards = () => {
      return Array.from(document.querySelectorAll('a'))
        .filter((link) => String(link.getAttribute('href') || '').includes('/school/schoolmajor/'))
        .map((link) => {
          const card = link.closest('.school-card, .school-item, .item, li, .el-card') || link.parentElement;
          return {
            name: textOf(card),
            majorsUrl: new URL(link.getAttribute('href') || '', location.href).href,
          };
        })
        .filter((item) => item.majorsUrl);
    };
  `;
}
