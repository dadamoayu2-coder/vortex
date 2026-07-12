const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, '..', 'tunnel-url.txt');
const cp = spawn('npx', ['cloudflared', 'tunnel', '--url', 'http://localhost:3000'], {
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe']
});

let urlFound = false;

cp.stdout.on('data', (data) => {
  const text = data.toString();
  process.stdout.write(text);
  const match = text.match(/https:\/\/[a-zA-Z0-9\-]+\.trycloudflare\.com/);
  if (match && !urlFound) {
    urlFound = true;
    fs.writeFileSync(logFile, match[0]);
    console.log('\nTUNNEL URL: ' + match[0]);
  }
});

cp.stderr.on('data', (data) => {
  const text = data.toString();
  process.stderr.write(text);
  const match = text.match(/https:\/\/[a-zA-Z0-9\-]+\.trycloudflare\.com/);
  if (match && !urlFound) {
    urlFound = true;
    fs.writeFileSync(logFile, match[0]);
    console.log('\nTUNNEL URL: ' + match[0]);
  }
});

cp.on('exit', () => process.exit());
