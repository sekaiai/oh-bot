import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { envSchema } from '../src/config/schema.ts';

type DiagnosticLevel = 'info' | 'warn' | 'error';

type Diagnostic = {
  level: DiagnosticLevel;
  message: string;
};

type PluginSummary = {
  id: string;
  enabled: boolean;
  details: string[];
};

const cwd = process.cwd();
const dataDir = path.resolve(cwd, 'data');
const pluginsDir = path.join(dataDir, 'plugins');

dotenv.config();

function pushDiagnostic(diagnostics: Diagnostic[], level: DiagnosticLevel, message: string): void {
  diagnostics.push({ level, message });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function printSection(title: string): void {
  process.stdout.write(`\n[${title}]\n`);
}

function printDiagnostics(items: Diagnostic[]): void {
  if (items.length === 0) {
    process.stdout.write('  - OK\n');
    return;
  }

  for (const item of items) {
    process.stdout.write(`  - ${item.level.toUpperCase()}: ${item.message}\n`);
  }
}

async function loadPluginSummaries(diagnostics: Diagnostic[]): Promise<PluginSummary[]> {
  const summaries: PluginSummary[] = [];

  if (!(await fileExists(pluginsDir))) {
    pushDiagnostic(diagnostics, 'warn', `插件目录不存在: ${pluginsDir}`);
    return summaries;
  }

  const files = (await readdir(pluginsDir)).filter((file) => file.endsWith('.json')).sort();

  if (files.length === 0) {
    pushDiagnostic(diagnostics, 'warn', '未发现任何插件配置文件');
    return summaries;
  }

  for (const file of files) {
    const filePath = path.join(pluginsDir, file);
    try {
      const raw = JSON.parse(await readFile(filePath, 'utf-8')) as Record<string, unknown>;
      const id = typeof raw.id === 'string' ? raw.id : file.replace(/\.json$/u, '');
      const enabled = Boolean(raw.enabled);
      const details: string[] = [];

      if (id === 'ds2api') {
        const legacyRoute = typeof raw.model === 'string'
          ? [{
            id: 'legacy',
            enabled: true
          }]
          : [];
        const routes = Array.isArray(raw.routes) && raw.routes.length > 0 ? raw.routes : legacyRoute;
        const enabledRoutes = routes.filter((route) => {
          return typeof route === 'object' && route !== null && Boolean((route as Record<string, unknown>).enabled);
        }).length;
        details.push(`routes=${routes.length}`);
        details.push(`enabledRoutes=${enabledRoutes}`);
        if (enabled && !raw.apiKey) {
          pushDiagnostic(diagnostics, 'warn', 'DS2API 已启用但 apiKey 为空');
        }
        if (enabled && enabledRoutes === 0) {
          pushDiagnostic(diagnostics, 'warn', 'DS2API 已启用但没有启用中的模型路由');
        }
      } else if (id === 'qweather') {
        details.push(`apiHost=${typeof raw.apiHost === 'string' ? raw.apiHost : '(unset)'}`);
        details.push(`lang=${typeof raw.lang === 'string' ? raw.lang : '(unset)'}`);
        if (enabled && !raw.apiKey) {
          pushDiagnostic(diagnostics, 'warn', '和风天气已启用但 apiKey 为空');
        }
      } else if (id === 'qingmeng') {
        const endpoints = Array.isArray(raw.endpoints) ? raw.endpoints : [];
        const enabledEndpoints = endpoints.filter((endpoint) => {
          return typeof endpoint === 'object' && endpoint !== null && Boolean((endpoint as Record<string, unknown>).enabled);
        }).length;
        details.push(`endpoints=${endpoints.length}`);
        details.push(`enabledEndpoints=${enabledEndpoints}`);

        if (enabled && !raw.ckey) {
          pushDiagnostic(diagnostics, 'warn', '倾梦 API 已启用但 ckey 为空');
        }
      }

      summaries.push({ id, enabled, details });
    } catch {
      pushDiagnostic(diagnostics, 'error', `插件配置解析失败: ${file}`);
    }
  }

  return summaries;
}

async function main(): Promise<void> {
  const envDiagnostics: Diagnostic[] = [];
  const dataDiagnostics: Diagnostic[] = [];
  const pluginDiagnostics: Diagnostic[] = [];

  const parsedEnv = envSchema.safeParse(process.env);
  if (!parsedEnv.success) {
    const fieldErrors = parsedEnv.error.flatten().fieldErrors;
    for (const [field, errors] of Object.entries(fieldErrors)) {
      pushDiagnostic(envDiagnostics, 'error', `${field}: ${(errors ?? []).join(', ')}`);
    }
  } else {
    const config = parsedEnv.data;

    if (!config.ADMIN_PASSWORD) {
      pushDiagnostic(envDiagnostics, 'warn', 'ADMIN_PASSWORD 未配置，管理端 API 不会启动');
    }

    if (config.NAPCAT_MEDIA_SEND_MODE !== 'base64' && !config.NAPCAT_MEDIA_TEMP_DIR) {
      pushDiagnostic(
        envDiagnostics,
        'warn',
        `NAPCAT_MEDIA_SEND_MODE=${config.NAPCAT_MEDIA_SEND_MODE} 但未配置 NAPCAT_MEDIA_TEMP_DIR`
      );
    }
  }

  for (const relativePath of ['rules.json', 'personas.json', 'plugins']) {
    const targetPath = path.join(dataDir, relativePath);
    if (!(await fileExists(targetPath))) {
      pushDiagnostic(dataDiagnostics, 'warn', `缺少运行期数据: ${targetPath}`);
    }
  }

  const pluginSummaries = await loadPluginSummaries(pluginDiagnostics);

  printSection('Environment');
  printDiagnostics(envDiagnostics);

  printSection('Runtime Data');
  printDiagnostics(dataDiagnostics);

  printSection('Plugins');
  printDiagnostics(pluginDiagnostics);
  for (const plugin of pluginSummaries) {
    process.stdout.write(
      `  - ${plugin.id}: ${plugin.enabled ? 'enabled' : 'disabled'}${plugin.details.length > 0 ? ` (${plugin.details.join(', ')})` : ''}\n`
    );
  }
}

main().catch((error) => {
  process.stderr.write(`codex-doctor failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
