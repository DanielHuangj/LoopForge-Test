import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function runServer(env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`server startup did not exit: ${output}`));
    }, 10_000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

describe('startup validation', () => {
  it('exits non-zero before listening when required configuration is missing and prints only variable names', async () => {
    const result = await runServer({});
    expect(result.code).toBe(1);
    expect(result.output).toContain('startup_config_error');
    expect(result.output).toContain('DATABASE_URL');
    expect(result.output).toContain('SESSION_SECRET');
    expect(result.output).toContain('SSO_MODE');
    expect(result.output).toMatch(/"timestamp":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"/);
    expect(result.output).not.toContain('CHANGE_ME');
  });

  it('rejects mock SSO in production before attempting to listen', async () => {
    const result = await runServer({
      APP_ENV: 'prod',
      DATABASE_URL: 'postgres://user:password@127.0.0.1:1/nope',
      SSO_MODE: 'mock',
      SESSION_SECRET: '0123456789abcdef0123456789abcdef',
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain('startup_config_error');
    expect(result.output).toContain('SSO_MODE');
    expect(result.output).not.toContain('password');
  });

  it('rejects incomplete OIDC configuration', async () => {
    const result = await runServer({
      APP_ENV: 'prod',
      DATABASE_URL: 'postgres://user:password@127.0.0.1:1/nope',
      SSO_MODE: 'oidc',
      SSO_ISSUER: 'https://idp.example.com',
      SESSION_SECRET: '0123456789abcdef0123456789abcdef',
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain('startup_config_error');
    expect(result.output).toContain('SSO_CLIENT_ID');
    expect(result.output).toContain('SSO_CLIENT_SECRET');
    expect(result.output).toContain('SSO_REDIRECT_URI');
  });
});
