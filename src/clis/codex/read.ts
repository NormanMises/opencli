import { cli, Strategy } from '../../registry.js';

export const readCommand = cli({
  site: 'codex',
  name: 'read',
  description: 'Read the contents of the current Codex conversation thread',
  domain: 'localhost',
  strategy: Strategy.UI,
  browser: true,
  columns: ['Thread_Content'],
  func: async (page) => {
    const historyText = await page.evaluate(`
      (function() {
        // Precise Codex selector for chat messages
        const turns = Array.from(document.querySelectorAll('[data-content-search-turn-key]'));
        if (turns.length > 0) {
            return turns.map(t => t.innerText || t.textContent).join('\\n\\n---\\n\\n');
        }
        
        // Fallback robust scraping heuristic for chat history panes
        const threadContainer = document.querySelector('[role="log"], [data-testid="conversation"], .thread-container, .messages-list, main');
        
        if (threadContainer) {
          return threadContainer.innerText || threadContainer.textContent;
        }
        
        // If specific containers fail, just dump the whole body's readable text minus the navigation
        return document.body.innerText;
      })()
    `);

    return [
      {
        Thread_Content: historyText,
      },
    ];
  },
});
