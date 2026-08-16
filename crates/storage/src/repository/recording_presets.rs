//! Saved recording shot settings.
//!
//! The table follows `agent_plans`: only what the preset list is ordered and
//! addressed by is a column, and the settings themselves are one
//! `document_json`. Every write normalizes the draft first, so a combination
//! that a [`RecordingRequest`](vibe_cs_domain::RecordingRequest) could not
//! carry never reaches the table.

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension as _, TransactionBehavior, params};
use uuid::Uuid;
use vibe_cs_domain::{RecordingShotPreset, RecordingShotPresetDraft};

use super::{Storage, decode, encode};
use crate::Result;

impl Storage {
    /// Lists every saved shot preset, most recently changed first.
    pub async fn list_recording_shot_presets(&self) -> Result<Vec<RecordingShotPreset>> {
        self.list_documents("recording_shot_presets", "updated_at DESC, id")
            .await
    }

    /// Reads one exact preset.
    pub async fn get_recording_shot_preset(&self, id: Uuid) -> Result<Option<RecordingShotPreset>> {
        self.run(move |connection| read_preset(connection, id))
            .await
    }

    /// Saves a new preset. Identity and both timestamps are server-owned.
    pub async fn create_recording_shot_preset(
        &self,
        draft: RecordingShotPresetDraft,
    ) -> Result<RecordingShotPreset> {
        let draft = draft.normalize()?;
        self.run(move |connection| {
            let now = Utc::now();
            let preset = draft.into_preset(Uuid::new_v4(), now, now);
            connection.execute(
                "INSERT INTO recording_shot_presets(\
                    id, name, created_at, updated_at, document_json\
                 ) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    preset.id.to_string(),
                    preset.name,
                    preset.created_at.to_rfc3339(),
                    preset.updated_at.to_rfc3339(),
                    encode(&preset)?,
                ],
            )?;
            Ok(preset)
        })
        .await
    }

    /// Replaces one preset's settings, keeping its identity and creation time.
    ///
    /// `Ok(None)` means the preset does not exist. The read and the write share
    /// one immediate transaction so the returned document is the one that was
    /// stored, not a later writer's.
    pub async fn update_recording_shot_preset(
        &self,
        id: Uuid,
        draft: RecordingShotPresetDraft,
    ) -> Result<Option<RecordingShotPreset>> {
        let draft = draft.normalize()?;
        self.run(move |connection| {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(current) = read_preset(&transaction, id)? else {
                return Ok(None);
            };
            let preset = draft.into_preset(id, current.created_at, Utc::now());
            transaction.execute(
                "UPDATE recording_shot_presets SET name = ?2, updated_at = ?3, \
                    document_json = ?4 WHERE id = ?1",
                params![
                    id.to_string(),
                    preset.name,
                    preset.updated_at.to_rfc3339(),
                    encode(&preset)?,
                ],
            )?;
            transaction.commit()?;
            Ok(Some(preset))
        })
        .await
    }

    /// Deletes one preset and reports whether it existed. Nothing references a
    /// preset: applying one copies its values into a shot, so a recording that
    /// used it is unaffected by its removal.
    pub async fn delete_recording_shot_preset(&self, id: Uuid) -> Result<bool> {
        self.delete_document("recording_shot_presets", id).await
    }
}

