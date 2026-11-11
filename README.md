# Seerr 求片插件

开发流程见[插件开发指南](https://github.com/wontonapp/wonton-docs/blob/main/develop.md)。

Seerr 是影视求片和订阅工具：搜索想看的电影和剧集，一键求片，媒体库入库后收到通知。它连接 Jellyfin、Emby 或 Plex 作为媒体库来源；本插件面向已装（或将要装）云吞 Jellyfin 插件的场景。

本插件使用 Seerr 官方镜像 `ghcr.io/seerr-team/seerr:v3.5.1`（amd64、arm64），经云吞网关打开网页。出网权限用于查询 TMDB 的元数据和海报。

## 图标与许可

`icon.svg` 使用 Seerr 仓库的官方标志 `public/os_icon.svg`，仅按插件规范加白色满幅底色；来源、MIT 许可全文和商标说明见 [NOTICE](NOTICE)。本插件不代表 Seerr 官方出品、合作或背书。

## 首次启动与登录

Seerr 没有原生 OIDC，也不认反向代理传来的用户名，所以清单用 `sso: none`：云吞网关保护网页，Seerr 保留自己的登录。第一次打开进入 Seerr 上游的向导：选择媒体服务器类型，填地址，用那台服务器的管理员账号登录——该账号随之成为 Seerr 管理员，之后家人用各自的媒体服务器账号登录求片。

连接 Jellyfin 的地址和 API 密钥按云吞的能力依赖接口注入（`WONTON_JELLYFIN_URL` / `WONTON_JELLYFIN_KEY`，由一次性服务 `init` 写进 Seerr 的 `settings.json`，每次重建容器都会更新）；变量为空时不写任何配置。能力依赖接口上线前的首次启动方案见 PR 说明——上游向导强制手填地址，与预置地址冲突，这一摩擦已报给底座。

## 邮件通知

Seerr 自己会发信：找回密码、管理员建账号时的初始密码、求片进展通知。这些信经云吞的内部邮箱发出，出现在收件人的云吞“Wonton”私聊里；只能发给家里的人，收件人是外部地址（比如 Plex 账号的邮箱）时发送失败。SMTP 地址和发件人由云吞注入，每次重建容器由一次性服务 `init` 写进 Seerr 的 `settings.json`，不用手填。

主人的内部邮箱在每次重建容器时自动写进 Seerr（一次性服务 `init-mail`，调 Seerr 自己的接口）；向导还没走完时没有主人账号，对齐推迟到下一次重建，急用也可以直接在 Seerr 的用户设置里改。家人登录后 Seerr 默认拿媒体服务器用户名当邮箱，发给他们的通知会失败：在 Seerr 的“用户管理”里把每个家人的邮箱改成他/她的内部邮箱 `<用户名>@wonton.internal`。

## 全自动下载

Seerr 只负责求片和跟踪库存。要自动下载，在 Seerr 设置里连接 Radarr / Sonarr 和下载器，按 Seerr 自己的文档配置；这些服务不在本插件范围内。

## 仓库里有什么

| 路径 | 内容 |
| --- | --- |
| `docker-compose.yml` | 插件本身：Seerr compose 加上 `x-wonton` 清单 |
| `init/init-settings.js` | 把核心注入的 Jellyfin 地址和密钥写进 `settings.json` 的一次性脚本 |
| `icon.svg` | Seerr 官方标志 |
| `scripts/check.sh` | 检查插件包，规则和安装时一样 |
| `scripts/dev.sh` | 开发环境：起一套云吞，装、重装、卸载插件，看日志、跑探针和冒烟 |
| `scripts/smoke-probes.sh` | 冒烟对这个插件逐项的探测 |
| `scripts/publish.sh` | 发布一个版本：打 tag、推送；`images/` 里有自己构建的镜像时先构建、推送并按摘要写回（本插件直接用上游镜像） |
| `AGENTS.md` | 给人和 AI 编程代理的规则 |
| `LICENSE` | 插件包自己的许可证 |
| `NOTICE` | 图标等第三方素材的许可和声明 |
| `.wonton/` | 开发环境的设置、密钥和数据，不提交 |
