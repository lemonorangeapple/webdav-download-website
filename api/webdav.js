import { createProxyMiddleware } from 'http-proxy-middleware';
import { parse } from 'url';
import basicAuth from 'basic-auth';

// 允许的只读方法（根据 WebDAV 规范调整）
const READ_ONLY_METHODS = ['GET', 'HEAD', 'OPTIONS', 'PROPFIND', 'PROPPATCH']; // PROPPATCH 可选，如需严格只读可移除

// Vercel Serverless 适配层
export default async function handler(req, res) {
    // 1. 读取环境变量（Vercel 中配置）
    const {
        WEBDAV_TARGET = '', // 目标 WebDAV 服务器地址（如 https://example.com/webdav）
        AUTH_USER = '',     // 鉴权用户名
        AUTH_PASS = '',     // 鉴权密码
    } = process.env;

    if (!WEBDAV_TARGET || !AUTH_USER || !AUTH_PASS) {
        return res.status(500).send('环境变量未配置');
    }

    // 2. HTTP Basic Auth 鉴权
    const user = basicAuth(req);
    if (!user || user.name !== AUTH_USER || user.pass !== AUTH_PASS) {
        res.setHeader('WWW-Authenticate', 'Basic realm="WebDAV Proxy (Read Only)"');
        return res.status(401).send('Unauthorized');
    }

    // 3. 只读权限校验
    if (!READ_ONLY_METHODS.includes(req.method)) {
        return res.status(403).send('Forbidden: Read-only access only');
    }

    // 4. 构建代理配置
    const proxy = createProxyMiddleware({
        target: WEBDAV_TARGET,
        changeOrigin: true,
        pathRewrite: (path) => {
            // 移除 Vercel 的 api 路径前缀（如 /api/webdav/xxx → /xxx）
            return path.replace(/^\/api\/webdav/, '');
        },
        // 保留 WebDAV 所需的请求头
        headers: {
            'X-Forwarded-For': req.headers['x-forwarded-for'] || req.ip,
            'User-Agent': req.headers['user-agent'],
        },
        // 处理 WebDAV 的特殊响应（如 PROPFIND 的 XML 响应）
        onProxyRes: (proxyRes, req, res) => {
            // 移除可能暴露的敏感响应头
            delete proxyRes.headers['server'];
            delete proxyRes.headers['x-powered-by'];
        },
        // 支持 HTTPS 目标服务器
        secure: true,
        // 转发 WebDAV 所需的 HTTP 方法
        methods: READ_ONLY_METHODS,
    });

    // 5. 适配 Vercel 的 req/res 为 Node.js http 格式
    return new Promise((resolve, reject) => {
        proxy(req, res, (err) => {
            if (err) reject(err);
            resolve();
        });
    });
}

// 允许 Vercel 处理所有 HTTP 方法
export const config = {
    api: {
        bodyParser: false, // 禁用内置解析，保留原始请求体
        externalResolver: true, // 告知 Vercel 使用外部解析器
    },
};