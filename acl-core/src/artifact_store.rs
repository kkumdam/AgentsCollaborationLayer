//! Artifact Store
//!
//! Content-addressable storage for all agent outputs: code patches, documents,
//! analysis results, intermediate data. Agents exchange artifact references
//! (artifact://type/hash) instead of raw content.

use std::sync::Arc;

use chrono::Utc;
use dashmap::DashMap;
use sha2::{Digest, Sha256};
use tracing::info;

use acl_proto::{Artifact, ArtifactReference};

use crate::error::{AclError, AclResult};

/// In-memory content-addressable Artifact Store
#[derive(Debug, Clone)]
pub struct ArtifactStore {
    /// content_hash -> Artifact
    artifacts: Arc<DashMap<String, Artifact>>,
    /// artifact URI -> content_hash (for lookup by URI)
    uri_index: Arc<DashMap<String, String>>,
}

impl ArtifactStore {
    pub fn new() -> Self {
        Self {
            artifacts: Arc::new(DashMap::new()),
            uri_index: Arc::new(DashMap::new()),
        }
    }

    /// Compute content hash (SHA-256)
    fn compute_hash(content: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(content);
        hex::encode(hasher.finalize())
    }

    /// Build artifact URI from type and hash
    fn build_uri(artifact_type: &str, hash: &str) -> String {
        format!("artifact://{}/{}", artifact_type, &hash[..12])
    }

    /// Publish an artifact and return its reference
    pub fn publish(&self, artifact: Artifact) -> AclResult<ArtifactReference> {
        let hash = Self::compute_hash(&artifact.content);
        let uri = Self::build_uri(&artifact.artifact_type, &hash);

        let atype = artifact.artifact_type.clone();
        let stored = Artifact {
            artifact_id: if artifact.artifact_id.is_empty() {
                hash.clone()
            } else {
                artifact.artifact_id
            },
            content_hash: hash.clone(),
            created_at: if artifact.created_at == 0 {
                Utc::now().timestamp_millis()
            } else {
                artifact.created_at
            },
            ..artifact
        };

        self.uri_index.insert(uri.clone(), hash.clone());
        self.artifacts.insert(hash.clone(), stored);

        info!(uri = %uri, "Artifact published");

        Ok(ArtifactReference {
            uri,
            artifact_type: atype,
            content_hash: hash,
        })
    }

    /// Get an artifact by its reference
    pub fn get(&self, reference: &ArtifactReference) -> AclResult<Artifact> {
        // Try by content hash first
        if !reference.content_hash.is_empty() {
            return self.artifacts
                .get(&reference.content_hash)
                .map(|a| a.value().clone())
                .ok_or_else(|| AclError::ArtifactNotFound(reference.content_hash.clone()));
        }

        // Try by URI
        if !reference.uri.is_empty() {
            let hash = self.uri_index
                .get(&reference.uri)
                .map(|h| h.value().clone())
                .ok_or_else(|| AclError::ArtifactNotFound(reference.uri.clone()))?;

            return self.artifacts
                .get(&hash)
                .map(|a| a.value().clone())
                .ok_or_else(|| AclError::ArtifactNotFound(hash));
        }

        Err(AclError::ArtifactNotFound("empty reference".to_string()))
    }

    /// Get artifact by URI string
    pub fn get_by_uri(&self, uri: &str) -> AclResult<Artifact> {
        let hash = self.uri_index
            .get(uri)
            .map(|h| h.value().clone())
            .ok_or_else(|| AclError::ArtifactNotFound(uri.to_string()))?;

        self.artifacts
            .get(&hash)
            .map(|a| a.value().clone())
            .ok_or_else(|| AclError::ArtifactNotFound(hash))
    }

    /// Query artifacts by type
    pub fn query_by_type(&self, artifact_type: &str) -> Vec<ArtifactReference> {
        self.artifacts
            .iter()
            .filter(|e| e.value().artifact_type == artifact_type)
            .map(|e| {
                let a = e.value();
                ArtifactReference {
                    uri: Self::build_uri(&a.artifact_type, &a.content_hash),
                    artifact_type: a.artifact_type.clone(),
                    content_hash: a.content_hash.clone(),
                }
            })
            .collect()
    }

    /// Query artifacts by task ID
    pub fn query_by_task(&self, task_id: &str) -> Vec<ArtifactReference> {
        self.artifacts
            .iter()
            .filter(|e| e.value().task_id == task_id)
            .map(|e| {
                let a = e.value();
                ArtifactReference {
                    uri: Self::build_uri(&a.artifact_type, &a.content_hash),
                    artifact_type: a.artifact_type.clone(),
                    content_hash: a.content_hash.clone(),
                }
            })
            .collect()
    }

    /// Count of stored artifacts
    pub fn count(&self) -> usize {
        self.artifacts.len()
    }
}

impl Default for ArtifactStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_artifact(content: &str, atype: &str, producer: &str) -> Artifact {
        Artifact {
            artifact_id: String::new(),
            artifact_type: atype.to_string(),
            content_hash: String::new(),
            content: content.as_bytes().to_vec(),
            producer_agent: producer.to_string(),
            task_id: "task-1".to_string(),
            created_at: 0,
            metadata: Default::default(),
        }
    }

    #[test]
    fn test_publish_and_retrieve() {
        let store = ArtifactStore::new();

        let artifact = make_artifact("Hello, world!", "text", "agent-1");
        let reference = store.publish(artifact).unwrap();

        assert!(reference.uri.starts_with("artifact://text/"));
        assert!(!reference.content_hash.is_empty());

        let retrieved = store.get(&reference).unwrap();
        assert_eq!(retrieved.content, b"Hello, world!");
        assert_eq!(retrieved.producer_agent, "agent-1");
    }

    #[test]
    fn test_content_dedup() {
        let store = ArtifactStore::new();

        let a1 = make_artifact("same content", "text", "agent-1");
        let a2 = make_artifact("same content", "text", "agent-2");

        let ref1 = store.publish(a1).unwrap();
        let ref2 = store.publish(a2).unwrap();

        // Same content should produce same hash
        assert_eq!(ref1.content_hash, ref2.content_hash);
    }

    #[test]
    fn test_query_by_type() {
        let store = ArtifactStore::new();

        store.publish(make_artifact("code1", "code_patch", "a1")).unwrap();
        store.publish(make_artifact("doc1", "document", "a2")).unwrap();
        store.publish(make_artifact("code2", "code_patch", "a3")).unwrap();

        let patches = store.query_by_type("code_patch");
        assert_eq!(patches.len(), 2);
    }
}
