import { useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { CheckCircle, XCircle, Loader2, Users, Trash2, Star, Tag, Palette, Image as ImageIcon } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { CullingSettings, CullingSuggestions, Invokes, Progress } from '../ui/AppProperties';
import Button from '../ui/Button';
import Switch from '../ui/Switch';
import Slider from '../ui/Slider';
import Dropdown from '../ui/Dropdown';
import Text from '../ui/Text';
import { TextColors, TextVariants } from '../../types/typography';
import { useProcessStore } from '../../store/useProcessStore';

const EMPTY_THUMBNAILS: Record<string, string> = {};

interface CullingModalProps {
  isOpen: boolean;
  onClose(): void;
  progress: (Progress & { stage?: string }) | null;
  suggestions: CullingSuggestions | null;
  error: string | null;
  imagePaths: string[];
  onApply(action: 'reject' | 'rate_zero' | 'delete', paths: string[]): void;
  onStyleKeepers?(keepers: string[]): void;
  onError(error: string): void;
}

type CullAction = 'reject' | 'rate_zero' | 'delete';

// The backend keeps at most ~500 pending thumbnail jobs and this dialog can list
// thousands of frames, so only ask for the ones the active tab shows first.
const THUMBNAIL_REQUEST_LIMIT = 500;

interface ImageThumbnailProps {
  path: string;
  thumbnails: Record<string, string>;
  isSelected: boolean;
  onToggle(): void;
  children?: ReactNode;
}

function ImageThumbnail({ path, thumbnails, isSelected, onToggle, children }: ImageThumbnailProps) {
  const thumbnailUrl = thumbnails[path];
  return (
    <div
      className={`relative group aspect-square rounded-md overflow-hidden border-2 bg-bg-primary transition-colors cursor-pointer ${
        isSelected ? 'border-accent' : 'border-transparent hover:border-surface'
      }`}
      onClick={onToggle}
    >
      {thumbnailUrl ? (
        <img
          src={thumbnailUrl}
          alt=""
          loading="lazy"
          className={`w-full h-full object-cover transition-opacity ${isSelected ? 'opacity-100' : 'opacity-75 group-hover:opacity-100'}`}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-text-secondary/30">
          <ImageIcon size={20} />
        </div>
      )}
      <div
        className={`absolute inset-0 bg-black/50 transition-opacity ${
          isSelected ? 'opacity-0' : 'opacity-100 group-hover:opacity-0'
        }`}
      />
      <div className="absolute top-2 right-2">{isSelected && <CheckCircle size={16} className="text-accent" />}</div>
      {children && (
        <Text
          as="div"
          variant={TextVariants.small}
          color={TextColors.white}
          className="absolute bottom-0 left-0 right-0 p-1 bg-black/60"
        >
          {children}
        </Text>
      )}
    </div>
  );
}

export default function CullingModal({
  isOpen,
  onClose,
  progress,
  suggestions,
  error,
  imagePaths,
  onApply,
  onStyleKeepers,
  onError,
}: CullingModalProps) {
  const { t } = useTranslation();
  const [isMounted, setIsMounted] = useState(false);
  const [show, setShow] = useState(false);
  const thumbnails = useProcessStore((s) => (isMounted ? s.thumbnails : EMPTY_THUMBNAILS));
  const [stage, setStage] = useState<'settings' | 'progress' | 'results'>('settings');

  const [settings, setSettings] = useState<CullingSettings>({
    groupSimilar: true,
    similarityThreshold: 28,
    filterBlurry: true,
    blurThreshold: 100.0,
  });

  const [selectedRejects, setSelectedRejects] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<CullAction>('reject');
  const [activeTab, setActiveTab] = useState<'similar' | 'blurry'>('similar');

  const CULL_ACTIONS = useMemo(
    () => [
      {
        value: 'reject' as const,
        label: t('modals.culling.actionReject'),
        icon: <Tag size={16} className="text-red-500" />,
      },
      { value: 'rate_zero' as const, label: t('modals.culling.actionRateZero'), icon: <Star size={16} /> },
      { value: 'delete' as const, label: t('modals.culling.actionDelete'), icon: <Trash2 size={16} /> },
    ],
    [t],
  );

  useEffect(() => {
    if (isOpen) {
      setIsMounted(true);
      const timer = setTimeout(() => setShow(true), 10);
      return () => clearTimeout(timer);
    } else {
      setShow(false);
      const timer = setTimeout(() => {
        setIsMounted(false);
        setStage('settings');
        setSelectedRejects(new Set());
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  useEffect(() => {
    if (suggestions || error) {
      setStage('results');
    } else if (progress) {
      setStage('progress');
    } else if (isOpen) {
      setStage('settings');
    }
  }, [progress, suggestions, error, isOpen]);

  useEffect(() => {
    if (stage === 'results' && suggestions) {
      const initialRejects = new Set<string>();
      suggestions.similarGroups.forEach((group) => {
        group.duplicates.forEach((dup) => initialRejects.add(dup.path));
      });
      suggestions.blurryImages.forEach((img) => initialRejects.add(img.path));
      setSelectedRejects(initialRejects);
    }
  }, [stage, suggestions]);

  // The dialog can list hundreds of frames that were never rendered in the library
  // grid, so their thumbnails are not in the in-memory cache yet (which showed up as
  // empty boxes). Ask the backend to generate the ones the active tab displays,
  // capped to what its queue accepts. Groups are sorted best-first, so the frames the
  // user sees at the top of the dialog are the ones that get requested.
  useEffect(() => {
    if (stage !== 'results' || !suggestions) return;
    const paths = new Set<string>();
    const add = (path: string) => {
      if (paths.size < THUMBNAIL_REQUEST_LIMIT) paths.add(path);
    };

    if (activeTab === 'similar') {
      suggestions.similarGroups.forEach((group) => {
        add(group.representative.path);
        group.duplicates.forEach((dup) => add(dup.path));
      });
    } else {
      suggestions.blurryImages.forEach((img) => add(img.path));
    }

    if (paths.size === 0) return;
    invoke('update_thumbnail_queue', { paths: Array.from(paths) }).catch((err) =>
      console.error('Failed to request culling thumbnails:', err),
    );
  }, [stage, suggestions, activeTab]);

  const handleStartCulling = useCallback(async () => {
    try {
      await invoke(Invokes.CullImages, { paths: imagePaths, settings });
    } catch (err) {
      console.error('Culling failed to start:', err);
      onError(String(err));
    }
  }, [imagePaths, settings, onError]);

  const handleToggleReject = (path: string) => {
    setSelectedRejects((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(path)) {
        newSet.delete(path);
      } else {
        newSet.add(path);
      }
      return newSet;
    });
  };

  const handleApply = () => {
    onApply(action, Array.from(selectedRejects));
  };

  const handleStyleKeepers = () => {
    if (!onStyleKeepers) return;
    const keepers = imagePaths.filter((path) => !selectedRejects.has(path));
    if (keepers.length === 0) return;
    // Apply the chosen action to the rejects first, then hand the survivors to
    // the AI Style modal so culling and grading happen in one flow.
    if (selectedRejects.size > 0) {
      onApply(action, Array.from(selectedRejects));
    }
    onStyleKeepers(keepers);
  };

  const numSimilar = suggestions?.similarGroups.reduce((acc, group) => acc + group.duplicates.length, 0) || 0;
  const numGroups = suggestions?.similarGroups.length || 0;
  const numBlurry = suggestions?.blurryImages.length || 0;

  const renderSettings = () => (
    <>
      <div className="flex items-center justify-center mb-4">
        <Users className="w-12 h-12 text-accent" />
      </div>
      <Text variant={TextVariants.title} className="mb-6 text-center">
        {t('modals.culling.title')}
      </Text>
      <div className="space-y-6 text-sm">
        <div>
          <Switch
            label={t('modals.culling.groupSimilar')}
            checked={settings.groupSimilar}
            onChange={(v) => setSettings((s) => ({ ...s, groupSimilar: v }))}
          />
          {settings.groupSimilar && (
            <div className="mt-2 pl-4 border-l-2 border-border-color ml-1">
              <Slider
                label={t('modals.culling.similarityThreshold')}
                min={1}
                max={64}
                step={1}
                value={settings.similarityThreshold}
                defaultValue={28}
                onChange={(e) => setSettings((s) => ({ ...s, similarityThreshold: Number(e.target.value) }))}
                fillOrigin="min"
              />
              <Text variant={TextVariants.small} className="mt-1">
                {t('modals.culling.similarityThresholdDesc')}
              </Text>
            </div>
          )}
        </div>
        <div>
          <Switch
            label={t('modals.culling.filterBlurry')}
            checked={settings.filterBlurry}
            onChange={(v) => setSettings((s) => ({ ...s, filterBlurry: v }))}
          />
          {settings.filterBlurry && (
            <div className="mt-2  pl-4 border-l-2 border-border-color ml-1">
              <Slider
                label={t('modals.culling.blurThreshold')}
                min={25}
                max={500}
                step={25}
                value={settings.blurThreshold}
                defaultValue={100.0}
                onChange={(e) => setSettings((s) => ({ ...s, blurThreshold: Number(e.target.value) }))}
                fillOrigin="min"
              />
              <Text variant={TextVariants.small} className="mt-1">
                {t('modals.culling.blurThresholdDesc')}
              </Text>
            </div>
          )}
        </div>
        <Text variant={TextVariants.small} className="text-text-secondary">
          {t('modals.culling.aiHint')}
        </Text>
      </div>
      <div className="flex justify-end gap-3 mt-8">
        <button
          className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors"
          onClick={onClose}
        >
          {t('modals.culling.cancel')}
        </button>
        <Button onClick={handleStartCulling}>{t('modals.culling.startCulling')}</Button>
      </div>
    </>
  );

  const renderProgress = () => (
    <div className="flex flex-col items-center justify-center h-48">
      <Loader2 className="w-16 h-16 text-accent animate-spin" />
      <p className="mt-4 text-text-primary">{progress?.stage || t('modals.culling.starting')}</p>
      {progress && progress.total > 0 && progress.current !== undefined && (
        <div className="w-full bg-surface rounded-full h-2.5 mt-2">
          <div
            className="bg-accent h-2.5 rounded-full"
            style={{ width: `${(progress.current / progress.total) * 100}%` }}
          />
        </div>
      )}
    </div>
  );

  const renderResults = () => {
    if (error) {
      return (
        <div className="flex flex-col items-center justify-center h-48">
          <XCircle className="w-16 h-16 text-red-500" />
          <Text variant={TextVariants.heading} className="mt-4 text-center">
            {t('modals.culling.cullingFailed')}
          </Text>
          <Text>{error}</Text>
          <div className="mt-6">
            <Button onClick={onClose}>{t('modals.culling.close')}</Button>
          </div>
        </div>
      );
    }

    if (!suggestions) return null;

    const totalSuggestions = numSimilar + numBlurry;
    if (totalSuggestions === 0) {
      return (
        <div className="flex flex-col items-center justify-center h-48">
          <CheckCircle className="w-16 h-16 text-green-500" />
          <Text variant={TextVariants.heading} className="mt-4">
            {t('modals.culling.noIssuesFound')}
          </Text>
          <Text>{t('modals.culling.noIssuesDesc')}</Text>
          <div className="mt-6">
            <Button onClick={onClose}>{t('modals.culling.done')}</Button>
          </div>
        </div>
      );
    }

    return (
      <>
        <Text variant={TextVariants.title} className="mb-4">
          {t('modals.culling.cullingSuggestions')}
        </Text>
        <div className="border-b border-surface mb-4">
          <nav className="-mb-px flex space-x-4" aria-label="Tabs">
            {numSimilar > 0 && (
              <button
                onClick={() => setActiveTab('similar')}
                className={`${
                  activeTab === 'similar'
                    ? 'border-accent text-accent'
                    : 'border-transparent text-text-secondary hover:text-text-primary hover:border-gray-300'
                } whitespace-nowrap py-2 px-1 border-b-2 font-medium text-sm`}
              >
                {t('modals.culling.similarGroupsTab')}{' '}
                <span className="bg-surface text-text-secondary rounded-full px-2 py-0.5 text-xs">{numGroups}</span>
              </button>
            )}
            {numBlurry > 0 && (
              <button
                onClick={() => setActiveTab('blurry')}
                className={`${
                  activeTab === 'blurry'
                    ? 'border-accent text-accent'
                    : 'border-transparent text-text-secondary hover:text-text-primary hover:border-gray-300'
                } whitespace-nowrap py-2 px-1 border-b-2 font-medium text-sm`}
              >
                {t('modals.culling.blurryImagesTab')}{' '}
                <span className="bg-surface text-text-secondary rounded-full px-2 py-0.5 text-xs">{numBlurry}</span>
              </button>
            )}
          </nav>
        </div>

        <div className="bg-bg-primary rounded-lg p-2 h-[50vh] overflow-y-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
            >
              {activeTab === 'similar' && (
                <div className="space-y-4">
                  {suggestions.similarGroups.map((group, index) => (
                    <div key={index} className="bg-surface rounded-lg p-3">
                      <Text variant={TextVariants.heading} className="mb-2">
                        {t('modals.culling.groupHeader', { index: index + 1 })}
                      </Text>
                      <div className="grid grid-cols-[1fr_3fr] gap-3">
                        <div>
                          <Text variant={TextVariants.label} className="mb-1">
                            {t('modals.culling.bestImage')}
                          </Text>
                          <div className="relative aspect-square rounded-md overflow-hidden border-2 border-green-500 bg-bg-primary">
                            {thumbnails[group.representative.path] ? (
                              <img
                                src={thumbnails[group.representative.path]}
                                alt=""
                                loading="lazy"
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-text-secondary/30">
                                <ImageIcon size={24} />
                              </div>
                            )}
                            <div className="absolute bottom-0 left-0 right-0 p-1 bg-black/60">
                              <Text as="div" variant={TextVariants.small} color={TextColors.white}>
                                {t('modals.culling.aiScore', {
                                  score: group.representative.aiScore.toFixed(2),
                                })}
                              </Text>
                              <div
                                className="truncate text-[10px] leading-tight text-white/70 cursor-help"
                                title={[
                                  `Quality ${(group.representative.qualityScore ?? 0).toFixed(2)}`,
                                  `Content ${(group.representative.semanticScore ?? 0).toFixed(2)}`,
                                  `Sharpness ${(group.representative.sharpnessMetric ?? 0).toFixed(0)}`,
                                  `Centering ${(group.representative.centerFocusMetric ?? 0).toFixed(2)}`,
                                  `Exposure ${(group.representative.exposureMetric ?? 0).toFixed(2)}`,
                                  `Colour ${(group.representative.colorMetric ?? 0).toFixed(2)}`,
                                ].join(' · ')}
                              >
                                {`Q ${(group.representative.qualityScore ?? 0).toFixed(2)} · S ${(group.representative.semanticScore ?? 0).toFixed(2)} · E ${(group.representative.exposureMetric ?? 0).toFixed(2)} · C ${(group.representative.colorMetric ?? 0).toFixed(2)}`}
                                {group.representative.iso ? ` · ISO ${group.representative.iso}` : ''}
                              </div>
                              {group.representative.tags.length > 0 && (
                                <div className="truncate text-[10px] leading-tight text-white/70">
                                  {group.representative.tags.join(' · ')}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                        <div>
                          <Text variant={TextVariants.label} className="mb-1">
                            {t('modals.culling.duplicatesHeader', { count: group.duplicates.length })}
                          </Text>
                          <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
                            {group.duplicates.map((dup) => (
                              <ImageThumbnail
                                key={dup.path}
                                path={dup.path}
                                thumbnails={thumbnails}
                                isSelected={selectedRejects.has(dup.path)}
                                onToggle={() => handleToggleReject(dup.path)}
                              >
                                {t('modals.culling.aiScore', { score: dup.aiScore.toFixed(2) })}
                              </ImageThumbnail>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {activeTab === 'blurry' && (
                <div className="grid grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2">
                  {suggestions.blurryImages.map((img) => (
                    <ImageThumbnail
                      key={img.path}
                      path={img.path}
                      thumbnails={thumbnails}
                      isSelected={selectedRejects.has(img.path)}
                      onToggle={() => handleToggleReject(img.path)}
                    >
                      {t('modals.culling.sharpness', { sharpness: img.sharpnessMetric.toFixed(0) })}
                    </ImageThumbnail>
                  ))}
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="flex justify-between items-center gap-3 mt-6">
          <div className="flex-1">
            <Dropdown
              options={CULL_ACTIONS.map(({ value, label }) => ({ value, label }))}
              value={action}
              onChange={(newValue: CullAction) => setAction(newValue)}
              className="w-full"
            />
          </div>
          <div className="flex gap-3">
            <button
              className="px-4 py-2 rounded-md text-text-secondary hover:bg-surface transition-colors"
              onClick={onClose}
            >
              {t('modals.culling.cancel')}
            </button>
            <button
              className="flex items-center gap-2 px-4 py-2 rounded-md bg-surface text-text-primary hover:bg-card-active transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={handleStyleKeepers}
              disabled={!onStyleKeepers || imagePaths.length <= selectedRejects.size}
              title={t('modals.culling.styleKeepersHint')}
            >
              <Palette size={16} />
              {t('modals.culling.styleKeepers')}
            </button>
            <Button onClick={handleApply} disabled={selectedRejects.size === 0}>
              {t('modals.culling.applyButton', { count: selectedRejects.size })}
            </Button>
          </div>
        </div>
      </>
    );
  };

  const renderContent = () => {
    switch (stage) {
      case 'settings':
        return renderSettings();
      case 'progress':
        return renderProgress();
      case 'results':
        return renderResults();
      default:
        return null;
    }
  };

  if (!isMounted) return null;

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
        className={`bg-surface rounded-lg shadow-xl p-6 w-full max-w-3xl transform transition-all duration-300 ease-out ${
          show ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 -translate-y-4'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {renderContent()}
      </div>
    </div>
  );
}
