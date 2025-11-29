// api/webdav-proxy.js
export default async (req, res) => {
  // 仅允许GET请求（下载/浏览需要）
  if (req.method !== 'GET' && req.method !== 'OPTIONS') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 环境变量配置
  const WEBDAV_URL = process.env.WEBDAV_URL;
  const WEBDAV_USER = process.env.WEBDAV_USER;
  const WEBDAV_PASS = process.env.WEBDAV_PASS;

  // 跨域配置
  res.setHeader('Access-Control-Allow-Origin', process.env.NEXT_PUBLIC_VERCEL_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const targetUrl = new URL(req.url.replace('/api/webdav-proxy', ''), WEBDAV_URL).href;
    const auth = Buffer.from(`${WEBDAV_USER}:${WEBDAV_PASS}`).toString('base64');
    
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Host': new URL(WEBDAV_URL).host,
      },
    });

    // 转发下载响应（处理文件流）
    const data = await response.arrayBuffer();
    res.status(response.status);
    for (const [key, value] of response.headers.entries()) {
      res.setHeader(key, value);
    }
    res.send(Buffer.from(data));
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: 'Download failed' });
  }
};