# shellcheck shell=bash
# scripts/dev.sh 的 probes / smoke 和 e2e/smoke.sh 都会 source 本文件，逐项调用下面的探针。
#
# Seerr：sso=none。上游没有 OIDC，也不认反向代理传来的用户名；首个管理员只能在上游向导里
# 通过登录一台真实媒体服务器创建。所以身份探针用官方 Jellyfin 镜像起一台一次性的
# 媒体服务器容器，接到本插件的网络里，经 Seerr 自己的向导 API 走完真实流程：
# Jellyfin 建管理员 → Seerr 用这个账号登录并创建首个管理员 → 断言 /auth/me 是主人管理员。
# 数据探针建一个本地用户，升级/重装后核对它还在。
#
# 钩子只依赖脚手架保证的东西：助手 dweb（dev.sh web：核心登录跳转 + 会话存进 --jar）、
# 变量 SMOKE_OWNER。e2e 对 identity_check 是直接调用（不经 run_hook，SMOKE_* 未导出），
# 所以这里不依赖其它 SMOKE_* 变量：容器和网络用 wonton.plugin 标签自己找，
# 主人名缺省为 owner（e2e 实例的主人名默认就是它）。

PROBE_PLUGIN_ID="app.seerr.seerr"

# 本插件的 seerr 容器（标签 wonton.plugin=<id>，服务名 seerr）。
probe_container() {
  local cname
  cname="$(docker ps --filter "label=wonton.plugin=$PROBE_PLUGIN_ID" --format '{{.Names}}' | grep -- '--seerr$' | head -1)"
  [[ -n "$cname" ]] || { echo "找不到 seerr 容器（标签 wonton.plugin=$PROBE_PLUGIN_ID）"; return 1; }
  printf '%s' "$cname"
}

probe_instance() {
  local cname inst
  cname="$(probe_container)" || return 1
  inst="${cname#wonton-}"
  printf '%s' "${inst%%--*}"
}

probe_network() {
  local cname net
  cname="$(probe_container)" || return 1
  net="$(docker inspect "$cname" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}
{{end}}' | head -1)"
  [[ -n "$net" ]] || { echo "seerr 容器不在任何网络里"; return 1; }
  printf '%s' "$net"
}

jellyfin_helper_name() {
  printf 'seerr-probe-jellyfin-%s' "$(probe_instance)"
}

# 探针容器不能一直挂在插件网络上：网络有活动端点时 Docker 拒绝卸载/重建插件
# （"network has active endpoints"），smoke 的 reinstall 会失败。用完就断开。
helper_detach() {
  local net jf
  jf="$(jellyfin_helper_name)"
  net="$(probe_network 2>/dev/null)" || return 0
  docker network disconnect "$net" "$jf" 2>/dev/null || true
}

# 探针自己的会话 jar：网关 Cookie 来自 core_login（dev.sh web 的登录跳转），
# Seerr 的 connect.sid 来自向导/登录响应；跨调用保留。
seerr_api() {
  local p="$1"; shift
  dweb --jar "$JAR" "$p" -H 'Content-Type: application/json' "$@"
}

# 网关会话失效时自己补一次登录。--fresh 必须带上：session_into 见 jar 文件存在
# （哪怕是刚 mktemp 的空文件）就直接跳过登录，不带网关会话的请求只会拿到
# 网关的错误体，jq 解析才报 Invalid numeric literal。
core_login() {
  dweb --jar "$JAR" --fresh / >/dev/null 2>&1
}

