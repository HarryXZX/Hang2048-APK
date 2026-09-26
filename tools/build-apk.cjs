'use strict';

/**
 * 构建 Android APK。
 *
 *   node tools/build-apk.cjs            # release（需要 keystore）
 *   node tools/build-apk.cjs --debug    # debug
 *   node tools/build-apk.cjs --setup    # 只生成 keystore，不构建
 *
 * 设计：
 *   · keystore 放在项目之外（默认 %USERPROFILE%\.hang2048-android\），
 *     项目因此可以直接公开而不带任何密钥材料。
 *   · keystore.properties 同样在项目外，android/app/build.gradle 通过
 *     rootProject.file('keystore.properties') 读取 —— 这里会在构建前
 *     把它同步过去（该文件已在 .gitignore 中）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ANDROID_DIR = path.join(ROOT, 'android');
const KEYSTORE_DIR = path.join(os.homedir(), '.hang2048-android');
const KEYSTORE_FILE = path.join(KEYSTORE_DIR, 'hang2048-release.jks');
const PROPS_FILE = path.join(ANDROID_DIR, 'keystore.properties');
const OUT_DIR = path.join(ROOT, 'output');

const ALIAS = 'hang2048';
const DNAME = 'CN=HYTools, OU=Hang2048, O=HYTools, L=, ST=, C=CN';

const args = process.argv.slice(2);
const isDebug = args.includes('--debug');
const setupOnly = args.includes('--setup');

/* ---------------- 工具 ---------------- */

function log(msg) { console.log(msg); }
function fail(msg) { console.error('\n✗ ' + msg); process.exit(1); }

function findJavaHome() {
  if (process.env.JAVA_HOME && fs.existsSync(path.join(process.env.JAVA_HOME, 'bin', 'keytool.exe'))) {
    return process.env.JAVA_HOME;
  }
  // 兜底：从 PATH 里的 java 反推
  const which = spawnSync('where', ['java'], { encoding: 'utf8', shell: true });
  if (which.status === 0) {
    const first = which.stdout.split(/\r?\n/).filter(Boolean)[0];
    if (first) return path.dirname(path.dirname(first));
  }
  return null;
}

function findAndroidSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk'),
    'C:\\Android\\Sdk'
  ].filter(Boolean);
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, 'platform-tools'))) return c;
  }
  return null;
}

function randomPassword(len = 24) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = require('crypto').randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += chars[bytes[i] % chars.length];
  return s;
}

/* ---------------- keystore ---------------- */

function ensureKeystore() {
  if (fs.existsSync(KEYSTORE_FILE) && fs.existsSync(PROPS_FILE)) {
    log('✓ keystore 已存在: ' + KEYSTORE_FILE);
    return loadProps();
  }

  const javaHome = findJavaHome();
  if (!javaHome) fail('找不到 JDK。请设置 JAVA_HOME 或确保 java 在 PATH 中。');

  const keytool = path.join(javaHome, 'bin', 'keytool.exe');
  if (!fs.existsSync(keytool)) fail('找不到 keytool: ' + keytool);

  fs.mkdirSync(KEYSTORE_DIR, { recursive: true });

  const password = randomPassword();
  log('生成签名密钥 ...');
  log('  keystore : ' + KEYSTORE_FILE);
  log('  alias    : ' + ALIAS);

  const result = spawnSync(keytool, [
    '-genkeypair',
    '-v',
    '-keystore', KEYSTORE_FILE,
    '-alias', ALIAS,
    '-keyalg', 'RSA',
    '-keysize', '2048',
    '-validity', '10950',        // 30 年
    '-storepass', password,
    '-keypass', password,
    '-dname', DNAME
  ], { encoding: 'utf8' });

  if (result.status !== 0) {
    fail('keytool 失败:\n' + (result.stderr || result.stdout));
  }

  // 写 properties：路径用绝对路径，避免 gradle 解析歧义
  const props = [
    '# 自动生成的签名配置 —— 请勿提交到版本库',
    '# keystore 本身在: ' + KEYSTORE_FILE,
    'storeFile=' + KEYSTORE_FILE.replace(/\\/g, '/'),
    'storePassword=' + password,
    'keyAlias=' + ALIAS,
    'keyPassword=' + password
  ].join('\n') + '\n';

  fs.writeFileSync(PROPS_FILE, props, 'utf8');

  // 密码单独留一份在外面，万一 properties 丢失还能找回
  const backup = path.join(KEYSTORE_DIR, 'README.txt');
  fs.writeFileSync(backup, [
    '夯048 · Hang2048 —— Android 签名材料',
    '',
    'keystore : ' + KEYSTORE_FILE,
    'alias    : ' + ALIAS,
    'storePass: ' + password,
    'keyPass  : ' + password,
    '有效期   : 30 年',
    '',
    '【重要】',
    '  一旦丢失这个文件，就无法再给已安装该应用的用户推送更新',
    '  （Android 要求更新包必须用同一把密钥签名）。',
    '  请务必备份到安全的地方。',
    ''
  ].join('\n'), 'utf8');

  log('✓ keystore 生成完成');
  log('  密码已写入: ' + PROPS_FILE);
  log('  备份说明  : ' + backup);
  return loadProps();
}

