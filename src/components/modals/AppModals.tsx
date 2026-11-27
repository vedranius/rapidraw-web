import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';
import { closeMergeModal, useUIStore } from '../../store/useUIStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useProcessStore } from '../../store/useProcessStore';
import CopyPasteSettingsModal from './CopyPasteSettingsModal';
import MergeModal from './MergeModal';
import CreateFolderModal from './CreateFolderModal';
import RenameFolderModal from './RenameFolderModal';
import RenameFileModal from './RenameFileModal';
import ConfirmModal from './ConfirmModal';
import ImportSettingsModal from './ImportSettingsModal';
import CullingModal from './CullingModal';
import AIStyleModal from './AIStyleModal';
import EditAgentModal from './EditAgentModal';
import McpHost from '../../agent/McpHost';
import CollageModal from './CollageModal';
import { ProjectSwitcher, TimelapseModal } from '../../store/videoIntegration';
import { AppSettings } from '../../types/settings';
import { ImageFlag, AlbumItem, AlbumGroup, MergeSettings } from '../../types/library';
import { CopyPasteSettings } from '../../utils/adjustments';
import { reloadAdjustmentsForPaths } from '../../hooks/useEditorActions';
import { globalImageCache } from '../../utils/ImageLRUCache';

export interface AppModalsProps {
  handleImageSelect: (path: string) => void;
  refreshImageList: () => Promise<void>;
  handleMergeSettingsChange: (settings: MergeSettings) => void;
  handleSaveMerge: () => Promise<string>;
  handleStartMerge: () => void;
  handleCreateFolder: (folderName: string) => Promise<void>;
  handleRenameFolder: (newName: string) => Promise<void>;
  handleSaveRename: (nameTemplate: string) => Promise<void>;
  handleStartImport: (settings: any) => Promise<void>;
  handleSetFlag: (flag: ImageFlag | null, paths?: string[]) => void;
  handleRate: (rating: number, paths?: string[]) => void;
  executeDelete: (paths: string[], options: any) => Promise<void>;
  handleSaveCollage: (base64Data: string, firstPath: string) => Promise<string>;
  handleCreateAlbumItem: (name: string, type: 'album' | 'group') => Promise<void>;
  handleRenameAlbumItem: (newName: string) => Promise<void>;
}

