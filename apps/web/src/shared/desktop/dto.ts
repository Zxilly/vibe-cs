export type EntityId = string;

export type ApiHealth = {
  status: 'ok' | 'degraded';
  version: string;
  started_at?: string;
};

export type DependencyKind = 'game' | 'obs' | 'ffmpeg' | 'encoder' | 'storage';
export type DependencyState = 'ready' | 'warning' | 'missing' | 'checking';

export type DependencyCheck = {
  kind: DependencyKind;
  state: DependencyState;
  label: string;
  detail: string;
  action_path?: string;
};

export type QuickCheckResponse = {
  checks: DependencyCheck[];
  checked_at: string;
};

export type ObsRecordStatus = {
  active: boolean;
  paused: boolean;
  timecode: string | null;
  output_path: string | null;
};

export type ObsSceneStatus = {
  current_program_scene: string;
  scenes: string[];
};

export type ObsVideoSettings = {
  base_width: number;
  base_height: number;
  output_width: number;
  output_height: number;
  fps_numerator: number;
  fps_denominator: number;
};

export type ObsDependencyStatus = {
  name: string;
  available: boolean;
  version: string | null;
  path: string | null;
  message: string | null;
};

export type ObsDiagnosis = {
  recording: ObsRecordStatus;
  scenes: ObsSceneStatus;
  video: ObsVideoSettings;
  configured_scene: string;
  scene_ready: boolean;
  resolution_matches: boolean;
  fps_matches: boolean;
  ready: boolean;
  warnings: string[];
  dependencies: {
    ready: boolean;
    dependencies: ObsDependencyStatus[];
  };
};

export type ObsStartResponse = {
  started: boolean;
  process_id: number;
};

export type ObsVideoSettingsSnapshot = {
  base_width: number;
  base_height: number;
  output_width: number;
  output_height: number;
  fps_numerator: number;
  fps_denominator: number;
};

export type ObsVideoField = 'output_resolution' | 'frame_rate';

export type ObsVideoFieldDiff = {
  field: ObsVideoField;
  current: string;
  target: string;
};

export type ObsVideoTuningPlan = {
  current: ObsVideoSettingsSnapshot;
  target: ObsVideoSettingsSnapshot;
  diff: ObsVideoFieldDiff[];
  expected_fingerprint: string;
  recording_active: boolean;
  warnings: string[];
  managed_fields: string[];
  excluded_fields: string[];
};

export type ObsVideoBackupReason = 'apply' | 'before_restore';

export type ObsVideoBackup = {
  id: EntityId;
  created_at: string;
  reason: ObsVideoBackupReason;
  settings: ObsVideoSettingsSnapshot;
  settings_fingerprint: string;
};

export type ObsVideoApplyResult = {
  applied: boolean;
  backup: ObsVideoBackup | null;
  settings: ObsVideoSettingsSnapshot;
};

export type ObsVideoRestoreResult = {
  restored: boolean;
  restored_backup_id: EntityId;
  rollback_backup: ObsVideoBackup | null;
  settings: ObsVideoSettingsSnapshot;
};

export type ObsVideoBackupDeleteResult = {
  id: EntityId;
  deleted: boolean;
};

export type StorageStatus = {
  data_dir: string;
  directory_bytes: number;
  filesystem_total_bytes: number;
  filesystem_available_bytes: number;
  file_count: number;
  directory_count: number;
  scan_complete: boolean;
  checked_at: string;
};

export type DetectedPaths = {
  cs2_path: string | null;
  steam_path: string | null;
  obs_path: string | null;
  ffmpeg_path: string | null;
  ffprobe_path: string | null;
};

export type MediaRuntimeStatus = {
  available: boolean;
  backend: 'ffmpeg-next';
  version: string;
  license: string;
  encoders: string[];
};

export type DemoStatus = 'pending' | 'parsing' | 'ready' | 'error';

/** Wire DTO mirrored from vibe-cs-domain::DemoRecord. */
export type DemoRecord = {
  id: EntityId;
  path: string;
  file_name: string;
  display_name: string;
  source: string;
  status: 'discovered' | 'indexing' | 'ready' | 'analyzing' | 'failed' | 'missing';
  map_name: string | null;
  match_date: string | null;
  duration_seconds: number | null;
  total_rounds: number | null;
  team_a_name: string | null;
  team_b_name: string | null;
  team_a_score: number | null;
  team_b_score: number | null;
  remark: string;
  content_sha256: string | null;
  file_size: number;
  created_at: string;
  updated_at: string;
};

export type DemoSummary = {
  id: EntityId;
  filename: string;
  display_name: string;
  map_name: string;
  played_at: string;
  duration_seconds: number;
  total_rounds: number;
  score_team_a: number;
  score_team_b: number;
  status: DemoStatus;
  players: string[];
  source: 'watch' | 'upload' | 'local';
  remark?: string;
};

export type Paginated<T> = {
  items: T[];
  total: number;
  page: number;
  page_size: number;
};

