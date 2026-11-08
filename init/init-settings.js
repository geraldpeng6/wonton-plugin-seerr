// 把云吞注入的配置写进 Seerr 的 settings.json：Jellyfin 连接信息和发信（SMTP）配置。
// Seerr 没有从环境变量读这些配置的入口，连接信息只能落在这个文件；
// 应用加载时会用内置默认值补全缺失字段（server/lib/settings 的 mergeSettings），
// 所以这里写最小结构是安全的。
//
// WONTON_JELLYFIN_URL / WONTON_JELLYFIN_KEY 由核心在插件声明使用 jellyfin 能力时注入；
// WONTON_SMTP_* / WONTON_MAIL_FROM 由核心在插件申请 notify 权限时注入。
// 变量为空（能力依赖接口未上线、用户没有选择提供方，或核心太旧）时不写对应配置，
// 用户在向导和设置页里自己填。
// 每次创建容器都会重新运行：注入的值变了就覆盖写最新的。
'use strict';

const fs = require('fs');
const path = require('path');

const dir = process.env.SEERR_CONFIG_DIR || '/app/config';
const file = path.join(dir, 'settings.json');

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(file, 'utf-8'));
} catch {
  settings = {};
}

const url = process.env.WONTON_JELLYFIN_URL || '';
const key = process.env.WONTON_JELLYFIN_KEY || '';
const smtpHost = process.env.WONTON_SMTP_HOST || '';
const smtpPort = Number(process.env.WONTON_SMTP_PORT || '') || 0;
const mailFrom = process.env.WONTON_MAIL_FROM || '';

let changed = false;

if (url) {
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

  settings.jellyfin = {
    ...(settings.jellyfin || {}),
    name: settings.jellyfin?.name ?? '',
    ip,
    port,
    useSsl,
    urlBase,
    apiKey: key || settings.jellyfin?.apiKey || '',
  };
  changed = true;
  console.log(
    `已写入 Jellyfin 连接 ${ip}:${port}${urlBase}${key ? '（含 API 密钥）' : ''}`
  );
}

if (smtpHost && smtpPort && mailFrom) {
  // 核心的 SMTP 不加密、也不提供 STARTTLS：ignoreTls 让应用不探测、直接明文发。
  // 不填用户名密码：服务器接受任何凭据，但明文连接上认证只会添乱。
  // senderName、开关通知类型这些用户自己的设置不在覆盖范围里。
  settings.notifications = {
    ...settings.notifications,
    agents: {
      ...settings.notifications?.agents,
      email: {
        ...settings.notifications?.agents?.email,
        enabled: true,
        options: {
          ...settings.notifications?.agents?.email?.options,
          emailFrom: mailFrom,
          smtpHost,
          smtpPort,
          ignoreTls: true,
        },
      },
    },
  };
  changed = true;
  console.log(`已写入发信配置 ${smtpHost}:${smtpPort}，发件地址 ${mailFrom}`);
} else if (smtpHost || smtpPort || mailFrom) {
  console.error(
    '发信配置只注入了一部分' +
      `（HOST=${smtpHost || '空'} PORT=${process.env.WONTON_SMTP_PORT || '空'} MAIL_FROM=${mailFrom || '空'}），` +
      '三个变量要同时有值才写，请检查核心对 notify 权限的支持'
  );
  process.exit(1);
}

if (!changed) {
  process.exit(0);
}

fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
