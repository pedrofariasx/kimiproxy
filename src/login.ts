/*
 * File: login.ts
 * Project: kimiproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 * 
 * Last Modified: Tue May 19 2026
 * Modified By: Pedro Farias
 */

import { initPlaywright, closePlaywright, activePage, BrowserType } from './services/playwright.ts';
import * as dotenv from 'dotenv';
import readline from 'readline';

dotenv.config();

function askQuestion(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans.trim());
  }));
}

async function main() {
  // Parse browser type from args or env
  let browserType: BrowserType = 'chromium';
  const browserArg = process.argv.find(arg => arg.startsWith('--browser='));
  if (browserArg) {
    browserType = browserArg.split('=')[1] as BrowserType;
  } else if (process.env.BROWSER) {
    browserType = process.env.BROWSER as BrowserType;
  }

  console.log('\n===========================================================');
  console.log('🔑 AUTENTICAÇÃO INTERATIVA - KIMIPROXY');
  console.log('===========================================================');
  
  const phoneInput = await askQuestion('📞 Digite o seu número de telefone (com DDI e DDD, ex: 5582987185879): ');
  if (!phoneInput) {
    console.error('❌ Erro: O número de telefone é obrigatório para realizar a autenticação.');
    process.exit(1);
  }

  let countryCode = '+55';
  let phoneNumber = phoneInput;

  if (phoneInput.startsWith('55')) {
    countryCode = '+55';
    phoneNumber = phoneInput.substring(2);
  } else if (phoneInput.startsWith('+55')) {
    countryCode = '+55';
    phoneNumber = phoneInput.substring(3);
  }

  console.log(`\n[Playwright] Inicializando navegador em segundo plano (HEADLESS)...`);
  // Executa 100% headless
  await initPlaywright(true, browserType);

  if (!activePage) {
    console.error('Falha ao inicializar o Playwright.');
    process.exit(1);
  }

  // Setup graceful termination
  const cleanup = async () => {
    console.log('\nEncerrando navegador...');
    await closePlaywright();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);

  // Setup real-time request interception to capture authentic guest headers
  let capturedHeaders: Record<string, string> = {};

  activePage.on('request', (request) => {
    const url = request.url();
    if (url.includes('kimi.com/api') || url.includes('kimi.com/apiv2')) {
      const headers = request.headers();
      if (headers['authorization'] && headers['x-msh-device-id']) {
        capturedHeaders = {
          'authorization': headers['authorization'],
          'x-msh-device-id': headers['x-msh-device-id'],
          'x-msh-platform': headers['x-msh-platform'] || 'web',
          'x-msh-session-id': headers['x-msh-session-id'] || '',
          'x-msh-version': headers['x-msh-version'] || '1.0.0',
          'x-traffic-id': headers['x-traffic-id'] || headers['x-msh-device-id'] || '',
          'x-language': headers['x-language'] || 'en-US',
          'r-timezone': headers['r-timezone'] || 'America/Maceio'
        };
      }
    }
  });

  try {
    console.log('Navegando para www.kimi.com para estabelecer cookies...');
    await activePage.goto('https://www.kimi.com/', { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 4000));

    console.log('Acionando botão de login na página para disparar a geração do Token de Visitante (Guest Token)...');
    const loginButtons = [
      'button:has-text("Log In")',
      'button:has-text("Sign Up")',
      'button:has-text("登录")',
      'button:has-text("注册")',
      '.login-btn',
      '.header-login-btn',
      'button.btn-primary',
      'div:has-text("登录")',
      'div:has-text("注册")'
    ];
    let clicked = false;
    for (const selector of loginButtons) {
      try {
        const btn = await activePage.$(selector);
        if (btn && await btn.isVisible()) {
          await btn.click({ force: true });
          clicked = true;
          console.log(`Botão de login acionado via seletor: ${selector}`);
          break;
        }
      } catch (e) {}
    }

    if (!clicked) {
      console.log('⚠️ Aviso: Não foi possível clicar no botão de login automaticamente. Aguardando geração passiva...');
    }

    await new Promise(r => setTimeout(r, 3000));

    console.log('Aguardando a geração das credenciais de visitante (guest tokens)...');
    let retries = 30;
    while (retries > 0 && (!capturedHeaders['authorization'] || !capturedHeaders['x-msh-device-id'])) {
      await new Promise(r => setTimeout(r, 500));
      retries--;
    }

    if (!capturedHeaders['authorization']) {
      console.log('⚠️ Aviso: Não foi possível interceptar os cabeçalhos de visitante automaticamente. Usando valores padrão.');
      capturedHeaders = {
        'authorization': 'Bearer ',
        'x-msh-device-id': '7641490630610354442',
        'x-msh-platform': 'web',
        'x-msh-session-id': '1731715420600121278',
        'x-msh-version': '1.0.0',
        'x-traffic-id': '7641490630610354442',
        'x-language': 'en-US',
        'r-timezone': 'America/Maceio'
      };
    } else {
      console.log('✅ Credenciais de visitante interceptadas com sucesso!');
      console.log(`- Token de Autorização: ${capturedHeaders['authorization'].substring(0, 35)}...`);
      console.log(`- Device ID: ${capturedHeaders['x-msh-device-id']}`);
      console.log(`- Session ID: ${capturedHeaders['x-msh-session-id']}`);
      console.log(`- Versão (x-msh-version): ${capturedHeaders['x-msh-version']}`);
    }

    console.log(`Disparando requisição direta de SMS para o número ${countryCode} ${phoneNumber}...`);
    const smsResult = await activePage.evaluate(async ({ countryCode, phoneNumber, headers }) => {
      const res = await fetch('https://www.kimi.com/api/user/sms/verify-code', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json, text/plain, */*',
          'authorization': headers['authorization'] || '',
          'x-msh-device-id': headers['x-msh-device-id'] || '',
          'x-msh-platform': headers['x-msh-platform'] || 'web',
          'x-msh-session-id': headers['x-msh-session-id'] || '',
          'x-msh-version': headers['x-msh-version'] || '1.0.0',
          'x-traffic-id': headers['x-traffic-id'] || '',
          'x-language': headers['x-language'] || 'en-US',
          'r-timezone': headers['r-timezone'] || 'America/Maceio'
        },
        body: JSON.stringify({
          action: "register",
          phone: phoneNumber,
          country_code: countryCode
        })
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Erro ao enviar SMS: ${res.status} - ${text}`);
      }
      try {
        return await res.json();
      } catch (e) {
        return null;
      }
    }, { countryCode, phoneNumber, headers: capturedHeaders });

    console.log('📨 Requisição de código SMS enviada com sucesso!');
    if (smsResult) {
      console.log('Resultado da API:', JSON.stringify(smsResult));
    }

    // Prompt user in terminal for the verification code
    const verifyCode = await askQuestion('\n📨 Digite o código de verificação recebido por SMS no seu celular: ');
    if (!verifyCode) {
      console.error('❌ Código de verificação não informado.');
      await cleanup();
    }

    console.log(`Verificando o código SMS digitado (${verifyCode}) via API direta...`);
    const loginResult = await activePage.evaluate(async ({ countryCode, phoneNumber, verifyCode, headers }) => {
      const res = await fetch('https://www.kimi.com/api/user/register/trial', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json, text/plain, */*',
          'authorization': headers['authorization'] || '',
          'x-msh-device-id': headers['x-msh-device-id'] || '',
          'x-msh-platform': headers['x-msh-platform'] || 'web',
          'x-msh-session-id': headers['x-msh-session-id'] || '',
          'x-msh-version': headers['x-msh-version'] || '1.0.0',
          'x-traffic-id': headers['x-traffic-id'] || '',
          'x-language': headers['x-language'] || 'en-US',
          'r-timezone': headers['r-timezone'] || 'America/Maceio'
        },
        body: JSON.stringify({
          country_code: countryCode,
          phone: phoneNumber,
          verify_code: verifyCode,
          wx_user_id: "",
          apple_user_id: ""
        })
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Falha na autenticação do código SMS: ${res.status} - ${text}`);
      }
      return await res.json();
    }, { countryCode, phoneNumber, verifyCode, headers: capturedHeaders });

    console.log('🎉 Autenticação realizada com sucesso!');
    const token = loginResult.access_token;
    if (!token) {
      throw new Error('A resposta da API de login não retornou um access_token válido.');
    }

    console.log('Injetando credenciais de sessão (Access Token e Cookies) no contexto do Playwright...');
    // Inject kimi-auth cookie
    await activePage.context().addCookies([
      {
        name: 'kimi-auth',
        value: token,
        domain: '.kimi.com',
        path: '/'
      }
    ]);

    // Inject into Local Storage
    await activePage.evaluate((t) => {
      localStorage.setItem('kimi-auth', t);
      localStorage.setItem('access_token', t);
    }, token);

    console.log('Recarregando página do Kimi com a sessão injetada...');
    await activePage.goto('https://www.kimi.com/', { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 4000));

    // Wait for chat interface to confirm session is valid
    const chatInputSelector = 'textarea:visible, [contenteditable="true"]:visible, div[contenteditable="true"]';
    await activePage.waitForSelector(chatInputSelector, { timeout: 30000 });

    console.log('\n🎉 Sessão autenticada e salva com sucesso em kimi_profile/!');
  } catch (e: any) {
    console.error('\n❌ Erro durante o login direto por API:', e.message || e);
  }

  await closePlaywright();
  process.exit(0);
}

main();
