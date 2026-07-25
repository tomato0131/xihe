const config = {
  // 开发联调默认连接当前 CentOS 7.9 虚拟机部署的羲和服务。
  // 正式小程序发布前必须替换为 HTTPS 域名，并在微信后台配置 request 合法域名。
  apiBaseUrl: 'http://SERVER_IP:8080'
}

module.exports = config
