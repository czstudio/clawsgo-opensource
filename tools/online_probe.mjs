/**
 * 在线 API 探测 - 对比线上 vs 本地响应
 */

const ONLINE = 'https://api.clawsgo.cn';
const LOCAL = 'http://localhost:5181';

async function probe(base, endpoint, body = {}, token = null) {
  try {
    const res = await fetch(`${base}/api/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data, headers: Object.fromEntries(res.headers) };
  } catch (e) {
    return { status: -1, error: e.message };
  }
}

async function authProbe(base) {
  // 发送 OTP
  const send = await probe(base, 'auth/phone-number/send-otp', { phoneNumber: '+8613800000000' });
  console.log(`[${base}] send-otp:`, send.status, send.data?.requestId ? 'OK' : 'FAIL');
  
  // 验证 OTP
  const verify = await probe(base, 'auth/phone-number/verify', { phoneNumber: '+8613800000000', code: '123456' });
  const token = verify.headers?.['set-auth-token'];
  console.log(`[${base}] verify:`, verify.status, verify.data?.userId ? 'OK' : 'FAIL', 'token:', token?.slice(0, 20));
  
  return token;
}

async function compareEndpoints(token, endpoint, body = {}) {
  const online = await probe(ONLINE, endpoint, body, token);
  const local = await probe(LOCAL, endpoint, body, token);
  
  const onlineKeys = online.data ? Object.keys(online.data) : [];
  const localKeys = local.data ? Object.keys(local.data) : [];
  
  const diff = {
    endpoint,
    onlineStatus: online.status,
    localStatus: local.status,
    onlineKeys,
    localKeys,
    missingInLocal: onlineKeys.filter(k => !localKeys.includes(k)),
    missingInOnline: localKeys.filter(k => !onlineKeys.includes(k)),
  };
  
  console.log(`\n[${endpoint}]`);
  console.log('  Online:', online.status, 'Keys:', onlineKeys.slice(0, 10).join(', '));
  console.log('  Local: ', local.status, 'Keys:', localKeys.slice(0, 10).join(', '));
  if (diff.missingInLocal.length) console.log('  Missing in local:', diff.missingInLocal);
  if (diff.missingInOnline.length) console.log('  Missing in online:', diff.missingInOnline);
  
  return diff;
}

async function main() {
  console.log('=== ONLINE VS LOCAL API COMPARISON ===\n');
  
  // 先获取 token（本地）
  const localToken = await authProbe(LOCAL);
  
  // 对比关键端点
  const endpoints = [
    ['getProfile', {}],
    ['getConversations', { limit: 10, offset: 0 }],
    ['getPlans', {}],
    ['getSubscription', {}],
    ['getHosts', {}],
    ['getSkills', {}],
    ['getImages', {}],
    ['getProjects', { limit: 10, offset: 0 }],
    ['getCards', {}],
    ['getSubagents', {}],
    ['getMcpServers', {}],
    ['getTeamMembers', {}],
    ['getNotifications', { limit: 10, offset: 0 }],
    ['getTickets', { limit: 10, offset: 0 }],
    ['getPaymentOrders', { limit: 10, offset: 0 }],
    ['getInvoices', { limit: 10, offset: 0 }],
    ['getLedger', { limit: 10, offset: 0 }],
    ['getInviteCodes', {}],
    ['getDevices', {}],
    ['getActivities', { limit: 10, offset: 0 }],
    ['getUsageStats', {}],
    ['getOverview', {}],
  ];
  
  const results = [];
  for (const [ep, body] of endpoints) {
    const diff = await compareEndpoints(localToken, ep, body);
    results.push(diff);
  }
  
  console.log('\n=== SUMMARY ===');
  const mismatched = results.filter(r => r.missingInLocal.length > 0 || r.missingInOnline.length > 0);
  console.log(`Total: ${results.length}, Mismatched: ${mismatched.length}`);
  
  if (mismatched.length > 0) {
    console.log('\nMismatched endpoints:');
    for (const m of mismatched) {
      console.log(`  ${m.endpoint}: missing local=[${m.missingInLocal.join(', ')}], missing online=[${m.missingInOnline.join(', ')}]`);
    }
  }
  
  fs.writeFileSync('/Users/cz/code/clawsgo-open/work/deep-reverse/api-diff.json', JSON.stringify(results, null, 2));
}

import fs from 'node:fs';
main().catch(console.error);
