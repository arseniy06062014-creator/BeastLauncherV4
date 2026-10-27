const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const paths = require('./paths.cjs');
const { fetchJson, downloadFile } = require('./http.cjs');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

// Fallback when the version json has no javaVersion (very old versions).
function fallbackMajor(mc) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(mc);
  if (!m) return 17;
  const minor = Number(m[2]);
  const patch = Number(m[3] || 0);
  if (minor <= 16) return 8;
  if (minor === 17) return 16;
  if (minor < 20 || (minor === 20 && patch < 5)) return 17;
  return 21;
}

// Mojang's own version json says which Java the version needs.
async function requiredMajor(mc) {
  try {
    const manifest = await fetchJson(MANIFEST_URL);
    const entry = manifest.versions.find((v) => v.id === mc);
    if (!entry) return fallbackMajor(mc);
    const vjson = await fetchJson(entry.url);
    return vjson.javaVersion?.majorVersion || fallbackMajor(mc);
  } catch {
    return fallbackMajor(mc);
  }
}

const OS = { win32: 'windows', linux: 'linux', darwin: 'mac' }[process.platform];
const ARCH = process.arch === 'arm64' ? 'aarch64' : 'x64';
const EXE = process.platform === 'win32' ? 'java.exe' : 'java';

function findJava(dir) {
  if (!fs.existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === EXE && path.basename(d) === 'bin') return p;
    }
  }
  return null;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 300000, windowsHide: true }, (err, _out, stderr) =>
      err ? reject(new Error(String(stderr || err.message).trim())) : resolve()
    );
  });
}

async function extract(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  try {
    if (process.platform === 'win32') {
      const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
      const q = (p) => `'${p.replace(/'/g, "''")}'`;
      const ps = path.join(sys, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      try {
        await run(ps, [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `Expand-Archive -LiteralPath ${q(archive)} -DestinationPath ${q(dest)} -Force`,
        ]);
      } catch (e1) {
        // fallback: bsdtar that ships with Windows 10+
        await run(path.join(sys, 'tar.exe'), ['-xf', archive, '-C', dest]).catch(() => {
          throw e1;
        });
      }
    } else {
      await run('tar', ['-xzf', archive, '-C', dest]);
    }
  } catch (e) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw new Error('Не удалось распаковать Java: ' + e.message);
  }
}

// Downloads a Temurin JRE for the given major version once and reuses it afterwards.
async function ensureJava(major, onProgress) {
  const dir = path.join(paths.cacheDir(), 'java', String(major));
  const existing = findJava(dir);
  if (existing) return existing;
  if (!OS) throw new Error('Эта система не поддерживается для автоустановки Java');

  const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/${OS}/${ARCH}/jre/hotspot/normal/eclipse`;
  const archive = path.join(paths.cacheDir(), 'java', `jre-${major}.${OS === 'windows' ? 'zip' : 'tar.gz'}`);
  await downloadFile(url, archive, { onProgress, timeout: 600000 });
  try {
    await extract(archive, dir);
  } finally {
    fs.rmSync(archive, { force: true });
  }
  const found = findJava(dir);
  if (!found) throw new Error(`Java ${major} скачана, но java не найдена`);
  if (process.platform !== 'win32') fs.chmodSync(found, 0o755);
  return found;
}

// "java" (default) = automatic. Any other value is the user's own path and is used as is.
async function resolveJava(userPath, mc, send) {
  if (userPath && userPath !== 'java') return userPath;
  const major = await requiredMajor(mc);
  send({ type: 'stage', text: `Подготовка Java ${major}…` });
  return ensureJava(major, (p) =>
    send({ type: 'progress', text: `Загрузка Java ${major}…`, percent: Math.round(p * 100) })
  );
}

module.exports = { resolveJava, ensureJava, requiredMajor, fallbackMajor, findJava };
