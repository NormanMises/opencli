import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cli, Strategy } from '../../registry.js';
import { CliError } from '../../errors.js';
import {
  ADJUST_LIST_URL,
  browserPrelude,
  inferDegreeLabelsByCode,
  normalizeMajorPrefix,
  normalizeReportType,
  normalizeScore,
  openPage,
  requireBrowserPage,
} from './adapter-shared.js';

type PdfSnapshotEntry = {
  dir: string;
  name: string;
  fullPath: string;
  mtimeMs: number;
  size: number;
};

const DOWNLOAD_DIR_CANDIDATES = [
  'D:\\download',
  path.join(os.homedir(), 'Downloads'),
];

function pdfSnapshotKey(entry: PdfSnapshotEntry): string {
  return `${entry.fullPath}:${entry.mtimeMs}:${entry.size}`;
}

async function listPdfFiles(dir: string): Promise<PdfSnapshotEntry[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const pdfEntries = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.pdf'))
      .map(async (entry) => {
        const fullPath = path.join(dir, entry.name);
        const stats = await fs.promises.stat(fullPath);
        return {
          dir,
          name: entry.name,
          fullPath,
          mtimeMs: stats.mtimeMs,
          size: stats.size,
        };
      }));
    return pdfEntries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}

async function snapshotPdfDownloads(): Promise<PdfSnapshotEntry[]> {
  const dirs = [...new Set(DOWNLOAD_DIR_CANDIDATES)];
  const files = await Promise.all(dirs.map((dir) => listPdfFiles(dir)));
  return files.flat().sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function waitForNewPdfDownload(before: PdfSnapshotEntry[], timeoutMs = 40000): Promise<PdfSnapshotEntry | null> {
  const known = new Set(before.map((entry) => pdfSnapshotKey(entry)));
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const current = await snapshotPdfDownloads();
    const fresh = current
      .filter((entry) => !known.has(pdfSnapshotKey(entry)))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (fresh.length > 0) {
      return fresh[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return null;
}

function adjustBrowserHelpers(): string {
  return `
    ${browserPrelude()}

    const visibleNodes = (root) => Array.from((root || document).querySelectorAll('span, button, div, label, a'))
      .filter((node) => isVisible(node))
      .map((node) => ({ node, text: textOf(node) }))
      .filter((item) => item.text);

    const findBlock = (keyword) => {
      const candidates = Array.from(document.querySelectorAll('.list-filter-block, .el-card__body, .filter-area, section, form'))
        .filter((node) => isVisible(node) && textOf(node).includes(keyword))
        .map((node) => ({
          node,
          text: textOf(node),
          selectCount: node.querySelectorAll('.el-select').length,
        }))
        .sort((a, b) => {
          if (a.selectCount !== b.selectCount) return a.selectCount - b.selectCount;
          return a.text.length - b.text.length;
        });
      return candidates[0]?.node || null;
    };

    const clickNode = async (node) => {
      if (!node) return false;
      const clickable = node.closest('label, button, a, .el-checkbox, .el-radio, .el-select-dropdown__item, li') || node;
      clickable.scrollIntoView?.({ block: 'center' });
      await sleep(120);
      clickable.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      clickable.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      clickable.click?.();
      clickable.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(180);
      return true;
    };

    const clickActionNode = async (node) => {
      if (!node) return false;
      const clickable = node.closest('button, a, .el-button, [role="button"]') || node;
      clickable.scrollIntoView?.({ block: 'center' });
      await sleep(120);
      clickable.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      clickable.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      clickable.click?.();
      await sleep(180);
      return true;
    };

    const primaryButtons = () => Array.from(document.querySelectorAll('button.el-button.el-button--primary'))
      .filter((node) => isVisible(node))
      .map((node) => ({ node, text: normalize(textOf(node)) }))
      .filter((item) => item.text);

    const clickText = async (keyword, targetText, exact = true) => {
      const root = keyword ? (findBlock(keyword) || document) : document;
      let hit = null;
      for (let attempt = 0; attempt < 5 && !hit; attempt += 1) {
        hit = visibleNodes(root).find((item) => exact ? normalize(item.text) === normalize(targetText) : normalize(item.text).includes(normalize(targetText))) || null;
        if (!hit) await sleep(250);
      }
      if (!hit) return false;
      await clickNode(hit.node);
      await sleep(700);
      return true;
    };

    const clickPrimaryButton = async (targetText) => {
      let hit = null;
      for (let attempt = 0; attempt < 8 && !hit; attempt += 1) {
        hit = primaryButtons().find((item) => item.text === normalize(targetText)) || null;
        if (!hit) await sleep(250);
      }
      if (!hit) return false;
      await clickNode(hit.node);
      await sleep(1200);
      return true;
    };

    const blockedByAuth = () => document.body.innerText.includes('您还未登录')
      || document.body.innerText.includes('前往登录')
      || dismissLoginDialog();

    const clickSchoolFeature = async (targetText) => {
      const normalized = normalize(targetText);
      const root = findBlock('院校特性') || document;

      const config = (() => {
        if (normalized === '全部' || normalized === '全国') {
          return { all: true, value: '' };
        }
        if (normalized.includes('双一流')) {
          return { all: false, value: 'syl' };
        }
        if (normalized === '211') {
          return { all: false, value: '211' };
        }
        if (normalized === '985') {
          return { all: false, value: '985' };
        }
        return { all: false, value: '' };
      })();

      const isChecked = (node) => {
        if (!node) return false;
        const rootNode = node.closest('label, .el-checkbox') || node;
        const input = rootNode.querySelector?.('input[type="checkbox"]') || null;
        return !!input?.checked
          || rootNode.classList?.contains('is-checked')
          || !!rootNode.querySelector?.('.is-checked');
      };

      const findAllButton = () => Array.from(root.querySelectorAll('button, span, a, div'))
        .filter((node) => isVisible(node))
        .find((node) => normalize(textOf(node)) === '全部') || null;

      const resetToAll = async () => {
        const allButton = findAllButton();
        if (!allButton) return false;
        await clickNode(allButton);
        await sleep(500);
        return true;
      };

      if (config.all) {
        return { ok: await resetToAll(), selected: '全部' };
      }

      await resetToAll();

      for (let attempt = 0; attempt < 8; attempt += 1) {
        const input = config.value
          ? root.querySelector('input.el-checkbox__original[type="checkbox"][value="' + config.value + '"]')
            || document.querySelector('input.el-checkbox__original[type="checkbox"][value="' + config.value + '"]')
          : null;
        const checkboxNode = input?.closest('label.el-checkbox, .el-checkbox') || null;
        if (!checkboxNode) {
          await sleep(250);
          continue;
        }

        if (isChecked(input) || isChecked(checkboxNode)) {
          return { ok: true, selected: normalize(textOf(checkboxNode)) };
        }

        const inner = checkboxNode.querySelector?.('.el-checkbox__inner')
          || checkboxNode.querySelector?.('input[type="checkbox"]')
          || checkboxNode;
        await clickNode(inner);
        await sleep(500);
        if (isChecked(input) || isChecked(checkboxNode)) {
          return { ok: true, selected: normalize(textOf(checkboxNode)) };
        }

        await clickNode(checkboxNode);
        await sleep(500);
        if (isChecked(input) || isChecked(checkboxNode)) {
          return { ok: true, selected: normalize(textOf(checkboxNode)) };
        }
      }

      return { ok: false, selected: '' };
    };

    const pickMajorSelect = async (index, matchers) => {
      const block = findBlock('专业选择');
      if (!block) return { ok: false, selected: '' };
      const selects = Array.from(block.querySelectorAll('.el-select'));
      const select = selects[index];
      if (!select) return { ok: false, selected: '' };
      const currentText = textOf(select);
      if (matchers.some((matcher) => matcher(currentText))) {
        return { ok: true, selected: currentText };
      }
      const trigger = select.querySelector('.el-select__wrapper, .el-select__selection, input') || select;
      await clickNode(trigger);
      await sleep(300);
      trigger.click?.();
      await sleep(700);

      let option = null;
      for (let attempt = 0; attempt < 8 && !option; attempt += 1) {
        option = Array.from(document.querySelectorAll('.el-select-dropdown__item, .el-select-dropdown li, [role="option"]'))
          .filter((node) => isVisible(node))
          .map((node) => ({ node, text: textOf(node) }))
          .find((item) => matchers.some((matcher) => matcher(item.text))) || null;
        if (!option) await sleep(200);
      }
      if (!option) {
        document.body.click();
        await sleep(200);
        return { ok: false, selected: '' };
      }

      option.node.click();
      await sleep(700);
      return { ok: true, selected: option.text };
    };

    const setByPlaceholder = async (placeholder, value) => {
      const input = Array.from(document.querySelectorAll('input')).find((node) => normalize(node.getAttribute('placeholder')).includes(normalize(placeholder)));
      if (!input) return false;
      dispatchInput(input, String(value));
      await sleep(300);
      return true;
    };

    const readResultSignature = () => {
      const schoolSummary = Array.from(document.querySelectorAll('tbody tr, .school-item, .school-card, .school-name, .item'))
        .filter((node) => isVisible(node))
        .map((node) => normalize(textOf(node)))
        .filter((text) => !!text)
        .slice(0, 12);
      const bodyText = normalize(document.body.innerText);
      const schoolMarker = bodyText.indexOf('调剂去向学校汇总');
      const tailText = schoolMarker >= 0
        ? bodyText.slice(schoolMarker, schoolMarker + 300)
        : bodyText.slice(Math.max(0, bodyText.length - 300));
      return normalize([schoolSummary.join('|'), tailText].join('||'));
    };

    const hasLoadingMask = () => Array.from(document.querySelectorAll('.el-loading-mask, .el-loading-spinner, [class*="el-loading"]'))
      .some((node) => {
        if (!isVisible(node)) return false;
        const className = String(node.className || '');
        return className.includes('el-loading') || normalize(textOf(node)).includes('加载');
      });

    const waitForQueryResult = async (beforeSignature) => {
      let sawLoading = false;
      let quietCount = 0;
      let lastSignature = beforeSignature;

      for (let attempt = 0; attempt < 30; attempt += 1) {
        const loading = hasLoadingMask();
        const currentSignature = readResultSignature();
        const changed = !!currentSignature && currentSignature !== beforeSignature;
        lastSignature = currentSignature || lastSignature;

        if (loading) {
          sawLoading = true;
          quietCount = 0;
        } else {
          quietCount += 1;
        }

        if ((changed && quietCount >= 2) || (sawLoading && quietCount >= 2) || (!sawLoading && quietCount >= 6)) {
          return { ok: true, changed, signature: lastSignature };
        }

        await sleep(500);
      }

      return {
        ok: false,
        changed: lastSignature !== beforeSignature,
        signature: lastSignature,
      };
    };

    const triggerAdjustDownload = async () => {
      const downloadButton = primaryButtons()
        .find((item) => item.text === '调剂报告下载') || null;
      if (!downloadButton) {
        return { ok: false, blocked: false, message: '未找到调剂报告下载按钮' };
      }

      await clickActionNode(downloadButton.node);
      await sleep(1200);

      if (blockedByAuth()) {
        return { ok: false, blocked: true, message: '点击调剂报告下载时被站点拦截' };
      }

      const clickDialogButton = async (matcher) => {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const dialog = Array.from(document.querySelectorAll('.el-message-box, .el-dialog, [role="dialog"]'))
            .find((node) => isVisible(node) && textOf(node));
          if (!dialog) {
            await sleep(250);
            continue;
          }

          const button = Array.from(dialog.querySelectorAll('button, .el-button, a, span'))
            .find((node) => isVisible(node) && matcher(normalize(textOf(node)))) || null;
          if (!button) {
            await sleep(250);
            continue;
          }

          await clickActionNode(button);
          await sleep(1200);
          return true;
        }
        return false;
      };

      const confirmed = await clickDialogButton((text) => text === '确定' || text === '确认');
      if (blockedByAuth()) {
        return { ok: false, blocked: true, message: '确认下载时被站点拦截' };
      }

      const reportConfirmed = await clickDialogButton((text) => text.includes('下载调剂报告') || text.includes('调剂报告下载'));
      if (blockedByAuth()) {
        return { ok: false, blocked: true, message: '确认调剂报告下载时被站点拦截' };
      }

      const messages = ['已点击调剂报告下载'];
      if (confirmed) messages.push('已确认下载弹窗');
      if (reportConfirmed) messages.push('已确认调剂报告');
      return { ok: true, blocked: false, message: messages.join('；') };
    };
  `;
}

cli({
  site: 'zhanxingyan',
  name: 'adjust-report',
  description: '按筛选条件触发展星研全国调剂数据报告下载',
  domain: 'www.zhanxingyan.cn',
  strategy: Strategy.COOKIE,
  browser: true,
  timeoutSeconds: 180,
  navigateBefore: false,
  args: [
    { name: 'report-type', required: true, choices: ['复试名单', '录取名单'], help: '数据类型' },
    { name: 'major-prefix', required: true, help: '4 位专业前缀，例如 0454' },
    { name: 'score', required: true, help: '分数，命令会自动取上下浮动 20 分' },
    { name: 'region', required: true, help: '院校位置，例如 北京市' },
    { name: 'school-feature', required: true, help: '院校特性，例如 “双一流”建设高校、211、985、全部' },
  ],
  columns: ['year', 'report_type', 'major_prefix', 'region', 'school_feature', 'min_score', 'max_score', 'status', 'message'],
  func: async (page, kwargs) => {
    requireBrowserPage(page);

    const reportType = normalizeReportType(kwargs['report-type']);
    const majorPrefix = normalizeMajorPrefix(kwargs['major-prefix']);
    const score = normalizeScore(kwargs.score);
    const region = String(kwargs.region ?? '').trim();
    const schoolFeature = String(kwargs['school-feature'] ?? '').trim();
    const shouldSelectRegion = region && region !== '全国' && region !== '全部';

    if (!region) {
      throw new CliError('INVALID_ARG', '缺少院校位置', '请传入 --region "北京市"');
    }
    if (!schoolFeature) {
      throw new CliError('INVALID_ARG', '缺少院校特性', '请传入 --school-feature "双一流"');
    }

    const minScore = Math.max(0, score - 20);
    const maxScore = score + 20;
    const reportLabel = reportType === '复试名单'
      ? '全国调剂去向复试名单'
      : '全国调剂去向录取名单';
    const degreeLabels = inferDegreeLabelsByCode(majorPrefix);
    const categoryPrefix = majorPrefix.slice(0, 2);
    const beforeDownload = await snapshotPdfDownloads();

    await openPage(page, ADJUST_LIST_URL);

    const accessState = await page.evaluate(`
      (() => {
        ${browserPrelude()}
        const text = normalize(document.body.innerText);
        return {
          hasAccess: !text.includes('登录购买（机构授权）后可查询调剂数据') && !text.includes('立即登录/注册'),
        };
      })()
    `);

    if (!accessState?.hasAccess) {
      throw new CliError(
        'COMMAND_EXEC',
        '当前 Browser Bridge 会话没有全国调剂数据查询权限。',
        '请在同一个 Chrome 会话中登录并确认该账号已购买或获授权调剂数据查询权限后重试。',
      );
    }

    const formAction = await page.evaluate(`
      (async () => {
        ${adjustBrowserHelpers()}
        const target = {
          year: '2025年',
          reportLabel: ${JSON.stringify(reportLabel)},
          degreeLabels: ${JSON.stringify(degreeLabels)},
          categoryPrefix: ${JSON.stringify(categoryPrefix)},
          majorPrefix: ${JSON.stringify(majorPrefix)},
          region: ${JSON.stringify(region)},
          shouldSelectRegion: ${JSON.stringify(shouldSelectRegion)},
          schoolFeature: ${JSON.stringify(schoolFeature)},
          minScore: ${minScore},
          maxScore: ${maxScore},
        };

        const steps = [];
        steps.push({ step: 'year', ok: await clickText('数据筛选', target.year, true) });
        steps.push({ step: 'report-type', ok: await clickText('数据筛选', target.reportLabel, true) });

        let degreeSelected = '';
        let category = { ok: false, selected: '' };
        let firstLevel = { ok: false, selected: '' };
        let exactMajor = { ok: false, selected: '' };
        let studyMode = { ok: false, selected: '' };
        for (const degree of target.degreeLabels) {
          const picked = await pickMajorSelect(0, [
            (text) => normalize(text) === normalize(degree),
          ]);
          if (!picked.ok) continue;

          const pickedCategory = await pickMajorSelect(1, [
            (text) => text.startsWith('(' + target.categoryPrefix + ')'),
            (text) => text.includes('(' + target.categoryPrefix + ')'),
          ]);
          if (!pickedCategory.ok) continue;

          const pickedFirstLevel = await pickMajorSelect(2, [
            (text) => text.startsWith('(' + target.majorPrefix + ')'),
            (text) => text.includes('(' + target.majorPrefix + ')'),
          ]);
          if (!pickedFirstLevel.ok) continue;

          const pickedExactMajor = await pickMajorSelect(3, [
            (text) => normalize(text) === '全部',
            (text) => normalize(text).includes('全部'),
          ]);
          if (!pickedExactMajor.ok) continue;

          const pickedStudyMode = await pickMajorSelect(4, [
            (text) => normalize(text) === '全日制',
            (text) => normalize(text).includes('全日制'),
          ]);
          if (!pickedStudyMode.ok) continue;

          degreeSelected = picked.selected;
          category = pickedCategory;
          firstLevel = pickedFirstLevel;
          exactMajor = pickedExactMajor;
          studyMode = pickedStudyMode;
          break;
        }

        steps.push({ step: 'degree', ok: !!degreeSelected, selected: degreeSelected });
        steps.push({ step: 'category', ok: category.ok, selected: category.selected });
        steps.push({ step: 'major-prefix', ok: firstLevel.ok, selected: firstLevel.selected });
        steps.push({ step: 'major-code', ok: exactMajor.ok, selected: exactMajor.selected });
        steps.push({ step: 'study-mode', ok: studyMode.ok, selected: studyMode.selected });

        steps.push({ step: 'region', ok: target.shouldSelectRegion ? await clickText('院校位置', target.region, true) : true });
        const schoolFeatureSelection = await clickSchoolFeature(target.schoolFeature);
        steps.push({ step: 'school-feature', ok: schoolFeatureSelection.ok, selected: schoolFeatureSelection.selected });
        steps.push({ step: 'min-score', ok: await setByPlaceholder('起始分数', target.minScore) });
        steps.push({ step: 'max-score', ok: await setByPlaceholder('截止分数', target.maxScore) });

        const beforeQuerySignature = readResultSignature();
        const queryClicked = await clickPrimaryButton('查询');
        steps.push({ step: 'query', ok: queryClicked });

        const failed = steps.find((item) => !item.ok);
        return {
          steps,
          failed,
          beforeQuerySignature,
        };
      })()
    `);

    if (formAction?.failed) {
      const stepSummary = Array.isArray(formAction?.steps)
        ? formAction.steps
          .map((item: { step?: string; ok?: boolean; selected?: string }) => {
            const parts = [`${item.step || 'unknown'}=${item.ok ? 'ok' : 'fail'}`];
            if (item.selected) parts.push(`selected=${item.selected}`);
            return parts.join(',');
          })
          .join('；')
        : '';
      throw new CliError(
        'COMMAND_EXEC',
        `调剂查询页自动化操作失败，未找到步骤“${formAction.failed.step}”对应的控件。`,
        stepSummary || '这通常表示当前账号页面结构或权限视图与预期不一致，请先在浏览器里手动确认页面已展示完整筛选表单。',
      );
    }

    const queryResult = await page.evaluate(`
      (async () => {
        ${adjustBrowserHelpers()}
        return await waitForQueryResult(${JSON.stringify(formAction?.beforeQuerySignature ?? '')});
      })()
    `);

    const downloadAction = queryResult?.ok
      ? await page.evaluate(`
        (async () => {
          ${adjustBrowserHelpers()}
          return await triggerAdjustDownload();
        })()
      `)
      : { ok: false, blocked: false, message: '查询结果未完成加载' };

    if (downloadAction?.blocked) {
      throw new CliError(
        'COMMAND_EXEC',
        '已定位到调剂报告下载入口，但下载时被站点拦截为未登录或未授权。',
        '请确认 Browser Bridge 连接的 Chrome 会话中，当前展星研账号具备调剂报告下载权限。',
      );
    }

    const actionSteps = [
      ...(Array.isArray(formAction?.steps) ? formAction.steps : []),
      { step: 'query-result', ok: !!queryResult?.ok, selected: queryResult?.changed ? 'changed' : 'stable' },
      { step: 'download', ok: !!downloadAction?.ok, selected: downloadAction?.message || '' },
    ];

    const failedAction = actionSteps.find((item) => !item.ok);
    if (failedAction) {
      const stepSummary = actionSteps
        .map((item: { step?: string; ok?: boolean; selected?: string }) => {
          const parts = [`${item.step || 'unknown'}=${item.ok ? 'ok' : 'fail'}`];
          if (item.selected) parts.push(`selected=${item.selected}`);
          return parts.join(',');
        })
        .join('；');
      throw new CliError(
        'COMMAND_EXEC',
        `调剂查询页自动化操作失败，未找到步骤“${failedAction.step}”对应的控件。`,
        stepSummary || '这通常表示当前账号页面结构或权限视图与预期不一致，请先在浏览器里手动确认页面已展示完整筛选表单。',
      );
    }

    const downloadedPdf = await waitForNewPdfDownload(beforeDownload);
    if (!downloadedPdf) {
      throw new CliError(
        'COMMAND_EXEC',
        '已点击调剂报告下载，但未检测到新的 PDF 文件。',
        `请确认 Chrome 的下载目录仍为 D:\\download 或 ${path.join(os.homedir(), 'Downloads')}，并检查页面是否还停留在下载确认弹窗。${downloadAction?.message ? ` 页面动作: ${downloadAction.message}` : ''}`,
      );
    }

    return [{
      year: 2025,
      report_type: reportType,
      major_prefix: majorPrefix,
      region,
      school_feature: schoolFeature,
      min_score: minScore,
      max_score: maxScore,
      status: 'downloaded',
      message: `已下载 ${downloadedPdf.name} 到 ${downloadedPdf.dir}`,
    }];
  },
});
