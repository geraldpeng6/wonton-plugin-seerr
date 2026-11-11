// 把 Seerr 主人账号（user 1）的邮箱改成云吞内部邮箱 WONTON_OWNER_EMAIL。
//
// Seerr 的邮箱来自向导里媒体服务器登录表单，常是没有 @ 的用户名或外部地址；通知和
// 找回密码都发到它。应用只在建号时写一次，之后不会自己改，所以每次重建容器用
// Seerr 自己的接口对齐一次：已经是内部邮箱就不动。不直接改它的数据库。
//
// 认证用 settings.json 里的 API 密钥（X-API-Key），核心把它视作主人账号本人；
// 密钥由应用首次启动时生成并写回 settings.json，所以这个服务要排在 seerr 健康之后。
// 向导还没走完（还没有主人账号）时这次没得改，下次重建容器再对。
'use strict';

const fs = require('fs');
const path = require('path');

const ownerEmail = (process.env.WONTON_OWNER_EMAIL || '').toLowerCase();
const dir = process.env.SEERR_CONFIG_DIR || '/app/config';
const base = (process.env.SEERR_URL || 'http://seerr:5055').replace(/\/+$/, '');

if (!ownerEmail) {
  console.log('没有注入 WONTON_OWNER_EMAIL，不改邮箱');
  process.exit(0);
}

let apiKey;
try {
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8'));
  apiKey = settings.main?.apiKey;
} catch (e) {
  console.error(`读不到 settings.json：${e.message}`);
  process.exit(1);
}
if (!apiKey) {
  console.error('settings.json 里还没有 API 密钥，改不了邮箱');
  process.exit(1);
}

const api = async (p, opts = {}) => {
  let res;
  try {
    res = await fetch(`${base}/api/v1${p}`, {
      ...opts,
      headers: {
        'X-API-Key': apiKey,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  } catch (e) {
    throw new Error(`连不上 Seerr（${base}）：${e.message}`);
  }
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // 响应不是 JSON 时把原文交给调用方报错
  }
  return { status: res.status, body, text };
};

(async () => {
  // API 密钥只在库里已有主人账号（user 1）时才被认成这个人；向导没走完时库里没有
  // 用户，带密钥的请求也一律 403。所以先用无需认证的 /settings/public 判断该不该动。
  const pub = await api('/settings/public');
  if (pub.status !== 200) {
    console.error(`读 Seerr 公开设置失败：HTTP ${pub.status} ${pub.text}`);
    process.exit(1);
  }
  if (!pub.body?.initialized) {
    console.log('向导还没走完（应用未初始化），这次不改邮箱');
    process.exit(0);
  }

  const cur = await api('/user/1/settings/main');
  if (cur.status === 404) {
    console.log('应用已初始化但读不到主人账号，这次不改邮箱');
    process.exit(0);
  }
  if (cur.status !== 200) {
    console.error(`读主人账号设置失败：HTTP ${cur.status} ${cur.text}`);
    process.exit(1);
  }
  const current = cur.body || {};
  if ((current.email || '').toLowerCase() === ownerEmail) {
    console.log('主人邮箱已经是内部邮箱，不用改');
    process.exit(0);
  }

  // 只回传接口里会覆盖的字段，别把用户没填的设置写成空值。
  const payload = { email: ownerEmail };
  for (const k of [
    'username',
    'locale',
    'discoverRegion',
    'streamingRegion',
    'originalLanguage',
    'watchlistSyncMovies',
    'watchlistSyncTv',
  ]) {
    if (current[k] != null) payload[k] = current[k];
  }
  const saved = await api('/user/1/settings/main', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (saved.status !== 200) {
    console.error(`改主人邮箱失败：HTTP ${saved.status} ${saved.text}`);
    process.exit(1);
  }

  // Plex 类账号的邮箱由 plex.tv 管理，接口可能静默不改；核对一遍再算成功。
  const after = await api('/user/1/settings/main');
  if (after.status !== 200 || (after.body?.email || '').toLowerCase() !== ownerEmail) {
    console.error(
      `改完再读，主人邮箱还是 ${after.body?.email ?? '读不到'}，不是 ${ownerEmail}`
    );
    process.exit(1);
  }
  console.log(`主人邮箱已从 ${current.email || '空'} 改为 ${ownerEmail}`);
})().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