# 会话与身份的公共前置：网关会话有效就用；没初始化就先走一遍真实向导；初始化过就重新登录。
ensure_session_run() {
  local res
  res="$(seerr_api /api/v1/auth/me 2>&1)"
  if jq -e '(.username != null or .jellyfinUsername != null) and (.permissions % 4 >= 2)' <<<"$res" 2>/dev/null >/dev/null; then
    return 0
  fi
  core_login || return 1
  res="$(seerr_api /api/v1/auth/me 2>&1)"
  if jq -e '(.username != null or .jellyfinUsername != null) and (.permissions % 4 >= 2)' <<<"$res" 2>/dev/null >/dev/null; then
    return 0
  fi
  res="$(seerr_api /api/v1/settings/public 2>&1)" || { echo "读不到 Seerr 状态：$res"; return 1; }
  if jq -e '.initialized == false' <<<"$res" 2>/dev/null >/dev/null; then
    ensure_jellyfin || return 1
    setup_seerr || return 1
  else
    # 已初始化但会话失效：用 Jellyfin 账号重新登录（地址已存在，不带 hostname）。
    # 登录要 Seerr 能连到那台 Jellyfin，探针容器可能已被断开，先接回去。
    ensure_jellyfin || return 1
    local body
    body="$(jq -nc --arg u "${SMOKE_OWNER:-owner}" '{username:$u,password:"wonton-e2e-password",email:$u}')"
    res="$(seerr_api /api/v1/auth/jellyfin -d "$body" 2>&1)" || {
      echo "重新登录失败：$(head -c 200 <<<"${res:-空响应}")"; return 1;
    }
  fi
  res="$(seerr_api /api/v1/auth/me 2>&1)"
  if ! jq -e '(.username != null or .jellyfinUsername != null) and (.permissions % 4 >= 2)' <<<"$res" 2>/dev/null >/dev/null; then
    echo "登录/向导后拿不到管理员会话：$(head -c 200 <<<"$res")"
    return 1
  fi
}

# 包装：无论成功失败、走到哪个 return，探针容器都不留在插件网络上——
# 网络有活动端点时 Docker 拒绝卸载重建，smoke 的 reinstall 会失败。
#
# jar 固定名字、跨项保留到 shell 退出：调用方在 ensure_session 返回后还要用它发请求
# （identity_check 的 /auth/me、data_write 的建用户），删掉就只剩网关会话、应用回 401
# cookie required。每项开头重建空的，core_login 带 --fresh 强制重新登录。
ensure_session() {
  local rc=0
  JAR="${TMPDIR:-/tmp}/seerr-probe-jar.$$"
  # 钩子被 300 秒限时杀掉时也要把助手容器从插件网络断开：
  # 它的端点会挡住实例网络删除，e2e 清理会失败（r5 实测 friendly_galileo 残留）。
  # run_hook 发的是 TERM，bash 不捕获 TERM 就不会跑 EXIT 清理，两个都要挂。
  trap 'rm -f "${JAR:-}" 2>/dev/null; helper_detach >/dev/null 2>&1' EXIT
  trap 'rm -f "${JAR:-}" 2>/dev/null; helper_detach >/dev/null 2>&1; exit 124' TERM
  rm -f "$JAR"
  core_login || true
  ensure_session_run || rc=$?
  helper_detach
  return "$rc"
}

# e2e 在装的时候调用（钩子的 300 秒预算之外）：把助手镜像先拉好，
# 否则冷机上 docker run 要现场拉 700MB，吃掉探针预算。
build_images() {
  docker pull -q jellyfin/jellyfin:12.4@sha256:fea863d0cd9ec445985d9c75fc6ed64e38a1d2766cf0c250a33d553f4fc1b771 || true
}

# 起一台一次性 Jellyfin（官方镜像，真实服务），接到本插件网络。幂等：
# 容器跨 reinstall 存活（compose 之外），网络被重建后重新接上即可。
ensure_jellyfin() {
  local net jf out
  jf="$(jellyfin_helper_name)"
  net="$(probe_network)" || return 1
  docker ps -a --format '{{.Names}}' | grep -qx "$jf" ||
    docker run -d --name "$jf" \
      jellyfin/jellyfin:12.4@sha256:fea863d0cd9ec445985d9c75fc6ed64e38a1d2766cf0c250a33d553f4fc1b771 \
      >/dev/null || { echo "起 Jellyfin 探针容器失败"; return 1; }
  out="$(docker network connect "$net" "$jf" 2>&1)" || [[ "$out" == *'already exists'* ]] ||
    { echo "接入插件网络失败：$out"; return 1; }
}

