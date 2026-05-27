/*
 * File: kimi.ts
 * Project: kimiproxy
 * Author: Pedro Farias
 * Created: 2026-05-19
 */

import { getKimiHeaders } from './playwright.ts';

interface SessionData {
  kimiChatId: string;
  parentMessageId: string | null;
}

const sessions = new Map<string, SessionData>();

export function updateSession(sessionId: string, kimiChatId: string, parentMessageId: string | null) {
  if (!sessionId || !kimiChatId) return;
  sessions.set(sessionId, { kimiChatId, parentMessageId });
}

export function getSession(sessionId: string): SessionData | undefined {
  return sessions.get(sessionId);
}

export function clearSession(sessionId: string): void {
  sessions.delete(sessionId);
}

// Mapeia modelos recebidos do front para os cenários internos da Kimi
export function getModelScenario(modelId: string) {
  const cleanModel = modelId.replace('-no-thinking', '');
  if (cleanModel === 'k2d6') {
    return { scenario: 'SCENARIO_K2D5', thinking: false };
  } else if (cleanModel === 'k2d6-thinking') {
    return { scenario: 'SCENARIO_K2D5', thinking: true };
  } else if (cleanModel === 'k2d6-agent') {
    return { scenario: 'SCENARIO_OK_COMPUTER', kimiPlusId: 'ok-computer', agentMode: 'TYPE_NORMAL' };
  } else if (cleanModel === 'k2d6-agent-ultra') {
    return { scenario: 'SCENARIO_OK_COMPUTER', kimiPlusId: 'ok-computer', agentMode: 'TYPE_ULTRA' };
  }
  // Default fallback
  return { scenario: 'SCENARIO_K2D5', thinking: modelId.includes('thinking') };
}

// Cria a moldura (envelope de 5 bytes) do Connect Protocol
export function encodeConnectRequest(payload: any): Uint8Array {
  const jsonStr = JSON.stringify(payload);
  const encoder = new TextEncoder();
  const jsonBytes = encoder.encode(jsonStr);
  const length = jsonBytes.length;

  const framed = new Uint8Array(5 + length);
  framed[0] = 0x00; // Flag: uncompressed data
  framed[1] = (length >> 24) & 0xff;
  framed[2] = (length >> 16) & 0xff;
  framed[3] = (length >> 8) & 0xff;
  framed[4] = length & 0xff;
  framed.set(jsonBytes, 5);

  return framed;
}

export async function fetchKimiModels(): Promise<any[]> {
  // Return only the two allowed models
  return [
    { id: 'k2d6', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'kimi' },
    { id: 'k2d6-thinking', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'kimi' }
  ];
}

export async function createKimiStream(
  prompt: string,
  enableThinking: boolean,
  modelId: string,
  sessionId?: string | null
): Promise<{ stream: ReadableStream, headers: Record<string, string>, uiSessionId: string }> {
  let headers: Record<string, string>;
  let activeChatId: string;
  let parentMessageId: string | null = null;

  // Try to reuse existing session
  const cachedSession = sessionId ? getSession(sessionId) : undefined;
  
  if (cachedSession) {
    // OpenCode: reuse existing chat — use cached headers, inject saved chatId
    const result = await getKimiHeaders(false);
    headers = result.headers;
    activeChatId = cachedSession.kimiChatId;
    parentMessageId = cachedSession.parentMessageId;
  } else {
    // New session (or no sessionId): normal flow, Playwright handles it
    const result = await getKimiHeaders(false);
    headers = result.headers;
    activeChatId = result.chatSessionId;
    parentMessageId = result.parentMessageId;
  }

  const modelConfig = getModelScenario(modelId);
  
  const payload: any = {
    scenario: modelConfig.scenario,
    message: {
      parent_id: parentMessageId || "",
      role: 'user',
      blocks: [
        {
          message_id: '',
          text: {
            content: prompt
          }
        }
      ],
      scenario: modelConfig.scenario
    },
    options: {
      thinking: enableThinking || modelConfig.thinking || false
    }
  };

  if (activeChatId) {
    payload.chat_id = activeChatId;
  }

  // Active search tool
  //payload.tools = [{ type: 'TOOL_TYPE_SEARCH', search: {} }];

  if (modelConfig.kimiPlusId) {
    payload.kimi_plus_id = modelConfig.kimiPlusId;
  }
  if (modelConfig.agentMode) {
    payload.options.agent_mode = modelConfig.agentMode;
  }

  // Connect protocol framing
  const framedPayload = encodeConnectRequest(payload);

  const response = await fetch('https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/Chat', {
    method: 'POST',
    headers: {
      'accept': '*/*',
      'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      'authorization': headers['authorization'],
      'connect-protocol-version': '1',
      'content-type': 'application/connect+json',
      'cookie': headers['cookie'],
      'origin': 'https://www.kimi.com',
      'referer': activeChatId ? `https://www.kimi.com/chat/${activeChatId}` : 'https://www.kimi.com/',
      'user-agent': headers['user-agent'],
      'x-msh-device-id': headers['x-msh-device-id'],
      'x-msh-platform': 'web',
      'x-msh-session-id': headers['x-msh-session-id'],
      'x-msh-version': '1.0.0',
      'x-traffic-id': headers['x-traffic-id'],
      'r-timezone': headers['r-timezone']
    },
    body: framedPayload
  });

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Failed to fetch from Kimi: ${response.status} ${response.statusText} - ${errText}`);
  }

  return { stream: response.body, headers, uiSessionId: activeChatId };
}