/*
 * File: playwright.ts
 * Project: kimiproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { chromium, firefox, webkit, BrowserContext, Page } from 'playwright';
import path from 'path';

export type BrowserType = 'chromium' | 'firefox' | 'webkit' | 'chrome' | 'edge';

let context: BrowserContext | null = null;
export let activePage: Page | null = null;
let currentHeaders: Record<string, string> = {};
let cachedKimiHeaders: { headers: Record<string, string>, chatSessionId: string, parentMessageId: string | null } | null = null;
let lastHeadersTime = 0;
const HEADERS_TTL = 10 * 60 * 1000; // 10 minutes

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class Mutex {
  private queue: (() => void)[] = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise<() => void>(resolve => {
      this.queue.push(() => {
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

// Lock to prevent concurrent UI interactions
const uiMutex = new Mutex();

export async function getCookies(): Promise<string> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return 'token=mock';
  if (!activePage) return '';
  const cookies = await activePage.context().cookies();
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

export async function getBasicHeaders(): Promise<{ cookie: string, userAgent: string, authorization: string }> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return { cookie: 'token=mock', userAgent: 'mock', authorization: 'Bearer MOCK' };
  if (!activePage) throw new Error('Playwright not initialized');
  
  const cookie = await getCookies();
  const userAgent = await activePage.evaluate(() => navigator.userAgent);
  const authorization = currentHeaders['authorization'] || '';
  
  return { cookie, userAgent, authorization };
}

export async function initPlaywright(headless = true, browserType: BrowserType = 'chromium') {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) {
    return;
  }

  const profilePath = path.resolve('kimi_profile');
  
  let browserEngine;
  let channel: string | undefined;

  switch (browserType) {
    case 'firefox':
      browserEngine = firefox;
      break;
    case 'webkit':
      browserEngine = webkit;
      break;
    case 'chrome':
      browserEngine = chromium;
      channel = 'chrome';
      break;
    case 'edge':
      browserEngine = chromium;
      channel = 'msedge';
      break;
    case 'chromium':
    default:
      browserEngine = chromium;
      break;
  }

  console.log(`[Playwright] Launching ${browserType}...`);

  context = await browserEngine.launchPersistentContext(profilePath, {
    headless,
    channel,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  });

  // Keep an active page to fetch headers on demand
  activePage = await context.newPage();
}

export async function closePlaywright() {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) {
    await context.close();
    context = null;
    activePage = null;
  }
}

/**
 * Ensures the session is valid and extracts Kimi headers and session ID.
 */
export async function getKimiHeaders(forceNew = false): Promise<{ headers: Record<string, string>, chatSessionId: string, parentMessageId: string | null }> {
  // Use a lock to ensure only one request uses the UI at a time
  const release = await uiMutex.acquire();

  try {
    return await _getKimiHeadersInternal(forceNew);
  } finally {
    release();
  }
}

