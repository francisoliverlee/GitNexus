/**
 * 3D Graph Adapter
 * Converts KnowledgeGraph to 3d-force-graph compatible data format
 * Supports folder-scoped filtering to limit rendering to a specific directory scope
 */
import type { NodeLabel, GraphNode, GraphRelationship } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../core/graph/types';
import { NODE_COLORS, NODE_SIZES, getCommunityColor } from './constants';

export interface Graph3DNode {
  id: string;
  name: string;
  nodeType: NodeLabel;
  filePath: string;
  startLine?: number;
  endLine?: number;
  color: string;
  size: number;
  community?: number;
  communityColor?: string;
  // runtime position (set by 3d-force-graph)
  x?: number;
  y?: number;
  z?: number;
  fx?: number;
  fy?: number;
  fz?: number;
}

export interface Graph3DLink {
  source: string;
  target: string;
  relationType: string;
  color: string;
  width: number;
}

export interface Graph3DData {
  nodes: Graph3DNode[];
  links: Graph3DLink[];
}

/** Scale node size for 3D rendering */
const getScaled3DNodeSize = (baseSize: number, nodeCount: number): number => {
  if (nodeCount > 50000) return Math.max(0.5, baseSize * 0.3);
  if (nodeCount > 20000) return Math.max(0.8, baseSize * 0.4);
  if (nodeCount > 5000) return Math.max(1, baseSize * 0.5);
  if (nodeCount > 1000) return Math.max(1.5, baseSize * 0.7);
  return baseSize;
};

/** Edge styles per relationship type */
const EDGE_STYLES_3D: Record<string, { color: string; widthMultiplier: number }> = {
  CONTAINS: { color: '#2d5a3d', widthMultiplier: 0.3 },
  DEFINES:  { color: '#0e7490', widthMultiplier: 0.4 },
  IMPORTS:  { color: '#1d4ed8', widthMultiplier: 0.5 },
  CALLS:    { color: '#7c3aed', widthMultiplier: 0.7 },
  EXTENDS:  { color: '#c2410c', widthMultiplier: 0.8 },
  IMPLEMENTS: { color: '#be185d', widthMultiplier: 0.7 },
};

/**
 * Filter nodes based on a focused folder path.
 * 
 * Strategy:
 * - If focusedFolderPath is null, show only structural nodes (Project/Package/Module/Folder) 
 *   and File nodes at the root level (overview mode).
 * - If focusedFolderPath is set, show:
 *   1. The folder node itself
 *   2. Direct child folders (one level)
 *   3. Files directly in this folder
 *   4. Code elements (Class, Function, Method, Interface, etc.) defined in those files
 *   5. Relationships between all visible nodes
 */
function filterNodesByFolder(
  graph: KnowledgeGraph,
  focusedFolderPath: string | null,
): { nodes: GraphNode[]; relationships: GraphRelationship[] } {
  // Build hierarchy maps from relationships
  const parentToChildren = new Map<string, Set<string>>();
  const childToParent = new Map<string, string>();
  const hierarchyRelations = new Set(['CONTAINS', 'DEFINES', 'IMPORTS']);

  graph.relationships.forEach(rel => {
    if (hierarchyRelations.has(rel.type)) {
      if (!parentToChildren.has(rel.sourceId)) {
        parentToChildren.set(rel.sourceId, new Set());
      }
      parentToChildren.get(rel.sourceId)!.add(rel.targetId);
      childToParent.set(rel.targetId, rel.sourceId);
    }
  });

  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
  const visibleNodeIds = new Set<string>();

  if (focusedFolderPath === null) {
    // ROOT MODE: Show only top-level structural overview
    // Include: Project, Package, Module nodes + top-level Folders + Files at root
    const structuralTypes = new Set(['Project', 'Package', 'Module']);
    
    graph.nodes.forEach(node => {
      if (structuralTypes.has(node.label)) {
        visibleNodeIds.add(node.id);
      }
    });

    // Add top-level folders (folders whose parent is a Project/Package/Module or have no parent)
    graph.nodes.forEach(node => {
      if (node.label === 'Folder') {
        const parentId = childToParent.get(node.id);
        if (!parentId) {
          // No parent - it's a root folder
          visibleNodeIds.add(node.id);
        } else {
          const parent = nodeMap.get(parentId);
          if (parent && structuralTypes.has(parent.label)) {
            visibleNodeIds.add(node.id);
          }
        }
      }
    });

    // Also include their immediate folder children (one level of subfolder)
    for (const nodeId of [...visibleNodeIds]) {
      const children = parentToChildren.get(nodeId);
      if (children) {
        for (const childId of children) {
          const child = nodeMap.get(childId);
          if (child && (child.label === 'Folder' || child.label === 'File')) {
            visibleNodeIds.add(childId);
          }
        }
      }
    }
  } else {
    // FOLDER SCOPE MODE: Show the focused folder and its contents
    const normalizedPath = focusedFolderPath.replace(/\/$/, '');

    // 1. Find the folder node itself
    const folderNode = graph.nodes.find(
      n => (n.label === 'Folder' || n.label === 'Package' || n.label === 'Module') 
        && n.properties.filePath.replace(/\/$/, '') === normalizedPath
    );

    if (folderNode) {
      visibleNodeIds.add(folderNode.id);

      // 2. Get direct children of this folder from CONTAINS relationships
      const directChildren = parentToChildren.get(folderNode.id);
      if (directChildren) {
        for (const childId of directChildren) {
          const child = nodeMap.get(childId);
          if (child) {
            visibleNodeIds.add(childId);

            // 3. If child is a File, also include its code elements (DEFINES targets)
            if (child.label === 'File') {
              const fileChildren = parentToChildren.get(childId);
              if (fileChildren) {
                for (const codeId of fileChildren) {
                  const codeNode = nodeMap.get(codeId);
                  if (codeNode && codeNode.label !== 'Import') {
                    // Include Class, Function, Method, Interface, etc. but skip Imports to reduce noise
                    visibleNodeIds.add(codeId);
                  }
                }
              }
            }

            // 4. If child is a Folder, just include it (user can drill down)
          }
        }
      }
    } else {
      // Folder node not found by exact match - try matching by filePath prefix
      // This handles cases where the tree has virtual folder nodes
      graph.nodes.forEach(node => {
        const nodePath = node.properties.filePath.replace(/\/$/, '');
        
        // Include nodes directly in this folder
        if (node.label === 'File' || node.label === 'Folder') {
          const parentPath = nodePath.substring(0, nodePath.lastIndexOf('/'));
          if (parentPath === normalizedPath || nodePath === normalizedPath) {
            visibleNodeIds.add(node.id);

            // Include code elements for files
            if (node.label === 'File') {
              const fileChildren = parentToChildren.get(node.id);
              if (fileChildren) {
                for (const codeId of fileChildren) {
                  const codeNode = nodeMap.get(codeId);
                  if (codeNode && codeNode.label !== 'Import') {
                    visibleNodeIds.add(codeId);
                  }
                }
              }
            }
          }
        }
      });
    }
  }

  // Filter relationships to only those between visible nodes
  const filteredRelationships = graph.relationships.filter(
    rel => visibleNodeIds.has(rel.sourceId) && visibleNodeIds.has(rel.targetId)
  );

  // Collect visible nodes
  const filteredNodes = graph.nodes.filter(n => visibleNodeIds.has(n.id));

  return { nodes: filteredNodes, relationships: filteredRelationships };
}