export type DemoQuery = {
  search?: string;
  map?: string;
  status?: DemoStatus;
  sort?: 'newest' | 'oldest' | 'name';
  page?: number;
  page_size?: number;
};

export type DemoUpdate = {
  display_name?: string;
  remark?: string;
};

export type ScanResult = {
  discovered: number;
  imported: number;
  updated: number;
  skipped: number;
  errors: string[];
};

export type DemoWatchRootStatus = {
  path: string;
  state: 'watching' | 'missing' | 'rejected' | 'duplicate' | 'error' | 'disabled';
  message: string | null;
};

export type DemoWatchStatus = {
  running: boolean;
  roots: DemoWatchRootStatus[];
  last_scan_at: string | null;
  last_event_at: string | null;
  last_error: string | null;
  imported: number;
  updated: number;
  missing: number;
};

export type ScanRequest = {
  paths: string[];
  recursive: boolean;
};

export type CosmeticFieldName = 'paint_kit' | 'seed' | 'wear' | 'stat_trak';

export type StablePlayerIdentity = {
  /** Decimal string because Steam64 values exceed JavaScript's safe integer range. */
  steam_id64: string;
  account_id: number;
};

export type CosmeticInspectionItem = {
  owner: StablePlayerIdentity;
  item_definition_index: number;
  match_basis: 'account_id' | 'steam_id64' | 'both';
  entity_handles: number[];
  class_names: string[];
  paint_kit: number | null;
  seed: number | null;
  wear: number | null;
  stat_trak: number | null;
  incompatible_fields: CosmeticFieldName[];
  conflicting_fields: CosmeticFieldName[];
};

export type CosmeticInspectionReport = {
  input_path: string;
  input_bytes: number;
  demo_messages: number;
  entity_updates: number;
  distinct_entities: number;
  items: CosmeticInspectionItem[];
};

export type CosmeticValues = {
  paint_kit?: number;
  seed?: number;
  wear?: number;
  stat_trak?: number;
};

export type CosmeticRewriteRequest = {
  confirm_new_file: true;
  patches: Array<{
    target: {
      owner: StablePlayerIdentity;
      item_definition_index: number;
    };
    values: CosmeticValues;
  }>;
};

export type CosmeticRewriteReport = {
  input_path: string;
  output_path: string;
  input_bytes: number;
  output_bytes: number;
  demo_messages: number;
  rewrite: {
    entity_updates: number;
    distinct_entities: number;
    patches: Array<{
      patch_index: number;
      matched_entities: number;
      field_hits: Array<{ field: CosmeticFieldName; hits: number }>;
      incompatible_type_occurrences: number;
    }>;
  };
};

export type CosmeticRewriteResponse = {
  demo: DemoRecord;
  report: CosmeticRewriteReport;
};

export type CosmeticCatalogItem = {
  item_definition_index: number;
  internal_name: string;
  display_name: string;
  category: 'weapon' | 'knife' | 'gloves' | 'agent' | 'equipment';
  base_image_available: boolean;
  paint_kit_ids: number[];
};

export type CosmeticPaintKit = {
  id: number;
  internal_name: string;
  display_name: string;
  wear_min: number;
  wear_max: number;
  compatible_item_definition_indices: number[];
};

export type CosmeticCatalog = {
  items: CosmeticCatalogItem[];
  paint_kits: CosmeticPaintKit[];
};

export type CosmeticPlan = {
  id: string;
  demo_id: string;
  name: string;
  patches: CosmeticRewriteRequest['patches'];
  created_at: string;
  updated_at: string;
};

export type PlayerAnalysis = {
  id: EntityId;
  name: string;
  team: 'A' | 'B';
  kills: number;
  deaths: number;
  assists: number;
  headshot_rate: number;
  rating: number;
  adr: number;
};

/** Wire DTO mirrored from vibe-cs-domain::PlayerStats. */
export type PlayerStats = {
  steam_id: string;
  name: string;
  team: string;
  kills: number;
  deaths: number;
  assists: number;
  headshots: number;
  damage: number;
  adr: number;
  rating: number;
  score: number;
};

export type SteamProfileState = 'available' | 'not_configured' | 'unavailable';

export type PlayerSteamProfile = {
  state: SteamProfileState;
  persona_name: string | null;
  real_name: string | null;
  profile_url: string | null;
  country_code: string | null;
  persona_state: number | null;
  last_logoff: string | null;
  created_at: string | null;
  /** A service-owned route when available; never a third-party image URL. */
  avatar_url: string | null;
  reason: string | null;
};

export type PlayerAggregateStats = {
  matches: number;
  kills: number;
  deaths: number;
  assists: number;
  headshots: number;
  damage: number;
  average_adr: number | null;
  average_rating: number | null;
};

export type PlayerDirectoryItem = {
  steam_id: string;
  name: string;
  aliases: string[];
  last_team: string | null;
  last_match_at: string;
  stats: PlayerAggregateStats;
  steam: PlayerSteamProfile;
};