async function _getKimiHeadersInternal(forceNew = false): Promise<{ headers: Record<string, string>, chatSessionId: string, parentMessageId: string | null }> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    const mockSessionId = process.env.TEST_SESSION_ID || 'mock-session';
    return { 
      headers: { 
        'authorization': 'Bearer MOCK', 
        'cookie': 'token=mock', 
        'user-agent': 'mock',
        'x-msh-device-id': 'mock-device',
        'x-msh-session-id': 'mock-session-header',
        'x-traffic-id': 'mock-traffic'
      }, 
      chatSessionId: mockSessionId, 
      parentMessageId: null 
    };
  }

  if (!forceNew && cachedKimiHeaders && (Date.now() - lastHeadersTime < HEADERS_TTL)) {
    return cachedKimiHeaders;
  }

  if (!activePage) {
    throw new Error('Playwright not initialized');
  }

  const currentUrl = activePage.url();
  const isOnKimi = currentUrl.includes('kimi.com');

  if (!isOnKimi || forceNew) {
    console.log(`[Playwright] Navigating to Kimi home... (Current: ${currentUrl})`);
    await activePage.goto('https://www.kimi.com/', { waitUntil: 'domcontentloaded' });
  }

  // Wait for the textarea
  console.log('[Playwright] Waiting for chat input...');
  const inputSelector = 'textarea:visible, [contenteditable="true"]:visible, div[contenteditable="true"]';
  await activePage.waitForSelector(inputSelector, { timeout: 30000 }).catch(() => {
    console.error('[Playwright] Chat input not found. Current URL:', activePage!.url());
    throw new Error('Timeout waiting for chat input. Are you logged in?');
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      console.error('[Playwright] Timeout waiting for Kimi headers. Current URL:', activePage!.url());
      reject(new Error('Timeout waiting for Kimi headers'));
    }, 60000);

    console.log('[Playwright] Setting up route interception...');
    const routeHandler = async (route: any, request: any) => {
      clearTimeout(timeout);
      
      const reqHeaders = request.headers();
      let uiSessionId = '';
      let uiParentMessageId: string | null = null;

      const postData = request.postData();
      if (postData) {
        try {
          const jsonStart = postData.indexOf('{');
          if (jsonStart !== -1) {
            const payload = JSON.parse(postData.slice(jsonStart));
            if (payload.chat_id) {
              uiSessionId = payload.chat_id;
            }
            if (payload.message && payload.message.parent_id) {
              uiParentMessageId = payload.message.parent_id;
            }
          }
        } catch (e) {
          // ignore parsing error
        }
      }

      const extractedHeaders = {
        'cookie': reqHeaders['cookie'] || '',
        'authorization': reqHeaders['authorization'] || '',
        'connect-protocol-version': reqHeaders['connect-protocol-version'] || '1',
        'x-msh-device-id': reqHeaders['x-msh-device-id'] || '',
        'x-msh-platform': reqHeaders['x-msh-platform'] || 'web',
        'x-msh-session-id': reqHeaders['x-msh-session-id'] || '',
        'x-msh-version': reqHeaders['x-msh-version'] || '1.0.0',
        'x-traffic-id': reqHeaders['x-traffic-id'] || '',
        'r-timezone': reqHeaders['r-timezone'] || 'America/Maceio',
        'user-agent': reqHeaders['user-agent'] || '',
        'origin': 'https://www.kimi.com',
        'referer': 'https://www.kimi.com/'
      };

      // Ensure we have cookie and authorization (critical)
      if (!extractedHeaders.cookie || !extractedHeaders.authorization) {
        console.log('[Playwright] Intercepted request missing critical headers, skipping...');
        await route.continue();
        return;
      }

      console.log('[Playwright] Successfully intercepted Kimi headers.');
      currentHeaders = extractedHeaders;
      cachedKimiHeaders = { headers: extractedHeaders, chatSessionId: uiSessionId, parentMessageId: uiParentMessageId };
      lastHeadersTime = Date.now();

      // Abort to prevent polluting chat history
      await route.abort('aborted');
      
      // Cleanup route
      await activePage!.unroute('**/apiv2/kimi.gateway.chat.v1.ChatService/Chat*', routeHandler);

      resolve(cachedKimiHeaders);
    };

    activePage!.route('**/apiv2/kimi.gateway.chat.v1.ChatService/Chat*', routeHandler).then(async () => {
      console.log('[Playwright] Triggering request...');
      const inputSelector = 'textarea:visible, [contenteditable="true"]:visible, div[contenteditable="true"]';
      
      // We use type instead of fill to trigger all events
      await activePage!.focus(inputSelector);
      await activePage!.fill(inputSelector, ''); // clear first
      await activePage!.type(inputSelector, 'a', { delay: 100 });
      console.log('[Playwright] Typed char, waiting for UI to update...');
      await sleep(2000); // Wait more for Send button to enable
      
      // Improved Send Button detection & aggressive clicking
      const selectors = [
        'button[type="submit"]',
        'button.send-button',
        '.chat-input-send-button',
        'svg.send-icon',
        'button:has(svg)'
      ];
      
      let clicked = false;
      for (const selector of selectors) {
        try {
          const btn = await activePage!.$(selector);
          if (btn && await btn.isVisible()) {
            console.log(`[Playwright] Attempting click on: ${selector}`);
            
            // Try both DOM click and Playwright click
            await activePage!.evaluate((sel) => {
              const element = document.querySelector(sel) as HTMLElement;
              if (element) {
                element.focus();
                element.click();
              }
            }, selector);
            
            // Also try a real mouse click just in case
            await btn.click({ force: true, delay: 50 }).catch(() => {});
            
            clicked = true;
            break;
          }
        } catch (e) {
          console.error(`[Playwright] Error clicking ${selector}:`, e);
        }
      }

      if (!clicked) {
        console.log('[Playwright] No send button found/clicked, fallback to Enter...');
        await activePage!.focus(inputSelector);
        await activePage!.keyboard.press('Enter');
      }
    });
  });
}
