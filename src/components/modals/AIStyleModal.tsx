import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { Loader2, Palette, Sparkles, GraduationCap, Trash2, Check, Wand2, AlertCircle, Tag } from 'lucide-react';
import { toast } from 'react-toastify';
import { AutoStyleSummary, Invokes, StyleMatch, StyleProfile } from '../ui/AppProperties';
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

type Tab = 'profiles' | 'matches' | 'learn';

const TAG_PREVIEW_LIMIT = 6;

function TagChip({ label }: { label: string }) {
  return (
    <span className="inline-block rounded-full bg-bg-primary px-2 py-0.5 text-[10px] text-text-secondary border border-border-color">
      {label}
    </span>
  );
}

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

  const pathCount = targetPaths.length;
  const targetKey = useMemo(() => targetPaths.join('\n'), [targetPaths]);

  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
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

  const handleApplySelected = async () => {
    if (!selectedId || !pathCount) return;
    setBusy('apply');
    try {
      await invoke(Invokes.ApplyStyleProfileToPaths, {
        paths: targetPaths,
        profileId: selectedId,
        intensity,
      });
      toast.success(t('modals.aiStyle.applied', { n: pathCount }));
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
    setBusy('auto');
    try {
      const summary = await invoke<AutoStyleSummary>(Invokes.AutoStylePathsWithAi, {
        paths: targetPaths,
        minScore,
        fallbackProfileId: useFallback ? selectedId : null,
        intensity,
      });
      toast.success(t('modals.aiStyle.autoApplied', { n: summary.applied }));
      await onApplied();
      onClose();
    } catch (err) {
      toast.error(t('modals.aiStyle.applyFailed', { err: String(err) }));
    } finally {
      setBusy(null);
    }
  };

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
        className={`bg-surface rounded-lg shadow-xl p-6 w-full max-w-4xl transform transition-all duration-300 ease-out ${
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
        <Text variant={TextVariants.small} className="text-center text-text-secondary mb-5">
          {t('modals.aiStyle.subtitle')}
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
                      ? 'bg-accent text-white'
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