export type PlayerRecentMatch = {
  demo_id: EntityId;
  demo_name: string;
  map_name: string | null;
  played_at: string;
  team: string | null;
  kills: number;
  deaths: number;
  assists: number;
  headshots: number;
  damage: number;
  adr: number | null;
  rating: number | null;
};

export type PlayerDirectoryPage = Paginated<PlayerDirectoryItem> & {
  scanned_demos: number;
  scan_complete: boolean;
};

export type PlayerProfile = {
  player: PlayerDirectoryItem;
  recent_matches: PlayerRecentMatch[];
  scanned_demos: number;
  scan_complete: boolean;
};

export type AvatarCacheStatus = {
  version: number;
  entries: number;
  bytes: number;
  maximum_entries: number;
  maximum_bytes: number;
  scan_complete: boolean;
  checked_at: string;
};

export type AvatarCacheCleanup = {
  removed_entries: number;
  freed_bytes: number;
  failed_entries: number;
  scan_complete: boolean;
  completed_at: string;
};

export type TeamSummary = {
  name: string;
  side: string;
  score: number;
  players: string[];
};

export type TimelineEvent = {
  id: string;
  tick: number;
  seconds: number;
  kind: 'round_start' | 'round_end' | 'kill' | 'damage' | 'bomb_plant' | 'bomb_defuse' | 'bomb_explode' | 'grenade' | 'purchase';
  actor: string | null;
  target: string | null;
  weapon: string | null;
  headshot: boolean;
  penetrated: boolean;
  position: [number, number, number] | null;
  detail: unknown;
};

export type AnalysisRoundRecord = {
  number: number;
  start_tick: number;
  end_tick: number;
  winner: string;
  reason: string;
  team_a_score: number;
  team_b_score: number;
  events: TimelineEvent[];
};

export type AnalysisHighlightRecord = {
  id: string;
  player_id: string;
  round: number;
  start_tick: number;
  end_tick: number;
  kind: 'multi_kill' | 'clutch' | 'one_tap' | 'wallbang' | 'no_scope' | 'knife' | 'taser' | 'defuse' | 'fail' | 'timeline';
  title: string;
  description: string;
  score: number;
  tags: string[];
  victims: string[];
};

export type InsightCapabilityRecord = {
  available: boolean;
  reason: string | null;
};

export type CountedItemRecord = {
  name: string;
  count: number;
};

export type TeamPurchaseInsightRecord = {
  team: string;
  purchase_count: number;
  items: CountedItemRecord[];
  spend: number | null;
};

export type RoundEconomyInsightRecord = {
  round: number;
  teams: TeamPurchaseInsightRecord[];
  unattributed_purchase_count: number;
};

export type PlayerUtilityInsightRecord = {
  player_id: string;
  throws: number;
  detonations: number;
  items: CountedItemRecord[];
  damage: number;
  damage_events: number;
  flash_events: number;
  players_flashed: number;
  flash_duration_seconds: number | null;
};

export type PlayerMatchupInsightRecord = {
  player_id: string;
  opponent_id: string;
  kills: number;
  deaths: number;
  headshot_kills: number;
  damage_dealt: number;
  damage_taken: number;
  damage_events: number;
};

export type AnalysisInsightsRecord = {
  round_economy: RoundEconomyInsightRecord[];
  player_utility: PlayerUtilityInsightRecord[];
  matchups: PlayerMatchupInsightRecord[];
  availability: {
    purchase_events: InsightCapabilityRecord;
    purchase_spend: InsightCapabilityRecord;
    utility_events: InsightCapabilityRecord;
    utility_damage: InsightCapabilityRecord;
    flash_effects: InsightCapabilityRecord;
    matchups: InsightCapabilityRecord;
  };
};

/** Wire DTO mirrored from vibe-cs-domain::MatchAnalysis. */
export type MatchAnalysisRecord = {
  demo_id: string;
  map_name: string;
  tick_rate: number;
  duration_seconds: number;
  teams: TeamSummary[];
  players: PlayerStats[];
  rounds: AnalysisRoundRecord[];
  highlights: AnalysisHighlightRecord[];
  /** Added by the current service; optional for older persisted/API fixtures. */
  insights?: AnalysisInsightsRecord;
};

export type LlmReviewScope = 'match' | 'highlights' | 'player';
export type LlmReviewTone = 'analytical' | 'coach' | 'direct';

export type LlmReviewRequest = {
  scope: LlmReviewScope;
  player_id?: EntityId;
  highlight_ids: EntityId[];
  tone: LlmReviewTone;
};

export type LlmReviewResult = {
  demo_id: EntityId;
  scope: LlmReviewScope;
  player_id: EntityId | null;
  highlight_ids: EntityId[];
  tone: LlmReviewTone;
  commentary: string;
  evidence_ids: string[];
  evidence_sha256: string;
  provider: string;
  model: string;
  generated_at: string;
  cached: boolean;
};

