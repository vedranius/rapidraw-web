import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'react-toastify';
import { useEditorStore } from '../store/useEditorStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { globalImageCache } from '../utils/ImageLRUCache';
import { reloadAdjustmentsForPaths } from '../hooks/useEditorActions';
import { executePlan, restoreSnapshots, snapshotPaths } from './executor';
import type { AgentExecutionHooks, AgentStep } from './types';

/**
 * Runs plans sent by AI clients through the RapidRAW Web MCP server (rrweb/relay/mcp.mjs) in this tab, with the
 * same executor, snapshot and undo as the AI Editor. Inert in the desktop app: the relay commands don't exist
 * there, so the hello fails and nothing is listened to.
 */
interface McpRequest {
  rid: string;
  op: 'run' | 'undo';
  steps?: AgentStep[];
  paths?: string[];
  runId?: string;
}

const MAX_RUNS = 20;

function currentState() {
  const selected = useEditorStore.getState().selectedImage?.path ?? null;
  const library = useLibraryStore.getState();
  return {
    openPhoto: selected,
    selection: library.multiSelectedPaths.length
      ? library.multiSelectedPaths.slice(0, 200)
      : selected
        ? [selected]
        : [],
    currentFolder: library.currentFolderPath,
  };
}

export default function McpHost({
  handleImageSelect,
  refreshImageList,
}: {
  handleImageSelect(path: string): void;
  refreshImageList(): Promise<void>;
}) {
  const hooksRef = useRef({ handleImageSelect, refreshImageList });
  hooksRef.current = { handleImageSelect, refreshImageList };

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    let unsubs: Array<() => void> = [];
    const runs = new Map<string, { snapshot: unknown; paths: string[] }>();
    let queue: Promise<unknown> = Promise.resolve();
    let helloTimer: ReturnType<typeof setTimeout> | null = null;

    let lastSent = '';
    const hello = () => {
      const state = currentState();
      lastSent = JSON.stringify(state);
      return invoke<{ enabled: boolean }>('__rr_mcp_hello', { state });
    };
    // only when the selection changed (the stores also change on every slider move)
    const helloSoon = () => {
      if (JSON.stringify(currentState()) === lastSent) return;
      if (helloTimer) clearTimeout(helloTimer);
      helloTimer = setTimeout(() => hello().catch(() => {}), 300);
    };

    const hooksFor = (paths: string[]): AgentExecutionHooks => ({
      targetPaths: paths,
      selectImage: (p) => hooksRef.current.handleImageSelect(p),
      refreshLibrary: () => hooksRef.current.refreshImageList(),
      reloadAdjustments: reloadAdjustmentsForPaths,
    });

    async function handle(req: McpRequest) {
      if (req.op === 'undo') {
        const run = req.runId ? runs.get(req.runId) : undefined;
        if (!run)
          throw new Error(`Unknown runId ${req.runId}: only the last ${MAX_RUNS} runs of this tab can be undone`);
        await restoreSnapshots(run.snapshot, run.paths, hooksFor(run.paths));
        run.paths.forEach((p) => globalImageCache.delete(p));
        runs.delete(req.runId!);
        return { ok: true, restored: run.paths };
      }
      const state = currentState();
      const targets = req.paths?.length ? req.paths : state.selection;
      const snapPaths = Array.from(new Set([...targets, ...(state.openPhoto ? [state.openPhoto] : [])]));
      const snapshot = snapPaths.length ? await snapshotPaths(snapPaths) : null;
      toast.info(`AI client: running ${req.steps?.length ?? 0} RapidRAW step(s)…`, { autoClose: 2500 });
      const results = await executePlan(req.steps ?? [], hooksFor(targets));
      snapPaths.forEach((p) => globalImageCache.delete(p));
      await reloadAdjustmentsForPaths(snapPaths).catch(() => {});
      const runId = req.rid;
      if (snapshot) {
        runs.set(runId, { snapshot, paths: snapPaths });
        while (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value!);
      }
      const failed = results.find((r) => !r.ok);
      if (failed) toast.error(`AI client: ${failed.tool} failed: ${failed.message}`);
      return {
        runId: snapshot ? runId : null,
        targets,
        results: results.map((r) => ({
          tool: r.tool,
          ok: r.ok,
          message: r.message,
          data: r.data,
          ms: r.finishedAt - r.startedAt,
        })),
        skipped: (req.steps?.length ?? 0) - results.length,
        state: currentState(),
      };
    }

    hello()
      .then(async () => {
        if (!active) return;
        unlisten = await listen<McpRequest>('__rr_mcp_request', ({ payload }) => {
          // one plan at a time, in the order they arrived
          queue = queue.then(async () => {
            try {
              const result = await handle(payload);
              await invoke('__rr_mcp_result', { rid: payload.rid, result });
            } catch (e) {
              await invoke('__rr_mcp_result', {
                rid: payload.rid,
                error: e instanceof Error ? e.message : String(e),
              }).catch(() => {});
            }
          });
        });
        if (!active) {
          unlisten();
          return;
        }
        unsubs = [useEditorStore.subscribe(helloSoon), useLibraryStore.subscribe(helloSoon)];
        // focusing a tab makes it the one that runs plans
        const claim = () => hello().catch(() => {});
        window.addEventListener('focus', claim);
        // after a reconnect the relay knows this tab again
        const keep = setInterval(() => {
          invoke('__rr_mcp_hello', { state: currentState(), passive: !document.hasFocus() }).catch(() => {});
        }, 20000);
        unsubs.push(
          () => window.removeEventListener('focus', claim),
          () => clearInterval(keep),
        );
      })
      .catch(() => {}); // desktop app or an older relay: no MCP

    return () => {
      active = false;
      unlisten?.();
      unsubs.forEach((u) => u());
      if (helloTimer) clearTimeout(helloTimer);
    };
  }, []);

  return null;
}
