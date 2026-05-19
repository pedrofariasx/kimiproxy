import test from 'node:test';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';

import { app } from '../index.ts';
import { encodeConnectRequest } from '../services/kimi.ts';

delete process.env.API_KEY;

// Helper to mock the fetch global for testing empty response retry and caching logic
function setupFetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (urlStr.includes('kimi.com')) {
      if (urlStr.includes('/GetAvailableModels')) {
         return new Response(JSON.stringify({ availableModels: [{ key: 'k2d6' }] }), { status: 200 });
      }
      return handler(urlStr, init);
    }
    return originalFetch(input, init);
  };
  return () => { globalThis.fetch = originalFetch; };
}

test('multiturn-thinking-tools: maintains reasoning_content history', async () => {
  let capturedPrompt = '';

  const restore = setupFetchMock((url, init) => {
    const rawBody = init?.body;
    let bodyObj: any = {};
    if (rawBody) {
      let bodyStr = '';
      if (typeof rawBody === 'string') {
        bodyStr = rawBody;
      } else if (rawBody instanceof Uint8Array) {
        bodyStr = new TextDecoder().decode(rawBody);
      } else if (Buffer.isBuffer(rawBody)) {
        bodyStr = rawBody.toString('utf-8');
      }
      
      const braceIndex = bodyStr.indexOf('{');
      if (braceIndex !== -1) {
        bodyStr = bodyStr.slice(braceIndex);
      }
      try {
        bodyObj = JSON.parse(bodyStr);
      } catch (e) {}
    }

    capturedPrompt = bodyObj.message?.blocks?.[0]?.text?.content || '';
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(encodeConnectRequest({
          op: 'set',
          mask: 'message',
          message: { id: 'kimi-1001', role: 'assistant' }
        }));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'k2d6',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'doing something', reasoning_content: 'thinking about hello' },
          { role: 'user', content: 'success' }
        ]
      })
    });
    
    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    // Validate that the conversation history is formatted correctly
    assert.ok(capturedPrompt.includes('User: hello'), 'Must include previous user message');
    assert.ok(capturedPrompt.includes('<think>\nthinking about hello\n</think>'), 'Must include previous thinking');
    assert.ok(capturedPrompt.includes('User: success'), 'Must include final user message');
  } finally {
    restore();
  }
});

test('streaming-whitespace: preserves exact whitespace', async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(encodeConnectRequest({
          op: 'append',
          mask: 'block.text.content',
          block: { text: { content: '   ' } }
        }));
        c.enqueue(encodeConnectRequest({
          op: 'append',
          mask: 'block.text.content',
          block: { text: { content: '  hello  ' } }
        }));
        c.enqueue(encodeConnectRequest({
          op: 'append',
          mask: 'block.text.content',
          block: { text: { content: '\n\n  ' } }
        }));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'k2d6', messages: [{role: 'user', content: 'test'}], stream: true })
    });
    
    const res = await app.fetch(req);
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let full = '';
    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.choices?.[0]?.delta?.content) {
              full += data.choices[0].delta.content;
            }
          } catch(e) {}
        }
      }
    }
    
    // We expect exactly: "     hello  \n\n  "
    assert.strictEqual(full, "     hello  \n\n  ");
  } finally {
    restore();
  }
});

test('caching-streaming and cache-control: returns prompt_tokens_details', async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(encodeConnectRequest({
          op: 'append',
          mask: 'block.text.content',
          block: { text: { content: 'done' } }
        }));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'k2d6', messages: [{role: 'user', content: 'test'}], stream: true })
    });
    
    const res = await app.fetch(req);
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let usageBlock: any = null;
    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.usage) {
              usageBlock = data.usage;
            }
          } catch(e) {}
        }
      }
    }
    
    assert.ok(usageBlock);
    assert.strictEqual(usageBlock.completion_tokens, Math.ceil('done'.length / 3.5));
    assert.ok(usageBlock.prompt_tokens > 0);
  } finally {
    restore();
  }
});

test('session-parent-tracking: appends messages using response message_id as parent', async () => {
  let capturedPayloads: any[] = [];

  const restore = setupFetchMock((url, init) => {
    const rawBody = init?.body;
    let bodyObj: any = {};
    if (rawBody) {
      let bodyStr = '';
      if (typeof rawBody === 'string') {
        bodyStr = rawBody;
      } else if (rawBody instanceof Uint8Array) {
        bodyStr = new TextDecoder().decode(rawBody);
      } else if (Buffer.isBuffer(rawBody)) {
        bodyStr = rawBody.toString('utf-8');
      }
      
      const braceIndex = bodyStr.indexOf('{');
      if (braceIndex !== -1) {
        bodyStr = bodyStr.slice(braceIndex);
      }
      try {
        bodyObj = JSON.parse(bodyStr);
      } catch (e) {}
    }
    capturedPayloads.push(bodyObj);
    
    const mockMessageId = capturedPayloads.length === 1 ? 'kimi-1001' : 'kimi-1002';
    
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(encodeConnectRequest({
          op: 'set',
          mask: 'message',
          message: { id: mockMessageId, role: 'assistant' }
        }));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    process.env.TEST_SESSION_ID = 'test-session-parent-tracking';
    // Turn 1
    const req1 = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'k2d6',
        messages: [{ role: 'user', content: 'Turn 1' }]
      })
    });
    
    const res1 = await app.fetch(req1);
    assert.strictEqual(res1.status, 200);
    await res1.text();

    // Turn 2
    const req2 = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'k2d6',
        messages: [
          { role: 'user', content: 'Turn 1' },
          { role: 'assistant', content: 'Response 1' },
          { role: 'user', content: 'Turn 2' }
        ]
      })
    });
    
    const res2 = await app.fetch(req2);
    assert.strictEqual(res2.status, 200);
    await res2.text();

    assert.strictEqual(capturedPayloads.length, 2);
    // In Turn 1, parent_id should be empty string
    assert.strictEqual(capturedPayloads[0].message?.parent_id, '');
    // In Turn 2, parent_id should be kimi-1001
    assert.strictEqual(capturedPayloads[1].message?.parent_id, 'kimi-1001', 'Turn 2 should use response_id from Turn 1 as parent');
    assert.strictEqual(capturedPayloads[1].message?.blocks?.[0]?.text?.content, 'User: Turn 1\n\nAssistant: Response 1\n\nUser: Turn 2\n\n', 'Should send the full OpenAI message history');
  } finally {
    restore();
  }
});
