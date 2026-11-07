// 把云吞注入的 Jellyfin 能力地址和密钥写进 Seerr 的 settings.json。
// Seerr 没有从环境变量读媒体服务器配置的入口，连接信息只能落在这个文件；
// 应用加载时会用内置默认值补全缺失字段（server/lib/settings 的 mergeSettings），
// 所以这里写最小结构是安全的。
//
// WONTON_JELLYFIN_URL / WONTON_JELLYFIN_KEY 由核心在插件声明使用 jellyfin 能力时注入；
// 为空（能力依赖接口未上线，或用户没有选择提供方）时不改任何文件，用户在向导里自己填。
// 每次创建容器都会重新运行：地址或密钥变了就覆盖写最新的。
'use strict';

const fs = require('fs');
const path = require('path');

const url = process.env.WONTON_JELLYFIN_URL || '';
const key = process.env.WONTON_JELLYFIN_KEY || '';
const dir = process.env.SEERR_CONFIG_DIR || '/app/config';
const file = path.join(dir, 'settings.json');

if (!url) {
  process.exit(0);
}

let parsed;
try {
  parsed = new URL(url);
} catch {
  console.error(`WONTON_JELLYFIN_URL 不是合法 URL：${url}`);
  process.exit(1);
}
if (parsed.username || parsed.password) {
  console.error('WONTON_JELLYFIN_URL 不应携带用户名或密码');
  process.exit(1);
}

const useSsl = parsed.protocol === 'https:';
const ip = parsed.hostname;
const port = Number(parsed.port) || (useSsl ? 443 : 8096);
const urlBase = parsed.pathname.replace(/\/+$/, '');

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(file, 'utf-8'));
} catch {
  settings = {};
}
settings.jellyfin = {
  ...(settings.jellyfin || {}),
  name: settings.jellyfin?.name ?? '',
  ip,
  port,
  useSsl,
  urlBase,
  apiKey: key || settings.jellyfin?.apiKey || '',
};

fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
console.log(
  `已写入 Jellyfin 连接 ${ip}:${port}${urlBase}${key ? '（含 API 密钥）' : ''}`
);
