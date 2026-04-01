import { useCallback, useEffect, useRef, useState } from 'react';
import { AppStateProvider, useAppState } from './hooks/useAppState';
import { DropZone } from './components/DropZone';
import { LoadingOverlay } from './components/LoadingOverlay';
import { Header } from './components/Header';
import { GraphCanvas, GraphCanvasHandle } from './components/GraphCanvas';
import { GraphCanvas3D, GraphCanvas3DHandle } from './components/GraphCanvas3D';
import { RightPanel } from './components/RightPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { StatusBar } from './components/StatusBar';
import { FileTreePanel } from './components/FileTreePanel';
import { CodeReferencesPanel } from './components/CodeReferencesPanel';
import { getActiveProviderConfig } from './core/llm/settings-service';
import { createKnowledgeGraph } from './core/graph/graph';
import {
  connectToServer,
  fetchRepos,
  normalizeServerUrl,
  connectHeartbeat,
  BackendError,
  type ConnectResult,
  type BackendRepo,
} from './services/backend-client';
import { ERROR_RESET_DELAY_MS } from './config/ui-constants';
import { Box, Layers } from '@/lib/lucide-icons';

const AppContent = () => {
  const {
    viewMode,
    setViewMode,
    setGraph,
    setProgress,
    setProjectName,
    progress,
    isRightPanelOpen,
    isSettingsPanelOpen,
    setSettingsPanelOpen,
    refreshLLMSettings,
    initializeAgent,
    startEmbeddingsWithFallback,
    embeddingStatus,
    codeReferences,
    selectedNode,
    isCodePanelOpen,
    serverBaseUrl,
    setServerBaseUrl,
    availableRepos,
    setAvailableRepos,
    switchRepo,
    focusedFolderPath,
    setFocusedFolderPath,
  } = useAppState();

  const graphCanvasRef = useRef<GraphCanvasHandle>(null);
  const graphCanvas3DRef = useRef<GraphCanvas3DHandle>(null);
  const [renderMode, setRenderMode] = useState<'2d' | '3d'>('2d');

  const handleServerConnect = useCallback(
    async (result: ConnectResult): Promise<void> => {
      // Extract project name from repoPath
      const repoPath = result.repoInfo.repoPath ?? result.repoInfo.path;
      const parts = (repoPath || '').split('/').filter((p) => p && !p.startsWith('.'));
      const projectName = parts[parts.length - 1] || parts[0] || 'server-project';
      setProjectName(projectName);

      // Build KnowledgeGraph from server data for visualization
      const graph = createKnowledgeGraph();
      for (const node of result.nodes) {
        graph.addNode(node);
      }
      for (const rel of result.relationships) {
        graph.addRelationship(rel);
      }
      setGraph(graph);

      // Transition directly to exploring view
      setViewMode('exploring');

      // Initialize agent with backend queries, then start embeddings
      try {
        if (getActiveProviderConfig()) {
          await initializeAgent(projectName);
        }
        startEmbeddingsWithFallback();
      } catch (err) {
        console.warn('Failed to initialize agent:', err);
      }
    },
    [setViewMode, setGraph, setProjectName, initializeAgent, startEmbeddingsWithFallback],
  );

  // Auto-connect when ?server query param is present (bookmarkable shortcut)
  const autoConnectRan = useRef(false);
  useEffect(() => {
    if (autoConnectRan.current) return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has('server')) return;
    autoConnectRan.current = true;

    // Clean the URL so a refresh won't re-trigger
    const cleanUrl = window.location.pathname + window.location.hash;
    window.history.replaceState(null, '', cleanUrl);

    setProgress({
      phase: 'extracting',
      percent: 0,
      message: 'Connecting to server...',
      detail: 'Validating server',
    });
    setViewMode('loading');

    const serverUrl = params.get('server') || window.location.origin;

    const baseUrl = normalizeServerUrl(serverUrl);

    connectToServer(serverUrl, (phase, downloaded, total) => {
      if (phase === 'validating') {
        setProgress({
          phase: 'extracting',
          percent: 5,
          message: 'Connecting to server...',
          detail: 'Validating server',
        });
      } else if (phase === 'downloading') {
        const pct = total ? Math.round((downloaded / total) * 90) + 5 : 50;
        const mb = (downloaded / (1024 * 1024)).toFixed(1);
        setProgress({
          phase: 'extracting',
          percent: pct,
          message: 'Downloading graph...',
          detail: `${mb} MB downloaded`,
        });
      } else if (phase === 'extracting') {
        setProgress({
          phase: 'extracting',
          percent: 97,
          message: 'Processing...',
          detail: 'Extracting file contents',
        });
      }
    })
      .then(async (result) => {
        await handleServerConnect(result);
        setProgress(null);
        setServerBaseUrl(baseUrl);
        fetchRepos()
          .then((repos) => setAvailableRepos(repos))
          .catch((e) => console.warn('Failed to fetch repo list:', e));
      })
      .catch((err) => {
        console.error('Auto-connect failed:', err);
        setProgress({
          phase: 'error',
          percent: 0,
          message: 'Failed to connect to server',
          detail: err instanceof Error ? err.message : 'Unknown error',
        });
        setTimeout(() => {
          setViewMode('onboarding');
          setProgress(null);
        }, ERROR_RESET_DELAY_MS);
      });
  }, [handleServerConnect, setProgress, setViewMode, setServerBaseUrl, setAvailableRepos]);

  const handleFocusNode = useCallback((nodeId: string) => {
    graphCanvasRef.current?.focusNode(nodeId);
  }, []);

  // Handle settings saved - refresh and reinitialize agent
  // NOTE: Must be defined BEFORE any conditional returns (React hooks rule)
  const handleSettingsSaved = useCallback(() => {
    refreshLLMSettings();
    initializeAgent();
  }, [refreshLLMSettings, initializeAgent]);

  // ── Server heartbeat: detect when server goes down while exploring ────────
  // Uses SSE (EventSource) for instant detection — no polling delay.
  useEffect(() => {
    if (viewMode !== 'exploring') return;

    const cleanup = connectHeartbeat(
      () => {}, // onConnect — already connected, no action needed
      () => {
        // Server went down — return to onboarding
        setViewMode('onboarding');
        setGraph(null);
        setProgress(null);
      },
    );

    return cleanup;
  }, [viewMode, setViewMode, setGraph, setProgress]);

  // Render based on view mode
  if (viewMode === 'onboarding') {
    return (
      <DropZone
        onServerConnect={async (result, serverUrl) => {
          // Refresh repo list before transitioning so it's ready in the header
          const repos = await fetchRepos().catch(() => [] as BackendRepo[]);
          setAvailableRepos(repos);
          await handleServerConnect(result);
          setProgress(null);
          if (serverUrl) {
            setServerBaseUrl(normalizeServerUrl(serverUrl));
          }
        }}
      />
    );
  }

  if (viewMode === 'loading' && progress) {
    return <LoadingOverlay progress={progress} />;
  }

  // Exploring view
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-void">
      <Header
        onFocusNode={handleFocusNode}
        availableRepos={availableRepos}
        onSwitchRepo={switchRepo}
        onReposChanged={(repos) => setAvailableRepos(repos)}
        onAnalyzeComplete={async (repoName) => {
          // A new repo was just indexed via the header dropdown.
          // Refresh the repo list, connect to the new repo, and switch to it.
          // Retry once after 1s if the repo isn't found yet (server may still
          // be reinitializing after the worker completed).
          const url = serverBaseUrl ?? 'http://localhost:4747';
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const repos = await fetchRepos();
              setAvailableRepos(repos);
              const result = await connectToServer(url, undefined, undefined, repoName);
              await handleServerConnect(result);
              setServerBaseUrl(normalizeServerUrl(url));
              setProgress(null);
              return;
            } catch (err: unknown) {
              if (attempt === 0 && err instanceof BackendError && err.status === 404) {
                // Server may still be reinitializing — wait and retry
                await new Promise((r) => setTimeout(r, 1500));
                continue;
              }
              console.error('Failed to connect after analyze:', err);
              fetchRepos()
                .then((repos) => setAvailableRepos(repos))
                .catch(() => {});
              return;
            }
          }
        }}
      />

      <main className="flex min-h-0 flex-1">
        {/* Left Panel - File Tree */}
        <FileTreePanel onFocusNode={handleFocusNode} />

        {/* Graph area - takes remaining space */}
        <div className="flex-1 relative min-w-0">
          {renderMode === '2d' ? (
            <GraphCanvas ref={graphCanvasRef} />
          ) : (
            <GraphCanvas3D ref={graphCanvas3DRef} />
          )}

          {/* 2D/3D Toggle Button - Bottom Left */}
          <div className="absolute bottom-4 left-4 z-20 flex items-center gap-2">
            <button
              onClick={() => setRenderMode((prev) => (prev === '2d' ? '3d' : '2d'))}
              className={`
                flex items-center gap-2 px-3 py-2 rounded-lg border backdrop-blur-sm transition-all
                ${renderMode === '3d'
                  ? 'bg-accent/20 border-accent/40 text-accent hover:bg-accent/30 shadow-glow-soft'
                  : 'bg-elevated/90 border-border-subtle text-text-secondary hover:bg-hover hover:text-text-primary'
                }
              `}
              title={renderMode === '2d' ? 'Switch to 3D View' : 'Switch to 2D View'}
            >
              {renderMode === '2d' ? (
                <>
                  <Box className="w-4 h-4" />
                  <span className="text-xs font-medium">3D</span>
                </>
              ) : (
                <>
                  <Layers className="w-4 h-4" />
                  <span className="text-xs font-medium">2D</span>
                </>
              )}
            </button>

            {/* Focused folder path indicator */}
            {focusedFolderPath !== null && (
              <div className="flex items-center gap-1.5 px-3 py-2 bg-elevated/90 border border-border-subtle rounded-lg backdrop-blur-sm">
                <span className="text-[10px] text-text-muted">Scope:</span>
                <span className="text-xs font-mono text-accent truncate max-w-[200px]">
                  {focusedFolderPath.split('/').pop() || focusedFolderPath}
                </span>
                <button
                  onClick={() => setFocusedFolderPath(null)}
                  className="ml-1 text-text-muted hover:text-text-primary transition-colors"
                  title="Show full project graph"
                >
                  <span className="text-xs">✕</span>
                </button>
              </div>
            )}
          </div>

          {/* Code References Panel (overlay) - does NOT resize the graph, it overlaps on top */}
          {isCodePanelOpen && (codeReferences.length > 0 || !!selectedNode) && (
            <div className="pointer-events-auto absolute inset-y-0 left-0 z-30">
              <CodeReferencesPanel onFocusNode={handleFocusNode} />
            </div>
          )}
        </div>

        {/* Right Panel - Code & Chat (tabbed) */}
        {isRightPanelOpen && <RightPanel />}
      </main>

      <StatusBar />

      {/* Settings Panel (modal) */}
      <SettingsPanel
        isOpen={isSettingsPanelOpen}
        onClose={() => setSettingsPanelOpen(false)}
        onSettingsSaved={handleSettingsSaved}
      />
    </div>
  );
};

function App() {
  return (
    <AppStateProvider>
      <AppContent />
    </AppStateProvider>
  );
}

export default App;