fn read_preset(connection: &Connection, id: Uuid) -> Result<Option<RecordingShotPreset>> {
    let document = connection
        .query_row(
            "SELECT document_json FROM recording_shot_presets WHERE id = ?1",
            params![id.to_string()],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    document.as_deref().map(decode).transpose()
}

#[cfg(test)]
mod tests {
    use vibe_cs_domain::{
        HlaeCameraStyle, RecordingPresentation, RecordingShotPresetDraft, RecordingVoicePolicy,
    };

    use crate::Storage;

    fn draft(name: &str) -> RecordingShotPresetDraft {
        RecordingShotPresetDraft {
            name: name.to_owned(),
            camera_style: HlaeCameraStyle::Pov,
            victim_pov: false,
            pre_roll_seconds: 1.5,
            post_roll_seconds: 1.0,
            presentation: RecordingPresentation {
                camera_fov: 106.0,
                viewmodel_fov: 60.0,
                flash_alpha: 102,
                show_hud: false,
                show_radar: true,
                voice: RecordingVoicePolicy::TargetOnly,
            },
        }
    }

    #[tokio::test]
    async fn a_saved_preset_reads_back_field_for_field() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let created = storage
            .create_recording_shot_preset(draft("  选手 POV · 三杀  "))
            .await
            .expect("create preset");

        // The name is normalized on the way in, everything else is stored as
        // given.
        assert_eq!(created.name, "选手 POV · 三杀");
        assert_eq!(created.camera_style, HlaeCameraStyle::Pov);
        assert!(!created.victim_pov);
        assert!((created.pre_roll_seconds - 1.5).abs() < f64::EPSILON);
        assert!((created.post_roll_seconds - 1.0).abs() < f64::EPSILON);
        assert_eq!(created.presentation, draft("x").presentation);
        assert_eq!(created.created_at, created.updated_at);

        let read = storage
            .get_recording_shot_preset(created.id)
            .await
            .expect("read preset")
            .expect("the preset exists");
        assert_eq!(read, created);

        let listed = storage
            .list_recording_shot_presets()
            .await
            .expect("list presets");
        assert_eq!(listed, vec![created.clone()]);

        assert!(
            storage
                .delete_recording_shot_preset(created.id)
                .await
                .expect("delete preset")
        );
        assert!(
            !storage
                .delete_recording_shot_preset(created.id)
                .await
                .expect("delete a second time")
        );
        assert!(
            storage
                .list_recording_shot_presets()
                .await
                .expect("list presets")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn an_update_keeps_the_identity_and_the_creation_time() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let created = storage
            .create_recording_shot_preset(draft("选手 POV · 三杀"))
            .await
            .expect("create preset");

        let updated = storage
            .update_recording_shot_preset(
                created.id,
                RecordingShotPresetDraft {
                    name: "观察者 · 建立镜头".to_owned(),
                    camera_style: HlaeCameraStyle::Crane,
                    presentation: RecordingPresentation {
                        show_hud: false,
                        show_radar: false,
                        ..RecordingPresentation::default()
                    },
                    ..draft("ignored")
                },
            )
            .await
            .expect("update preset")
            .expect("the preset exists");

        assert_eq!(updated.id, created.id);
        assert_eq!(updated.created_at, created.created_at);
        assert!(updated.updated_at >= created.updated_at);
        assert_eq!(updated.camera_style, HlaeCameraStyle::Crane);
        assert!(!updated.presentation.show_radar);
        assert_eq!(
            storage
                .get_recording_shot_preset(created.id)
                .await
                .expect("read preset")
                .expect("the preset exists"),
            updated
        );

        assert!(
            storage
                .update_recording_shot_preset(uuid::Uuid::new_v4(), draft("未知预设"))
                .await
                .expect("update an unknown preset")
                .is_none()
        );
    }

    #[tokio::test]
    async fn a_combination_that_cannot_be_recorded_never_reaches_the_table() {
        let storage = Storage::open_in_memory().await.expect("open storage");
        let observer_with_a_pov_field_of_view = RecordingShotPresetDraft {
            camera_style: HlaeCameraStyle::Tracking,
            presentation: RecordingPresentation {
                camera_fov: 120.0,
                ..RecordingPresentation::default()
            },
            ..draft("跟随 · 120 FOV")
        };
        assert!(
            storage
                .create_recording_shot_preset(observer_with_a_pov_field_of_view.clone())
                .await
                .is_err()
        );
        assert!(
            storage
                .list_recording_shot_presets()
                .await
                .expect("list presets")
                .is_empty()
        );

        let stored = storage
            .create_recording_shot_preset(draft("选手 POV · 三杀"))
            .await
            .expect("create preset");
        assert!(
            storage
                .update_recording_shot_preset(stored.id, observer_with_a_pov_field_of_view)
                .await
                .is_err()
        );
        assert_eq!(
            storage
                .get_recording_shot_preset(stored.id)
                .await
                .expect("read preset")
                .expect("the preset exists"),
            stored,
            "a rejected update must leave the stored preset untouched"
        );
    }
}