export default function AppModals(props: AppModalsProps) {
  const { t } = useTranslation();
  const { appSettings, handleSettingsChange } = useSettingsStore(
    useShallow((state) => ({
      appSettings: state.appSettings,
      handleSettingsChange: state.handleSettingsChange,
    })),
  );

  const {
    isCreateFolderModalOpen,
    isRenameFolderModalOpen,
    isRenameFileModalOpen,
    isImportModalOpen,
    isCopyPasteSettingsModalOpen,
    folderActionTarget,
    renameTargetPaths,
    importSourcePaths,
    isCreateAlbumModalOpen,
    isCreateAlbumGroupModalOpen,
    isRenameAlbumModalOpen,
    albumActionTarget,
    confirmModalState,
    mergeModalState,
    cullingModalState,
    aiStyleModalState,
    editAgentModalState,
    collageModalState,
    setUI,
  } = useUIStore(
    useShallow((state) => ({
      isCreateFolderModalOpen: state.isCreateFolderModalOpen,
      isRenameFolderModalOpen: state.isRenameFolderModalOpen,
      isRenameFileModalOpen: state.isRenameFileModalOpen,
      isImportModalOpen: state.isImportModalOpen,
      isCopyPasteSettingsModalOpen: state.isCopyPasteSettingsModalOpen,
      folderActionTarget: state.folderActionTarget,
      renameTargetPaths: state.renameTargetPaths,
      importSourcePaths: state.importSourcePaths,
      isCreateAlbumModalOpen: state.isCreateAlbumModalOpen,
      isCreateAlbumGroupModalOpen: state.isCreateAlbumGroupModalOpen,
      isRenameAlbumModalOpen: state.isRenameAlbumModalOpen,
      albumActionTarget: state.albumActionTarget,
      confirmModalState: state.confirmModalState,
      mergeModalState: state.mergeModalState,
      cullingModalState: state.cullingModalState,
      aiStyleModalState: state.aiStyleModalState,
      editAgentModalState: state.editAgentModalState,
      collageModalState: state.collageModalState,
      setUI: state.setUI,
    })),
  );

  const mergeSourcePaths = mergeModalState.sourcePaths;
  const mergeLoadingPath =
    mergeSourcePaths.length > 0 ? mergeSourcePaths[Math.floor(mergeSourcePaths.length / 2)] : null;
  const mergeThumbnail = useProcessStore((state) =>
    mergeLoadingPath ? state.thumbnails[mergeLoadingPath] : undefined,
  );
  const thumbnails = useProcessStore((state) => state.thumbnails);

  const closeConfirmModal = () => {
    setUI((state) => ({ confirmModalState: { ...state.confirmModalState, isOpen: false } }));
  };

  const currentAlbumData = (() => {
    if (!albumActionTarget) return null;
    const { albumTree } = useLibraryStore.getState();
    const findNode = (nodes: AlbumItem[]): AlbumItem | null => {
      for (const n of nodes) {
        if (n.id === albumActionTarget) return n;
        if (n.type === 'group') {
          const res = findNode((n as AlbumGroup).children);
          if (res) return res;
        }
      }
      return null;
    };
    return findNode(albumTree);
  })();

  const currentAlbumName = currentAlbumData?.name || '';
  const isAlbumGroup = currentAlbumData?.type === 'group';

  return (
    <>
      <CopyPasteSettingsModal
        isOpen={isCopyPasteSettingsModalOpen}
        onClose={() => setUI({ isCopyPasteSettingsModalOpen: false })}
        settings={appSettings?.copyPasteSettings as CopyPasteSettings}
        onSave={(newSettings) =>
          handleSettingsChange({ ...appSettings, copyPasteSettings: newSettings } as AppSettings)
        }
      />
      <MergeModal
        loadingImageUrl={mergeThumbnail || null}
        onClose={closeMergeModal}
        onOpenFile={(path: string) => props.handleImageSelect(path)}
        onSave={props.handleSaveMerge}
        onSettingsChange={props.handleMergeSettingsChange}
        onStart={props.handleStartMerge}
        state={mergeModalState}
      />
      <CreateFolderModal
        isOpen={isCreateFolderModalOpen}
        onClose={() => setUI({ isCreateFolderModalOpen: false })}
        onSave={props.handleCreateFolder}
      />
      <RenameFolderModal
        currentName={folderActionTarget ? folderActionTarget.split(/[\\/]/).pop() || '' : ''}
        isOpen={isRenameFolderModalOpen}
        onClose={() => setUI({ isRenameFolderModalOpen: false })}
        onSave={props.handleRenameFolder}
      />
      <CreateFolderModal
        isOpen={isCreateAlbumModalOpen}
        onClose={() => setUI({ isCreateAlbumModalOpen: false })}
        onSave={(name) => props.handleCreateAlbumItem(name, 'album')}
        title={t('contextMenus.albums.newAlbum')}
        placeholder={t('modals.createAlbum.placeholder')}
        buttonText={t('modals.createFolder.create')}
      />
      <CreateFolderModal
        isOpen={isCreateAlbumGroupModalOpen}
        onClose={() => setUI({ isCreateAlbumGroupModalOpen: false })}
        onSave={(name) => props.handleCreateAlbumItem(name, 'group')}
        title={t('contextMenus.albums.newGroup')}
        placeholder={t('modals.createGroup.placeholder')}
        buttonText={t('modals.createFolder.create')}
      />
      <RenameFolderModal
        currentName={currentAlbumName}
        isOpen={isRenameAlbumModalOpen}
        onClose={() => setUI({ isRenameAlbumModalOpen: false })}
        onSave={props.handleRenameAlbumItem}
        title={isAlbumGroup ? t('contextMenus.albums.renameGroup') : t('contextMenus.albums.renameAlbum')}
        placeholder={isAlbumGroup ? t('modals.renameGroup.placeholder') : t('modals.renameAlbum.placeholder')}
      />
      <RenameFileModal
        filesToRename={renameTargetPaths}
        isOpen={isRenameFileModalOpen}
        onClose={() => setUI({ isRenameFileModalOpen: false })}
        onSave={props.handleSaveRename}
      />
      <ConfirmModal {...confirmModalState} onClose={closeConfirmModal} />
      <ImportSettingsModal
        fileCount={importSourcePaths.length}
        isOpen={isImportModalOpen}
        onClose={() => setUI({ isImportModalOpen: false })}
        onSave={props.handleStartImport}
      />
      <CullingModal
        isOpen={cullingModalState.isOpen}
        onClose={() =>
          setUI({
            cullingModalState: { isOpen: false, progress: null, suggestions: null, error: null, pathsToCull: [] },
          })
        }
        progress={cullingModalState.progress}
        suggestions={cullingModalState.suggestions}
        error={cullingModalState.error}
        imagePaths={cullingModalState.pathsToCull}
        onApply={(action, paths) => {
          if (action === 'reject') {
            props.handleSetFlag(ImageFlag.Reject, paths);
          } else if (action === 'rate_zero') {
            props.handleRate(1, paths);
          } else if (action === 'delete') {
            props.executeDelete(paths, { includeAssociated: false });
          }
          setUI({
            cullingModalState: { isOpen: false, progress: null, suggestions: null, error: null, pathsToCull: [] },
          });
        }}
        onStyleKeepers={(keepers) =>
          setUI({
            cullingModalState: { isOpen: false, progress: null, suggestions: null, error: null, pathsToCull: [] },
            aiStyleModalState: { isOpen: true, targetPaths: keepers },
          })
        }
        onError={(err) => {
          setUI((state) => ({ cullingModalState: { ...state.cullingModalState, error: err, progress: null } }));
        }}
      />
      <AIStyleModal
        isOpen={aiStyleModalState.isOpen}
        onClose={() => setUI({ aiStyleModalState: { isOpen: false, targetPaths: [] } })}
        targetPaths={aiStyleModalState.targetPaths}
        thumbnails={thumbnails}
        onApplied={async () => {
          const paths = aiStyleModalState.targetPaths;
          paths.forEach((path) => globalImageCache.delete(path));
          await reloadAdjustmentsForPaths(paths);
          await props.refreshImageList();
        }}
      />
      <McpHost handleImageSelect={props.handleImageSelect} refreshImageList={props.refreshImageList} />
      <EditAgentModal
        isOpen={editAgentModalState.isOpen}
        onClose={() => setUI({ editAgentModalState: { isOpen: false, targetPaths: [] } })}
        targetPaths={editAgentModalState.targetPaths}
        onApplied={async () => {
          const paths = editAgentModalState.targetPaths;
          paths.forEach((path) => globalImageCache.delete(path));
          await reloadAdjustmentsForPaths(paths);
          await props.refreshImageList();
        }}
        handleImageSelect={props.handleImageSelect}
        refreshImageList={props.refreshImageList}
      />
      <CollageModal
        isOpen={collageModalState.isOpen}
        onClose={() => setUI({ collageModalState: { isOpen: false, sourceImages: [] } })}
        onSave={props.handleSaveCollage}
        sourceImages={collageModalState.sourceImages}
      />
      <TimelapseModal />
      <ProjectSwitcher />
    </>
  );
}
