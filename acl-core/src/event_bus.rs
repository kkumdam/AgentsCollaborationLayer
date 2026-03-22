//! Event Bus
//!
//! Pub/sub infrastructure for all state transitions.
//! Emits events like TASK_CREATED, TASK_CLAIMED, ARTIFACT_PUBLISHED, etc.
//! Provides both in-memory (for MVP/testing) and NATS JetStream backends.

use std::sync::Arc;

use chrono::Utc;
use dashmap::DashMap;
use tokio::sync::broadcast;
use tracing::{debug, info};
use uuid::Uuid;

use acl_proto::{Event, EventType};

use crate::error::AclResult;

/// Event subscriber callback type
pub type EventCallback = Arc<dyn Fn(Event) + Send + Sync>;

/// Event filter for subscriptions
#[derive(Debug, Clone)]
pub struct EventFilter {
    pub event_types: Vec<EventType>,
    pub source_filter: Option<String>,
    pub task_id_filter: Option<String>,
}

impl EventFilter {
    pub fn all() -> Self {
        Self {
            event_types: vec![],
            source_filter: None,
            task_id_filter: None,
        }
    }

    pub fn for_types(types: Vec<EventType>) -> Self {
        Self {
            event_types: types,
            source_filter: None,
            task_id_filter: None,
        }
    }

    pub fn matches(&self, event: &Event) -> bool {
        // If event_types is empty, match all
        if !self.event_types.is_empty() {
            let event_type = event.event_type();
            if !self.event_types.contains(&event_type) {
                return false;
            }
        }

        if let Some(ref source) = self.source_filter {
            if &event.source != source {
                return false;
            }
        }

        true
    }
}

/// In-memory Event Bus using tokio broadcast channels
#[derive(Clone)]
pub struct EventBus {
    sender: broadcast::Sender<Event>,
    /// Event history for replay
    history: Arc<DashMap<String, Event>>,
    /// Subscriber count tracking
    subscriber_count: Arc<std::sync::atomic::AtomicUsize>,
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self {
            sender,
            history: Arc::new(DashMap::new()),
            subscriber_count: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        }
    }

    /// Publish an event to the bus
    pub fn publish(&self, event_type: EventType, payload: Vec<u8>, source: &str) -> AclResult<Event> {
        let event = Event {
            event_id: Uuid::new_v4().to_string(),
            event_type: event_type.into(),
            payload,
            timestamp: Utc::now().timestamp_millis(),
            source: source.to_string(),
        };

        self.history.insert(event.event_id.clone(), event.clone());

        // Ignore send errors (no receivers)
        let _ = self.sender.send(event.clone());

        debug!(
            event_id = %event.event_id,
            event_type = ?event_type,
            source = %source,
            "Event published"
        );

        Ok(event)
    }

    /// Publish a typed event with serialized payload
    pub fn publish_state_update(
        &self,
        event_type: EventType,
        task_id: &str,
        agent_id: &str,
    ) -> AclResult<Event> {
        let payload = serde_json::json!({
            "task_id": task_id,
            "agent_id": agent_id,
        });
        self.publish(event_type, payload.to_string().into_bytes(), agent_id)
    }

    /// Subscribe to events with a filter, returns a broadcast receiver
    pub fn subscribe(&self, _filter: EventFilter) -> broadcast::Receiver<Event> {
        self.subscriber_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        info!(
            subscribers = self.subscriber_count.load(std::sync::atomic::Ordering::Relaxed),
            "New event subscriber"
        );
        self.sender.subscribe()
    }

    /// Get event history (all events)
    pub fn get_history(&self) -> Vec<Event> {
        let mut events: Vec<Event> = self.history.iter().map(|e| e.value().clone()).collect();
        events.sort_by_key(|e| e.timestamp);
        events
    }

    /// Get events by type from history
    pub fn get_events_by_type(&self, event_type: EventType) -> Vec<Event> {
        self.history
            .iter()
            .filter(|e| e.value().event_type() == event_type)
            .map(|e| e.value().clone())
            .collect()
    }

    /// Clear event history
    pub fn clear_history(&self) {
        self.history.clear();
    }

    /// Total events published
    pub fn event_count(&self) -> usize {
        self.history.len()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new(10000)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio;

    #[tokio::test]
    async fn test_publish_and_subscribe() {
        let bus = EventBus::new(100);
        let filter = EventFilter::for_types(vec![EventType::TaskCreated]);
        let mut rx = bus.subscribe(filter);

        bus.publish(EventType::TaskCreated, b"test".to_vec(), "agent-1").unwrap();

        let event = rx.recv().await.unwrap();
        assert_eq!(event.event_type(), EventType::TaskCreated);
        assert_eq!(event.source, "agent-1");
    }

    #[tokio::test]
    async fn test_event_history() {
        let bus = EventBus::new(100);

        bus.publish(EventType::TaskCreated, b"t1".to_vec(), "a1").unwrap();
        bus.publish(EventType::TaskClaimed, b"t2".to_vec(), "a2").unwrap();
        bus.publish(EventType::TaskDone, b"t3".to_vec(), "a3").unwrap();

        assert_eq!(bus.event_count(), 3);

        let created = bus.get_events_by_type(EventType::TaskCreated);
        assert_eq!(created.len(), 1);
    }

    #[test]
    fn test_event_filter() {
        let filter = EventFilter::for_types(vec![EventType::TaskCreated, EventType::TaskDone]);

        let event_match = Event {
            event_id: "1".into(),
            event_type: EventType::TaskCreated.into(),
            payload: vec![],
            timestamp: 0,
            source: "test".into(),
        };
        assert!(filter.matches(&event_match));

        let event_no_match = Event {
            event_id: "2".into(),
            event_type: EventType::PolicyViolation.into(),
            payload: vec![],
            timestamp: 0,
            source: "test".into(),
        };
        assert!(!filter.matches(&event_no_match));
    }
}
