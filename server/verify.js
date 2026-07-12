const express = require('express');
const path = require('path');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 8080;
const API_URL = process.env.API_URL || 'https://vortex-9.onrender.com';

app.use(express.json());

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'verify.html')));
app.use('/css', express.static(path.join(__dirname, '..', 'public', 'css')));

app.all('/api/*', (req, res) => {
  if (!API_URL) return res.status(503).json({ error: 'API not configured' });
  const target = new URL(req.originalUrl, API_URL);
  const mod = target.protocol === 'https:' ? https : http;
  const opts = { method: req.method, headers: { 'Content-Type': 'application/json' } };
  if (req.headers.authorization) opts.headers['Authorization'] = req.headers.authorization;

  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? JSON.stringify(req.body) : null;

  const proxyReq = mod.request(target, opts, proxyRes => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => res.status(502).json({ error: 'API unreachable' }));
  if (body) proxyReq.write(body);
  proxyReq.end();
});

app.listen(PORT, () => console.log(`VORTEX Verify on :${PORT}`));