export type RoundSummary = {
  number: number;
  winner: 'A' | 'B';
  reason: string;
  start_tick: number;
  end_tick: number;
  team_a_score: number;
  team_b_score: number;
  events: TimelineEvent[];
};

export type Highlight = {
  id: EntityId;
  label: string;
  category: 'multi-kill' | 'clutch' | 'entry' | 'utility';
  kind: AnalysisHighlightRecord['kind'];
  description: string;
  tags: string[];
  victims: string[];
  player_id: EntityId;
  round: number;
  start_tick: number;
  end_tick: number;
  confidence: number;
};

export type AnalysisWorkspace = {
  demo_id: EntityId;
  map_name: string;
  tick_rate: number;
  duration_seconds: number;
  teams: TeamSummary[];
  players: PlayerAnalysis[];
  rounds: RoundSummary[];
  highlights: Highlight[];
  insights?: AnalysisInsightsRecord;
};

export type ReplayPlayerRecord = {
  id: string;
  name: string;
  team: string;
  position: [number, number, number];
  yaw: number;
  health: number;
  armor: number;
  alive: boolean;
  weapon: string;
  input?: {
    forward: boolean;
    left: boolean;
    backward: boolean;
    right: boolean;
    jump: boolean;
    crouch: boolean;
    walk: boolean;
    reload: boolean;
    fire: boolean;
    secondary_fire: boolean;
  } | null;
};

export type ReplayProjectileRecord = {
  kind: string;
  position: [number, number, number];
  active: boolean;
  radius?: number | null;
  masks_vision?: boolean;
};

export type ReplayBombRecord = {
  position: [number, number, number];
  state: string;
  carrier_id: string | null;
};

export type ReplayFrameRecord = {
  tick: number;
  players: ReplayPlayerRecord[];
  projectiles: ReplayProjectileRecord[];
  bomb: ReplayBombRecord | null;
};

export type ReplayCacheMetadata = {
  state: 'hit' | 'generated' | 'bypassed';
  version: number;
  key: string | null;
  bytes: number;
  generated_at: string | null;
  repaired: boolean;
  reason: string | null;
};

export type ReplayPayload = {
  frames: ReplayFrameRecord[];
  cache: ReplayCacheMetadata;
};

export type ReplayCacheStatus = {
  version: number;
  entries: number;
  bytes: number;
  maximum_entries: number;
  maximum_bytes: number;
  scan_complete: boolean;
  checked_at: string;
};

export type ReplayCacheCleanup = {
  removed_entries: number;
  freed_bytes: number;
  failed_entries: number;
  scan_complete: boolean;
  completed_at: string;
};

export type HeatPointRecord = {
  x: number;
  y: number;
  weight: number;
  floor: number;
  kind: string;
  player_id?: string | null;
  team?: string | null;
  event_kind?: string | null;
};

export type RadarOverviewRecord = {
  map_name: string;
  transform: {
    pos_x: number;
    pos_y: number;
    scale: number;
    rotate: boolean;
    zoom: number | null;
  } | null;
  image_url: string | null;
  image_mime: string | null;
  browser_displayable: boolean;
};

export type RecordingRequest = {
  id?: EntityId;
  demo_id: EntityId;
  highlight_id: string | null;
  player_id: string;
  title: string;
  start_tick: number;
  end_tick: number;
  playback_speed: number;
  pre_roll_seconds: number;
  post_roll_seconds: number;
  victim_pov: boolean;
  show_keyboard: boolean;
  show_kill_fx: boolean;
  fade: boolean;
};

export type RecordingQueueRequest = {
  items: RecordingRequest[];
};

export type RecordingPlanResponse = {
  active_items: number;
  disabled_items: number;
  estimated_seconds: number;
  warnings: string[];
  items: RecordingRequest[];
  director: DirectorPlan;
};

export type DirectorShot = {
  demo_id: EntityId;
  source_item_ids: EntityId[];
  player_id: string;
  kind: 'player' | 'victim_reaction';
  start_tick: number;
  end_tick: number;
  score: number;
  evidence: string[];
  explanation: string;
};

export type DirectorPlan = {
  shots: DirectorShot[];
  warnings: string[];
  source_item_count: number;
  merged_item_count: number;
  victim_reaction_count: number;
  unresolved_victim_requests: number;
};

export type CaptureLatencySample = {
  game_observed_ms: number;
  obs_observed_ms: number;
};

export type CaptureLatencyCalibration = {
  sample_count: number;
  recommended_delay_ms: number;
  median_offset_ms: number;
  jitter_ms: number;
  confidence: 'high' | 'medium' | 'low';
  diagnostic: string;
};

export type RecordingExecutionResponse = {
  job_id: EntityId;
  status: 'queued' | 'running';
};

export type JobStatus =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type RecordingJobOutput = {
  id: EntityId;
  path: string;
  title: string;
  duration_seconds: number;
  demo_id: EntityId | null;
  player_name: string | null;
  category: string;
  tags: string[];
  metadata: unknown;
  created_at: string;
};