/**
 * Convert KnowledgeGraph into 3d-force-graph compatible format
 * with folder-scoped filtering
 */
export const knowledgeGraphTo3D = (
  knowledgeGraph: KnowledgeGraph,
  communityMemberships?: Map<string, number>,
  visibleLabels?: NodeLabel[],
  focusedFolderPath?: string | null,
): Graph3DData => {
  // First, apply folder-scope filtering
  const { nodes: scopedNodes, relationships: scopedRelationships } = filterNodesByFolder(
    knowledgeGraph,
    focusedFolderPath ?? null,
  );

  const nodeCount = scopedNodes.length;
  const symbolTypes = new Set(['Function', 'Class', 'Method', 'Interface']);

  // Then apply label visibility filter
  const filteredNodes = visibleLabels
    ? scopedNodes.filter(n => visibleLabels.includes(n.label))
    : scopedNodes;

  const nodeIdSet = new Set(filteredNodes.map(n => n.id));

  const nodes: Graph3DNode[] = filteredNodes.map(node => {
    const communityIndex = communityMemberships?.get(node.id);
    const hasCommunity = communityIndex !== undefined;
    const usesCommunityColor = hasCommunity && symbolTypes.has(node.label);
    const color = usesCommunityColor
      ? getCommunityColor(communityIndex!)
      : NODE_COLORS[node.label] || '#9ca3af';

    const baseSize = NODE_SIZES[node.label] || 4;
    const size = getScaled3DNodeSize(baseSize, nodeCount);

    return {
      id: node.id,
      name: node.properties.name,
      nodeType: node.label,
      filePath: node.properties.filePath,
      startLine: node.properties.startLine,
      endLine: node.properties.endLine,
      color,
      size,
      community: communityIndex,
      communityColor: hasCommunity ? getCommunityColor(communityIndex!) : undefined,
    };
  });

  // Build edge dedup set - only from scoped relationships
  const edgeSeen = new Set<string>();
  const links: Graph3DLink[] = [];
  const baseWidth = nodeCount > 20000 ? 0.3 : nodeCount > 5000 ? 0.5 : 0.8;

  scopedRelationships.forEach(rel => {
    if (!nodeIdSet.has(rel.sourceId) || !nodeIdSet.has(rel.targetId)) return;
    const edgeKey = `${rel.sourceId}→${rel.targetId}`;
    if (edgeSeen.has(edgeKey)) return;
    edgeSeen.add(edgeKey);

    const style = EDGE_STYLES_3D[rel.type] || { color: '#4a4a5a', widthMultiplier: 0.4 };
    links.push({
      source: rel.sourceId,
      target: rel.targetId,
      relationType: rel.type,
      color: style.color,
      width: baseWidth * style.widthMultiplier,
    });
  });

  return { nodes, links };
};
