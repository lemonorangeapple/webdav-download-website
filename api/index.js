import { createClient } from 'webdav';
import cors from 'cors';


// CORS 中间件配置
const corsMiddleware = cors({
    origin: '*',
    methods: ['GET', 'HEAD', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
});

// 初始化 WebDAV 客户端（严格校验环境变量）
const getWebDAVClient = () => {
    const url = process.env.REMOTE_WEBDAV_URL;
    const user = process.env.REMOTE_WEBDAV_USER;
    const pass = process.env.REMOTE_WEBDAV_PASS;

    if (!url || !user || !pass) {
        throw new Error('Missing REMOTE_WEBDAV_URL/USER/PASS environment variables');
    }

    return createClient(url, {
        username: user,
        password: pass,
        timeout: 30000, // 30秒超时
        headers: { 'User-Agent': 'Vercel-WebDAV-Mirror/1.0' }
    });
};

// Vercel Serverless 入口函数（ESM 必须导出 default）
export default async (req, res) => {
    let webdavClient;
    try {
        // 初始化客户端
        webdavClient = getWebDAVClient();

        // 1. 处理 CORS 预检请求
        if (req.method === 'OPTIONS') {
            corsMiddleware(req, res, () => res.status(200).end());
            return;
        }

        // 2. 拦截所有写操作（只读保护）
        const writeMethods = ['PUT', 'POST', 'DELETE', 'MKCOL', 'COPY', 'MOVE'];
        if (writeMethods.includes(req.method)) {
            return res.status(403).json({
                error: 'Read-only mirror',
                message: 'Write operations are forbidden'
            });
        }

        // 3. 解析请求路径（去除 /api 前缀）
        const path = req.url.replace(/^\/api/, '') || '/';

        // 4. 仅处理 GET/HEAD 请求
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            return res.status(200).end();
        }

        // 5. 检查路径是否存在并获取信息
        let pathStat;
        try {
            pathStat = await webdavClient.stat(path);
        } catch (err) {
            if (err.statusCode === 404) {
                return res.status(404).json({
                    error: 'Not found',
                    message: `Path "${path}" does not exist`
                });
            }
            throw new Error(`Failed to stat path: ${err.message}`);
        }

        // 6. 处理目录请求（返回文件列表）
        if (pathStat.type === 'directory') {
            const files = await webdavClient.getDirectoryContents(path);
            const unique = process.env.VERCEL_PROJECT_NAME;
            // 生成美观的目录页面
            const html = `
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <script defer src="https://status.imjcj.eu.org/script.js" data-website-id="de91f9df-1cb9-457e-be8e-5aafbc7f1152"></script>
          <title>Directory: ${path}</title>
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 2rem; max-width: 1200px; margin: 0 auto; }
            h1 { color: #1a1a1a; margin-bottom: 1.5rem; font-size: 1.8rem; }
            .file-list { list-style: none; gap: 0.5rem; display: flex; flex-direction: column; }
            .file-item { padding: 0.8rem 1rem; background: #f8f9fa; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; }
            .file-item a { color: #0066cc; text-decoration: none; font-size: 1rem; }
            .file-item a:hover { text-decoration: underline; }
            .file-size { color: #666; font-size: 0.9rem; }
            .parent-dir { margin-bottom: 1rem; }
          </style>
        </head>
        <body>
          <h1>📁 ${path}</h1>
          <ul class="file-list">
            ${path !== '/' ? `<li class="file-item parent-dir"><a href="${path.split('/').slice(0, -1).join('/') || '/'}">⬆️ Parent Directory</a></li>` : ''}
            ${files.map(file => {
                const relativePath = path + (file.filename.startsWith(path) ? file.filename.slice(path.length) : file.filename);
                const rawPath = relativePath.replace(/^\/api/, '') || '/';
                const decodedPath = decodeURIComponent(rawPath);
                // 确保路径以/开头
                const normalizedPath = decodedPath.startsWith('/') ? decodedPath : `/${decodedPath}`;
                // 对最终路径进行UTF-8编码（适配WebDAV服务）
                const cleanLink = encodeURI(normalizedPath);

                return `
                    <li class="file-item">
                        <a href="${cleanLink}">${file.basename}</a>
                        <span class="file-size">${formatFileSize(file.size)}</span>
                    </li>
                `;
            }).join('')}
          </ul>
          <span style="position: absolute; left: 0; top: 0; color: white;">${unique}</span>
        </body>
        </html>
      `;

            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.status(200).send(html);
        }

        // ✅ 关键修复：webdav@5.x 仅支持 binary/text 格式，无 buffer
        const fileBinary = await webdavClient.getFileContents(path); // 默认 binary 格式
        const fileBuffer = Buffer.from(fileBinary, 'binary'); // 转为 Buffer

        // 设置下载响应头（解决中文文件名乱码）
        const fileName = encodeURIComponent(pathStat.basename);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', fileBuffer.length);
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${fileName}`);
        res.setHeader('Cache-Control', 'public, max-age=86400'); // 缓存1天

        // 返回文件Buffer
        return res.status(200).send(fileBuffer);

    } catch (err) {
        console.error('WebDAV Mirror Error:', err);
        // 友好的错误返回
        res.status(500).json({
            error: 'Server function crashed',
            details: err.message,
            hint: 'Check REMOTE_WEBDAV environment variables and remote server status'
        });
    }
};

// 辅助函数：格式化文件大小
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['Bytes', 'KiB', 'MiB', 'GiB'];
    const scale = 1024;
    const index = Math.floor(Math.log(bytes) / Math.log(scale));
    return `${(bytes / Math.pow(scale, index)).toFixed(2)} ${units[index]}`;
}
