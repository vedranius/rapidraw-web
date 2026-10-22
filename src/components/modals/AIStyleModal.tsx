import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import {
  Loader2,
  Palette,
  Sparkles,
  GraduationCap,
  Trash2,
  Check,
  Wand2,
  AlertCircle,
  Tag,
  Pencil,
  Save,
  X,
  Dices,
  History,
} from 'lucide-react';
import { toast } from 'react-toastify';
import { AutoStyleSummary, Invokes, PromptAiStatus, SidecarSnapshot, StyleMatch, StyleProfile } from '../ui/AppProperties';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Slider from '../ui/Slider';
import Text from '../ui/Text';
import { TextVariants } from '../../types/typography';

interface AIStyleModalProps {
  isOpen: boolean;
  onClose(): void;
  targetPaths: string[];
  thumbnails: Record<string, string>;
  onApplied(): Promise<void> | void;
}

type Tab = 'profiles' | 'prompt' | 'matches' | 'learn';

const TAG_PREVIEW_LIMIT = 6;

// The interpreter understands English and Croatian, so the examples stay in
// English and double as a hint of the vocabulary it recognises.
const PROMPT_EXAMPLES = [
  'moody teal and orange concert',
  '1950s glam rock concert portrait, Queen',
  'warm airy wedding, Portra 400',
  'cinematic neon night portrait',
  'black and white street portrait',
  'mračni koncert, tirkizno i narančasto',
];

// One-click vocabulary for the local prompt interpreter. Clicking a chip adds
// the exact English phrase it understands; clicking it again removes it.
type IngredientLabel = 'ingredientSubject' | 'ingredientMood' | 'ingredientLight' | 'ingredientFilm';

const PROMPT_INGREDIENTS: { labelKey: IngredientLabel; items: string[] }[] = [
  { labelKey: 'ingredientSubject', items: ['concert', 'portrait', 'wedding', 'street', 'landscape', 'night'] },
  { labelKey: 'ingredientMood', items: ['moody', 'airy', 'warm', 'cool', 'cinematic', 'vintage'] },
  { labelKey: 'ingredientLight', items: ['neon', 'golden hour', 'soft highlights', 'backlit', 'low-key', 'high-key'] },
  {
    labelKey: 'ingredientFilm',
    items: ['portra 400', 'fuji 400h', 'ektar 100', 'kodak gold 200', 'tri-x 400', 'cinestill 800t'],
  },
];

// Curated, internally coherent starting points. A random word salad often
// cancels itself out (high-key + low-key, sepia + black and white).
const SURPRISE_PROMPTS = [
  'moody concert, neon lights, teal and orange, cinematic',
  'warm portrait, soft highlights, Portra 400, airy',
  'golden hour wedding, warm, Fuji 400H, dreamy',
  'gritty street, black and white, high contrast, Tri-X 400',
  'night concert, low-key, cool highlights, Cinestill 800T',
  'vintage landscape, Kodak Gold 200, warm, faded',
  'dramatic portrait, backlit, warm, film grain',
  'pastel wedding, airy, soft highlights, Fuji 400H',
];

const PROMPT_HISTORY_KEY = 'rapidraw.aiStyle.promptHistory';

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const promptHasPhrase = (text: string, phrase: string) =>
  new RegExp(`(^|[^a-z0-9])${escapeRegExp(phrase)}([^a-z0-9]|$)`, 'i').test(text);

function TagChip({ label }: { label: string }) {
  return (
    <span className="inline-block rounded-full bg-bg-primary px-2 py-0.5 text-[10px] text-text-secondary border border-border-color">
      {label}
    </span>
  );
}

const UNDO_TOAST_ID = 'ai-style-undo';

