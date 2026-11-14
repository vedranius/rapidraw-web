import { ChangeEvent, useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Copy, Download, Eye, EyeOff, GitBranch, Loader2, Plug, Trash2 } from 'lucide-react';
import { toast } from 'react-toastify';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { loadInstalledSkills } from '../../agent/skills';

/** AI Editor → AI clients: connect Claude, Cursor, VS Code... to the RapidRAW Web MCP server and install skills. */
interface McpInfo {
  enabled: boolean;
  token: string;
  path: string;
  defaultSource: string;
  skillsDir: string;
  tools: string[];
}
interface InstalledSkill {
  id: string;
  raw: string;
  source: string | null;
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Copied');
  } catch {
    toast.info('Select the text and copy it (the clipboard needs HTTPS or localhost)');
  }
}

function Snippet({ title, hint, code, secret }: { title: string; hint?: string; code: string; secret?: string }) {
  const [show, setShow] = useState(false);
  const shown = secret && !show ? code.split(secret).join('•'.repeat(12)) : code;
  return (
    <div className="rounded-lg border border-border-color bg-bg-primary/40 p-3">
      <div className="mb-1 flex items-center gap-2">
        <h4 className="text-[11px] font-semibold text-text-primary">{title}</h4>
        <div className="ml-auto flex gap-1">
          {secret && (
            <button
              type="button"
              className="rounded p-1 text-text-secondary hover:text-text-primary"
              onClick={() => setShow((v) => !v)}
              aria-label={show ? 'Hide token' : 'Show token'}
            >
              {show ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
          )}
          <button
            type="button"
            className="rounded p-1 text-text-secondary hover:text-text-primary"
            onClick={() => void copy(code)}
            aria-label={`Copy ${title}`}
          >
            <Copy size={12} />
          </button>
        </div>
      </div>
      {hint && <p className="mb-1.5 text-[10px] leading-relaxed text-text-secondary">{hint}</p>}
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-bg-secondary p-2 font-mono text-[10px] text-text-primary select-text">
        {shown}
      </pre>
    </div>
  );
}

export default function McpPanel({ onSkillsChanged }: { onSkillsChanged(): void }) {
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setInfo(await invoke<McpInfo>('__rr_mcp_info'));
      setInstalled((await invoke<InstalledSkill[]>('__rr_skills_list')) ?? []);
      await loadInstalledSkills();
      onSkillsChanged();
    } catch {
      setUnavailable(true);
    }
  }, [onSkillsChanged]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const install = async (from?: string) => {
    setBusy(true);
    try {
      const result = await invoke<{ source: string; installed: string[] }>('__rr_skills_install', {
        source: from ?? '',
      });
      toast.success(`Installed ${result.installed.length} skill(s)`);
      setSource('');
      await refresh();
    } catch (e) {
      toast.error(`Installing skills failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    await invoke('__rr_skills_remove', { id }).catch((e) => toast.error(String(e)));
    await refresh();
  };

  if (unavailable) {
    return (
      <div className="p-6 text-[11px] leading-relaxed text-text-secondary">
        The MCP server for AI clients is part of RapidRAW Web: start <b>RapidRAW Web Bridge</b> and open RapidRAW in the
        browser to connect Claude, Cursor, VS Code or other AI apps.
      </div>
    );
  }
  if (!info) {
    return (
      <div className="flex items-center gap-2 p-6 text-[11px] text-text-secondary">
        <Loader2 size={13} className="animate-spin" /> Loading…
      </div>
    );
  }

  const url = `${window.location.origin}${info.path}`;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
  const auth = `Bearer ${info.token}`;
  const remoteEnv = local ? '' : `export RAPIDRAW_MCP_URL=${url}\nexport RAPIDRAW_MCP_TOKEN=${info.token}\n`;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto max-w-3xl space-y-4">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
            <Plug size={14} className="text-accent" /> AI clients (MCP server)
          </h3>
          <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
            RapidRAW Web is an MCP server: AI apps such as Claude Code, Claude Desktop, Cursor or VS Code can list your
            photos, look at previews, change any slider, run every AI Editor command (masks, denoise, HDR, panorama,
            crop, styles, export…) and undo. Plans run in this browser tab, so you see every change. Edits stay
            non-destructive. {info.enabled ? '' : 'The server is turned off (RR_MCP=0).'}
          </p>
          <p className="mt-1 text-[10px] text-text-secondary">
            {info.tools.length} tools · server <span className="font-mono">{url}</span>
            {local ? ' · no token needed on this computer' : ''}
          </p>
        </div>

        <Snippet
          title="Claude Code: plugin with all skills (recommended)"
          hint={`Adds the MCP connection and every RapidRAW skill in one step (inside Claude Code: /plugin marketplace add vedranius/rapidraw-web).${local ? '' : ' Set the two variables first (shell profile), because the plugin defaults to localhost.'}`}
          code={`${remoteEnv}claude plugin marketplace add vedranius/rapidraw-web\nclaude plugin install rapidraw@rapidraw-web`}
          secret={local ? undefined : info.token}
        />
        <Snippet
          title="Claude Code: only the MCP server"
          code={`claude mcp add --transport http rapidraw ${url} --header "Authorization: ${auth}"`}
          secret={info.token}
        />
        <Snippet
          title="Claude Desktop, Codex, Gemini CLI and other stdio clients"
          hint="Add to the client's MCP configuration (Claude Desktop: Settings → Developer → Edit Config). Needs Node.js."
          code={JSON.stringify(
            {
              mcpServers: {
                rapidraw: {
                  command: 'npx',
                  args: [
                    '-y',
                    'mcp-remote',
                    url,
                    ...(url.startsWith('http:') && !local ? ['--allow-http'] : []),
                    '--header',
                    `Authorization:${auth}`,
                  ],
                },
              },
            },
            null,
            2,
          )}
          secret={info.token}
        />
        <Snippet
          title="Cursor, VS Code, Windsurf and other HTTP clients"
          code={JSON.stringify({ mcpServers: { rapidraw: { url, headers: { Authorization: auth } } } }, null, 2)}
          secret={info.token}
        />

        <div className="rounded-lg border border-border-color bg-bg-primary/40 p-3">
          <h4 className="text-[11px] font-semibold text-text-primary">Skills</h4>
          <p className="mt-1 text-[10px] leading-relaxed text-text-secondary">
            Skills are editing recipes for the in-app AI Editor and for AI clients (as MCP prompts). Install all
            RapidRAW skills from GitHub, or any repository with <span className="font-mono">SKILL.md</span> files.
            Installing again updates them.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button onClick={() => void install()} disabled={busy}>
              {busy ? <Loader2 size={12} className="animate-spin" /> : <GitBranch size={12} />}
              Install / update all RapidRAW skills
            </Button>
            <a
              href="/rr/skills.zip"
              className="inline-flex items-center gap-1.5 rounded-md border border-border-color px-3 py-1.5 text-[11px] text-text-secondary hover:text-text-primary"
            >
              <Download size={12} /> Download skills (.zip for Claude.ai)
            </a>
          </div>
          <div className="mt-2 flex gap-2">
            <Input
              value={source}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setSource(e.target.value)}
              placeholder="owner/repo, https://github.com/…, git URL or .md URL"
            />
            <Button onClick={() => void install(source)} disabled={busy || !source.trim()}>
              Install
            </Button>
          </div>
          {installed.length > 0 && (
            <ul className="mt-3 space-y-1">
              {installed.map((skill) => (
                <li key={skill.id} className="flex items-center gap-2 text-[10px] text-text-secondary">
                  <span className="font-mono text-text-primary">{skill.id}</span>
                  <span className="truncate">{skill.source}</span>
                  <button
                    type="button"
                    onClick={() => void remove(skill.id)}
                    className="ml-auto rounded p-1 hover:bg-red-500/10 hover:text-red-300"
                    aria-label={`Remove ${skill.id}`}
                  >
                    <Trash2 size={11} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[9px] text-text-secondary/70">Stored on the server in {info.skillsDir}</p>
        </div>
      </div>
    </div>
  );
}
