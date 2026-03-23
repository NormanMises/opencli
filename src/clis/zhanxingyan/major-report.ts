import { cli, Strategy } from '../../registry.js';
import { CliError } from '../../errors.js';
import {
  SCHOOL_LIST_URL,
  assertPageReady,
  browserPrelude,
  inferDegreeLabelsByCode,
  openPage,
  normalizeMajorSelector,
  requireBrowserPage,
} from './adapter-shared.js';

type DownloadRow = {
  department: string;
  direction: string;
  study_mode: string;
  status: string;
  message: string;
};

cli({
  site: 'zhanxingyan',
  name: 'major-report',
  description: '按院校和专业代码下载开设招生专业页面中的全部数据报告',
  domain: 'www.zhanxingyan.cn',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'school', required: true, help: '院校名称，例如 北京大学' },
    { name: 'major-code', required: true, help: '4 位专业前缀或 6 位专业代码，例如 0812、081200 或 0812J6' },
  ],
  columns: ['school', 'major_code', 'department', 'direction', 'study_mode', 'status', 'message'],
  func: async (page, kwargs) => {
    requireBrowserPage(page);

    const school = String(kwargs.school ?? '').trim();
    const majorCode = normalizeMajorSelector(kwargs['major-code']);
    const isMajorPrefix = majorCode.length === 4;
    if (!school) {
      throw new CliError('INVALID_ARG', '缺少院校名称', '请传入 --school "北京大学"');
    }

    await assertPageReady(
      page,
      SCHOOL_LIST_URL,
      '院校查询页',
      `Array.from(document.querySelectorAll('input')).some((node) => String(node.getAttribute('placeholder') || '').includes('招生单位名称'))`,
    );

    const schoolLookup = await page.evaluate(`
      (async () => {
        ${browserPrelude()}
        const schoolName = ${JSON.stringify(school)};
        const input = findInputByPlaceholder('招生单位名称');
        if (!input) return { error: '院校搜索输入框不存在' };

        dispatchInput(input, schoolName);
        await sleep(200);

        const queryButton = byText('button, .el-button, span', '查询', true);
        if (queryButton) queryButton.click();
        await sleep(1800);

        const cards = findSchoolCards();
        const matched = cards.find((item) => normalize(item.name).includes(normalize(schoolName)));
        return { majorsUrl: matched ? matched.majorsUrl : '' };
      })()
    `);

    if (schoolLookup?.error) {
      throw new CliError('COMMAND_EXEC', schoolLookup.error, '请确认院校查询页仍可正常搜索。');
    }
    if (!schoolLookup?.majorsUrl) {
      throw new CliError(
        'NOT_FOUND',
        `未找到院校“${school}”的开设专业入口。`,
        '请先在浏览器中确认院校名称与页面展示一致。',
      );
    }

    await openPage(page, schoolLookup.majorsUrl);

    if (isMajorPrefix) {
      const listResults: Array<{
        candidates: Array<{ majorCode: string; majorName: string; degree: string }>;
        attempt?: { degree?: string; error?: string; selectedCategory?: string; selectedFirstLevel?: string; selectedMode?: string };
      }> = [];
      for (const degree of ['专业学位', '学术学位']) {
        await openPage(page, schoolLookup.majorsUrl);
        const scanResult = await page.evaluate(`
          (async () => {
            ${browserPrelude()}
            const prefix = ${JSON.stringify(majorCode)};
            const degree = ${JSON.stringify(degree)};
            const categoryPrefix = prefix.slice(0, 2);

            const visibleItems = (root) => Array.from((root || document).querySelectorAll('.filter-item, button, span, a'))
              .filter((node) => isVisible(node))
              .map((node) => ({ node, text: textOf(node) }))
              .filter((item) => item.text);

            const findBlock = (keyword) => {
              return Array.from(document.querySelectorAll('.list-filter-block, .school-info-list, .el-card__body, section, form, .search-area, .filter-area'))
                .find((node) => isVisible(node) && textOf(node).includes(keyword)) || null;
            };

            const clickInBlock = async (keyword, matchers) => {
              const block = findBlock(keyword) || document;
              let hit = null;
              for (let attempt = 0; attempt < 5 && !hit; attempt += 1) {
                hit = visibleItems(block).find((item) => matchers.some((matcher) => matcher(item.text))) || null;
                if (!hit) await sleep(250);
              }
              if (!hit) return { ok: false, selected: '' };
              hit.node.click();
              await sleep(700);
              return { ok: true, selected: hit.text };
            };

            const pageButtons = () => Array.from(document.querySelectorAll('li.number'))
              .filter((item) => isVisible(item));

            const readCandidates = () => Array.from(document.querySelectorAll('.school-item'))
              .map((item) => {
                const text = textOf(item);
                const match = text.match(/\\(([0-9A-Z]{6})\\)/);
                const majorCode = match ? match[1] : '';
                const compactText = text
                  .replace(/\\s*展开\\s*$/, '')
                  .replace(/\\s*学科等级[:：].*$/, '')
                  .trim();
                const majorName = compactText
                  .replace(/^\\([0-9A-Z]{6}\\)\\s*/, '')
                  .replace(/\\s+(?:学术学位|专业学位)(?:\\s|$).*$/, '')
                  .trim();
                return {
                  majorCode,
                  majorName: majorName || compactText,
                  degree,
                };
              })
              .filter((item) => item.majorCode.startsWith(prefix));

            const openPageNumber = async (pageNo) => {
              const btn = pageButtons().find((item) => textOf(item) === String(pageNo));
              if (!btn) return false;
              btn.click();
              await sleep(1800);
              return true;
            };

            const picked = await clickInBlock('学位类别', [
              (text) => normalize(text) === normalize(degree),
            ]);
            if (!picked.ok) {
              return { candidates: [], attempt: { degree, error: '未能选中学位类别' } };
            }

            const category = await clickInBlock('选择专业', [
              (text) => text.startsWith('(' + categoryPrefix + ')'),
              (text) => text.includes('(' + categoryPrefix + ')'),
            ]);
            if (!category.ok) {
              return { candidates: [], attempt: { degree, error: '未能选中专业门类' } };
            }

            const firstLevel = await clickInBlock('一级学科', [
              (text) => text.startsWith('(' + prefix + ')'),
              (text) => text.includes('(' + prefix + ')'),
            ]);

            const studyMode = await clickInBlock('学习方式', [
              (text) => normalize(text) === '全日制',
              (text) => normalize(text).includes('全日制'),
            ]);

            const queryButton = byText('button, .el-button, span', '查询', true);
            if (!queryButton) {
              return {
                candidates: [],
                attempt: {
                  degree,
                  error: '未找到查询按钮',
                  selectedCategory: category.selected,
                  selectedFirstLevel: firstLevel.selected,
                  selectedMode: studyMode.selected,
                },
              };
            }

            queryButton.click();
            await sleep(2200);

            const collected = [];
            const pushUnique = (items) => {
              for (const item of items) {
                if (!item.majorCode) continue;
                if (collected.some((entry) => entry.majorCode === item.majorCode && entry.majorName === item.majorName)) continue;
                collected.push(item);
              }
            };

            pushUnique(readCandidates());

            const pages = pageButtons().map((item) => Number(textOf(item))).filter((value) => Number.isFinite(value));
            for (const pageNo of pages) {
              const changed = await openPageNumber(pageNo);
              if (!changed) continue;
              pushUnique(readCandidates());
            }

            return {
              candidates: collected,
              attempt: {
                degree,
                error: collected.length ? '' : '未发现匹配专业',
                selectedCategory: category.selected,
                selectedFirstLevel: firstLevel.selected,
                selectedMode: studyMode.selected,
              },
            };
          })()
        `);
        listResults.push({
          candidates: Array.isArray(scanResult?.candidates) ? scanResult.candidates : [],
          attempt: scanResult?.attempt,
        });
      }

      const candidates = listResults
        .flatMap((item) => item.candidates)
        .filter((item, index, all) => all.findIndex((entry) => (
          entry.majorCode === item.majorCode
          && entry.majorName === item.majorName
          && entry.degree === item.degree
        )) === index);
      if (!candidates.length) {
        const attemptSummary = listResults
          .map((result) => result.attempt)
          .filter((item): item is NonNullable<typeof item> => !!item)
          .map((item) => {
            const pieces = [
              `学位类别=${item.degree || '未知'}`,
              `结果=${item.error || '已扫描'}`,
            ];
            if (item.selectedCategory) pieces.push(`专业门类=${item.selectedCategory}`);
            if (item.selectedFirstLevel) pieces.push(`一级学科=${item.selectedFirstLevel}`);
            if (item.selectedMode) pieces.push(`学习方式=${item.selectedMode}`);
            return pieces.join('，');
          })
          .join('；');
        throw new CliError(
          'COMMAND_EXEC',
          `未找到专业前缀 ${majorCode} 对应的候选专业`,
          attemptSummary || '请先在浏览器中确认该院校开设专业页仍可按学位类别和专业筛选。',
        );
      }

      return candidates.map((item: { majorCode: string; majorName: string; degree: string }) => ({
        school,
        major_code: item.majorCode,
        department: item.majorName,
        direction: '',
        study_mode: item.degree,
        status: 'select-major-code',
        message: `已列出专业前缀 ${majorCode} 的候选项，请改用其中一个 6 位代码重新下载`,
      }));
    }

    const majorLookup = await page.evaluate(`
      (async () => {
        ${browserPrelude()}
        const code = ${JSON.stringify(majorCode)};
        const degreeLabels = ${JSON.stringify(inferDegreeLabelsByCode(majorCode))};
        const categoryPrefix = code.slice(0, 2);
        const firstLevelPrefix = code.slice(0, 4);

        const visibleItems = (root) => Array.from((root || document).querySelectorAll('.filter-item, button, span, a'))
          .filter((node) => isVisible(node))
          .map((node) => ({ node, text: textOf(node) }))
          .filter((item) => item.text);

        const findExpandedTable = (target) => {
          let cursor = target?.nextElementSibling || null;
          while (cursor) {
            if (cursor.matches?.('.school-item')) break;
            if (isVisible(cursor) && (
              cursor.matches?.('.el-table, .general-table')
              || String(cursor.className || '').includes('el-table')
              || textOf(cursor).includes('数据报告')
            )) {
              return cursor;
            }
            cursor = cursor.nextElementSibling;
          }
          return null;
        };

        const findBlock = (keyword) => {
          return Array.from(document.querySelectorAll('.list-filter-block, .school-info-list, .el-card__body, section, form, .search-area, .filter-area'))
            .find((node) => isVisible(node) && textOf(node).includes(keyword)) || null;
        };

        const clickInBlock = async (keyword, matchers) => {
          const block = findBlock(keyword) || document;
          let hit = null;
          for (let attempt = 0; attempt < 5 && !hit; attempt += 1) {
            hit = visibleItems(block).find((item) => matchers.some((matcher) => matcher(item.text))) || null;
            if (!hit) await sleep(250);
          }
          if (!hit) return { ok: false, selected: '' };
          hit.node.click();
          await sleep(700);
          return { ok: true, selected: hit.text };
        };

        let lastAttempt = { error: '未能选中学位类别' };
        for (const degree of degreeLabels) {
          const picked = await clickInBlock('学位类别', [
            (text) => normalize(text) === normalize(degree),
          ]);
          if (!picked.ok) {
            lastAttempt = { error: '未能选中学位类别' };
            continue;
          }

          const category = await clickInBlock('选择专业', [
            (text) => text.startsWith('(' + categoryPrefix + ')'),
            (text) => text.includes('(' + categoryPrefix + ')'),
          ]);
          if (!category.ok) {
            lastAttempt = { error: '未能选中专业门类', selectedDegree: picked.selected };
            continue;
          }

          const firstLevel = await clickInBlock('一级学科', [
            (text) => text.startsWith('(' + firstLevelPrefix + ')'),
            (text) => text.includes('(' + firstLevelPrefix + ')'),
          ]);
          if (!firstLevel.ok) {
            lastAttempt = {
              error: '未能选中一级学科',
              selectedDegree: picked.selected,
              selectedCategory: category.selected,
            };
            continue;
          }

          const studyMode = await clickInBlock('学习方式', [
            (text) => normalize(text) === '全日制',
            (text) => normalize(text).includes('全日制'),
          ]);
          if (!studyMode.ok) {
            lastAttempt = {
              error: '未能选中学习方式',
              selectedDegree: picked.selected,
              selectedCategory: category.selected,
              selectedFirstLevel: firstLevel.selected,
            };
            continue;
          }

          const queryButton = byText('button, .el-button, span', '查询', true);
          if (!queryButton) {
            lastAttempt = {
              error: '未找到查询按钮',
              selectedDegree: picked.selected,
              selectedCategory: category.selected,
              selectedFirstLevel: firstLevel.selected,
              selectedMode: studyMode.selected,
            };
            continue;
          }

          queryButton.click();
          await sleep(2200);

          const candidates = Array.from(document.querySelectorAll('.school-item'))
            .filter((item) => textOf(item).includes('(' + firstLevelPrefix));

          const findTarget = () => candidates.find((item) => textOf(item).includes('(' + code + ')')) || null;
          let target = findTarget();
          if (!target) {
            lastAttempt = {
              error: '筛选后未找到专业 ' + code,
              selectedDegree: picked.selected,
              selectedCategory: category.selected,
              selectedFirstLevel: firstLevel.selected,
              selectedMode: studyMode.selected,
            };
            continue;
          }

          const expand = Array.from(target.querySelectorAll('button.el-button, .school-item-action button, .school-item-action .el-button'))
            .find((node) => isVisible(node) && textOf(node).includes('展开')) || null;
          if (expand) {
            expand.click();
            await sleep(2200);
          }

          target = findTarget() || target;

          let rows = [];
          for (let attempt = 0; attempt < 6 && rows.length === 0; attempt += 1) {
            const table = findExpandedTable(target);
            rows = table
              ? Array.from(table.querySelectorAll('.el-table__body tr.el-table__row, .el-table__body-wrapper tbody tr'))
              : [];
            if (!rows.length) await sleep(500);
          }

          if (rows.length) {
            return {
              selectedDegree: picked.selected,
              selectedCategory: category.selected,
              selectedFirstLevel: firstLevel.selected,
              selectedMode: studyMode.selected,
              rowsCount: rows.length,
            };
          }

          lastAttempt = {
            error: '筛选后未发现可下载的数据表格',
            selectedDegree: picked.selected,
            selectedCategory: category.selected,
            selectedFirstLevel: firstLevel.selected,
            selectedMode: studyMode.selected,
          };
        }

        return lastAttempt;
      })()
    `);

    const filterSummary = `当前命中的筛选值: 学位类别=${majorLookup?.selectedDegree || '未命中'}，专业门类=${majorLookup?.selectedCategory || '未命中'}，一级学科=${majorLookup?.selectedFirstLevel || '未命中'}，学习方式=${majorLookup?.selectedMode || '未命中'}`;

    const clickResult = await page.evaluate(`
      (async () => {
        ${browserPrelude()}
        const code = ${JSON.stringify(majorCode)};

        const findTarget = () => Array.from(document.querySelectorAll('.school-item'))
          .find((item) => isVisible(item) && textOf(item).includes('(' + code + ')')) || null;

        const pageButtons = () => Array.from(document.querySelectorAll('li.number'))
          .filter((item) => isVisible(item));

        const openPageNumber = async (pageNo) => {
          const btn = pageButtons().find((item) => textOf(item) === String(pageNo));
          if (!btn) return false;
          btn.click();
          await sleep(1800);
          return true;
        };

        const ensureTargetVisible = async () => {
          let target = findTarget();
          if (target) return { target, page: null };

          const pages = pageButtons().map((item) => Number(textOf(item))).filter((value) => Number.isFinite(value));
          for (const pageNo of pages) {
            const changed = await openPageNumber(pageNo);
            if (!changed) continue;
            target = findTarget();
            if (target) return { target, page: pageNo };
          }

          return { target: null, page: null };
        };

        const resolved = await ensureTargetVisible();
        const target = resolved.target;
        if (!target) return { error: '查询后未找到目标专业卡片' };

        const findExpandedTable = (node) => {
          let cursor = node?.nextElementSibling || null;
          while (cursor) {
            if (cursor.matches?.('.school-item')) break;
            if (isVisible(cursor) && (
              cursor.matches?.('.el-table, .general-table')
              || String(cursor.className || '').includes('el-table')
              || textOf(cursor).includes('数据报告')
            )) {
              return cursor;
            }
            cursor = cursor.nextElementSibling;
          }
          return null;
        };

        const expand = Array.from(target.querySelectorAll('button.el-button, .school-item-action button, .school-item-action .el-button'))
          .find((node) => isVisible(node) && textOf(node).includes('展开')) || null;
        if (expand && textOf(target).includes('展开')) {
          expand.click();
          await sleep(2500);
        }

        const table = findExpandedTable(target);
        if (!table) return { error: '已展开目标专业，但未找到展开后的数据表格' };

        const rows = Array.from(table.querySelectorAll('.el-table__body tr.el-table__row, .el-table__body-wrapper tbody tr'));
        if (!rows.length) return { error: '已找到展开表格，但表格中没有可操作的数据行' };

        const blockedByAuth = () => document.body.innerText.includes('您还未登录')
          || document.body.innerText.includes('前往登录')
          || dismissLoginDialog();

        const closeVisibleDialog = async () => {
          const dialog = Array.from(document.querySelectorAll('.el-dialog, [role="dialog"], .el-message-box'))
            .find((node) => isVisible(node) && (
              textOf(node).includes('下载调剂报告')
              || textOf(node).includes('调剂报告')
              || textOf(node).includes('数据报告')
              || textOf(node).includes('确认要扣除一次下载次数进行数据下载吗')
            )) || null;
          if (!dialog) return false;

          const closeControl = Array.from(dialog.querySelectorAll('button, .el-button, .el-dialog__headerbtn, i, span, a'))
            .find((node) => {
              if (!isVisible(node)) return false;
              const text = textOf(node);
              return text === '关闭'
                || text === '取消'
                || node.classList.contains('el-dialog__close')
                || node.classList.contains('el-icon-close');
            }) || null;
          if (!closeControl) return false;

          closeControl.click();
          await sleep(800);
          return true;
        };

        const clickNode = async (node) => {
          if (!node) return false;
          const clickable = node.closest('a, button') || node;
          clickable.scrollIntoView?.({ block: 'center' });
          await sleep(150);
          clickable.click();
          return true;
        };

        const reportRows = rows.map((row) => {
          const cells = Array.from(row.querySelectorAll('td')).map((td) => textOf(td));
          return {
            department: cells[0] || '',
            direction: cells[2] || '',
            study_mode: cells[3] || '',
          };
        });

        const downloadControls = Array.from(table.querySelectorAll(
          'td[class*="column_15"] a, td[class*="column_15"] button, td[class*="column_15"] .el-link, td[class*="column_15"] .el-link__inner'
        ))
          .map((node) => node.closest('a, button') || node)
          .filter((node, index, all) => !!node && isVisible(node) && textOf(node) === '下载' && all.indexOf(node) === index);

        if (!downloadControls.length) {
          return {
            blocked: false,
            results: reportRows.map((row) => ({ ...row, status: 'missing-download', message: '未找到数据报告下载按钮' })),
            page: resolved.page,
          };
        }

        const actionMessages = [];
        let totalReportClicks = 0;

        for (const downloadControl of downloadControls) {
          await clickNode(downloadControl);
          await sleep(1200);

          if (blockedByAuth()) {
            return {
              blocked: true,
              results: reportRows.map((row) => ({ ...row, status: 'auth-required', message: '当前 Browser Bridge 会话没有数据报告下载权限' })),
            };
          }

          let confirmed = false;
          for (let attempt = 0; attempt < 10 && !confirmed; attempt += 1) {
            const confirmButton = Array.from(document.querySelectorAll('.el-message-box__btns .el-button--primary, .el-message-box__btns button, .el-message-box__btns span'))
              .find((node) => isVisible(node) && textOf(node) === '确定');
            if (!confirmButton) {
              await sleep(250);
              continue;
            }
            await clickNode(confirmButton);
            confirmed = true;
            await sleep(1500);
          }

          if (blockedByAuth()) {
            return {
              blocked: true,
              results: reportRows.map((row) => ({ ...row, status: 'auth-required', message: '确认下载时被拦截，当前账号可能没有下载权限' })),
            };
          }

          let reportButtons = [];
          for (let attempt = 0; attempt < 10 && reportButtons.length === 0; attempt += 1) {
            reportButtons = Array.from(document.querySelectorAll('button, .el-button, a, span'))
              .map((node) => node.closest('a, button') || node)
              .filter((node, index, all) => !!node && isVisible(node) && textOf(node).includes('下载调剂报告') && all.indexOf(node) === index);
            if (!reportButtons.length) await sleep(350);
          }

          if (reportButtons.length) {
            for (const button of reportButtons) {
              await clickNode(button);
              totalReportClicks += 1;
              await sleep(900);

              if (blockedByAuth()) {
                return {
                  blocked: true,
                  results: reportRows.map((row) => ({ ...row, status: 'auth-required', message: '点击调剂报告下载时被拦截，当前账号可能没有下载权限' })),
                };
              }
            }
            actionMessages.push('已点击 ' + reportButtons.length + ' 个下载调剂报告按钮');
          } else if (confirmed) {
            actionMessages.push('已确认数据报告下载');
          } else {
            actionMessages.push('已点击下载按钮，但未捕获到确认框或下载调剂报告按钮');
          }

          await closeVisibleDialog();
          await sleep(700);
        }

        const finalMessage = totalReportClicks > 0
          ? '已点击 ' + totalReportClicks + ' 个下载调剂报告按钮'
          : actionMessages.join('；');

        return {
          blocked: false,
          results: reportRows.map((row) => ({ ...row, status: 'clicked', message: finalMessage })),
          page: resolved.page,
        };
      })()
    `);

    if (clickResult?.error) {
      throw new CliError('COMMAND_EXEC', clickResult.error, filterSummary);
    }
    if (clickResult?.blocked) {
      throw new CliError(
        'COMMAND_EXEC',
        `已定位到专业 ${majorCode}，但下载时被站点拦截为未登录或未授权。`,
        '请确认 Browser Bridge 连接的 Chrome 会话中，当前展星研账号具备数据报告下载权限。',
      );
    }

    return (Array.isArray(clickResult?.results) ? clickResult.results : []).map((row: DownloadRow) => ({
      school,
      major_code: majorCode,
      department: row.department,
      direction: row.direction,
      study_mode: row.study_mode,
      status: row.status,
      message: clickResult?.page ? `${row.message}（分页定位到第 ${clickResult.page} 页）` : row.message,
    }));
  },
});
