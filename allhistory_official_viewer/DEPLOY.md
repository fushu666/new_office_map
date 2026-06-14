# 世界历史地图部署说明

## 运行方式

本地开发：

```powershell
powershell -ExecutionPolicy Bypass -File .\run_official_viewer.ps1
```

服务器运行：

```bash
PORT=8898 HOST=0.0.0.0 PUBLIC_ORIGIN=https://你的域名 AH_CACHE_DIR=/data/allhistory-cache node server.mjs
```

如果服务器使用 Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\run_official_viewer.ps1 `
  -Port 8898 `
  -HostName 0.0.0.0 `
  -PublicOrigin "https://你的域名" `
  -CacheDir "D:\allhistory-cache"
```

## 推荐反向代理

建议用 Nginx、宝塔、1Panel 或 Cloudflare Tunnel 把公网 HTTPS 代理到本服务：

```nginx
location / {
  proxy_pass http://127.0.0.1:8898;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

## 健康检查

```txt
GET /healthz
```

返回 `ok: true` 表示服务运行正常。

## 缓存

服务会把 AllHistory 官方资源缓存到 `AH_CACHE_DIR`，包括 style、PBF/PNG 瓦片、sprite、glyphs。第二次访问相同资源会直接读取本地缓存，能明显减少官网请求和等待时间。

不要把 `.cache/` 或 `AH_CACHE_DIR` 提交到 Git。
