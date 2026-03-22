/**
 * In-Memory Artifact Store (TypeScript)
 *
 * Content-addressable storage for agent outputs.
 * Agents exchange artifact references instead of raw content.
 */

import { createHash } from 'crypto';
import { Artifact, ArtifactReference } from '../types';

export class ArtifactStore {
  private artifacts: Map<string, Artifact> = new Map();
  private uriIndex: Map<string, string> = new Map();

  /**
   * Compute SHA-256 content hash
   */
  private computeHash(content: Buffer | string): string {
    const hash = createHash('sha256');
    hash.update(typeof content === 'string' ? Buffer.from(content) : content);
    return hash.digest('hex');
  }

  /**
   * Build artifact URI
   */
  private buildUri(type: string, hash: string): string {
    return `artifact://${type}/${hash.substring(0, 12)}`;
  }

  /**
   * Publish an artifact and return its reference
   */
  publish(artifact: Artifact): ArtifactReference {
    const hash = this.computeHash(artifact.content);
    const uri = this.buildUri(artifact.artifactType, hash);

    const stored: Artifact = {
      ...artifact,
      artifactId: artifact.artifactId || hash,
      contentHash: hash,
      createdAt: artifact.createdAt || Date.now(),
    };

    this.artifacts.set(hash, stored);
    this.uriIndex.set(uri, hash);

    return {
      uri,
      artifactType: artifact.artifactType,
      contentHash: hash,
    };
  }

  /**
   * Get an artifact by reference
   */
  get(ref: ArtifactReference): Artifact {
    // By content hash
    if (ref.contentHash) {
      const artifact = this.artifacts.get(ref.contentHash);
      if (artifact) return { ...artifact };
    }

    // By URI
    if (ref.uri) {
      const hash = this.uriIndex.get(ref.uri);
      if (hash) {
        const artifact = this.artifacts.get(hash);
        if (artifact) return { ...artifact };
      }
    }

    throw new Error(`Artifact not found: ${ref.uri || ref.contentHash}`);
  }

  /**
   * Get by URI string
   */
  getByUri(uri: string): Artifact {
    const hash = this.uriIndex.get(uri);
    if (!hash) throw new Error(`Artifact not found: ${uri}`);
    const artifact = this.artifacts.get(hash);
    if (!artifact) throw new Error(`Artifact not found: ${hash}`);
    return { ...artifact };
  }

  /**
   * Query by type
   */
  queryByType(type: string): ArtifactReference[] {
    return Array.from(this.artifacts.values())
      .filter((a) => a.artifactType === type)
      .map((a) => ({
        uri: this.buildUri(a.artifactType, a.contentHash),
        artifactType: a.artifactType,
        contentHash: a.contentHash,
      }));
  }

  /**
   * Query by task ID
   */
  queryByTask(taskId: string): ArtifactReference[] {
    return Array.from(this.artifacts.values())
      .filter((a) => a.taskId === taskId)
      .map((a) => ({
        uri: this.buildUri(a.artifactType, a.contentHash),
        artifactType: a.artifactType,
        contentHash: a.contentHash,
      }));
  }

  get count(): number {
    return this.artifacts.size;
  }
}