# Jellyfin 的 Startup 向导四步要在同一个 curl 会话里做：建管理员之后，
# 后续接口要它发给的会话 Cookie。规范层面宿主连不上插件网络（194 实测：
# 容器 healthy、Startup complete 5.3 秒，宿主 curl 210 秒全 000），所以
# 全部经 docker exec 进 Jellyfin 助手容器自己 curl localhost：宿主只发
# docker 命令，不进插件网络、不起临时容器（r5 的无名容器端点挡删除），
# exec 随 CLI 一起死，钩子被限时杀掉也干净。会话 Cookie 存助手容器的
# /tmp/jf.jar，四步共用。
jf_setup() {
  local jf code tries
  jf="$(jellyfin_helper_name)"
  ensure_jellyfin || return 1
  jfx() { docker exec "$jf" curl -sS --noproxy '*' -c /tmp/jf.jar -b /tmp/jf.jar "$@"; }
  tries=0
  while :; do
    code="$(jfx -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:8096/Startup/User 2>/dev/null)" || code=000
    [ "$code" = 200 ] && break
    tries=$((tries + 1))
    if [ "$tries" -ge 70 ]; then
      echo "Jellyfin 210 秒内没就绪（最后 $code）"
      docker ps -a --filter "name=$jf" --format '{{.Names}} {{.Status}}'
      docker logs --tail 3 "$jf" 2>&1
      return 1
    fi
    sleep 3
  done
  docker exec "$jf" rm -f /tmp/jf.jar
  jfx -H 'Content-Type: application/json' \
    -d "{\"Name\":\"${SMOKE_OWNER:-owner}\",\"Password\":\"wonton-e2e-password\"}" \
    http://localhost:8096/Startup/User >/dev/null || return 1
  jfx -H 'Content-Type: application/json' \
    -d '{"ServerName":"Jellyfin","UICulture":"zh-CN","MetadataCountryCode":"CN","PreferredMetadataLanguage":"zh-cn"}' \
    http://localhost:8096/Startup/Configuration >/dev/null || return 1
  jfx -H 'Content-Type: application/json' -d '{"EnableRemoteAccess":false}' \
    http://localhost:8096/Startup/RemoteAccess >/dev/null || return 1
  jfx -X POST http://localhost:8096/Startup/Complete >/dev/null || return 1
}

# 完成一次真实的首次登录：Jellyfin 建主人管理员 → Seerr 向导登录 → 初始化。只在未初始化时执行。
setup_seerr() {
  local res body
  jf_setup || return 1
  body="$(jq -nc --arg u "${SMOKE_OWNER:-owner}" --arg h "$(jellyfin_helper_name)" \
    '{username:$u,password:"wonton-e2e-password",hostname:$h,port:8096,useSsl:false,urlBase:"",email:($u + "@example.com"),serverType:2}')"
  res="$(seerr_api /api/v1/auth/jellyfin -d "$body" 2>&1)" || {
    echo "Seerr 向导登录失败：$(head -c 200 <<<"${res:-空响应}")"; return 1;
  }
  res="$(seerr_api /api/v1/settings/initialize -X POST 2>&1)" || {
    echo "Seerr 初始化失败：$(head -c 200 <<<"${res:-空响应}")"; return 1;
  }
  helper_detach
}

web_assert() { grep -qiE 'seerr|setup|wizard'; }

identity_check() {
  local res
  ensure_session || return 1
  res="$(seerr_api /api/v1/auth/me 2>&1)" || { echo "GET /auth/me 失败：$res"; return 1; }
  # Jellyfin 类型用户没有 username（为 null），身份在 jellyfinUsername；本地用户才有 username。
  jq -e --arg name "${SMOKE_OWNER:-owner}" '(.username == $name or .jellyfinUsername == $name) and (.permissions % 4 >= 2)' <<<"$res" >/dev/null || {
    echo "当前用户不是主人管理员 ${SMOKE_OWNER:-owner}：$(head -c 200 <<<"$res")"; return 1;
  }
  echo "主人 ${SMOKE_OWNER:-owner} 是 Seerr 管理员（首个管理员经真实 Jellyfin 向导创建）"
}

data_write() {
  local res
  ensure_session || return 1
  res="$(seerr_api /api/v1/user -d '{"username":"wonton-smoke-member","email":"wonton-smoke-member@example.com","password":"wonton-smoke-password"}' 2>&1)" || {
    if grep -q "User already exists" <<<"$res"; then
      return 0
    fi
    echo "建测试用户失败：$(head -c 200 <<<"$res")"; return 1;
  }
  jq -e '.username == "wonton-smoke-member"' <<<"$res" >/dev/null || { echo "建出来的用户不对：$res"; return 1; }
  helper_detach
}

data_check() {
  local res
  ensure_session || return 1
  res="$(seerr_api '/api/v1/user?take=100' 2>&1)" || { echo "列不出用户：$res"; return 1; }
  jq -e '.results[]? | select(.username == "wonton-smoke-member")' <<<"$res" >/dev/null || {
    echo "升级/重装后找不到 wonton-smoke-member：$(head -c 200 <<<"$res")"; return 1; }
  helper_detach
}
