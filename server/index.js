const express = require('express');
const path = require('path');
const createServer = require('./core');

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

const { app } = createServer(DATA_DIR);

app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'panel.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'license.html')));
app.use(express.static(path.join(__dirname, '..', 'public')));

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`VORTEX v1.1.0 running on port ${PORT}`);
    console.log(`Panel: http://localhost:${PORT}/panel`);
    console.log(`License: http://localhost:${PORT}/`);
  });
}

module.exports = app;
