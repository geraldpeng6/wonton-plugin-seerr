// 把云吞注入的配置写进 Seerr 的 settings.json：Jellyfin 连接信息和发信（SMTP）配置。
// Seerr 没有从环境变量读这些配置的入口，连接信息只能落在这个文件。
//
// 这个文件必须是完整的一份设置（应用启动时有一处用 raw 模式整份读回，缺 main 等顶层键会崩），
// 所以这里借用应用自己的 Settings 类（和应用同一份官方镜像）来生成、合并后再落盘，
// 不自己维护一份默认值；密钥也由应用补齐。
//
// WONTON_JELLYFIN_URL / WONTON_JELLYFIN_KEY 由核心在插件声明使用 jellyfin 能力时注入；
// WONTON_SMTP_* / WONTON_MAIL_FROM 由核心在插件申请 notify 权限时注入。
// 变量为空（能力依赖接口未上线、用户没有选择提供方，或核心太旧）时不写对应配置，
// 用户在向导和设置页里自己填。
// 每次创建容器都会重新运行：注入的值变了就覆盖写最新的。
'use strict';

const dir = process.env.SEERR_CONFIG_DIR || '/app/config';
// 应用读 CONFIG_DIRECTORY 里的 settings.json；和应用容器挂的是同一个目录。
process.env.CONFIG_DIRECTORY = dir;

const url = process.env.WONTON_JELLYFIN_URL || '';
const key = process.env.WONTON_JELLYFIN_KEY || '';
const smtpHost = process.env.WONTON_SMTP_HOST || '';
const smtpPort = Number(process.env.WONTON_SMTP_PORT || '') || 0;
const mailFrom = process.env.WONTON_MAIL_FROM || '';

let parsedUrl;
if (url) {
  try {
    parsedUrl = new URL(url);
  } catch {
    console.error(`WONTON_JELLYFIN_URL 不是合法 URL：${url}`);
    process.exit(1);
  }
  if (parsedUrl.username || parsedUrl.password) {
    console.error('WONTON_JELLYFIN_URL 不应携带用户名或密码');
    process.exit(1);
  }
}

if (smtpHost || smtpPort || mailFrom) {
  if (!smtpHost || !smtpPort || !mailFrom) {
    console.error(
      '发信配置只注入了一部分' +
        `（HOST=${smtpHost || '空'} PORT=${process.env.WONTON_SMTP_PORT || '空'} MAIL_FROM=${mailFrom || '空'}），` +
        '三个变量要同时有值才写，请检查核心对 notify 权限的支持'
    );
    process.exit(1);
  }
}

if (!url && !smtpHost) {
  process.exit(0);
}

// 应用自己的 Settings：load() 读现有文件（没有就生成完整默认值）、跑迁移、补密钥并保存。
const settings = new (require('/app/dist/lib/settings/index.js').default)();
settings
  .load()
  .then(() => {
    if (parsedUrl) {
      const useSsl = parsedUrl.protocol === 'https:';
      const port = Number(parsedUrl.port) || (useSsl ? 443 : 8096);
      const urlBase = parsedUrl.pathname.replace(/\/+$/, '');
      settings.jellyfin = {
        name: settings.jellyfin.name ?? '',
        ip: parsedUrl.hostname,
        port,
        useSsl,
        urlBase,
        apiKey: key || settings.jellyfin.apiKey || '',
      };
      console.log(
        `已写入 Jellyfin 连接 ${parsedUrl.hostname}:${port}${urlBase}${key ? '（含 API 密钥）' : ''}`
      );
    }

    if (smtpHost) {
      // 核心的 SMTP 不加密、也不提供 STARTTLS：ignoreTls 让应用不探测、直接明文发。
      // 不填用户名密码：服务器接受任何凭据，但明文连接上认证只会添乱。
      // senderName、通知开关这些用户自己的设置不在覆盖范围里。
      settings.notifications = {
        agents: {
          email: {
            enabled: true,
            options: {
              emailFrom: mailFrom,
              smtpHost,
              smtpPort,
              ignoreTls: true,
            },
          },
        },
      };
      console.log(`已写入发信配置 ${smtpHost}:${smtpPort}，发件地址 ${mailFrom}`);
    }

    return settings.save();
  })
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`写 settings.json 失败：${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
