import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  AlertTriangle,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Cpu,
  FileText,
  Image as ImageIcon,
  KeyRound,
  Loader2,
  Play,
  Plus,
  Save,
  Send,
  Server,
  Settings,
  Sparkles,
  Trash2,
  Undo2,
  Wand2,
  X,
  XCircle,
} from 'lucide-react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { Invokes, PromptAiConfig, PromptAiStatus } from '../ui/AppProperties';
import { useEditorStore } from '../../store/useEditorStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { reloadAdjustmentsForPaths } from '../../hooks/useEditorActions';
import type { AgentContext, AgentMessage, AgentPlanResponse, AgentSkill, AgentStepResult } from '../../agent/types';
import { ADJUSTMENT_REFERENCE, AGENT_TOOL_CATALOG, getTool } from '../../agent/catalog';
import { buildAgentContext } from '../../agent/context';
import { describeLocalFallback, planLocally, planWithAi } from '../../agent/planner';
import { deleteCustomSkill, getAllSkills, matchSkill, parseSkillMarkdown, saveCustomSkill } from '../../agent/skills';
import { announceFailure, executePlan, restoreSnapshots, snapshotPaths } from '../../agent/executor';

interface EditAgentModalProps {
  isOpen: boolean;
  onClose(): void;
  targetPaths: string[];
  onApplied?(): void | Promise<void>;
  handleImageSelect(path: string): void;
  refreshImageList(): Promise<void>;
}

const HISTORY_KEY = 'rapidraw.editAgent.promptHistory.v1';

const EXAMPLES = [
  'Očisti šum, sačuvaj detalje i daj topli koncertni look',
  'Spoji odabrane HDR brackete pa prirodno izbalansiraj svjetla i sjene',
  'Portret: nježna koža, mekana svjetla, topli ton, bez plastike',
  'Crno-bijeli dokumentarni look s dubokim, čitljivim sjenama',
  'Krop 4:5, provjeri histogram i izvezi JPEG u /home/vedran/Slike/izvoz',
  'Odšumi ISO 6400, zadrži boje i izvuci sjene bez sivila',
  'AI subject mask: podigni pjevača +0.2 EV i zaštiti svjetla',
  'Napravi filmski look 1970-ih, topli highlighti, hladne sjene',
];

function newId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function fileName(path: string | null | undefined): string {
  if (!path) return '';
  return path.split(/[\\/]/).pop() || path;
}

function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(startedAt: number, finishedAt: number): string {
  const ms = Math.max(0, finishedAt - startedAt);
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function readHistory(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string').slice(0, 6)
      : [];
  } catch {
    return [];
  }
}

function writeHistory(entry: string): string[] {
  const next = [entry, ...readHistory().filter((item) => item !== entry)].slice(0, 6);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // Local storage is optional; planning must still work without it.
  }
  return next;
}

function emptyStatus(): PromptAiStatus {
  return {
    available: false,
    model: null,
    url: '',
    provider: 'ollama',
    configured: false,
    models: [],
    detail: null,
  };
}

function resultFor(index: number, results: AgentStepResult[]): AgentStepResult | undefined {
  return results[index];
}

function explicitPlanPaths(plan: AgentPlanResponse): string[] {
  const paths = new Set<string>();
  for (const step of plan.steps) {
    const params = step.params || {};
    if (Array.isArray(params.paths)) {
      params.paths.forEach((path) => {
        if (typeof path === 'string' && path.length > 0) paths.add(path);
      });
    }
    if (typeof params.path === 'string' && params.path.length > 0) paths.add(params.path);
  }
  return Array.from(paths);
}

