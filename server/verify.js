const express = require('express');
const path = require('path');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 8080;
const API_URL = process.env.API_URL || '';

app.use(express.json());

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'verify.html')));
app.use('/css', express.static(path.join(__dirname, '..', 'public', 'css')));

app.all('/api/*', (req, res) => {
  if (!API_URL) return res.status(503).json({ error: 'API server not configured' });
  const target = new URL(req.originalUrl, API_URL);
  const mod = target.protocol === 'https:' ? require('https') : http;
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? JSON.stringify(req.body) : null;
  const headers = { 'Content-Type': 'application/json' };
  if (req.headers.authorization) headers['Authorization'] = req.headers.authorization;

  const proxyReq = mod.request(target, { method: req.method, headers }, proxyRes => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => res.status(502).json({ error: 'API server unreachable' }));
  if (body) proxyReq.write(body);
  proxyReq.end();
});

app.listen(PORT, () => console.log(`VORTEX Verify on :${PORT}`));
