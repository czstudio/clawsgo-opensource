import { spawn } from 'node:child_process';

async function startServer() {
  console.log('Starting server...');
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['server/serve.mjs'], {
      cwd: '/Users/cz/code/clawsgo-open',
      env: { ...process.env, NODE_OPTIONS: '' },
      stdio: 'pipe',
    });
    proc.stdout.on('data', d => {
      const line = d.toString();
      if (line.includes('localhost:5181')) {
        console.log('Server ready');
        resolve(proc);
      }
    });
    proc.stderr.on('data', d => {
      process.stderr.write(d);
    });
    setTimeout(() => reject(new Error('Server start timeout')), 15000);
  });
}

async function runE2E() {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['tools/e2e.mjs'], {
      cwd: '/Users/cz/code/clawsgo-open',
      env: { ...process.env, NODE_OPTIONS: '' },
      stdio: 'inherit',
    });
    proc.on('exit', (code) => {
      resolve(code);
    });
  });
}

const server = await startServer();
await new Promise(r => setTimeout(r, 2000));
const code = await runE2E();
server.kill();
process.exit(code ?? 0);