function StatusPill({ available, label }: { available: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
        available
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
          : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${available ? 'bg-emerald-400' : 'bg-amber-400'}`} />
      {label}
    </span>
  );
}

export default function EditAgentModal({
  isOpen,
  onClose,
  targetPaths,
  onApplied,
  handleImageSelect,
  refreshImageList,
}: EditAgentModalProps) {
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);
  const [tab, setTab] = useState<'agent' | 'skills' | 'tools' | 'provider'>('agent');
  const [toolQuery, setToolQuery] = useState('');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [plan, setPlan] = useState<AgentPlanResponse | null>(null);
  const [results, setResults] = useState<AgentStepResult[]>([]);
  const [runningIndex, setRunningIndex] = useState(-1);
  const [busy, setBusy] = useState<'planning' | 'running' | null>(null);
  const [autoRun, setAutoRun] = useState(true);
  const [useAiPlanner, setUseAiPlanner] = useState(true);
  const [planError, setPlanError] = useState<string | null>(null);
  const [context, setContext] = useState<AgentContext | null>(null);
  const [sessionPaths, setSessionPaths] = useState<string[]>(targetPaths);
  const [skills, setSkills] = useState<AgentSkill[]>(() => getAllSkills());
  const [activeSkillId, setActiveSkillId] = useState<string | null>(null);
  const [promptHistory, setPromptHistory] = useState<string[]>(readHistory);
  const [snapshot, setSnapshot] = useState<unknown>(null);
  const [snapshotPathsList, setSnapshotPathsList] = useState<string[]>([]);
  const [showSkillEditor, setShowSkillEditor] = useState(false);
  const [skillDraft, setSkillDraft] = useState({
    name: '',
    description: '',
    triggers: '',
    allowedTools: '',
    content: '',
  });
  const [skillError, setSkillError] = useState<string | null>(null);
  const [aiStatus, setAiStatus] = useState<PromptAiStatus>(emptyStatus);
  const [aiConfig, setAiConfig] = useState<PromptAiConfig>({
    provider: 'ollama',
    baseUrl: '',
    apiKey: '',
    model: '',
    timeoutSecs: 120,
  });
  const [savingProvider, setSavingProvider] = useState(false);
  const [providerMessage, setProviderMessage] = useState<string | null>(null);

  const { appSettings, handleSettingsChange } = useSettingsStore();
  const selectedImage = useEditorStore((state) => state.selectedImage);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const selectedSkill = useMemo(
    () => skills.find((skill) => skill.id === activeSkillId) || null,
    [activeSkillId, skills],
  );

  const filteredTools = useMemo(() => {
    const query = toolQuery.trim().toLowerCase();
    if (!query) return AGENT_TOOL_CATALOG;
    return AGENT_TOOL_CATALOG.filter((tool) =>
      `${tool.id} ${tool.label} ${tool.description} ${tool.params} ${(tool.examples || []).join(' ')}`
        .toLowerCase()
        .includes(query),
    );
  }, [toolQuery]);

  const hooks = useMemo(
    () => ({
      targetPaths: sessionPaths,
      selectImage: handleImageSelect,
      refreshLibrary: refreshImageList,
      reloadAdjustments: reloadAdjustmentsForPaths,
    }),
    [handleImageSelect, refreshImageList, sessionPaths],
  );

  const refreshContext = useCallback(async () => {
    try {
      setContext(await buildAgentContext(sessionPaths));
    } catch {
      setContext(null);
    }
  }, [sessionPaths]);

  const refreshAiStatus = useCallback(async () => {
    try {
      const status = await invoke<PromptAiStatus>(Invokes.GetPromptAiStatus);
      setAiStatus(status);
      setUseAiPlanner(status.available);
      return status;
    } catch (error) {
      const status = emptyStatus();
      status.detail = String(error);
      setAiStatus(status);
      setUseAiPlanner(false);
      return status;
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
      setShow(false);
      const frame = requestAnimationFrame(() => setShow(true));
      return () => cancelAnimationFrame(frame);
    }
    setShow(false);
    const timer = window.setTimeout(() => setIsMounted(false), 220);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    setPlanError(null);
    setTab('agent');
    setMessages([]);
    setPlan(null);
    setResults([]);
    setSnapshot(null);
    setSnapshotPathsList([]);
    setSessionPaths(targetPaths);
    setSkills(getAllSkills());
    void refreshAiStatus();
  }, [isOpen, refreshAiStatus, targetPaths]);

  useEffect(() => {
    if (!isOpen) return;
    void refreshContext();
  }, [isOpen, refreshContext]);

  useEffect(() => {
    const stored = appSettings?.promptAi;
    if (!stored) return;
    setAiConfig({
      provider: stored.provider || 'ollama',
      baseUrl: stored.baseUrl ?? '',
      apiKey: stored.apiKey ?? '',
      model: stored.model ?? '',
      timeoutSecs: stored.timeoutSecs ?? 120,
    });
  }, [appSettings?.promptAi]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, results]);

  const pushMessage = useCallback((message: AgentMessage) => {
    setMessages((current) => [...current, message]);
  }, []);

  const executePlanSteps = useCallback(
    async (planToRun: AgentPlanResponse): Promise<AgentStepResult[]> => {
      setBusy('running');
      setResults([]);
      setPlanError(null);
      let collected: AgentStepResult[] = [];
      try {
        collected = await executePlan(
          planToRun.steps,
          hooks,
          (index, result) => {
            setRunningIndex(index);
            setResults((current) => {
              const next = [...current];
              next[index] = result;
              return next;
            });
            announceFailure(result);
          },
          () => false,
          (index) => setRunningIndex(index),
        );
        const okCount = collected.filter((result) => result.ok).length;
        const failed = collected.find((result) => !result.ok);
        const lastCreated = [...collected]
          .reverse()
          .find((result) =>
            ['photo.denoise', 'photo.hdr', 'photo.panorama', 'photo.focus-stack', 'photo.negative'].includes(
              result.tool,
            ),
          );
        if (lastCreated) {
          const data = (lastCreated.data || {}) as { saved?: unknown };
          const saved = Array.isArray(data.saved)
            ? data.saved.filter((entry): entry is string => typeof entry === 'string')
            : typeof data.saved === 'string'
              ? [data.saved]
              : [];
          if (saved.length > 0) setSessionPaths(saved);
        }
        pushMessage({
          id: newId('assistant'),
          role: 'assistant',
          text: failed
            ? `Stopped after ${okCount}/${planToRun.steps.length} steps: ${failed.message}`
            : `Completed ${okCount}/${planToRun.steps.length} steps.`,
          at: Date.now(),
          plan: planToRun,
          results: collected,
          planner: planToRun.planner === 'local' ? 'local' : 'ai',
          error: failed?.message,
        });
        if (failed) {
          setPlanError(failed.message);
        }
        await refreshContext();
        await onApplied?.();
        return collected;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setPlanError(message);
        pushMessage({
          id: newId('assistant'),
          role: 'assistant',
          text: `Execution failed: ${message}`,
          at: Date.now(),
          plan: planToRun,
          results: collected,
          planner: planToRun.planner === 'local' ? 'local' : 'ai',
          error: message,
        });
        return collected;
      } finally {
        setBusy(null);
        setRunningIndex(-1);
      }
    },
    [hooks, onApplied, pushMessage, refreshContext],
  );

  const handlePlanAndRun = useCallback(async () => {
    const prompt = input.trim();
    if (!prompt) {
      setPlanError('Describe what RapidRAW should do.');
      promptRef.current?.focus();
      return;
    }
    if (busy) return;

    setBusy('planning');
    setPlanError(null);
    setResults([]);
    setPlan(null);
    setPromptHistory(writeHistory(prompt));
    pushMessage({
      id: newId('user'),
      role: 'user',
      text: prompt,
      at: Date.now(),
    });

    const pathsToSnapshot = Array.from(
      new Set([...sessionPaths, ...(selectedImage?.path ? [selectedImage.path] : [])]),
    );
    let currentSnapshot: unknown = null;
    try {
      currentSnapshot = await snapshotPaths(pathsToSnapshot);
      setSnapshot(currentSnapshot);
      setSnapshotPathsList(pathsToSnapshot);
    } catch {
      // Snapshots are an extra safety net. Some virtual paths (cloud/Android)
      // cannot be snapshotted, but editing can still work.
      setSnapshot(null);
      setSnapshotPathsList([]);
    }

    let planToRun: AgentPlanResponse | null = null;
    try {
      const liveContext = await buildAgentContext(sessionPaths);
      setContext(liveContext);
      if (useAiPlanner && aiStatus.available) {
        try {
          // The AI may match a skill automatically. The deterministic fallback
          // only uses a skill the photographer explicitly selected, so it never
          // applies a full recipe from a keyword in a precise technical request.
          const skill = selectedSkill || matchSkill(prompt);
          planToRun = await planWithAi(prompt, liveContext, skill, Boolean(selectedSkill));
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          pushMessage({
            id: newId('system'),
            role: 'system',
            text: describeLocalFallback(reason),
            at: Date.now(),
          });
          planToRun = planLocally(prompt, liveContext, selectedSkill);
        }
      } else {
        const reason =
          aiStatus.detail ||
          (aiStatus.available ? 'AI planer je isključen' : 'AI provider nije konfiguriran ili nije dostupan');
        pushMessage({
          id: newId('system'),
          role: 'system',
          text: describeLocalFallback(reason),
          at: Date.now(),
        });
        planToRun = planLocally(prompt, liveContext, selectedSkill);
      }

      if (!planToRun) {
        throw new Error('The planner returned no plan.');
      }
      // Plans may explicitly open or address a photo that was not in the
      // initial selection. Capture those sidecars too before the first write.
      const coveredPaths = new Set(pathsToSnapshot);
      const extraPaths = explicitPlanPaths(planToRun).filter((path) => !coveredPaths.has(path));
      if (extraPaths.length > 0) {
        const extended = [...pathsToSnapshot, ...extraPaths];
        try {
          const extendedSnapshot = await snapshotPaths(extended);
          setSnapshot(extendedSnapshot);
          setSnapshotPathsList(extended);
        } catch {
          // Keep the original snapshot. The plan preview still shows the
          // affected paths and each operation saves its own sidecar.
        }
      }
      setPlan(planToRun);
      pushMessage({
        id: newId('assistant'),
        role: 'assistant',
        text: planToRun.summary,
        at: Date.now(),
        plan: planToRun,
        planner: planToRun.planner === 'local' ? 'local' : 'ai',
      });
      setBusy(null);
      if (planToRun.steps.length === 0) {
        setPlanError(planToRun.summary || 'The planner found no safe executable steps.');
        pushMessage({
          id: newId('system'),
          role: 'system',
          text: 'No RapidRAW command was executed. Refine the request or add a provider/model that can plan it.',
          at: Date.now(),
        });
        return;
      }
      const riskySteps = planToRun.steps.filter((step) => getTool(step.tool)?.destructive);
      if (autoRun && riskySteps.length > 0) {
        pushMessage({
          id: newId('system'),
          role: 'system',
          text: `This plan includes ${riskySteps.length} high-impact step(s): ${riskySteps
            .map((step) => step.tool)
            .join(', ')}. Review the plan and press Run to approve them.`,
          at: Date.now(),
        });
        return;
      }
      if (autoRun) {
        await executePlanSteps(planToRun);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPlanError(message);
      pushMessage({
        id: newId('system'),
        role: 'system',
        text: `Planning failed: ${message}`,
        at: Date.now(),
        error: message,
      });
    } finally {
      setBusy(null);
    }
  }, [
    aiStatus.available,
    aiStatus.detail,
    autoRun,
    busy,
    executePlanSteps,
    input,
    pushMessage,
    selectedImage?.path,
    selectedSkill,
    sessionPaths,
    useAiPlanner,
  ]);

  const handleRunExistingPlan = useCallback(async () => {
    if (!plan || busy) return;
    if (snapshot === null && sessionPaths.length > 0) {
      try {
        const current = await snapshotPaths(sessionPaths);
        setSnapshot(current);
        setSnapshotPathsList(sessionPaths);
      } catch {
        // Ignore; execution still has the editor history and per-step saves.
      }
    }
    await executePlanSteps(plan);
  }, [busy, executePlanSteps, plan, sessionPaths, snapshot]);

  const handleUndoPlan = useCallback(async () => {
    if (busy) return;
    if (snapshot === null) {
      setPlanError('Nema spremljene snimke za ovaj plan. Koristi editor Undo za pojedinačne korake.');
      return;
    }
    setBusy('running');
    try {
      await restoreSnapshots(snapshot, snapshotPathsList, hooks);
      setSnapshot(null);
      setSnapshotPathsList([]);
      setResults([]);
      await refreshContext();
      await onApplied?.();
      pushMessage({
        id: newId('system'),
        role: 'system',
        text: 'Plan je vraćen na stanje prije pokretanja. Novostvorene datoteke (denoise/HDR/panorama/stack/export) ostaju na disku.',
        at: Date.now(),
      });
    } catch (error) {
      setPlanError(`Undo failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
    }
  }, [busy, hooks, onApplied, pushMessage, refreshContext, snapshot, snapshotPathsList]);

  const handleSaveProvider = useCallback(async () => {
    if (!appSettings) return;
    setSavingProvider(true);
    setProviderMessage(null);
    try {
      const config: PromptAiConfig = {
        provider: aiConfig.provider || 'ollama',
        baseUrl: aiConfig.baseUrl?.trim() || undefined,
        apiKey: aiConfig.apiKey?.trim() || undefined,
        model: aiConfig.model?.trim() || undefined,
        timeoutSecs: aiConfig.timeoutSecs ?? 120,
      };
      await handleSettingsChange({ ...appSettings, promptAi: config });
      const status = await refreshAiStatus();
      setProviderMessage(
        status.available
          ? `Connected: ${status.model || config.provider}. AI planner is ready.`
          : status.detail || 'Provider saved, but it is not available yet.',
      );
    } catch (error) {
      setProviderMessage(`Could not save provider: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSavingProvider(false);
    }
  }, [aiConfig, appSettings, handleSettingsChange, refreshAiStatus]);

  const handleDeleteSkill = useCallback(
    (id: string) => {
      deleteCustomSkill(id);
      setSkills(getAllSkills());
      if (activeSkillId === id) setActiveSkillId(null);
    },
    [activeSkillId],
  );

  const handleSaveSkill = useCallback(() => {
    if (!skillDraft.name.trim() || !skillDraft.content.trim()) {
      setSkillError('Name and recipe content are required.');
      return;
    }
    const saved = saveCustomSkill({
      name: skillDraft.name,
      description: skillDraft.description,
      triggers: skillDraft.triggers
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
      allowedTools: skillDraft.allowedTools
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
      content: skillDraft.content,
    });
    setSkills(getAllSkills());
    setActiveSkillId(saved.id);
    setShowSkillEditor(false);
    setSkillError(null);
    setSkillDraft({ name: '', description: '', triggers: '', allowedTools: '', content: '' });
    setTab('agent');
  }, [skillDraft]);

  const handleImportSkill = useCallback(async (file: File | null) => {
    if (!file) return;
    try {
      const parsed = parseSkillMarkdown(await file.text());
      const saved = saveCustomSkill({
        name: parsed.name,
        description: parsed.description,
        triggers: parsed.triggers,
        allowedTools: parsed.allowedTools,
        content: parsed.content,
      });
      setSkills(getAllSkills());
      setActiveSkillId(saved.id);
      setSkillError(null);
      setTab('agent');
    } catch (error) {
      setSkillError(`Could not import ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (importRef.current) importRef.current.value = '';
    }
  }, []);

  if (!isMounted) return null;

  const targetLabel =
    sessionPaths.length === 0
      ? 'No selection'
      : sessionPaths.length === 1
        ? fileName(sessionPaths[0])
        : `${sessionPaths.length} photos`;
  const histogram = context?.histogram;
  const exif = context?.image?.exif || {};
  const modelName = [exif.Make, exif.Model].filter(Boolean).join(' ');
  const iso = exif.ISO !== undefined ? `ISO ${String(exif.ISO)}` : '';
  const canRun = !!plan && !busy;

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-2 backdrop-blur-sm transition-opacity duration-200 sm:p-6 ${
        show ? 'opacity-100' : 'opacity-0'
      }`}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="RapidRAW AI Editor"
    >
      <div
        className={`flex h-[min(92vh,940px)] w-full max-w-[1180px] transform flex-col overflow-hidden rounded-xl border border-border-color bg-surface shadow-2xl transition-all duration-200 ${
          show ? 'translate-y-0 scale-100 opacity-100' : '-translate-y-3 scale-[0.985] opacity-0'
        }`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex flex-wrap items-center gap-3 border-b border-border-color px-4 py-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <Wand2 size={18} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold text-text-primary">RapidRAW AI Editor</h2>
              <span className="rounded-full border border-border-color px-2 py-0.5 text-[9px] uppercase tracking-wider text-text-secondary">
                command layer
              </span>
            </div>
            <p className="truncate text-[11px] text-text-secondary">
              Natural language over every adjustment, mask, RAW operation and library action.
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full border border-border-color bg-bg-primary px-2 py-1 text-[10px] text-text-secondary">
              <ImageIcon size={11} />
              {targetLabel}
            </span>
            <StatusPill
              available={aiStatus.available}
              label={aiStatus.available ? aiStatus.model || aiStatus.provider : 'local planner'}
            />
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border-color bg-bg-primary p-1.5 text-text-secondary transition-colors hover:border-accent hover:text-text-primary"
              aria-label="Close"
            >
              <X size={15} />
            </button>
          </div>
        </header>

        <div className="flex items-center gap-1 border-b border-border-color px-3 py-1.5">
          {[
            { id: 'agent' as const, label: 'AI Editor', icon: <Sparkles size={13} /> },
            { id: 'skills' as const, label: `Skills (${skills.length})`, icon: <BookOpen size={13} /> },
            { id: 'tools' as const, label: `Commands (${AGENT_TOOL_CATALOG.length})`, icon: <Cpu size={13} /> },
            { id: 'provider' as const, label: 'AI provider', icon: <Server size={13} /> },
          ].map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setTab(entry.id)}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] transition-colors ${
                tab === entry.id
                  ? 'bg-accent/15 text-text-primary'
                  : 'text-text-secondary hover:bg-bg-primary hover:text-text-primary'
              }`}
            >
              {entry.icon}
              {entry.label}
            </button>
          ))}
          <div className="ml-auto hidden items-center gap-3 text-[10px] text-text-secondary sm:flex">
            <span>{AGENT_TOOL_CATALOG.length} tools</span>
            <span>all sliders</span>
            <span>MCP-ready JSON</span>
          </div>
        </div>

        {tab === 'agent' && (
          <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_390px]">
            <section className="flex min-h-0 flex-col">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border-color bg-bg-primary/40 px-4 py-2 text-[10px] text-text-secondary">
                <span className="inline-flex items-center gap-1">
                  <FileText size={11} />
                  {selectedImage ? fileName(selectedImage.path) : fileName(sessionPaths[0]) || 'No photo open'}
                </span>
                {selectedImage && (
                  <span>
                    {selectedImage.width}×{selectedImage.height}
                    {selectedImage.isRaw ? ' · RAW' : ''}
                  </span>
                )}
                {modelName && <span>{modelName}</span>}
                {iso && <span>{iso}</span>}
                {histogram && (
                  <span
                    className={
                      histogram.tone === 'balanced'
                        ? 'text-emerald-300'
                        : histogram.tone === 'underexposed' || histogram.tone === 'overexposed'
                          ? 'text-red-300'
                          : 'text-amber-300'
                    }
                  >
                    histogram {histogram.median.toFixed(2)} · {histogram.tone}
                  </span>
                )}
                {selectedSkill && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-accent">
                    <BookOpen size={10} />
                    {selectedSkill.name}
                    <button type="button" onClick={() => setActiveSkillId(null)} aria-label="Clear skill">
                      <X size={10} />
                    </button>
                  </span>
                )}
              </div>

              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
                {messages.length === 0 && (
                  <div className="flex h-full min-h-[220px] flex-col items-center justify-center gap-3 text-center">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/10 text-accent">
                      <Wand2 size={22} />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-text-primary">Tell RapidRAW what the photo needs.</p>
                      <p className="mx-auto mt-1 max-w-md text-[11px] leading-relaxed text-text-secondary">
                        The planner can use tone, curves, HSL, colour grading, local AI masks, RAW denoise, HDR,
                        panorama, focus stacking, metadata, culling and export. Pick a skill on the right or write a
                        complete recipe.
                      </p>
                    </div>
                    <div className="flex flex-wrap justify-center gap-1.5">
                      {EXAMPLES.slice(0, 4).map((example) => (
                        <button
                          key={example}
                          type="button"
                          onClick={() => {
                            setInput(example);
                            promptRef.current?.focus();
                          }}
                          className="max-w-[260px] rounded-full border border-border-color bg-bg-primary px-2.5 py-1 text-[10px] text-text-secondary transition-colors hover:border-accent hover:text-text-primary"
                        >
                          {example}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {messages.map((message) => (
                  <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[92%] rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${
                        message.role === 'user'
                          ? 'border-accent/30 bg-accent/10 text-text-primary'
                          : message.role === 'system'
                            ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                            : message.error
                              ? 'border-red-500/30 bg-red-500/10 text-red-200'
                              : 'border-border-color bg-bg-primary/70 text-text-primary'
                      }`}
                    >
                      <div className="mb-1 flex items-center gap-2 text-[9px] uppercase tracking-wider opacity-70">
                        {message.role === 'user' ? 'You' : message.role === 'system' ? 'Planner notice' : 'RapidRAW'}
                        <span className="ml-auto">{formatClock(message.at)}</span>
                      </div>
                      <p className="whitespace-pre-wrap">{message.text}</p>
                      {message.plan && (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <span
                            className={`rounded-full border px-2 py-0.5 text-[9px] uppercase tracking-wide ${
                              message.planner === 'local'
                                ? 'border-amber-500/40 text-amber-300'
                                : 'border-emerald-500/40 text-emerald-300'
                            }`}
                          >
                            {message.planner === 'local' ? 'local plan' : 'AI plan'}
                          </span>
                          <span className="text-[9px] opacity-60">{message.plan.steps.length} steps</span>
                          {message.plan.rejected.length > 0 && (
                            <span className="text-[9px] text-red-300">
                              rejected: {message.plan.rejected.join(', ')}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {busy && (
                  <div className="flex items-center gap-2 rounded-lg border border-border-color bg-bg-primary/60 px-3 py-2 text-[11px] text-text-secondary">
                    <Loader2 size={13} className="animate-spin text-accent" />
                    {busy === 'planning' ? 'Planning the edit against the live catalog…' : 'Running RapidRAW commands…'}
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              <div className="border-t border-border-color bg-bg-primary/30 p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] text-text-secondary">
                  <label className="inline-flex cursor-pointer items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={useAiPlanner}
                      onChange={(event) => setUseAiPlanner(event.target.checked)}
                      disabled={!aiStatus.available}
                      className="accent-accent"
                    />
                    AI planning
                  </label>
                  <span className="opacity-60">{aiStatus.available ? aiStatus.model : 'provider offline'}</span>
                  <label className="inline-flex cursor-pointer items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={autoRun}
                      onChange={(event) => setAutoRun(event.target.checked)}
                      className="accent-accent"
                    />
                    auto-run
                  </label>
                  <span className="ml-auto inline-flex items-center gap-1">
                    <Cpu size={10} />
                    rendering stays local
                  </span>
                </div>
                <div className="flex items-end gap-2">
                  <textarea
                    ref={promptRef}
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                        event.preventDefault();
                        void handlePlanAndRun();
                      }
                    }}
                    rows={2}
                    placeholder="npr. Odšumi visoki ISO, zaštiti svjetla, podigni pjevača i daj topli koncertni look bez plastike…"
                    className="min-h-[58px] flex-1 resize-none rounded-md border border-border-color bg-surface px-3 py-2 text-xs text-text-primary placeholder:text-text-secondary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
                  />
                  <div className="flex flex-col gap-1.5">
                    <Button
                      onClick={() => void handlePlanAndRun()}
                      disabled={!!busy || !input.trim()}
                      className="h-8 whitespace-nowrap px-3 text-[11px]"
                    >
                      {busy === 'planning' ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                      {autoRun ? 'Plan & run' : 'Plan'}
                    </Button>
                    <Button
                      onClick={() => void handleRunExistingPlan()}
                      disabled={!canRun}
                      className="h-8 whitespace-nowrap bg-surface px-3 text-[11px]"
                    >
                      <Play size={12} />
                      Run plan
                    </Button>
                  </div>
                </div>
                {planError && (
                  <div className="mt-2 flex items-start gap-1.5 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] text-red-300">
                    <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                    <span>{planError}</span>
                  </div>
                )}
                {promptHistory.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    <Clock3 size={10} className="text-text-secondary" />
                    {promptHistory.map((entry) => (
                      <button
                        key={entry}
                        type="button"
                        onClick={() => setInput(entry)}
                        className="max-w-[220px] truncate rounded-full border border-border-color px-2 py-0.5 text-[9px] text-text-secondary hover:border-accent hover:text-text-primary"
                      >
                        {entry}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </section>

            <aside className="min-h-0 overflow-y-auto border-t border-border-color bg-bg-primary/20 p-3 lg:border-l lg:border-t-0">
              <div className="mb-2 flex items-center gap-2">
                <Sparkles size={13} className="text-accent" />
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-text-primary">
                  {plan ? 'Plan preview' : 'Command surface'}
                </h3>
                {plan && (
                  <span className="ml-auto rounded-full border border-border-color px-2 py-0.5 text-[9px] text-text-secondary">
                    {plan.planner === 'local' ? 'local' : 'AI'}
                  </span>
                )}
              </div>

              {!plan && (
                <div className="space-y-2">
                  <p className="text-[10px] leading-relaxed text-text-secondary">
                    The planner receives the live catalog, the selected photo, current adjustments and a measured
                    histogram. It cannot invent a tool or execute arbitrary code.
                  </p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {[
                      ['Tone', 'exposure, curves, HDR'],
                      ['Colour', 'HSL, grading, LUT, film'],
                      ['Detail', 'denoise, sharpness, texture'],
                      ['Masks', 'AI subject/sky/foreground'],
                      ['Geometry', 'lens, straighten, crop'],
                      ['Library', 'cull, rate, tag, export'],
                    ].map(([title, detail]) => (
                      <div key={title} className="rounded border border-border-color bg-surface/60 px-2 py-1.5">
                        <p className="text-[10px] font-medium text-text-primary">{title}</p>
                        <p className="text-[9px] text-text-secondary">{detail}</p>
                      </div>
                    ))}
                  </div>
                  <div className="rounded border border-border-color bg-surface/60 p-2">
                    <div className="mb-1 flex items-center gap-1 text-[10px] text-text-secondary">
                      <BookOpen size={11} />
                      Active skills
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {skills.slice(0, 8).map((skill) => (
                        <button
                          key={skill.id}
                          type="button"
                          onClick={() => {
                            setActiveSkillId(skill.id);
                            setTab('agent');
                          }}
                          className={`rounded-full border px-2 py-0.5 text-[9px] transition-colors ${
                            activeSkillId === skill.id
                              ? 'border-accent bg-accent/15 text-text-primary'
                              : 'border-border-color text-text-secondary hover:border-accent hover:text-text-primary'
                          }`}
                        >
                          {skill.name}
                        </button>
                      ))}
                    </div>
                  </div>
                  {histogram?.warning && (
                    <div className="flex items-start gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-300">
                      <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                      {histogram.warning}
                    </div>
                  )}
                </div>
              )}

              {plan && (
                <div className="space-y-2">
                  <p className="text-[11px] leading-relaxed text-text-primary">{plan.summary}</p>
                  {plan.rejected.length > 0 && (
                    <div className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] text-red-300">
                      Rejected unknown tool(s): {plan.rejected.join(', ')}
                    </div>
                  )}
                  <ol className="space-y-1.5">
                    {plan.steps.map((step, index) => {
                      const result = resultFor(index, results);
                      const running = busy === 'running' && runningIndex === index && !result;
                      const tool = getTool(step.tool);
                      return (
                        <li
                          key={`${step.tool}-${index}`}
                          className={`rounded border px-2 py-1.5 ${
                            result?.ok
                              ? 'border-emerald-500/30 bg-emerald-500/5'
                              : result && !result.ok
                                ? 'border-red-500/30 bg-red-500/5'
                                : running
                                  ? 'border-accent/40 bg-accent/5'
                                  : 'border-border-color bg-surface/60'
                          }`}
                        >
                          <div className="flex items-center gap-1.5">
                            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-bg-primary text-[8px] font-semibold text-text-secondary">
                              {index + 1}
                            </span>
                            <span className="truncate font-mono text-[10px] text-text-primary">{step.tool}</span>
                            {tool?.destructive && (
                              <span className="rounded bg-red-500/15 px-1 text-[8px] uppercase text-red-300">risk</span>
                            )}
                            <span className="ml-auto">
                              {running ? (
                                <Loader2 size={11} className="animate-spin text-accent" />
                              ) : result?.ok ? (
                                <CheckCircle2 size={11} className="text-emerald-400" />
                              ) : result && !result.ok ? (
                                <XCircle size={11} className="text-red-400" />
                              ) : (
                                <span className="text-[8px] text-text-secondary">queued</span>
                              )}
                            </span>
                          </div>
                          {step.note && (
                            <p className="mt-1 pl-5 text-[9px] leading-snug text-text-secondary">{step.note}</p>
                          )}
                          {Object.keys(step.params || {}).length > 0 && (
                            <pre className="mt-1 max-h-20 overflow-auto rounded bg-bg-primary/80 p-1 font-mono text-[8px] leading-tight text-text-secondary">
                              {JSON.stringify(step.params, null, 1)}
                            </pre>
                          )}
                          {result && (
                            <div className="mt-1 pl-5 text-[9px] leading-snug">
                              <span className={result.ok ? 'text-emerald-300' : 'text-red-300'}>{result.message}</span>
                              <span className="ml-1 text-text-secondary/60">
                                {formatDuration(result.startedAt, result.finishedAt)}
                              </span>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      onClick={() => void handleRunExistingPlan()}
                      disabled={!canRun}
                      className="h-7 px-2 text-[10px]"
                    >
                      <Play size={11} />
                      Run
                    </Button>
                    <Button
                      onClick={() => void handleUndoPlan()}
                      disabled={!!busy || snapshot === null}
                      className="h-7 bg-surface px-2 text-[10px]"
                    >
                      <Undo2 size={11} />
                      Undo plan
                    </Button>
                  </div>
                  <p className="text-[9px] leading-snug text-text-secondary/70">
                    Undo restores sidecars captured before the plan. Files created by denoise, merge, stack or export
                    are not deleted.
                  </p>
                </div>
              )}
            </aside>
          </div>
        )}

        {tab === 'skills' && (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="mb-3 flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-text-primary">Skill library</h3>
                <p className="mt-0.5 max-w-3xl text-[11px] leading-relaxed text-text-secondary">
                  A skill is a Markdown recipe with YAML frontmatter. Built-ins cover concert, portrait, HDR, panorama,
                  focus stacking, high-ISO rescue, documentary noir, editorial colour, social export and culling. Custom
                  skills stay on this machine.
                </p>
              </div>
              <input
                ref={importRef}
                type="file"
                accept=".md,.markdown,text/markdown,text/plain"
                className="hidden"
                onChange={(event) => void handleImportSkill(event.target.files?.[0] || null)}
              />
              <Button onClick={() => importRef.current?.click()} className="h-8 bg-surface px-3 text-[11px]">
                <FileText size={12} />
                Import SKILL.md
              </Button>
              <Button onClick={() => setShowSkillEditor((current) => !current)} className="h-8 px-3 text-[11px]">
                <Plus size={12} />
                New skill
              </Button>
            </div>

            {skillError && (
              <div className="mb-3 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] text-red-300">
                {skillError}
              </div>
            )}

            {showSkillEditor && (
              <div className="mb-4 rounded-lg border border-border-color bg-bg-primary/50 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <Save size={13} className="text-accent" />
                  <h4 className="text-[11px] font-semibold uppercase tracking-wide text-text-primary">New skill</h4>
                </div>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  <Input
                    value={skillDraft.name}
                    onChange={(event) => setSkillDraft((current) => ({ ...current, name: event.target.value }))}
                    placeholder="Name, e.g. Church Concert Warm"
                    className="h-8 text-[11px]"
                  />
                  <Input
                    value={skillDraft.triggers}
                    onChange={(event) => setSkillDraft((current) => ({ ...current, triggers: event.target.value }))}
                    placeholder="Triggers, comma separated: concert, church, choir"
                    className="h-8 text-[11px]"
                  />
                  <Input
                    value={skillDraft.description}
                    onChange={(event) => setSkillDraft((current) => ({ ...current, description: event.target.value }))}
                    placeholder="One-line description"
                    className="h-8 text-[11px] md:col-span-2"
                  />
                  <Input
                    value={skillDraft.allowedTools}
                    onChange={(event) => setSkillDraft((current) => ({ ...current, allowedTools: event.target.value }))}
                    placeholder="Allowed tools, comma separated: photo.inspect, photo.auto-tone, settings.patch"
                    className="h-8 font-mono text-[10px] md:col-span-2"
                  />
                  <textarea
                    value={skillDraft.content}
                    onChange={(event) => setSkillDraft((current) => ({ ...current, content: event.target.value }))}
                    rows={7}
                    placeholder={'# Recipe\n\n1. Inspect the histogram.\n2. Protect highlights.\n3. ...'}
                    className="resize-y rounded-md border border-border-color bg-surface px-2 py-1.5 text-[11px] text-text-primary placeholder:text-text-secondary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent md:col-span-2"
                  />
                </div>
                <div className="mt-2 flex justify-end gap-2">
                  <Button onClick={() => setShowSkillEditor(false)} className="h-7 bg-surface px-3 text-[10px]">
                    Cancel
                  </Button>
                  <Button onClick={handleSaveSkill} className="h-7 px-3 text-[10px]">
                    <Save size={11} />
                    Save skill
                  </Button>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
              {skills.map((skill) => (
                <div
                  key={skill.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setActiveSkillId(skill.id);
                    setTab('agent');
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setActiveSkillId(skill.id);
                      setTab('agent');
                    }
                  }}
                  className={`cursor-pointer rounded-lg border p-3 text-left transition-colors ${
                    activeSkillId === skill.id
                      ? 'border-accent bg-accent/10'
                      : 'border-border-color bg-bg-primary/40 hover:border-accent/60'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <BookOpen size={13} className="mt-0.5 shrink-0 text-accent" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <h4 className="truncate text-[11px] font-semibold text-text-primary">{skill.name}</h4>
                        {skill.builtIn ? (
                          <span className="rounded-full border border-border-color px-1.5 text-[8px] uppercase text-text-secondary">
                            built-in
                          </span>
                        ) : (
                          <span className="rounded-full border border-accent/40 px-1.5 text-[8px] uppercase text-accent">
                            custom
                          </span>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-[10px] leading-snug text-text-secondary">
                        {skill.description}
                      </p>
                      <p className="mt-1.5 line-clamp-1 text-[9px] text-text-secondary/70">
                        {skill.triggers.join(' · ')}
                      </p>
                      <p className="mt-0.5 text-[9px] text-text-secondary/60">
                        {skill.allowedTools.length ? `${skill.allowedTools.length} allowed tools` : 'all tools'}
                      </p>
                    </div>
                    {!skill.builtIn && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleDeleteSkill(skill.id);
                        }}
                        className="rounded p-1 text-text-secondary transition-colors hover:bg-red-500/10 hover:text-red-300"
                        aria-label={`Delete ${skill.name}`}
                      >
                        <Trash2 size={11} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'tools' && (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="mb-3 flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-text-primary">Command reference</h3>
                <p className="mt-0.5 max-w-3xl text-[11px] leading-relaxed text-text-secondary">
                  These are the exact tools the AI may call. `settings.patch` is the universal escape hatch: it can
                  address every RapidRAW adjustment key, including curves, HSL, colour grading, masks, lens correction,
                  transform, LUT, grain, halation, AI depth blur, relight and fog.
                </p>
              </div>
              <div className="w-full max-w-xs">
                <Input
                  value={toolQuery}
                  onChange={(event) => setToolQuery(event.target.value)}
                  placeholder="Search commands, keys, params…"
                  className="h-8 text-[11px]"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              {filteredTools.map((tool) => (
                <details key={tool.id} className="group rounded-lg border border-border-color bg-bg-primary/40">
                  <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
                    <ChevronRight
                      size={12}
                      className="shrink-0 text-text-secondary transition-transform group-open:rotate-90"
                    />
                    <span className="font-mono text-[10px] text-text-primary">{tool.id}</span>
                    <span className="truncate text-[10px] text-text-secondary">{tool.label}</span>
                    {tool.destructive && (
                      <span className="rounded bg-red-500/15 px-1 text-[8px] uppercase text-red-300">risk</span>
                    )}
                    <span className="ml-auto rounded-full border border-border-color px-1.5 py-0.5 text-[8px] uppercase tracking-wide text-text-secondary">
                      {tool.category}
                    </span>
                  </summary>
                  <div className="border-t border-border-color/70 px-3 py-2 pl-8">
                    <p className="text-[10px] leading-relaxed text-text-secondary">{tool.description}</p>
                    <div className="mt-1.5 rounded bg-bg-primary/80 px-2 py-1 font-mono text-[9px] text-text-primary">
                      {tool.params}
                    </div>
                    {tool.examples && tool.examples.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {tool.examples.map((example) => (
                          <button
                            key={example}
                            type="button"
                            onClick={() => {
                              setInput(example);
                              setTab('agent');
                              promptRef.current?.focus();
                            }}
                            className="max-w-full truncate rounded border border-border-color px-1.5 py-0.5 font-mono text-[8px] text-text-secondary hover:border-accent hover:text-text-primary"
                          >
                            {example}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </details>
              ))}
              {filteredTools.length === 0 && (
                <p className="rounded border border-border-color bg-bg-primary/40 px-3 py-4 text-center text-[11px] text-text-secondary">
                  No command matches “{toolQuery}”.
                </p>
              )}
            </div>

            <details className="mt-4 rounded-lg border border-border-color bg-bg-primary/40">
              <summary className="cursor-pointer px-3 py-2 text-[11px] font-medium text-text-primary">
                Every adjustment key and photographic range
              </summary>
              <pre className="max-h-80 overflow-auto border-t border-border-color px-3 py-2 font-mono text-[9px] leading-relaxed text-text-secondary">
                {ADJUSTMENT_REFERENCE}
              </pre>
            </details>
          </div>
        )}

        {tab === 'provider' && (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="mx-auto max-w-3xl space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-text-primary">AI provider</h3>
                <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
                  The provider only plans a JSON list of RapidRAW tool calls. Image rendering, histogram checks and
                  every pixel operation stay local. Any OpenAI-compatible endpoint works, including local Ollama, LM
                  Studio, OpenCode gateways, ChatGPT and Claude.
                </p>
              </div>

              <div className="rounded-lg border border-border-color bg-bg-primary/40 p-3">
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {[
                    ['ollama', 'Ollama (local)'],
                    ['openai', 'OpenAI-compatible'],
                    ['anthropic', 'Claude'],
                  ].map(([provider, label]) => (
                    <button
                      key={provider}
                      type="button"
                      onClick={() =>
                        setAiConfig((current) => ({
                          ...current,
                          provider,
                          model:
                            current.model ||
                            (provider === 'anthropic'
                              ? 'claude-3-5-haiku-latest'
                              : provider === 'openai'
                                ? 'gpt-4o-mini'
                                : ''),
                        }))
                      }
                      className={`rounded-full border px-3 py-1 text-[10px] transition-colors ${
                        aiConfig.provider === provider
                          ? 'border-accent bg-accent/15 text-text-primary'
                          : 'border-border-color bg-surface text-text-secondary hover:border-accent hover:text-text-primary'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  <Input
                    value={aiConfig.baseUrl ?? ''}
                    onChange={(event) => setAiConfig((current) => ({ ...current, baseUrl: event.target.value }))}
                    placeholder={
                      aiConfig.provider === 'anthropic'
                        ? 'https://api.anthropic.com/v1'
                        : aiConfig.provider === 'openai'
                          ? 'https://api.openai.com/v1 · https://openrouter.ai/api/v1 · http://localhost:1234/v1'
                          : 'http://127.0.0.1:11434'
                    }
                    className="h-8 font-mono text-[10px] md:col-span-2"
                  />
                  <Input
                    value={aiConfig.model ?? ''}
                    onChange={(event) => setAiConfig((current) => ({ ...current, model: event.target.value }))}
                    placeholder={
                      aiConfig.provider === 'anthropic'
                        ? 'claude-3-5-haiku-latest'
                        : aiConfig.provider === 'openai'
                          ? 'gpt-4o-mini'
                          : 'auto (qwen2.5-coder:7b recommended)'
                    }
                    className="h-8 font-mono text-[10px]"
                  />
                  <div className="relative">
                    <KeyRound
                      size={12}
                      className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-secondary"
                    />
                    <Input
                      type="password"
                      value={aiConfig.apiKey ?? ''}
                      onChange={(event) => setAiConfig((current) => ({ ...current, apiKey: event.target.value }))}
                      placeholder={aiConfig.provider === 'ollama' ? 'API key (optional for local)' : 'API key'}
                      className="h-8 pl-7 font-mono text-[10px]"
                    />
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    onClick={() => void handleSaveProvider()}
                    disabled={savingProvider}
                    className="h-8 px-3 text-[11px]"
                  >
                    {savingProvider ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                    Save & test
                  </Button>
                  <Button onClick={() => void refreshAiStatus()} className="h-8 bg-surface px-3 text-[11px]">
                    <Settings size={12} />
                    Refresh status
                  </Button>
                  {providerMessage && (
                    <span className={`text-[10px] ${aiStatus.available ? 'text-emerald-300' : 'text-amber-300'}`}>
                      {providerMessage}
                    </span>
                  )}
                </div>
              </div>

              <div className="rounded-lg border border-border-color bg-bg-primary/40 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill available={aiStatus.available} label={aiStatus.available ? 'available' : 'unavailable'} />
                  <span className="font-mono text-[10px] text-text-secondary">{aiStatus.provider}</span>
                  {aiStatus.model && <span className="font-mono text-[10px] text-text-primary">{aiStatus.model}</span>}
                  {aiStatus.url && <span className="truncate text-[10px] text-text-secondary">{aiStatus.url}</span>}
                </div>
                {aiStatus.detail && (
                  <p className="mt-2 text-[10px] leading-relaxed text-amber-300">{aiStatus.detail}</p>
                )}
                {aiStatus.models.length > 0 && (
                  <div className="mt-2">
                    <p className="mb-1 text-[9px] uppercase tracking-wide text-text-secondary">Installed models</p>
                    <div className="flex flex-wrap gap-1">
                      {aiStatus.models.map((model) => (
                        <button
                          key={model}
                          type="button"
                          onClick={() => setAiConfig((current) => ({ ...current, model }))}
                          className={`rounded-full border px-2 py-0.5 font-mono text-[9px] ${
                            aiConfig.model === model
                              ? 'border-accent bg-accent/15 text-text-primary'
                              : 'border-border-color text-text-secondary hover:border-accent'
                          }`}
                        >
                          {model}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="rounded-lg border border-border-color bg-bg-primary/40 p-3 text-[10px] leading-relaxed text-text-secondary">
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-text-primary">
                  <ChevronRight size={12} className="text-accent" />
                  How planning works
                </div>
                <p>
                  RapidRAW sends the prompt, selected photo context, current adjustments, histogram and the exact tool
                  catalog. The model has to answer with a JSON object. Unknown tools are rejected. If the provider fails
                  or is unavailable, the modal explicitly reports it and uses the deterministic local planner instead of
                  waiting silently.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
