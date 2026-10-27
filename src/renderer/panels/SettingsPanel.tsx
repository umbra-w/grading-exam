import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import type { AIConfig, AppSettings, ProviderId, TokenUsage } from '@shared/types';

/**
 * 供应商预设。与 `src/main/ai/compat.ts` 的 PROVIDER_PRESETS 必须保持一致。
 *
 * 已知重复：这两份 `baseUrl`/`model`/`disableThinking`/`vision` 是同一套事实，
 * 目前各写一遍——**改一处忘另一处就会出现"选了预设但请求发错地址"**。
 * 正确做法是挪到 `shared/` 由两侧共用。此处先内联，不假装已经统一。
 */
const PRESETS: Array<{
  id: ProviderId;
  label: string;
  baseUrl: string;
  model: string;
  disableThinking: boolean;
  vision: boolean;
}> = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', disableThinking: false, vision: true },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', disableThinking: true, vision: false },
  { id: 'qwen', label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', disableThinking: true, vision: true },
  { id: 'zhipu', label: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', disableThinking: true, vision: true },
  { id: 'kimi', label: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-32k', disableThinking: true, vision: true },
  { id: 'custom', label: '自定义（OpenAI 兼容）', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', disableThinking: false, vision: false },
];

export function SettingsPanel(): JSX.Element {
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const setUsage = useStore((s) => s.setUsage);

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    window.gradingExam
      .getSettings()
      .then((s) => {
        if (alive) setDraft(s);
      })
      .catch((e: unknown) => {
        // 不 catch 的话失败会永久停在「读取设置中…」——那是静默失败，
        // 比报错更难排查。这里把原因显示出来。
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return (
      <div className="card">
        <h2>设置读取失败</h2>
        <p className="hint">
          未能从主进程读到设置。这通常意味着 IPC 通道没通，而不是你的配置有问题。
        </p>
        <div className="notice">{error}</div>
      </div>
    );
  }

  if (!draft) return <div className="card">读取设置中…</div>;

  const ai = draft.ai;

  function patchAI(patch: Partial<AIConfig>): void {
    setDraft({ ...draft!, ai: { ...ai, ...patch } });
  }

  function applyPreset(id: ProviderId): void {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    patchAI({
      provider: id,
      baseUrl: p.baseUrl,
      model: p.model,
      disableThinking: p.disableThinking,
    });
    void window.gradingExam.writeLog('info', `已切换供应商预设：${p.label}（${p.model}）`);
  }

  async function onSave(): Promise<void> {
    setSaving(true);
    try {
      const saved = await window.gradingExam.saveSettings(draft!);
      setDraft(saved);
    } finally {
      setSaving(false);
    }
  }

  async function onTest(): Promise<void> {
    setTestResult('测试中…');
    await window.gradingExam.writeLog('info', '开始测试 AI 连接…');
    // ai:test 通道已在 Phase 1 接上（client.testConnection）。
    // 这里此前写死「Phase 1 未实现」——那是过期文案，会让人以为功能没做。
    const r = await window.gradingExam.aiTest(draft!.ai);
    setTestResult(
      r.ok
        ? `连接成功（模型 ${r.diag?.model ?? '未知'}，返回 ${r.text.slice(0, 40) || '空'}）`
        : `连接失败：${r.diag?.rawSnippet ?? r.diag?.errorCode ?? '未知原因'}`,
    );
  }

  async function onPickExportDir(): Promise<void> {
    const r = await window.gradingExam.pickDir();
    if (!r.canceled && r.path) {
      setDraft({ ...draft!, general: { ...draft!.general, exportDir: r.path } });
    }
  }

  async function onResetUsage(): Promise<void> {
    await window.gradingExam.resetUsage();
    setUsage({ prompt: 0, completion: 0, total: 0, costCNY: 0 } as TokenUsage);
  }

  return (
    <>
      <div className="card">
        <h2>AI 服务</h2>
        <p className="hint">
          密钥仅保存在本机（electron-store），不上传任何服务器。软件本身无后端。
        </p>

        <div className="grid2">
          <div className="field">
            <label>供应商预设</label>
            <select value={ai.provider} onChange={(e) => applyPreset(e.target.value as ProviderId)}>
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <span className="sub">
              该预设{' '}
              {PRESETS.find((p) => p.id === ai.provider)?.vision ? '支持图片输入' : '不支持图片输入（截图评分会失败）'}
            </span>
          </div>

          <div className="field">
            <label>模型名称</label>
            <input type="text" value={ai.model} onChange={(e) => patchAI({ model: e.target.value })} />
            <span className="sub">
              截图评分需选用视觉模型，如 gpt-4o、qwen-vl 系列、glm-4v 等
            </span>
          </div>
        </div>

        <div className="field">
          <label>API 地址</label>
          <input type="text" value={ai.baseUrl} onChange={(e) => patchAI({ baseUrl: e.target.value })} />
        </div>

        <div className="field">
          <label>API Key</label>
          <input
            type="password"
            value={ai.apiKey}
            placeholder="sk-..."
            onChange={(e) => patchAI({ apiKey: e.target.value })}
          />
        </div>

        <div className="grid3">
          <div className="field">
            <label>max_tokens</label>
            <input
              type="number"
              value={ai.maxTokens}
              onChange={(e) => patchAI({ maxTokens: Number(e.target.value) || 8000 })}
            />
            <span className="sub">默认 8000；给太小会导致正文为空</span>
          </div>

          <div className="field">
            <label>temperature</label>
            <input
              type="number"
              step="0.1"
              min="0"
              max="2"
              value={ai.temperature}
              onChange={(e) => patchAI({ temperature: Number(e.target.value) })}
            />
            <span className="sub">评分任务建议 0.1</span>
          </div>

          <div className="field">
            <label>超时（毫秒）</label>
            <input
              type="number"
              value={ai.timeoutMs}
              onChange={(e) => patchAI({ timeoutMs: Number(e.target.value) || 120000 })}
            />
          </div>
        </div>

        <label className="row" style={{ gap: 6, marginBottom: 12, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={ai.disableThinking}
            style={{ width: 'auto' }}
            onChange={(e) => patchAI({ disableThinking: e.target.checked })}
          />
          <span>
            关闭思考模式
            <span className="sub" style={{ marginLeft: 6 }}>
              DeepSeek v4 / 国产推理模型必须开启，否则思考耗尽 token 导致正文为空
            </span>
          </span>
        </label>

        <div className="row">
          <button className="primary" onClick={() => void onSave()} disabled={saving}>
            {saving ? '保存中…' : '保存设置'}
          </button>
          <button onClick={() => void onTest()}>测试连接</button>
          {testResult ? <span className="sub">{testResult}</span> : null}
        </div>
      </div>

      <div className="card">
        <h2>自动化与合规</h2>
        <p className="hint">
          仅限用户自有账号、自有平台、已获授权场景使用。无人值守模式须显式确认，并自行承担平台风控风险。
        </p>
        <div className="grid3">
          <div className="field">
            <label>默认批阅模式</label>
            <select
              value={draft.autoDefaults.mode}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  autoDefaults: { ...draft.autoDefaults, mode: e.target.value as AppSettings['autoDefaults']['mode'] },
                })
              }
            >
              <option value="standard">标准模式（仅 AI 评分，不填分）</option>
              <option value="steady">稳健模式（人工确认后填分）</option>
              <option value="top">顶尖模式（全自动，风险自负）</option>
            </select>
            <span className="sub">默认稳健模式；顶尖模式须显式开启</span>
          </div>

          <div className="field">
            <label>操作间隔（毫秒）</label>
            <input
              type="number"
              value={draft.autoDefaults.throttleMs}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  autoDefaults: { ...draft.autoDefaults, throttleMs: Number(e.target.value) || 600 },
                })
              }
            />
            <span className="sub">节流以降低平台风控概率</span>
          </div>

          <div className="field">
            <label>连续处理上限（0 = 不限）</label>
            <input
              type="number"
              value={draft.autoDefaults.maxPapers}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  autoDefaults: { ...draft.autoDefaults, maxPapers: Number(e.target.value) || 0 },
                })
              }
            />
          </div>
        </div>
      </div>

      <div className="card">
        <h2>数据与用量</h2>
        <div className="field">
          <label>导出目录</label>
          <div className="row">
            <input type="text" value={draft.general.exportDir} readOnly placeholder="未设置（默认使用系统下载目录）" />
            <button onClick={() => void onPickExportDir()}>选择…</button>
          </div>
        </div>
        <div className="row">
          <button onClick={() => void onResetUsage()}>重置用量统计</button>
          <span className="sub">本机累计 token 与估算成本，可随时清零</span>
        </div>
      </div>
    </>
  );
}