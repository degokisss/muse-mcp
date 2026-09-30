import type { Page } from "playwright-core";

// Every purpose has several candidates, tried in order.
// If Muse changes its UI, only this file needs to change.
export const SELECTORS = {
  composerRoot: ["[data-hatch-composer-root]"],
  editor: [
    "[data-hatch-composer-root] textarea",
    '[data-hatch-composer-root] [data-lexical-editor="true"]',
    '[data-hatch-composer-root] [contenteditable="true"]',
  ],
  stopButton: ['[data-testid="hatch-composer-stop-button"]'],
  message: ["[data-message-item]"],
  errorNotice: ['[data-testid="assistant-response-error-notice"]'],
} as const;

export type SelectorKey = keyof typeof SELECTORS;

/** Return the first candidate selector that currently matches an element. */
export async function resolve(page: Page, key: SelectorKey): Promise<string | null> {
  for (const sel of SELECTORS[key]) {
    if ((await page.locator(sel).count()) > 0) return sel;
  }
  return null;
}