export type RecordingJob = {
  id: EntityId;
  status: JobStatus;
  items: RecordingRequest[];
  current_index: number;
  progress: number;
  message: string;
  outputs: RecordingJobOutput[];
  created_at: string;
  updated_at: string;
};

export type RuntimeState = {
  status: 'ready';
  version: string;
  started_at: string;
  data_dir: string;
  active_recording_job: EntityId | null;
  runtime_session: 'idle' | 'playback_launching' | 'playback' | 'playback_stopping' | 'recording';
};

export type DemoPlaybackOptions = {
  start_tick?: number;
  player?: string;
  timescale?: number;
};

export type DemoPlaybackStatus = {
  executable_available: boolean;
  executable: string | null;
  gsi_installed: boolean;
  gsi_fresh: boolean;
  gsi_sequence: number;
  gsi_received_at: string | null;
  map_name: string | null;
  map_phase: string | null;
  player_name: string | null;
  player_activity: string | null;
  ready_to_launch: boolean;
  gsi_ready: boolean;
  warnings: string[];
};

export type DemoPlaybackPreflight = {
  ready: true;
  executable: string;
  demo_path: string;
  launch_path: string;
  demo_size: number;
  demo_sha256: string;
  arguments: string[];
  managed_copy: boolean;
  status: DemoPlaybackStatus;
  warnings: string[];
};

export type DemoPlaybackLaunch = {
  started: true;
  process_id: number;
  demo_id: EntityId;
  preflight: DemoPlaybackPreflight;
};

export type DemoPlaybackStop = {
  stopped: true;
  process_id: number | null;
  already_stopped: boolean;
  forced_process_stop: boolean;
};

export type RecordedClip = {
  id: EntityId;
  title: string;
  player_name: string;
  map_name: string;
  duration_seconds: number;
  created_at: string;
  stream_url: string;
};

/** Wire DTO mirrored from vibe-cs-domain::RecordedClip. */
export type RecordedClipRecord = {
  id: EntityId;
  path: string;
  title: string;
  duration_seconds: number;
  demo_id: EntityId | null;
  player_name: string | null;
  map_name: string;
  category: string;
  tags: string[];
  metadata: unknown;
  created_at: string;
  stream_url: string;
};

export type MontageClipRecord = {
  clip_id: EntityId;
  order: number;
  trim_start: number;
  trim_end: number | null;
  transition: string;
  title: string | null;
  avatar_asset_id: EntityId | null;
};

export type MontageBrandingTheme = 'vibe' | 'broadcast' | 'minimal' | 'neon';

export type MontageSettingsRecord = {
  width: number;
  height: number;
  fps: number;
  encoder: string;
  quality: number;
  background_music: string | null;
  music_volume: number;
  transition_seconds: number;
  intro_title: string | null;
  intro_duration_seconds: number;
  include_name_cards: boolean;
  name_card_duration_seconds: number;
  outro_title: string | null;
  outro_duration_seconds: number;
  branding_theme: MontageBrandingTheme;
};

export type MontageProjectRecord = {
  id: EntityId;
  name: string;
  clips: MontageClipRecord[];
  settings: MontageSettingsRecord;
  created_at: string;
  updated_at: string;
};

export type CreateMontageProject = Pick<MontageProjectRecord, 'name' | 'clips' | 'settings'>;

export type MontageExportRequest = {
  name: string;
  clip_ids: EntityId[];
  transition: 'cut' | 'fade' | 'whip';
  resolution: '1080p' | '1440p' | '2160p';
  fps: 30 | 60;
  include_name_cards: boolean;
  background_music?: string | null;
  music_volume?: number;
  transition_seconds?: number;
  intro_title?: string | null;
  intro_duration_seconds?: number;
  outro_title?: string | null;
  outro_duration_seconds?: number;
  branding_theme?: MontageBrandingTheme;
};

export type EditorExportOptions = {
  encoder: 'auto' | 'libopenh264' | 'h264_mf' | 'h264_qsv' | 'h264_nvenc' | 'h264_amf';
  quality: number;
  range_start_seconds?: number;
  range_end_seconds?: number;
};

export type WaveformResponse = {
  waveform: number[];
  cached: boolean;
};

export type JobAccepted = {
  job_id: EntityId;
  status: 'queued' | 'running';
};

export type ExportJobRecord = {
  kind: string;
  job: {
    id: EntityId;
    project_id: EntityId;
    status: JobStatus;
    progress: number;
    output_path: string;
    error: string | null;
    created_at: string;
    updated_at: string;
  };
};

export type OutputKind = 'recording' | 'export';
export type OutputAvailability = 'present' | 'missing' | 'unsafe';

