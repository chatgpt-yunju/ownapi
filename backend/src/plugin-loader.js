/**
 * 插件加载器 — 自动扫描、注册、加载插件
 *
 * 用法（在 app.js 中）：
 *   const { loadPlugins } = require('./plugin-loader');
 *   await loadPlugins(app);
 */
const fs = require('fs');
const path = require('path');
const db = require('./config/db');

const PLUGINS_DIR = path.join(__dirname, 'plugins');

async function ensurePluginsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS plugins (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      display_name VARCHAR(200) NOT NULL DEFAULT '',
      description TEXT,
      version VARCHAR(20) NOT NULL DEFAULT '1.0.0',
      enabled TINYINT NOT NULL DEFAULT 1,
      config JSON,
      route_prefix VARCHAR(100) NOT NULL DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `).catch(() => {});
}

function discoverPlugins() {
  if (!fs.existsSync(PLUGINS_DIR)) {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });
    return [];
  }

  const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
  const plugins = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginJsonPath = path.join(PLUGINS_DIR, entry.name, 'plugin.json');
    if (!fs.existsSync(pluginJsonPath)) continue;

    try {
      const meta = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));
      meta._dirName = entry.name;
      meta._dirPath = path.join(PLUGINS_DIR, entry.name);
      plugins.push(meta);
    } catch (err) {
      console.warn(`[plugin-loader] 跳过插件 ${entry.name}：plugin.json 解析失败`, err.message);
    }
  }

  return plugins;
}

async function syncToDatabase(plugins) {
  for (const meta of plugins) {
    const name = meta.name || meta._dirName;
    const routePrefix = meta.routePrefix || `/api/plugins/${name}`;

    await db.query(`
      INSERT INTO plugins (name, display_name, description, version, route_prefix, config)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        display_name = VALUES(display_name),
        description = VALUES(description),
        version = VALUES(version),
        route_prefix = VALUES(route_prefix)
    `, [
      name,
      meta.displayName || name,
      meta.description || '',
      meta.version || '1.0.0',
      routePrefix,
      JSON.stringify({ quotaCost: meta.quotaCost || 0, requireAuth: meta.requireAuth || false }),
    ]);
  }
}

async function runMigrations(plugins) {
  for (const meta of plugins) {
    const migratePath = path.join(meta._dirPath, 'migrate.js');
    if (!fs.existsSync(migratePath)) continue;

    try {
      const migrate = require(migratePath);
      if (typeof migrate === 'function') await migrate(db);
      console.log(`[plugin-loader] 迁移完成: ${meta.name}`);
    } catch (err) {
      console.warn(`[plugin-loader] 迁移失败 ${meta.name}:`, err.message);
    }
  }
}

async function mountRoutes(app, plugins) {
  const [rows] = await db.query('SELECT name, enabled FROM plugins');
  const enabledMap = new Map(rows.map(r => [r.name, r.enabled]));

  let loaded = 0;
  for (const meta of plugins) {
    const name = meta.name || meta._dirName;
    if (!enabledMap.get(name)) continue;

    const routesPath = path.join(meta._dirPath, 'routes.js');
    if (!fs.existsSync(routesPath)) continue;

    try {
      const router = require(routesPath);
      const prefix = meta.routePrefix || `/api/plugins/${name}`;
      app.use(prefix, router);
      loaded++;
      console.log(`[plugin-loader] ✓ ${name} → ${prefix}`);
    } catch (err) {
      console.error(`[plugin-loader] ✗ ${name} 加载失败:`, err.message);
    }
  }

  return loaded;
}

async function loadPlugins(app) {
  console.log('[plugin-loader] 开始加载插件...');

  await ensurePluginsTable();
  const plugins = discoverPlugins();

  if (plugins.length === 0) {
    console.log('[plugin-loader] 未发现任何插件');
    return;
  }

  console.log(`[plugin-loader] 发现 ${plugins.length} 个插件`);
  await syncToDatabase(plugins);
  await runMigrations(plugins);
  const loaded = await mountRoutes(app, plugins);
  console.log(`[plugin-loader] 加载完成: ${loaded}/${plugins.length} 个插件已启用`);
}

module.exports = { loadPlugins, discoverPlugins, PLUGINS_DIR };