function loadProps() {
  if (!fs.existsSync(PROPS_FILE)) return null;
  const text = fs.readFileSync(PROPS_FILE, 'utf8');
  const props = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([^#=]+)=(.*)$/.exec(line);
    if (m) props[m[1].trim()] = m[2].trim();
  }
  return props;
}

/* ---------------- gradle ---------------- */

function findGradleWrapper() {
  const candidates = [
    path.join(ANDROID_DIR, 'gradlew.bat'),
    path.join(ANDROID_DIR, 'gradlew')
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function ensureGradleWrapper() {
  const wrapper = findGradleWrapper();
  if (wrapper) return wrapper;

  log('未找到 gradle wrapper，尝试用本机 gradle 生成 ...');
  const g = spawnSync('gradle', ['--version'], { encoding: 'utf8', shell: true });
  if (g.status !== 0) {
    fail('需要 gradle wrapper。请安装 Android Studio（会自动提供），\n' +
         '  或手动在 android/ 目录执行: gradle wrapper --gradle-version 8.9');
  }
  const gen = spawnSync('gradle', ['wrapper', '--gradle-version', '8.9'], {
    cwd: ANDROID_DIR, encoding: 'utf8', shell: true
  });
  if (gen.status !== 0) fail('生成 gradle wrapper 失败:\n' + (gen.stderr || gen.stdout));
  return findGradleWrapper();
}

/* ---------------- 主流程 ---------------- */

function main() {
  log('=== 夯048 · Hang2048 —— Android 构建 ===\n');

  // 1. 环境检查
  const sdk = findAndroidSdk();
  if (!sdk) fail('找不到 Android SDK。请设置 ANDROID_HOME，或安装 Android Studio。');
  log('Android SDK : ' + sdk);

  const javaHome = findJavaHome();
  if (!javaHome) fail('找不到 JDK。');
  log('JDK         : ' + javaHome);

  const buildTools = path.join(sdk, 'build-tools');
  const platforms = path.join(sdk, 'platforms');
  log('build-tools : ' + (fs.existsSync(buildTools) ? fs.readdirSync(buildTools).join(', ') : '缺失'));
  log('platforms   : ' + (fs.existsSync(platforms) ? fs.readdirSync(platforms).join(', ') : '缺失'));

  // 2. 写 local.properties（SDK 路径）——这是绕开错误系统环境变量的标准做法
  const localProps = path.join(ANDROID_DIR, 'local.properties');
  fs.writeFileSync(localProps, 'sdk.dir=' + sdk.replace(/\\/g, '\\\\') + '\n', 'utf8');
  log('local.properties 已写入: ' + localProps);

  // 3. 签名材料
  if (!isDebug) {
    ensureKeystore();
  }
  if (setupOnly) {
    log('\n（--setup 模式，仅生成签名材料，不执行构建）');
    return;
  }

  // 4. 图标
  const iconDir = path.join(ANDROID_DIR, 'app', 'src', 'main', 'res', 'mipmap-xxxhdpi');
  if (!fs.existsSync(iconDir)) {
    log('\n生成应用图标 ...');
    const r = spawnSync(process.execPath, [path.join(__dirname, 'make-android-icons.cjs')], {
      stdio: 'inherit'
    });
    if (r.status !== 0) fail('图标生成失败');
  }

  // 5. 构建
  const wrapper = ensureGradleWrapper();
  const task = isDebug ? 'assembleDebug' : 'assembleRelease';
  log('\n开始构建: ' + task + '\n');

  const result = spawnSync(wrapper, [task, '--no-daemon', '--stacktrace'], {
    cwd: ANDROID_DIR,
    stdio: 'inherit',
    env: { ...process.env, JAVA_HOME: javaHome },
    shell: true
  });

  if (result.status !== 0) fail('构建失败');

  // 6. 收集产物
  const apkDir = path.join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk');
  const found = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.apk')) found.push(p);
    }
  })(apkDir);

  if (found.length === 0) fail('构建成功但没找到 APK');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  log('\n=== 产物 ===');
  for (const apk of found) {
    const dest = path.join(OUT_DIR, path.basename(apk));
    fs.copyFileSync(apk, dest);
    const mb = (fs.statSync(dest).size / 1048576).toFixed(2);
    log('  ' + dest + '  (' + mb + ' MB)');
  }
}

main();
