import { useEffect, useRef, useCallback, useMemo, useState, forwardRef, useImperativeHandle } from 'react';
import { ZoomIn, ZoomOut, Maximize2, RotateCcw, Lightbulb, LightbulbOff } from '@/lib/lucide-icons';
import { useAppState } from '../hooks/useAppState';
import { knowledgeGraphTo3D, type Graph3DNode, type Graph3DLink } from '../lib/graph-adapter-3d';
import type { GraphNode, NodeLabel } from 'gitnexus-shared';
import { QueryFAB } from './QueryFAB';
import * as THREE from 'three';

export interface GraphCanvas3DHandle {
  focusNode: (nodeId: string) => void;
}

export const GraphCanvas3D = forwardRef<GraphCanvas3DHandle>((_, ref) => {
  const {
    graph,
    setSelectedNode,
    selectedNode: appSelectedNode,
    visibleLabels,
    visibleEdgeTypes,
    openCodePanel,
    highlightedNodeIds,
    aiCitationHighlightedNodeIds,
    aiToolHighlightedNodeIds,
    blastRadiusNodeIds,
    isAIHighlightsEnabled,
    toggleAIHighlights,
    clearAIToolHighlights,
    clearAICitationHighlights,
    clearBlastRadius,
    focusedFolderPath,
    setFocusedFolderPath,
  } = useAppState();

  const containerRef = useRef<HTMLDivElement>(null);
  const graphInstanceRef = useRef<any>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);

  // Double-click detection refs
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastClickedNodeRef = useRef<string | null>(null);

  // Stable ref for the latest click handler (3d-force-graph captures the callback at init time)
  const handleNodeClickRef = useRef<(node: Graph3DNode) => void>(() => {});

  const nodeById = useMemo(() => {
    if (!graph) return new Map<string, GraphNode>();
    return new Map(graph.nodes.map(n => [n.id, n]));
  }, [graph]);

  // Build community memberships
  const communityMemberships = useMemo(() => {
    if (!graph) return new Map<string, number>();
    const memberships = new Map<string, number>();
    graph.relationships.forEach(rel => {
      if (rel.type === 'MEMBER_OF') {
        const communityNode = nodeById.get(rel.targetId);
        if (communityNode && communityNode.label === 'Community') {
          const numericPart = rel.targetId.replace('comm_', '');
          const communityIdx = /^\d+$/.test(numericPart) ? parseInt(numericPart, 10) : 0;
          memberships.set(rel.sourceId, communityIdx);
        }
      }
    });
    return memberships;
  }, [graph, nodeById]);

  // Highlighted node IDs
  const effectiveHighlightedNodeIds = useMemo(() => {
    if (!isAIHighlightsEnabled) return highlightedNodeIds;
    const next = new Set(highlightedNodeIds);
    for (const id of aiCitationHighlightedNodeIds) next.add(id);
    for (const id of aiToolHighlightedNodeIds) next.add(id);
    return next;
  }, [highlightedNodeIds, aiCitationHighlightedNodeIds, aiToolHighlightedNodeIds, isAIHighlightsEnabled]);

  const effectiveBlastRadiusNodeIds = useMemo(() => {
    if (!isAIHighlightsEnabled) return new Set<string>();
    return blastRadiusNodeIds;
  }, [blastRadiusNodeIds, isAIHighlightsEnabled]);

  // Convert graph data with folder scope filtering
  const graphData = useMemo(() => {
    if (!graph) return { nodes: [], links: [] };

    // Filter by visible edge types
    const filteredGraph = {
      ...graph,
      get relationships() {
        return graph.relationships.filter(r => visibleEdgeTypes.includes(r.type as any));
      }
    };

    return knowledgeGraphTo3D(
      filteredGraph as any,
      communityMemberships,
      visibleLabels as NodeLabel[],
      focusedFolderPath,
    );
  }, [graph, communityMemberships, visibleLabels, visibleEdgeTypes, focusedFolderPath]);

  // Focus node handler
  const focusNode = useCallback((nodeId: string) => {
    const fg = graphInstanceRef.current;
    if (!fg) return;

    const node = (graphData.nodes as Graph3DNode[]).find(n => n.id === nodeId);
    if (!node || node.x === undefined || node.y === undefined || node.z === undefined) return;

    const distance = 120;
    const distRatio = 1 + distance / Math.hypot(node.x, node.y, node.z);
    fg.cameraPosition(
      { x: node.x * distRatio, y: node.y * distRatio, z: node.z * distRatio },
      { x: node.x, y: node.y, z: node.z },
      1000
    );
  }, [graphData.nodes]);

  // Double-click handler: drill into a node's children
  const handleNodeDoubleClick = useCallback((node3d: Graph3DNode) => {
    const graphNode = nodeById.get(node3d.id);
    if (!graphNode) return;

    const drillableTypes = new Set(['Folder', 'Package', 'Module', 'Project']);
    const fileTypes = new Set(['File']);
    const codeTypes = new Set(['Class', 'Function', 'Method', 'Interface', 'Enum', 'Variable']);

    if (drillableTypes.has(graphNode.label)) {
      // Folder / Package / Module / Project → drill into this directory
      setFocusedFolderPath(graphNode.properties.filePath.replace(/\/$/, ''));
    } else if (fileTypes.has(graphNode.label)) {
      // File → focus on its parent folder
      const filePath = graphNode.properties.filePath;
      const parentFolder = filePath.substring(0, filePath.lastIndexOf('/'));
      if (parentFolder) {
        setFocusedFolderPath(parentFolder);
      }
    } else if (codeTypes.has(graphNode.label)) {
      // Code element → focus on its file's parent folder
      const filePath = graphNode.properties.filePath;
      const parentFolder = filePath.substring(0, filePath.lastIndexOf('/'));
      if (parentFolder) {
        setFocusedFolderPath(parentFolder);
      }
    }
  }, [nodeById, setFocusedFolderPath]);

  // Combined click handler that distinguishes single vs double click
  const handleNodeClick = useCallback((node3d: Graph3DNode) => {
    const nodeId = node3d.id;

    if (clickTimerRef.current && lastClickedNodeRef.current === nodeId) {
      // Double click detected — cancel single click action & handle double click
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      lastClickedNodeRef.current = null;
      handleNodeDoubleClick(node3d);
    } else {
      // Possible single click — wait a short delay before executing
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current);
      }
      lastClickedNodeRef.current = nodeId;
      clickTimerRef.current = setTimeout(() => {
        clickTimerRef.current = null;
        lastClickedNodeRef.current = null;
        // Single click action: select + focus camera
        const graphNode = nodeById.get(nodeId);
        if (graphNode) {
          setSelectedNode(graphNode);
          openCodePanel();
        }
        focusNode(nodeId);
      }, 250);
    }
  }, [handleNodeDoubleClick, nodeById, setSelectedNode, openCodePanel, focusNode]);

  // Keep the ref in sync with latest handleNodeClick
  handleNodeClickRef.current = handleNodeClick;

  // Cleanup click timer on unmount
  useEffect(() => {
    return () => {
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current);
      }
    };
  }, []);

  // Expose focusNode
  useImperativeHandle(ref, () => ({
    focusNode: (nodeId: string) => {
      if (graph) {
        const node = nodeById.get(nodeId);
        if (node) {
          setSelectedNode(node);
          openCodePanel();
        }
      }
      focusNode(nodeId);
    }
  }), [focusNode, graph, nodeById, setSelectedNode, openCodePanel]);

  // Initialize 3D Force Graph
  useEffect(() => {
    if (!containerRef.current) return;

    let fg: any;
    let destroyed = false;

    const init = async () => {
      const ForceGraph3DModule = await import('3d-force-graph');
      const ForceGraph3D = ForceGraph3DModule.default;
      if (destroyed || !containerRef.current) return;

      fg = new ForceGraph3D(containerRef.current)
        .backgroundColor('#06060a')
        .showNavInfo(false)
        .nodeId('id')
        .nodeLabel((node: any) => {
          const n = node as Graph3DNode;
          const drillable = ['Folder', 'Package', 'Module', 'Project', 'File'].includes(n.nodeType);
          return `<div style="
            background: #12121c;
            border: 1px solid ${n.color};
            color: #f5f5f7;
            padding: 4px 10px;
            border-radius: 6px;
            font-family: 'JetBrains Mono', monospace;
            font-size: 11px;
            pointer-events: none;
          ">
            <strong>${n.name}</strong>
            <span style="color: #8888a0; margin-left: 6px;">${n.nodeType}</span>
            ${drillable ? '<br/><span style="color: #8b5cf6; font-size: 10px;">双击展开子元素</span>' : ''}
          </div>`;
        })
        .nodeColor((node: any) => {
          const n = node as Graph3DNode;
          if (effectiveBlastRadiusNodeIds.has(n.id)) return '#ef4444';
          if (effectiveHighlightedNodeIds.has(n.id)) return '#06b6d4';
          if (appSelectedNode?.id === n.id) return '#ffffff';
          return n.color;
        })
        .nodeVal((node: any) => {
          const n = node as Graph3DNode;
          let baseVal = n.size * n.size * 0.5;
          if (effectiveBlastRadiusNodeIds.has(n.id)) baseVal *= 3;
          else if (effectiveHighlightedNodeIds.has(n.id)) baseVal *= 2.5;
          else if (appSelectedNode?.id === n.id) baseVal *= 3;
          return baseVal;
        })
        .nodeOpacity(0.95)
        .nodeResolution(16)
        .linkSource('source')
        .linkTarget('target')
        .linkColor((link: any) => {
          const l = link as Graph3DLink;
          return l.color;
        })
        .linkWidth((link: any) => {
          const l = link as Graph3DLink;
          return l.width;
        })
        .linkOpacity(0.35)
        .linkDirectionalParticles((link: any) => {
          const l = link as Graph3DLink;
          return l.relationType === 'CALLS' ? 2 : 0;
        })
        .linkDirectionalParticleWidth(1.2)
        .linkDirectionalParticleSpeed(0.005)
        .linkDirectionalParticleColor((link: any) => {
          const l = link as Graph3DLink;
          return l.color;
        })
        .onNodeClick((node: any) => {
          handleNodeClickRef.current(node as Graph3DNode);
        })
        .onNodeHover((node: any) => {
          const n = node as Graph3DNode | null;
          setHoveredNode(n ? n.name : null);
          if (containerRef.current) {
            containerRef.current.style.cursor = n ? 'pointer' : 'grab';
          }
        })
        .onBackgroundClick(() => {
          setSelectedNode(null);
        })
        .d3AlphaDecay(0.02)
        .d3VelocityDecay(0.3)
        .warmupTicks(80)
        .cooldownTime(15000);

      // Custom node rendering with THREE.js spheres + glow
      fg.nodeThreeObject((node: any) => {
        const n = node as Graph3DNode;
        const isHighlighted = effectiveHighlightedNodeIds.has(n.id);
        const isBlastRadius = effectiveBlastRadiusNodeIds.has(n.id);
        const isSelected = appSelectedNode?.id === n.id;

        const group = new THREE.Group();

        // Main sphere
        let nodeColor = n.color;
        let radius = Math.max(1, n.size * 0.6);

        if (isBlastRadius) {
          nodeColor = '#ef4444';
          radius *= 1.8;
        } else if (isHighlighted) {
          nodeColor = '#06b6d4';
          radius *= 1.5;
        } else if (isSelected) {
          nodeColor = '#ffffff';
          radius *= 1.6;
        }

        const sphereGeometry = new THREE.SphereGeometry(radius, 16, 12);
        const sphereMaterial = new THREE.MeshPhongMaterial({
          color: new THREE.Color(nodeColor),
          emissive: new THREE.Color(nodeColor),
          emissiveIntensity: isHighlighted || isBlastRadius || isSelected ? 0.6 : 0.2,
          shininess: 80,
          transparent: true,
          opacity: 0.92,
        });
        const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
        group.add(sphere);

        // Outer glow for highlighted / selected nodes
        if (isHighlighted || isBlastRadius || isSelected) {
          const glowGeometry = new THREE.SphereGeometry(radius * 1.6, 16, 12);
          const glowMaterial = new THREE.MeshBasicMaterial({
            color: new THREE.Color(nodeColor),
            transparent: true,
            opacity: 0.15,
          });
          const glow = new THREE.Mesh(glowGeometry, glowMaterial);
          group.add(glow);
        }

        // Text label for larger structural nodes
        const structuralTypes = new Set(['Project', 'Package', 'Module', 'Folder']);
        if (structuralTypes.has(n.nodeType) || isSelected) {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d')!;
          const fontSize = 28;
          ctx.font = `500 ${fontSize}px JetBrains Mono, monospace`;
          const textWidth = ctx.measureText(n.name).width;
          canvas.width = textWidth + 20;
          canvas.height = fontSize + 10;
          ctx.font = `500 ${fontSize}px JetBrains Mono, monospace`;
          ctx.fillStyle = '#e4e4ed';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(n.name, canvas.width / 2, canvas.height / 2);

          const texture = new THREE.CanvasTexture(canvas);
          texture.minFilter = THREE.LinearFilter;
          const spriteMaterial = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            opacity: 0.9,
            depthWrite: false,
          });
          const sprite = new THREE.Sprite(spriteMaterial);
          const labelScale = radius * 0.3;
          sprite.scale.set(
            (canvas.width / canvas.height) * labelScale * 4,
            labelScale * 4,
            1
          );
          sprite.position.y = radius + labelScale * 2.5;
          group.add(sprite);
        }

        // Drillable ring indicator for folder-like nodes (hint that double-click expands)
        const drillableTypes = new Set(['Folder', 'Package', 'Module', 'Project']);
        if (drillableTypes.has(n.nodeType)) {
          const ringGeometry = new THREE.RingGeometry(radius * 1.3, radius * 1.5, 32);
          const ringMaterial = new THREE.MeshBasicMaterial({
            color: new THREE.Color('#8b5cf6'),
            transparent: true,
            opacity: 0.25,
            side: THREE.DoubleSide,
          });
          const ring = new THREE.Mesh(ringGeometry, ringMaterial);
          ring.rotation.x = Math.PI / 2; // Lay flat around the node
          group.add(ring);
        }

        return group;
      });

      graphInstanceRef.current = fg;
      setIsInitialized(true);
    };

    init();

    return () => {
      destroyed = true;
      if (graphInstanceRef.current) {
        graphInstanceRef.current._destructor?.();
        graphInstanceRef.current = null;
      }
      setIsInitialized(false);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update graph data when it changes
  useEffect(() => {
    const fg = graphInstanceRef.current;
    if (!fg || !isInitialized) return;
    if (graphData.nodes.length === 0) return;

    fg.graphData({
      nodes: graphData.nodes.map(n => ({ ...n })),
      links: graphData.links.map(l => ({ ...l })),
    });

    // Auto-zoom to fit after layout stabilizes
    setTimeout(() => {
      fg.zoomToFit(800, 60);
    }, 2000);
  }, [graphData, isInitialized]);

  // Update node styles when highlights change
  useEffect(() => {
    const fg = graphInstanceRef.current;
    if (!fg || !isInitialized) return;

    // Force re-render of nodes to pick up new highlight colors
    fg.nodeColor(fg.nodeColor());
    fg.nodeVal(fg.nodeVal());
    fg.nodeThreeObject(fg.nodeThreeObject());
  }, [effectiveHighlightedNodeIds, effectiveBlastRadiusNodeIds, appSelectedNode, isInitialized]);

  // Resize handler
  useEffect(() => {
    const fg = graphInstanceRef.current;
    if (!fg || !containerRef.current) return;

    const resizeObserver = new ResizeObserver(() => {
      if (containerRef.current) {
        const { width, height } = containerRef.current.getBoundingClientRect();
        fg.width(width);
        fg.height(height);
      }
    });

    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, [isInitialized]);

  // Controls
  const handleZoomIn = useCallback(() => {
    const fg = graphInstanceRef.current;
    if (!fg) return;
    const camera = fg.camera();
    const pos = camera.position;
    fg.cameraPosition(
      { x: pos.x * 0.7, y: pos.y * 0.7, z: pos.z * 0.7 },
      undefined,
      400
    );
  }, []);

  const handleZoomOut = useCallback(() => {
    const fg = graphInstanceRef.current;
    if (!fg) return;
    const camera = fg.camera();
    const pos = camera.position;
    fg.cameraPosition(
      { x: pos.x * 1.4, y: pos.y * 1.4, z: pos.z * 1.4 },
      undefined,
      400
    );
  }, []);

  const handleResetZoom = useCallback(() => {
    const fg = graphInstanceRef.current;
    if (!fg) return;
    fg.zoomToFit(600, 60);
    setSelectedNode(null);
  }, [setSelectedNode]);

  const handleClearSelection = useCallback(() => {
    setSelectedNode(null);
  }, [setSelectedNode]);

  const handleToggleAIHighlights = useCallback(() => {
    if (isAIHighlightsEnabled) {
      clearAIToolHighlights();
      clearAICitationHighlights();
      clearBlastRadius();
      setSelectedNode(null);
    }
    toggleAIHighlights();
  }, [isAIHighlightsEnabled, clearAIToolHighlights, clearAICitationHighlights, clearBlastRadius, setSelectedNode, toggleAIHighlights]);

  return (
    <div className="relative w-full h-full bg-void">
      {/* Background gradient */}
      <div className="absolute inset-0 pointer-events-none z-0">
        <div
          className="absolute inset-0"
          style={{
            background: `
              radial-gradient(circle at 50% 50%, rgba(124, 58, 237, 0.05) 0%, transparent 70%),
              linear-gradient(to bottom, #06060a, #0a0a10)
            `
          }}
        />
      </div>

      {/* 3D Force Graph container */}
      <div
        ref={containerRef}
        className="w-full h-full cursor-grab active:cursor-grabbing"
        style={{ position: 'relative', zIndex: 1 }}
      />

      {/* 3D Mode indicator */}
      <div className="absolute top-4 left-4 z-20 flex items-center gap-2 px-3 py-1.5 bg-accent/20 border border-accent/30 rounded-lg backdrop-blur-sm pointer-events-none">
        <div className="w-2 h-2 bg-accent rounded-full animate-pulse" />
        <span className="text-xs font-medium text-accent">3D Mode</span>
      </div>

      {/* Hovered node tooltip */}
      {hoveredNode && !appSelectedNode && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-elevated/95 border border-border-subtle rounded-lg backdrop-blur-sm z-20 pointer-events-none animate-fade-in">
          <span className="font-mono text-sm text-text-primary">{hoveredNode}</span>
        </div>
      )}

      {/* Selection info bar */}
      {appSelectedNode && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-4 py-2 bg-accent/20 border border-accent/30 rounded-xl backdrop-blur-sm z-20 animate-slide-up">
          <div className="w-2 h-2 bg-accent rounded-full animate-pulse" />
          <span className="font-mono text-sm text-text-primary">
            {appSelectedNode.properties.name}
          </span>
          <span className="text-xs text-text-muted">
            ({appSelectedNode.label})
          </span>
          <button
            onClick={handleClearSelection}
            className="ml-2 px-2 py-0.5 text-xs text-text-secondary hover:text-text-primary hover:bg-white/10 rounded transition-colors"
          >
            Clear
          </button>
        </div>
      )}

      {/* Graph Controls - Bottom Right */}
      <div className="absolute bottom-4 right-4 flex flex-col gap-1 z-10">
        <button
          onClick={handleZoomIn}
          className="w-9 h-9 flex items-center justify-center bg-elevated border border-border-subtle rounded-md text-text-secondary hover:bg-hover hover:text-text-primary transition-colors"
          title="Zoom In"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <button
          onClick={handleZoomOut}
          className="w-9 h-9 flex items-center justify-center bg-elevated border border-border-subtle rounded-md text-text-secondary hover:bg-hover hover:text-text-primary transition-colors"
          title="Zoom Out"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <button
          onClick={handleResetZoom}
          className="w-9 h-9 flex items-center justify-center bg-elevated border border-border-subtle rounded-md text-text-secondary hover:bg-hover hover:text-text-primary transition-colors"
          title="Fit to Screen"
        >
          <Maximize2 className="w-4 h-4" />
        </button>

        <div className="h-px bg-border-subtle my-1" />

        {appSelectedNode && (
          <button
            onClick={() => focusNode(appSelectedNode.id)}
            className="w-9 h-9 flex items-center justify-center bg-accent/20 border border-accent/30 rounded-md text-accent hover:bg-accent/30 transition-colors"
            title="Focus on Selected Node"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
            </svg>
          </button>
        )}

        {appSelectedNode && (
          <button
            onClick={handleClearSelection}
            className="w-9 h-9 flex items-center justify-center bg-elevated border border-border-subtle rounded-md text-text-secondary hover:bg-hover hover:text-text-primary transition-colors"
            title="Clear Selection"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Query FAB */}
      <QueryFAB />

      {/* AI Highlights toggle - Top Right */}
      <div className="absolute top-4 right-4 z-20">
        <button
          onClick={handleToggleAIHighlights}
          className={
            isAIHighlightsEnabled
              ? 'w-10 h-10 flex items-center justify-center bg-cyan-500/15 border border-cyan-400/40 rounded-lg text-cyan-200 hover:bg-cyan-500/20 hover:border-cyan-300/60 transition-colors'
              : 'w-10 h-10 flex items-center justify-center bg-elevated border border-border-subtle rounded-lg text-text-muted hover:bg-hover hover:text-text-primary transition-colors'
          }
          title={isAIHighlightsEnabled ? 'Turn off all highlights' : 'Turn on AI highlights'}
        >
          {isAIHighlightsEnabled ? <Lightbulb className="w-4 h-4" /> : <LightbulbOff className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
});

GraphCanvas3D.displayName = 'GraphCanvas3D';