export default function AIStyleModal({ isOpen, onClose, targetPaths, thumbnails, onApplied }: AIStyleModalProps) {
  const { t } = useTranslation();
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);
  const [tab, setTab] = useState<Tab>('profiles');

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [profiles, setProfiles] = useState<StyleProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [intensity, setIntensity] = useState(100);

  const [matches, setMatches] = useState<StyleMatch[]>([]);
  const [minScore, setMinScore] = useState(0.12);
  const [useFallback, setUseFallback] = useState(false);

  const [learnName, setLearnName] = useState('');
  const [learnSubject, setLearnSubject] = useState('');
  const [derived, setDerived] = useState<StyleProfile | null>(null);

  // Prompt-driven looks ("moody teal and orange concert, subtle grain").
  const [prompt, setPrompt] = useState('');
  const [aiStatus, setAiStatus] = useState<PromptAiStatus | null>(null);
  const [useAi, setUseAi] = useState(true);
  const [candidates, setCandidates] = useState<StyleProfile[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [basePreview, setBasePreview] = useState<string | null>(null);
  const [compareCandidate, setCompareCandidate] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  // Preview of a saved profile on the first selected photo, so a built-in or
  // learned look can be judged before it is applied (the Matches tab only
  // shows the source thumbnails).
  const [profilePreview, setProfilePreview] = useState<{ base: string | null; look: string; id: string } | null>(null);
  const [profilePreviewFailed, setProfilePreviewFailed] = useState(false);
  const [showProfileBase, setShowProfileBase] = useState(false);
  const profilePreviewRequest = useRef(0);
  const [generating, setGenerating] = useState(false);
  const [editingCandidate, setEditingCandidate] = useState<string | null>(null);
  const [savedCandidates, setSavedCandidates] = useState<string[]>([]);
  const [promptHistory, setPromptHistory] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(PROMPT_HISTORY_KEY);
      const parsed: unknown = stored ? JSON.parse(stored) : [];
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 6)
        : [];
    } catch {
      return [];
    }
  });
  const previewRequest = useRef(0);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const candidatesRef = useRef<HTMLDivElement>(null);

  // Blob URLs live as long as the candidate card; revoke the previous batch
  // whenever a new set of previews replaces it (and on unmount).
  useEffect(() => {
    return () => {
      Object.values(previews).forEach((url) => URL.revokeObjectURL(url));
    };
  }, [previews]);

  useEffect(() => {
    return () => {
      if (basePreview) URL.revokeObjectURL(basePreview);
    };
  }, [basePreview]);

  useEffect(() => {
    if (!profilePreview) return;
    return () => {
      URL.revokeObjectURL(profilePreview.look);
      if (profilePreview.base) URL.revokeObjectURL(profilePreview.base);
    };
  }, [profilePreview]);

  // Bring the freshly generated looks into view instead of leaving the user
  // at the prompt box with the cards hidden below the fold.
  useEffect(() => {
    if (candidates.length > 0) {
      candidatesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [candidates.length]);

  const pathCount = targetPaths.length;
  const targetKey = useMemo(() => targetPaths.join('\n'), [targetPaths]);

  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
      // With a selection, the content-aware Matches tab is the useful landing
      // page (and the natural hand-off from culling); without one, browsing
      // all saved profiles makes more sense.
      setTab(targetPaths.length > 0 ? 'matches' : 'profiles');
      const timer = setTimeout(() => setShow(true), 10);
      return () => clearTimeout(timer);
    }
    setShow(false);
    const timer = setTimeout(() => {
      setIsMounted(false);
      setTab('profiles');
      setDerived(null);
      setError(null);
    }, 300);
    return () => clearTimeout(timer);
  }, [isOpen]);

  // Local Ollama is optional: when present, it turns the prompt into
  // photographic tags before the local colour engine builds the four looks.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void (async () => {
      try {
        const status = await invoke<PromptAiStatus>(Invokes.GetPromptAiStatus);
        if (cancelled) return;
        setAiStatus(status);
        setUseAi(status.available);
      } catch {
        if (!cancelled) {
          setAiStatus({ available: false, model: null, url: '' });
          setUseAi(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const loadMatches = useCallback(async () => {
    if (!pathCount) {
      setMatches([]);
      return;
    }
    const result = await invoke<StyleMatch[]>(Invokes.MatchStyleProfilesForPaths, {
      paths: targetPaths,
      minScore,
    });
    setMatches(result);
  }, [pathCount, targetPaths, minScore]);

  // Full reload: only when the modal opens or the selection changes. Deliberately
  // not tied to minScore/loadMatches so dragging the threshold slider does not
  // re-scan thousands of sidecars on every tick.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const list = await invoke<StyleProfile[]>(Invokes.ListStyleProfiles);
        if (cancelled) return;
        setProfiles(list);
        setSelectedId((current) => (current && list.some((p) => p.id === current) ? current : (list[0]?.id ?? null)));
        if (targetPaths.length) {
          const result = await invoke<StyleMatch[]>(Invokes.MatchStyleProfilesForPaths, {
            paths: targetPaths,
            minScore,
          });
          if (!cancelled) setMatches(result);
        } else {
          setMatches([]);
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, targetKey]);

  const selectedProfile = profiles.find((p) => p.id === selectedId) ?? null;

  useEffect(() => {
    if (!isOpen || tab !== 'profiles' || !selectedProfile || !targetPaths[0]) {
      setProfilePreview(null);
      setProfilePreviewFailed(false);
      setShowProfileBase(false);
      return;
    }
    setShowProfileBase(false);
    const request = ++profilePreviewRequest.current;
    setProfilePreviewFailed(false);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const batch = await invoke<{ base: number[]; looks: number[][] }>(Invokes.PreviewStyleProfiles, {
            path: targetPaths[0],
            profiles: [selectedProfile],
            intensity,
          });
          if (request !== profilePreviewRequest.current) return;
          const look = batch.looks[0];
          if (!look || look.length === 0) {
            setProfilePreviewFailed(true);
            setProfilePreview(null);
            return;
          }
          const base =
            batch.base && batch.base.length > 0
              ? URL.createObjectURL(new Blob([new Uint8Array(batch.base)], { type: 'image/jpeg' }))
              : null;
          setProfilePreview({
            base,
            look: URL.createObjectURL(new Blob([new Uint8Array(look)], { type: 'image/jpeg' })),
            id: selectedProfile.id,
          });
        } catch (err) {
          if (request !== profilePreviewRequest.current) return;
          console.error('Could not render the saved profile preview:', err);
          setProfilePreviewFailed(true);
          setProfilePreview(null);
        }
      })();
    }, 350);
    return () => clearTimeout(timer);
  }, [isOpen, tab, selectedProfile, intensity, targetKey]);

  const takeSidecarSnapshot = useCallback(async (): Promise<SidecarSnapshot[]> => {
    try {
      return await invoke<SidecarSnapshot[]>(Invokes.SnapshotSidecars, { paths: targetPaths });
    } catch (err) {
      // A failed snapshot must never block the actual style application.
      console.error('Could not snapshot sidecars for undo:', err);
      return [];
    }
  }, [targetPaths]);

  const restoreAfterApply = useCallback(
    async (snapshot: SidecarSnapshot[]) => {
      try {
        await invoke(Invokes.RestoreSidecars, { snapshots: snapshot });
        // The apply already regenerated the thumbnails with the look; after
        // restoring the sidecars they must be rendered again from the old edit.
        await invoke(Invokes.RegenerateThumbnails, { paths: targetPaths });
        toast.dismiss(UNDO_TOAST_ID);
        toast.info(t('modals.aiStyle.undone'));
        await onApplied();
      } catch (err) {
        toast.error(t('modals.aiStyle.undoFailed', { err: String(err) }));
      }
    },
    [onApplied, t, targetPaths],
  );

  const showApplied = useCallback(
    (message: string, snapshot: SidecarSnapshot[]) => {
      if (snapshot.length === 0) {
        toast.success(message);
        return;
      }
      toast.dismiss(UNDO_TOAST_ID);
      toast.success(
        <div className="flex items-center gap-3">
          <span>{message}</span>
          <button
            type="button"
            className="shrink-0 rounded bg-white/20 px-2 py-0.5 text-xs font-semibold underline transition-colors hover:bg-white/30"
            onClick={() => void restoreAfterApply(snapshot)}
          >
            {t('modals.aiStyle.undo')}
          </button>
        </div>,
        {
          toastId: UNDO_TOAST_ID,
          autoClose: 10000,
          closeOnClick: false,
        },
      );
    },
    [restoreAfterApply, t],
  );

  const handleApplySelected = async () => {
    if (!selectedId || !pathCount) return;
    if (intensity <= 0) {
      toast.info(t('modals.aiStyle.nothingToApply'));
      return;
    }
    setBusy('apply');
    try {
      const snapshot = await takeSidecarSnapshot();
      await invoke(Invokes.ApplyStyleProfileToPaths, {
        paths: targetPaths,
        profileId: selectedId,
        intensity,
      });
      showApplied(t('modals.aiStyle.applied', { n: pathCount }), snapshot);
      await onApplied();
      onClose();
    } catch (err) {
      toast.error(t('modals.aiStyle.applyFailed', { err: String(err) }));
    } finally {
      setBusy(null);
    }
  };

  const handleAutoApply = async () => {
    if (!pathCount) return;
    if (intensity <= 0) {
      toast.info(t('modals.aiStyle.nothingToApply'));
      return;
    }
    setBusy('auto');
    try {
      const snapshot = await takeSidecarSnapshot();
      const summary = await invoke<AutoStyleSummary>(Invokes.AutoStylePathsWithAi, {
        paths: targetPaths,
        minScore,
        fallbackProfileId: useFallback ? selectedId : null,
        intensity,
      });
      if (summary.applied === 0) {
        // Keep the modal open: the usual cause is a folder that was never
        // tagged, and the fallback checkbox is right here.
        toast.info(t('modals.aiStyle.noneMatched'));
        return;
      }
      if (summary.skipped.length > 0) {
        showApplied(
          t('modals.aiStyle.autoAppliedPartial', {
            n: summary.applied,
            skipped: summary.skipped.length,
          }),
          snapshot,
        );
      } else {
        showApplied(t('modals.aiStyle.autoApplied', { n: summary.applied }), snapshot);
      }
      await onApplied();
      onClose();
    } catch (err) {
      toast.error(t('modals.aiStyle.applyFailed', { err: String(err) }));
    } finally {
      setBusy(null);
    }
  };

  const previewName = targetPaths[0]?.split(/[\\/]/).pop() ?? '';

  const renderCandidatePreviews = useCallback(
    async (list: StyleProfile[]) => {
      const previewPath = targetPaths[0];
      if (!previewPath || list.length === 0) {
        setPreviews({});
        setBasePreview(null);
        setPreviewFailed(!previewPath);
        return;
      }
      const request = ++previewRequest.current;
      try {
        const batch = await invoke<{ base: number[]; looks: number[][] }>(Invokes.PreviewStyleProfiles, {
          path: previewPath,
          profiles: list,
          intensity,
        });
        if (request !== previewRequest.current) return;
        setPreviewFailed(false);
        setBasePreview(
          batch.base && batch.base.length > 0
            ? URL.createObjectURL(new Blob([new Uint8Array(batch.base)], { type: 'image/jpeg' }))
            : null,
        );
        const next: Record<string, string> = {};
        list.forEach((profile, index) => {
          const data = batch.looks[index];
          if (data && data.length > 0) {
            next[profile.id] = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: 'image/jpeg' }));
          }
        });
        setPreviews(next);
      } catch (err) {
        if (request !== previewRequest.current) return;
        console.error('Could not render style previews:', err);
        setPreviews({});
        setBasePreview(null);
        setPreviewFailed(true);
      }
    },
    [targetPaths, intensity],
  );

  const rememberPrompt = (text: string) => {
    setPromptHistory((current) => {
      const next = [text, ...current.filter((item) => item !== text)].slice(0, 6);
      try {
        localStorage.setItem(PROMPT_HISTORY_KEY, JSON.stringify(next));
      } catch {
        // A blocked localStorage must never stop the look from being generated.
      }
      return next;
    });
  };

  const handleGenerateCandidates = async (textOverride?: string) => {
    const text = (textOverride ?? prompt).trim();
    if (!text) {
      toast.error(t('modals.aiStyle.promptEmpty'));
      return;
    }
    setGenerating(true);
    setEditingCandidate(null);
    setSavedCandidates([]);
    setPreviewFailed(false);
    try {
      const list = await invoke<StyleProfile[]>(Invokes.GenerateStyleCandidates, {
        prompt: text,
        useAi: useAi && (aiStatus?.available ?? false),
      });
      setCandidates(list);
      if (
        useAi &&
        aiStatus?.available &&
        !list.some((candidate) => candidate.id.startsWith('generated-ai-'))
      ) {
        // The status probe succeeded but the expansion call did not: be honest
        // instead of silently presenting the local fallback as an AI result.
        toast.info(t('modals.aiStyle.aiFallback'));
      }
      rememberPrompt(text);
      await renderCandidatePreviews(list);
    } catch (err) {
      toast.error(t('modals.aiStyle.promptFailed', { err: String(err) }));
    } finally {
      setGenerating(false);
    }
  };

  const toggleIngredient = (phrase: string) => {
    setPrompt((current) => {
      if (promptHasPhrase(current, phrase)) {
        const without = current.replace(
          new RegExp(`(^|[^a-z0-9])${escapeRegExp(phrase)}(?=[^a-z0-9]|$)`, 'i'),
          ' ',
        );
        return without.replace(/\s+/g, ' ').trim();
      }
      return `${current.trim()} ${phrase}`.trim();
    });
    promptRef.current?.focus();
  };

  const handleSurprise = () => {
    const text = SURPRISE_PROMPTS[Math.floor(Math.random() * SURPRISE_PROMPTS.length)];
    setPrompt(text);
    void handleGenerateCandidates(text);
  };

  const candidateNumber = (profile: StyleProfile, key: string) => {
    const value = profile.adjustments?.[key];
    return typeof value === 'number' ? value : 0;
  };

  const editCandidate = (id: string, key: string, value: number, refresh: boolean) => {
    const next = candidates.map((profile) =>
      profile.id === id ? { ...profile, adjustments: { ...profile.adjustments, [key]: value } } : profile,
    );
    setCandidates(next);
    // The saved copy no longer matches once a slider moves; require an explicit
    // Save again instead of showing a misleading check mark.
    setSavedCandidates((current) => current.filter((savedId) => savedId !== id));
    if (refresh) void renderCandidatePreviews(next);
  };

  const handleApplyCandidate = async (profile: StyleProfile) => {
    if (intensity <= 0) {
      toast.info(t('modals.aiStyle.nothingToApply'));
      return;
    }
    setBusy(`apply-candidate:${profile.id}`);
    try {
      const snapshot = await takeSidecarSnapshot();
      await invoke(Invokes.ApplyCustomStyleProfile, {
        paths: targetPaths,
        profile,
        intensity,
      });
      showApplied(t('modals.aiStyle.applied', { n: pathCount }), snapshot);
      await onApplied();
      onClose();
    } catch (err) {
      toast.error(t('modals.aiStyle.applyFailed', { err: String(err) }));
    } finally {
      setBusy(null);
    }
  };

  const handleSaveCandidate = async (profile: StyleProfile) => {
    setBusy(`save-candidate:${profile.id}`);
    try {
      const list = await invoke<StyleProfile[]>(Invokes.SaveStyleProfile, {
        profile: { ...profile, intensity },
      });
      setProfiles(list);
      setSavedCandidates((current) => (current.includes(profile.id) ? current : [...current, profile.id]));
      toast.success(t('modals.aiStyle.saved'));
    } catch (err) {
      toast.error(t('modals.aiStyle.saveFailed', { err: String(err) }));
    } finally {
      setBusy(null);
    }
  };

  const renderPrompt = () => (
    <div className="space-y-4">
      <Text variant={TextVariants.small} className="text-text-secondary">
        {t('modals.aiStyle.promptHint')}
      </Text>

      <textarea
        ref={promptRef}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={t('modals.aiStyle.promptPlaceholder')}
        aria-label={t('modals.aiStyle.tabPrompt')}
        maxLength={600}
        rows={3}
        className="w-full resize-none rounded-md border border-border-color bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-accent"
      />

      {aiStatus && (
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="inline-flex items-center gap-1 rounded-full border border-border-color bg-bg-primary px-2 py-0.5 text-text-secondary">
            <Sparkles size={12} />
            {t('modals.aiStyle.aiAssist')}
          </span>
          {aiStatus.available ? (
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-text-secondary">
              <input
                type="checkbox"
                checked={useAi}
                onChange={(event) => setUseAi(event.target.checked)}
                className="accent-accent"
              />
              <span className="font-mono text-[10px]">{aiStatus.model}</span>
            </label>
          ) : (
            <span className="text-text-secondary">{t('modals.aiStyle.aiUnavailable')}</span>
          )}
          <span className="text-text-secondary/80">{t('modals.aiStyle.aiAssistHint')}</span>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {PROMPT_EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => {
              setPrompt(example);
              promptRef.current?.focus();
            }}
            className="rounded-full border border-border-color bg-bg-primary px-3 py-1 text-xs text-text-secondary transition-colors hover:border-accent hover:text-text-primary"
          >
            {example}
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-border-color bg-bg-primary/60 p-2 space-y-1.5">
        <Text variant={TextVariants.small} className="text-text-secondary">
          {t('modals.aiStyle.ingredients')}
        </Text>
        {PROMPT_INGREDIENTS.map((group) => (
          <div key={group.labelKey} className="flex flex-wrap items-center gap-1">
            <span className="w-16 shrink-0 text-[10px] uppercase tracking-wide text-text-secondary">
              {t(`modals.aiStyle.${group.labelKey}`)}
            </span>
            {group.items.map((item) => {
              const active = promptHasPhrase(prompt, item);
              return (
                <button
                  key={item}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleIngredient(item)}
                  className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                    active
                      ? 'border-accent bg-accent/15 text-text-primary'
                      : 'border-border-color bg-bg-primary text-text-secondary hover:border-accent hover:text-text-primary'
                  }`}
                >
                  {item}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {promptHistory.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-text-secondary">
            <History size={12} />
            {t('modals.aiStyle.promptHistory')}
          </span>
          {promptHistory.map((item) => (
            <button
              key={item}
              type="button"
              title={item}
              onClick={() => {
                setPrompt(item);
                promptRef.current?.focus();
              }}
              className="max-w-[16rem] truncate rounded-full border border-border-color bg-bg-primary px-2 py-0.5 text-[10px] text-text-secondary transition-colors hover:border-accent hover:text-text-primary"
            >
              {item}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <Text variant={TextVariants.small} className="text-text-secondary">
          {t('modals.aiStyle.promptPreviewNote', { name: previewName })}
        </Text>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            onClick={handleSurprise}
            disabled={generating}
            className="flex items-center gap-2 bg-surface text-text-primary border border-border-color"
            style={{ padding: '0.35rem 0.6rem', fontSize: '0.75rem' }}
          >
            <Dices size={15} />
            {t('modals.aiStyle.surprise')}
          </Button>
          <Button
            onClick={() => void handleGenerateCandidates()}
            disabled={generating || !prompt.trim()}
            className="flex items-center gap-2"
          >
            {generating ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
            {generating ? t('modals.aiStyle.promptGenerating') : t('modals.aiStyle.promptGenerate')}
          </Button>
        </div>
      </div>

      {candidates.length > 0 && (
        <>
          <div className="rounded-lg bg-bg-primary p-3">
            <Slider
              label={t('modals.aiStyle.intensity')}
              min={0}
              max={100}
              step={1}
              value={intensity}
              defaultValue={100}
              onChange={(e) => setIntensity(Number(e.target.value))}
              onPointerUp={() => void renderCandidatePreviews(candidates)}
              fillOrigin="min"
              suffix="%"
            />
          </div>

          <div
            ref={candidatesRef}
            className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[52vh] overflow-y-auto pr-1 scroll-mt-2"
          >
            {candidates.map((candidate, index) => {
              const preview = previews[candidate.id];
              const saved = savedCandidates.includes(candidate.id);
              const showingBefore = compareCandidate === candidate.id && !!basePreview;
              return (
                <div key={candidate.id} className="rounded-lg border border-border-color bg-bg-primary overflow-hidden">
                  <div className="relative aspect-square bg-black/30">
                    {preview ? (
                      <>
                        <img
                          src={showingBefore ? basePreview! : preview}
                          alt={showingBefore ? `${candidate.name} — before` : candidate.name}
                          className="w-full h-full object-contain"
                        />
                        {basePreview && (
                          <button
                            type="button"
                            onPointerDown={(event) => {
                              event.preventDefault();
                              setCompareCandidate(candidate.id);
                            }}
                            onPointerUp={() => setCompareCandidate(null)}
                            onPointerLeave={() => setCompareCandidate(null)}
                            onPointerCancel={() => setCompareCandidate(null)}
                            className="absolute bottom-2 right-2 rounded-full bg-black/70 px-2.5 py-1 text-[10px] font-medium text-white shadow-sm backdrop-blur transition-colors hover:bg-black/90"
                          >
                            {showingBefore ? t('modals.aiStyle.after') : t('modals.aiStyle.before')}
                          </button>
                        )}
                      </>
                    ) : (
                      <div className="w-full h-full flex items-center justify-center px-3 text-center text-xs text-text-secondary">
                        {previewFailed
                          ? t('modals.aiStyle.promptPreviewFailed')
                          : t('modals.aiStyle.promptPreviewPending')}
                      </div>
                    )}
                  </div>
                  <div className="p-2 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        {index === 0 && (
                          <span className="shrink-0 rounded-full bg-accent/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-accent">
                            {t('modals.aiStyle.recommended')}
                          </span>
                        )}
                        {candidate.id.startsWith('generated-ai-') && (
                          <span className="shrink-0 rounded-full border border-accent/40 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-accent">
                            AI
                          </span>
                        )}
                        <Text variant={TextVariants.label} className="truncate">
                          {candidate.name}
                        </Text>
                      </div>
                      {saved && <Check size={14} className="text-accent shrink-0" />}
                    </div>
                    {candidate.description && (
                      <Text variant={TextVariants.small} className="text-text-secondary line-clamp-2">
                        {candidate.description}
                      </Text>
                    )}
                    <div className="flex items-center gap-1.5 pt-1">
                      <Button
                        className="flex-1 flex items-center justify-center gap-1"
                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                        onClick={() => void handleApplyCandidate(candidate)}
                        disabled={busy === `apply-candidate:${candidate.id}`}
                      >
                        {busy === `apply-candidate:${candidate.id}` ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : (
                          <Wand2 size={13} />
                        )}
                        {t('modals.aiStyle.candidateApply')}
                      </Button>
                      <Button
                        className="flex items-center justify-center gap-1 bg-surface text-text-primary border border-border-color"
                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                        onClick={() => void handleSaveCandidate(candidate)}
                        disabled={busy === `save-candidate:${candidate.id}`}
                      >
                        {busy === `save-candidate:${candidate.id}` ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : (
                          <Save size={13} />
                        )}
                        {t('modals.aiStyle.candidateSave')}
                      </Button>
                      <Button
                        className="flex items-center justify-center gap-1 bg-surface text-text-primary border border-border-color"
                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                        onClick={() =>
                          setEditingCandidate((current) => (current === candidate.id ? null : candidate.id))
                        }
                      >
                        <Pencil size={13} />
                        {t('modals.aiStyle.candidateEdit')}
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {editingCandidate &&
            (() => {
              const candidate = candidates.find((profile) => profile.id === editingCandidate);
              if (!candidate) return null;
              const slider = (
                key: string,
                label: string,
                min: number,
                max: number,
                step = 1,
                fillOrigin: 'min' | 'default' = 'min',
              ) => (
                <Slider
                  key={key}
                  label={label}
                  min={min}
                  max={max}
                  step={step}
                  value={candidateNumber(candidate, key)}
                  defaultValue={0}
                  onChange={(e) => editCandidate(candidate.id, key, Number(e.target.value), false)}
                  onPointerUp={() => editCandidate(candidate.id, key, candidateNumber(candidate, key), true)}
                  fillOrigin={fillOrigin}
                />
              );
              return (
                <div className="rounded-lg border border-accent p-3 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <Text variant={TextVariants.label}>{t('modals.aiStyle.candidateEditor')}</Text>
                    <button
                      className="p-1 rounded hover:bg-surface text-text-secondary"
                      onClick={() => setEditingCandidate(null)}
                      aria-label={t('modals.aiStyle.close')}
                    >
                      <X size={16} />
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {/* Ranges match the generator's clamps so a Bold or
                        black-and-white candidate never opens out of range. */}
                    {slider('contrast', t('adjustments.basic.contrast'), -60, 60, 1, 'default')}
                    {slider('brightness', t('adjustments.basic.brightness'), -5, 5, 0.1, 'default')}
                    {slider('saturation', t('adjustments.color.saturation'), -100, 40, 1, 'default')}
                    {slider('temperature', t('adjustments.color.temperature'), -40, 40, 1, 'default')}
                    {slider('highlights', t('adjustments.basic.highlights'), -80, 60, 1, 'default')}
                    {slider('shadows', t('adjustments.basic.shadows'), -40, 60, 1, 'default')}
                    {slider('grainAmount', t('adjustments.effects.grain'), 0, 60)}
                    {slider('vignetteAmount', t('adjustments.effects.vignette'), -60, 0)}
                  </div>
                  <Text variant={TextVariants.small} className="text-text-secondary">
                    {t('modals.aiStyle.candidateEditHint')}
                  </Text>
                </div>
              );
            })()}
        </>
      )}
    </div>
  );

  const handleLearn = async () => {
    if (!learnName.trim()) {
      toast.error(t('modals.aiStyle.learnNameRequired'));
      return;
    }
    setBusy('learn');
    try {
      const subject = learnSubject.trim();
      // If a subject is given, mark the source images as belonging to it so the
      // learned profile can match the rest of the event later.
      if (subject) {
        try {
          await invoke(Invokes.AssignArtistToPaths, { paths: targetPaths, artist: subject });
        } catch (err) {
          toast.error(t('modals.aiStyle.assignFailed', { err: String(err) }));
        }
      }
      const profile = await invoke<StyleProfile>(Invokes.DeriveStyleProfileFromPaths, {
        paths: targetPaths,
        name: learnName.trim(),
        subject: subject || null,
      });
      setDerived(profile);
      toast.success(t('modals.aiStyle.learned'));
    } catch (err) {
      toast.error(t('modals.aiStyle.learnFailed', { err: String(err) }));
    } finally {
      setBusy(null);
    }
  };

  const handleAssignArtist = async () => {
    const artist = learnSubject.trim();
    if (!artist) {
      toast.error(t('modals.aiStyle.artistRequired'));
      return;
    }
    setBusy('assign');
    try {
      await invoke(Invokes.AssignArtistToPaths, { paths: targetPaths, artist });
      toast.success(t('modals.aiStyle.artistAssigned', { artist, n: pathCount }));
    } catch (err) {
      toast.error(t('modals.aiStyle.assignFailed', { err: String(err) }));
    } finally {
      setBusy(null);
    }
  };

  const handleSaveDerived = async () => {
    if (!derived) return;
    setBusy('save');
    try {
      const list = await invoke<StyleProfile[]>(Invokes.SaveStyleProfile, { profile: derived });
      setProfiles(list);
      setSelectedId(derived.id);
      setDerived(null);
      setLearnName('');
      setLearnSubject('');
      setTab('profiles');
      toast.success(t('modals.aiStyle.saved'));
    } catch (err) {
      toast.error(t('modals.aiStyle.saveFailed', { err: String(err) }));
    } finally {
      setBusy(null);
    }
  };

  const handleDeleteProfile = async (profile: StyleProfile) => {
    setBusy(`delete:${profile.id}`);
    try {
      const list = await invoke<StyleProfile[]>(Invokes.DeleteStyleProfile, { id: profile.id });
      setProfiles(list);
      if (selectedId === profile.id) setSelectedId(list[0]?.id ?? null);
      toast.success(t('modals.aiStyle.deleted'));
    } catch (err) {
      toast.error(t('modals.aiStyle.deleteFailed', { err: String(err) }));
    } finally {
      setBusy(null);
    }
  };

  const renderProfiles = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <Text variant={TextVariants.small} className="text-text-secondary">
          {t('modals.aiStyle.profilesHint')}
        </Text>
        <Button variant="secondary" onClick={() => setTab('learn')} className="shrink-0 flex items-center gap-2">
          <GraduationCap size={16} />
          {t('modals.aiStyle.tabLearn')}
        </Button>
      </div>

      {selectedProfile && targetPaths[0] && (
        <>
          <div className="relative mx-auto aspect-square w-full max-w-[320px] overflow-hidden rounded-lg border border-border-color bg-black">
          {profilePreview?.id === selectedProfile.id ? (
            <>
              <img
                src={showProfileBase && profilePreview.base ? profilePreview.base : profilePreview.look}
                alt={selectedProfile.name}
                className="h-full w-full object-contain"
              />
              <div className="absolute left-2 top-2 max-w-[70%] truncate rounded bg-black/60 px-2 py-1 text-[10px] text-white/80">
                {selectedProfile.name}
              </div>
              {profilePreview.base && (
                <button
                  type="button"
                  className="absolute bottom-2 right-2 rounded bg-black/70 px-2 py-1 text-[11px] text-white transition-colors hover:bg-black/90"
                  onPointerDown={() => setShowProfileBase(true)}
                  onPointerUp={() => setShowProfileBase(false)}
                  onPointerLeave={() => setShowProfileBase(false)}
                  onPointerCancel={() => setShowProfileBase(false)}
                >
                  {showProfileBase ? t('modals.aiStyle.after') : t('modals.aiStyle.before')}
                </button>
              )}
            </>
          ) : (
            <div className="flex h-20 items-center justify-center gap-2 text-xs text-text-secondary">
              {profilePreviewFailed ? (
                t('modals.aiStyle.promptPreviewFailed')
              ) : (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('modals.aiStyle.promptPreviewPending')}
                </>
              )}
            </div>
          )}
        </div>
          <Text variant={TextVariants.small} className="text-center text-text-secondary">
            {t('modals.aiStyle.promptPreviewNote', { name: previewName })}
          </Text>
        </>
      )}

      <div className="space-y-2 max-h-[42vh] overflow-y-auto pr-1">
        {profiles.length === 0 && (
          <Text variant={TextVariants.small} className="text-text-secondary">
            {t('modals.aiStyle.noProfiles')}
          </Text>
        )}
        {profiles.map((profile) => {
          const active = profile.id === selectedId;
          return (
            <div
              key={profile.id}
              role="button"
              tabIndex={0}
              onClick={() => setSelectedId(profile.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') setSelectedId(profile.id);
              }}
              className={`rounded-lg border p-3 cursor-pointer transition-colors ${
                active ? 'border-accent bg-bg-primary' : 'border-border-color hover:bg-bg-primary'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Text variant={TextVariants.label} className="truncate">
                      {profile.name}
                    </Text>
                    {profile.builtIn && <TagChip label={t('modals.aiStyle.builtIn')} />}
                    {profile.subject && <TagChip label={profile.subject} />}
                    {profile.lut?.name && <TagChip label={`LUT · ${profile.lut.name}`} />}
                  </div>
                  {profile.description && (
                    <Text variant={TextVariants.small} className="text-text-secondary mt-1">
                      {profile.description}
                    </Text>
                  )}
                  {profile.detectTags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {profile.detectTags.slice(0, TAG_PREVIEW_LIMIT).map((tag) => (
                        <TagChip key={tag} label={tag} />
                      ))}
                      {profile.detectTags.length > TAG_PREVIEW_LIMIT && (
                        <TagChip label={`+${profile.detectTags.length - TAG_PREVIEW_LIMIT}`} />
                      )}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {active && <Check size={18} className="text-accent" />}
                  {!profile.builtIn && (
                    <button
                      className="p-1 rounded hover:bg-surface text-text-secondary hover:text-red-400 transition-colors"
                      title={t('modals.aiStyle.deleteProfile')}
                      disabled={busy === `delete:${profile.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleDeleteProfile(profile);
                      }}
                    >
                      {busy === `delete:${profile.id}` ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <Trash2 size={16} />
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="rounded-lg bg-bg-primary p-3">
        <Slider
          label={t('modals.aiStyle.intensity')}
          min={0}
          max={100}
          step={1}
          value={intensity}
          defaultValue={100}
          onChange={(e) => setIntensity(Number(e.target.value))}
          fillOrigin="min"
          suffix="%"
        />
      </div>

      <div className="flex justify-end gap-3">
        <button
          className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors"
          onClick={onClose}
        >
          {t('modals.aiStyle.close')}
        </button>
        <Button
          onClick={handleApplySelected}
          disabled={!selectedProfile || !pathCount || busy === 'apply'}
          className="flex items-center gap-2"
        >
          {busy === 'apply' ? <Loader2 size={16} className="animate-spin" /> : <Palette size={16} />}
          {t('modals.aiStyle.applyTo', { n: pathCount })}
        </Button>
      </div>
    </div>
  );

  const renderMatches = () => (
    <div className="space-y-4">
      <Text variant={TextVariants.small} className="text-text-secondary">
        {t('modals.aiStyle.matchesHint')}
      </Text>

      <div className="rounded-lg bg-bg-primary p-3">
        <Slider
          label={t('modals.aiStyle.minScore')}
          min={0}
          max={60}
          step={1}
          value={Math.round(minScore * 100)}
          defaultValue={12}
          onChange={(e) => setMinScore(Number(e.target.value) / 100)}
          onPointerUp={() => void loadMatches()}
          fillOrigin="min"
          suffix="%"
        />
        <Text variant={TextVariants.small} className="mt-1 text-text-secondary">
          {t('modals.aiStyle.minScoreDesc')}
        </Text>
      </div>

      <div className="flex items-center justify-between gap-3">
        <Text variant={TextVariants.small} className="text-text-secondary">
          {t('modals.aiStyle.matchedCount', { matched: matches.length, total: pathCount })}
        </Text>
        <Button
          variant="secondary"
          onClick={() => void loadMatches()}
          disabled={loading}
          className="flex items-center gap-2"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
          {t('modals.aiStyle.recompute')}
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-[38vh] overflow-y-auto pr-1">
        {matches.map((match) => {
          const matchLabel = `${Math.round(match.score * 100)}% · ${match.matchedTags.slice(0, 2).join(', ')}`;
          return (
            <div
              key={match.path}
              className="relative rounded-md overflow-hidden border border-border-color bg-bg-primary"
            >
              {thumbnails[match.path] ? (
                <img src={thumbnails[match.path]} alt="" className="w-full h-24 object-cover" />
              ) : (
                <div className="w-full h-24 flex items-center justify-center text-text-secondary text-xs">
                  {t('modals.aiStyle.noPreview')}
                </div>
              )}
              <div className="absolute bottom-0 left-0 right-0 bg-black/70 p-1">
                <div className="truncate text-[10px] text-white">{match.profileName}</div>
                <div className="truncate text-[10px] text-white/70">{matchLabel}</div>
              </div>
            </div>
          );
        })}
      </div>

      <label className="flex items-center gap-2 text-sm text-text-primary cursor-pointer">
        <input
          type="checkbox"
          checked={useFallback}
          onChange={(e) => setUseFallback(e.target.checked)}
          className="accent-current"
        />
        {t('modals.aiStyle.useFallback', { name: selectedProfile?.name ?? '—' })}
      </label>

      <div className="flex justify-end gap-3">
        <button
          className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors"
          onClick={onClose}
        >
          {t('modals.aiStyle.close')}
        </button>
        <Button onClick={handleAutoApply} disabled={!pathCount || busy === 'auto'} className="flex items-center gap-2">
          {busy === 'auto' ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
          {t('modals.aiStyle.autoApply')}
        </Button>
      </div>
    </div>
  );

  const renderLearn = () => (
    <div className="space-y-4">
      <Text variant={TextVariants.small} className="text-text-secondary">
        {t('modals.aiStyle.learnDesc')}
      </Text>

      <div className="space-y-3">
        <Input
          value={learnName}
          onChange={(e) => setLearnName(e.target.value)}
          placeholder={t('modals.aiStyle.learnNamePlaceholder')}
        />
        <div className="flex items-center gap-2">
          <Input
            value={learnSubject}
            onChange={(e) => setLearnSubject(e.target.value)}
            placeholder={t('modals.aiStyle.learnSubjectPlaceholder')}
            className="flex-1"
          />
          <Button
            variant="secondary"
            onClick={handleAssignArtist}
            disabled={!learnSubject.trim() || !pathCount || busy === 'assign'}
            className="shrink-0 flex items-center gap-2"
          >
            {busy === 'assign' ? <Loader2 size={16} className="animate-spin" /> : <Tag size={16} />}
            {t('modals.aiStyle.assignArtist')}
          </Button>
        </div>
      </div>

      {derived && (
        <div className="rounded-lg border border-accent bg-bg-primary p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-accent" />
            <Text variant={TextVariants.label}>{derived.name}</Text>
          </div>
          {derived.detectTags.length > 0 && (
            <>
              <Text variant={TextVariants.small} className="text-text-secondary">
                {t('modals.aiStyle.derivedTags')}
              </Text>
              <div className="flex flex-wrap gap-1">
                {derived.detectTags.map((tag) => (
                  <TagChip key={tag} label={tag} />
                ))}
              </div>
            </>
          )}
          <Text variant={TextVariants.small} className="text-text-secondary">
            {t('modals.aiStyle.derivedValues', {
              n: Object.keys(derived.adjustments ?? {}).length,
            })}
          </Text>
          <div className="flex justify-end gap-3 pt-1">
            <button
              className="px-3 py-1.5 rounded-md text-text-secondary hover:bg-surface transition-colors"
              onClick={() => setDerived(null)}
            >
              {t('modals.aiStyle.discard')}
            </button>
            <Button onClick={handleSaveDerived} disabled={busy === 'save'} className="flex items-center gap-2">
              {busy === 'save' ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
              {t('modals.aiStyle.saveProfile')}
            </Button>
          </div>
        </div>
      )}

      <div className="flex justify-end gap-3">
        <button
          className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors"
          onClick={onClose}
        >
          {t('modals.aiStyle.close')}
        </button>
        <Button
          onClick={handleLearn}
          disabled={!pathCount || busy === 'learn' || !learnName.trim()}
          className="flex items-center gap-2"
        >
          {busy === 'learn' ? <Loader2 size={16} className="animate-spin" /> : <GraduationCap size={16} />}
          {t('modals.aiStyle.learnButton', { n: pathCount })}
        </Button>
      </div>
    </div>
  );

  if (!isMounted) return null;

  const tabs = [
    { key: 'profiles' as Tab, label: t('modals.aiStyle.tabProfiles'), icon: <Palette size={15} /> },
    { key: 'prompt' as Tab, label: t('modals.aiStyle.tabPrompt'), icon: <Wand2 size={15} /> },
    { key: 'matches' as Tab, label: t('modals.aiStyle.tabMatches'), icon: <Sparkles size={15} /> },
    { key: 'learn' as Tab, label: t('modals.aiStyle.tabLearn'), icon: <GraduationCap size={15} /> },
  ];

  return (
    <div
      className={`fixed inset-0 flex items-center justify-center z-50 bg-black/30 backdrop-blur-xs transition-opacity duration-300 ease-in-out ${
        show ? 'opacity-100' : 'opacity-0'
      }`}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={`bg-surface rounded-lg shadow-xl p-6 w-full max-w-4xl max-h-[90vh] overflow-y-auto transform transition-all duration-300 ease-out ${
          show ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 -translate-y-4'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-center mb-3">
          <Palette className="w-10 h-10 text-accent" />
        </div>
        <Text variant={TextVariants.title} className="mb-1 text-center">
          {t('modals.aiStyle.title')}
        </Text>
        <Text variant={TextVariants.small} className="text-center text-text-secondary mb-1">
          {t('modals.aiStyle.subtitle')}
        </Text>
        <Text variant={TextVariants.small} className="text-center text-text-secondary/70 mb-5">
          {t('modals.aiStyle.adaptHint')}
        </Text>

        {!pathCount ? (
          <div className="flex items-center justify-center gap-2 py-10 text-text-secondary">
            <AlertCircle size={18} />
            {t('modals.aiStyle.noImages')}
          </div>
        ) : error ? (
          <div className="flex items-center justify-center gap-2 py-10 text-red-400">
            <AlertCircle size={18} />
            {error}
          </div>
        ) : (
          <>
            <div className="flex items-center justify-center gap-2 mb-5">
              {tabs.map((item) => (
                <button
                  key={item.key}
                  onClick={() => setTab(item.key)}
                  className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors ${
                    tab === item.key
                      ? 'bg-accent text-button-text'
                      : 'text-text-secondary hover:bg-bg-primary hover:text-text-primary'
                  }`}
                >
                  {item.icon}
                  {item.label}
                </button>
              ))}
            </div>

            {loading && tab === 'profiles' ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-8 h-8 text-accent animate-spin" />
              </div>
            ) : (
              <>
                {tab === 'profiles' && renderProfiles()}
                {tab === 'prompt' && renderPrompt()}
                {tab === 'matches' && renderMatches()}
                {tab === 'learn' && renderLearn()}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