export type OutputItem = {
  id: EntityId;
  output_kind: OutputKind;
  media_kind: string;
  title: string;
  status: JobStatus;
  progress: number;
  path: string;
  file_name: string;
  availability: OutputAvailability;
  managed: boolean;
  mutable: boolean;
  size_bytes: number | null;
  project_id: EntityId | null;
  demo_id: EntityId | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type OutputQuery = {
  page?: number;
  page_size?: number;
  kind?: OutputKind;
  status?: JobStatus;
  availability?: OutputAvailability;
  search?: string;
};

export type OutputPage = Paginated<OutputItem> & {
  scan_limited: boolean;
};

export type DeleteOutputResult = {
  id: EntityId;
  output_kind: OutputKind;
  record_deleted: boolean;
  file_deleted: boolean;
  file_action:
    | 'record_only'
    | 'missing_record_removed'
    | 'external_file_preserved'
    | 'managed_file_deleted'
    | 'managed_file_pending_cleanup';
  warning: string | null;
};

export type OutputReference = {
  kind: OutputKind;
  id: EntityId;
};

export type BatchDeleteOutputResult = {
  requested: number;
  deleted: number;
  failed: number;
  items: Array<{
    kind: OutputKind;
    id: EntityId;
    result: DeleteOutputResult | null;
    error: string | null;
  }>;
};

export type CleanupMissingOutputsResult = {
  inspected: number;
  deleted: number;
  scan_limited: boolean;
};

export type CleanupStagedOutputsResult = {
  inspected: number;
  deleted: number;
  failed: number;
  scan_limited: boolean;
};

export type TimelineClipDto = {
  id: EntityId;
  asset_id: EntityId | null;
  name: string;
  start: number;
  duration: number;
  source_in: number;
  source_out: number;
  speed: number;
  volume: number;
  transform: {
    x: number;
    y: number;
    scale_x: number;
    scale_y: number;
    rotation: number;
    opacity: number;
  };
  effects: Array<{ id: string; kind: string; enabled: boolean; parameters: unknown }>;
  transition_in: string | null;
  transition_out: string | null;
  text: {
    content: string;
    font_family: string;
    font_asset_id?: EntityId | null;
    font_size: number;
    color: string;
    background: string | null;
    align: string;
  } | null;
  metadata: unknown;
  group_id: EntityId | null;
  link_group_id: EntityId | null;
  keyframes: Array<{
    id: EntityId;
    time: number;
    property: 'x' | 'y' | 'scale_x' | 'scale_y' | 'rotation' | 'opacity' | 'volume';
    value: number;
  }>;
  speed_segments: Array<{
    id: EntityId;
    start: number;
    end: number;
    speed: number;
  }>;
};

export type TimelineTrackDto = {
  id: EntityId;
  name: string;
  kind: 'video' | 'audio' | 'text' | 'overlay';
  order: number;
  muted: boolean;
  locked: boolean;
  hidden: boolean;
  clips: TimelineClipDto[];
};

export type EditorProject = {
  id: EntityId;
  name: string;
  width: number;
  height: number;
  fps: number;
  updated_at: string;
  created_at: string;
  duration_seconds: number;
  tracks: TimelineTrackDto[];
  markers: EditorMarker[];
  settings: unknown;
  revision: number;
};

export type EditorMarker = {
  id: EntityId;
  time: number;
  label: string;
  color: string;
};

export type EditorProjectSnapshot = {
  id: EntityId;
  project_id: EntityId;
  revision: number;
  name: string;
  created_at: string;
};

export type CreateEditorProject = {
  name: string;
  width: number;
  height: number;
  fps: number;
};

export type EditorPresetDocument = {
  schema_version: 1;
  transform: TimelineClipDto['transform'];
  volume: number;
  color_adjust: {
    brightness: number;
    contrast: number;
    saturation: number;
  } | null;
  grayscale: boolean;
  blur_radius: number | null;
  transition_in: EditorTransitionName | null;
  transition_out: EditorTransitionName | null;
};

export type EditorTransitionName =
  | 'fade'
  | 'flash'
  | 'dip'
  | 'zoom'
  | 'wipe'
  | 'slide'
  | 'blur'
  | 'glitch'
  | 'spin';

export type EditorPreset = {
  id: EntityId;
  name: string;
  revision: number;
  document: EditorPresetDocument;
  created_at: string;
  updated_at: string;
};

export type EditorProjectDeletionResult = {
  deleted_project_ids: EntityId[];
  deleted_asset_ids: EntityId[];
  preserved_shared_asset_ids: EntityId[];
  removed_files: number;
  preserved_external_files: number;
  failed_files: string[];
};

export type MediaAsset = {
  id: EntityId;
  project_id: EntityId | null;
  path: string;
  name: string;
  kind: string;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  file_size: number;
  has_audio: boolean;
  proxy_path: string | null;
  proxy_status:
    | { status: 'not_requested' }
    | { status: 'generating'; started_at: string }
    | { status: 'ready'; generated_at: string }
    | { status: 'failed'; message: string; failed_at: string };
  waveform: number[] | null;
  metadata_status:
    | { status: 'pending' }
    | { status: 'ready' }
    | { status: 'unavailable'; message: string };
  created_at: string;
};

export type EditorAudioSeparation = {
  project: EditorProject;
  asset: MediaAsset;
};

export type EditorPackageExport = {
  package_id: EntityId;
  name: string;
  path: string;
  size: number;
  sha256: string;
  download_url: string | null;
};

export type EditorPackageImport = {
  project: EditorProject;
  assets: MediaAsset[];
};

export type MediaProxyCleanup = {
  removed_files: number;
  freed_bytes: number;
  failed_files: string[];
  skipped_generating: number;
};

export type AppConfig = {
  locale: string;
  theme: string;
  update_manifest_url: string;
  data_dir: string;
  demo_watch_paths: string[];
  ffmpeg_path: string;
  ffprobe_path: string;
  preferred_encoder: 'auto' | 'libopenh264' | 'h264_mf' | 'h264_qsv' | 'h264_nvenc' | 'h264_amf';
  cs2_path: string;
  steam_path: string;
  steam: {
    steam_id: string;
    web_api_key: string;
    authentication_code: string;
    known_share_code: string;
    maximum_results: number;
  };
  steam_has_web_api_key: boolean;
  steam_has_authentication_code: boolean;
  steam_has_share_code: boolean;
  obs: {
    host: string;
    port: number;
    password: string;
    executable: string;
    scene: string;
  };
  obs_has_password: boolean;
  llm: {
    provider: string;
    model: string;
    base_url: string;
    api_key: string;
    prompt: string;
  };
  llm_has_api_key: boolean;
  clear_llm_api_key: boolean;
  recording: {
    pre_roll_seconds: number;
    post_roll_seconds: number;
    transition_seconds: number;
    resolution: string;
    fps: number;
    show_radar: boolean;
    radar_restore_visible: boolean;
    show_keyboard: boolean;
    mute_voice: boolean;
    voice_restore_volume: number;
    camera_fov: number;
    camera_fov_restore: number;
    viewmodel_fov: number;
    viewmodel_fov_restore: number;
    flash_alpha: number;
    flash_alpha_restore: number;
    grenade_trajectory: boolean;
    grenade_trajectory_restore: boolean;
    show_hud: boolean;
    hud_restore_visible: boolean;
    isolate_target_voice: boolean;
    first_person_hud_assets: string;
    obs_realtime_kill_fx_media: string;
    obs_realtime_keyboard_media: string;
    capture_delay_ms: number;
  };
};

export type MatchHistoryItem = {
  id: EntityId;
  steam_id: string;
  match_id: string;
  outcome_id: string;
  token: number;
  map_name: string | null;
  played_at: string | null;
  score: string | null;
  result: 'win' | 'loss' | 'draw' | 'unknown';
  demo_status: 'available' | 'downloading' | 'downloaded' | 'failed';
  demo_id: EntityId | null;
  last_error: string | null;
  synced_at: string;
  updated_at: string;
};

export type MatchHistorySyncResult = {
  synced: number;
  created: number;
  total: number;
  cursor_advanced: boolean;
};

export type MatchDownloadJob = {
  id: EntityId;
  match_record_id: string;
  status: 'queued' | 'downloading' | 'decompressing' | 'importing' | 'completed' | 'cancelling' | 'cancelled' | 'failed';
  downloaded_bytes: number;
  total_bytes: number | null;
  progress: number;
  demo_id: EntityId | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type RecoveryStatus = {
  recovery_required: boolean;
  reason?: string;
  backup_created_at?: string;
  affected_files: string[];
};

export type ApiProblem = {
  code?: string;
  message?: string;
  detail?: string | { code?: string; message?: string; params?: Record<string, unknown> };
};

export type AgentMode = 'guide' | 'edit' | 'hlae';

export type AgentStatus = {
  sidecarAvailable: boolean;
  configured: boolean;
  provider: string;
  model: string;
  streaming: boolean;
};

export type AgentToolCall = {
  name: string;
  input: unknown;
  output: unknown;
};

export type AgentProposal = {
  kind: 'highlight_edit' | 'beat_alignment' | 'hlae';
  title: string;
  payload: unknown;
};

export type ProposalPrerequisite = { code: string; message: string };
export type HlaeProposalIntent = {
  demo_id: EntityId;
  highlight_ids: string[];
  camera_style: 'pov' | 'orbit' | 'dolly';
  mode: 'preview' | 'capture';
};
export type ProposalConfirmation = {
  base_fingerprint: string;
  proposal_fingerprint: string;
  confirmation_token: string;
  expected_revision: number;
  confirm: true;
};
export type HlaeProposalPreview = {
  schema_version: number;
  proposal_revision: number;
  ready: boolean;
  prerequisites: ProposalPrerequisite[];
  base_fingerprint: string | null;
  proposal_fingerprint: string | null;
  confirmation_token: string | null;
  typed_plan: unknown | null;
  compiled_preview: unknown | null;
  notices: string[];
};
export type HlaeProposalExportResult = {
  directory: string;
  files: string[];
  completion_marker: string;
  launched: false;
};
export type BeatAlignmentProposalRequest = {
  project_id: EntityId;
  expected_revision: number;
  draft: BeatAlignmentDraft;
};
export type BeatAlignmentProposalPreview = {
  ready: boolean;
  prerequisites: ProposalPrerequisite[];
  project_id: EntityId;
  expected_revision: number;
  base_fingerprint: string | null;
  proposal_fingerprint: string | null;
  confirmation_token: string | null;
  changes: BeatAlignmentDraft['clips'];
};
export type BeatAlignmentApplyResult = {
  project_id: EntityId;
  previous_revision: number;
  revision: number;
  applied_clip_ids: EntityId[];
  snapshot_created: boolean;
};
export type HighlightEditProposalRequest = {
  demo_id: EntityId;
  highlight_ids: string[];
  target_project_id?: EntityId | null;
  expected_revision?: number | null;
  new_project_name?: string | null;
};
export type HighlightAssetMapping = {
  highlight_id: string;
  recorded_clip_id: EntityId;
  path: string;
  duration_seconds: number;
  file_size: number;
  content_sha256: string;
};
export type HighlightEditClipInsert = {
  highlight_id: string;
  recorded_clip_id: EntityId;
  editor_clip_id: EntityId;
  timeline_start_seconds: number;
  timeline_end_seconds: number;
  source_in_seconds: number;
  source_out_seconds: number;
  transition_in: string | null;
};
export type HighlightEditPlan = {
  demo_id: EntityId;
  project_id: EntityId;
  project_name: string;
  create_project: boolean;
  expected_revision: number;
  target_track_id: EntityId;
  create_track: boolean;
  mappings: HighlightAssetMapping[];
  insertions: HighlightEditClipInsert[];
};
export type HighlightEditProposalPreview = {
  ready: boolean;
  prerequisites: ProposalPrerequisite[];
  mappings: HighlightAssetMapping[];
  insertions: HighlightEditClipInsert[];
  target_project_id: EntityId | null;
  creates_new_project: boolean;
  expected_revision: number;
  base_fingerprint: string | null;
  proposal_fingerprint: string | null;
  confirmation_token: string | null;
  plan: HighlightEditPlan | null;
};
export type HighlightEditApplyResult = {
  project_id: EntityId;
  previous_revision: number;
  revision: number;
  inserted_clip_ids: EntityId[];
  project_created: boolean;
  snapshot_created: boolean;
  already_applied: boolean;
};

export type AgentMessage = {
  id: EntityId;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  toolCalls: AgentToolCall[];
  proposals: AgentProposal[];
};

export type AgentThread = {
  id: EntityId;
  messages: AgentMessage[];
  updatedAt: string;
};

export type AgentChatInput = {
  requestId: EntityId;
  threadId?: EntityId;
  demoId?: EntityId;
  editorProjectId?: EntityId;
  audioAssetId?: EntityId;
  mode: AgentMode;
  message: string;
};

export type AgentEvent =
  | { type: 'started'; threadId: EntityId }
  | { type: 'textDelta'; delta: string }
  | { type: 'toolCall'; toolCall: AgentToolCall }
  | { type: 'proposal'; proposal: AgentProposal }
  | { type: 'complete'; thread: AgentThread }
  | { type: 'error'; message: string };

export type AgentChatResult = { thread_id: EntityId };

export type AudioBeat = {
  index: number;
  time_seconds: number;
  strength: number;
  phrase_position: number;
};

export type AudioAnalysis = {
  duration_seconds: number;
  analysis_sample_rate: number;
  bpm: number | null;
  tempo_confidence: number;
  beats: AudioBeat[];
  onsets: Array<{ time_seconds: number; strength: number }>;
  energy: Array<{ time_seconds: number; rms: number; peak: number }>;
  sections: Array<{
    start_seconds: number;
    end_seconds: number;
    character: string;
    mean_energy: number;
    confidence: number;
  }>;
  limitations: string[];
};

export type AudioAnalysisOptions = {
  sample_rate?: number;
  maximum_duration_seconds?: number;
  maximum_beats?: number;
  maximum_onsets?: number;
  energy_points?: number;
  maximum_sections?: number;
};

export type BeatAlignmentRequest = {
  beats: AudioBeat[];
  clips: Array<{
    clip_id: string;
    source_duration_seconds: number;
    minimum_duration_seconds?: number;
    maximum_duration_seconds?: number;
    preferred_beats?: number;
  }>;
  options?: {
    timeline_start_seconds?: number;
    maximum_duration_change_ratio?: number;
    beats_per_phrase?: number;
    prefer_strong_boundaries?: boolean;
  };
};

export type BeatAlignmentDraft = {
  advisory_only: true;
  clips: Array<{
    clip_id: string;
    timeline_start_seconds: number;
    timeline_end_seconds: number;
    planned_duration_seconds: number;
    source_duration_seconds: number;
    duration_change_ratio: number;
    start_beat_index: number;
    end_beat_index: number;
    rationale: string[];
  }>;
  unplaced_clip_ids: string[];
  constraints: string[];
};
